import type { AgentToMatch, Jwk, MatchToAgent } from "@twobullets/contracts/agent";
import type { MatchConfig } from "@twobullets/contracts/match";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { AllocationError, type AllocatedMatch, type Allocator, type AllocatorListener } from "./allocator";

// One server-match child process per match on this host (process-per-match, ADR 0004), driven over the agent IPC
// contract in packages/contracts/src/agent.ts. server-api plays the host agent's role for the single-host MVP:
//   spawn `<command> <args> --host=<bind> --port=<p>` with an IPC channel
//   ← ready {wsPort}                      (process booted: Havok + level loaded, WS listening)
//   → jwks {keys}, allocate {config}
//   ← phase {phase, freeSlots}            (first phase = allocation acknowledged)
//   ← player / metrics / phase …
//   ← result {summary}, exit {code}       (or the process dies: abort)
// Needs server-match `--mode=agent` (see the report / docs/release/plan.md "server-match changes").

export interface LocalProcessAllocatorOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly bindHost: string;
  readonly portMin: number;
  readonly portMax: number;
  readonly maxMatches: number;
  /** `{port}` and `{matchId}` are replaced. */
  readonly urlTemplate: string;
  /** Spawn → ready and allocate → first phase, each. */
  readonly readyTimeoutMs: number;
  /** Hard wall-clock cap per match (platform.md §3.1: 20 min + margin). */
  readonly maxMinutes: number;
  readonly killGraceMs?: number;
  readonly log?: (line: string) => void;
  /** Forward child stdout/stderr lines to `log`. */
  readonly forwardOutput?: boolean;
}

interface Child {
  readonly matchId: string;
  readonly port: number;
  readonly proc: ChildProcess;
  state: "booting" | "allocating" | "running" | "stopping" | "exited";
  gotResult: boolean;
  exitReason: string | null;
  timers: NodeJS.Timeout[];
}

export class LocalProcessAllocator implements Allocator {
  private readonly options: LocalProcessAllocatorOptions;
  private listener: AllocatorListener | null = null;
  private readonly children = new Map<string, Child>();
  private readonly usedPorts = new Set<number>();
  private jwks: readonly Jwk[] = [];

  constructor(options: LocalProcessAllocatorOptions, initialJwks: readonly Jwk[] = []) {
    this.options = options;
    this.jwks = initialJwks;
  }

  setListener(listener: AllocatorListener): void {
    this.listener = listener;
  }

  capacity(): { used: number; max: number } {
    return { used: this.children.size, max: this.options.maxMatches };
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  private takePort(): number | null {
    for (let p = this.options.portMin; p <= this.options.portMax; p++) {
      if (!this.usedPorts.has(p)) {
        this.usedPorts.add(p);
        return p;
      }
    }
    return null;
  }

  allocate(config: MatchConfig): Promise<AllocatedMatch> {
    if (this.children.size >= this.options.maxMatches) return Promise.reject(new AllocationError("noCapacity", "all match slots busy"));
    if (this.children.has(config.matchId)) return Promise.reject(new Error(`match ${config.matchId} already allocated`));
    const port = this.takePort();
    if (port === null) return Promise.reject(new AllocationError("noCapacity", "no free match port"));

    const o = this.options;
    const proc = spawn(o.command, [...o.args, `--host=${o.bindHost}`, `--port=${port}`], {
      cwd: o.cwd,
      env: { ...process.env, ...o.env, TB_MATCH_ID: config.matchId, TB_HOST_ID: config.hostId, TB_RESUME_SECRET: randomBytes(32).toString("hex") },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const child: Child = { matchId: config.matchId, port, proc, state: "booting", gotResult: false, exitReason: null, timers: [] };
    this.children.set(config.matchId, child);
    const tag = `[match ${config.matchId}]`;
    if (o.forwardOutput !== false) {
      for (const stream of [proc.stdout, proc.stderr]) {
        if (stream) createInterface({ input: stream }).on("line", (line) => this.log(`${tag} ${line}`));
      }
    }

    return new Promise<AllocatedMatch>((resolve, reject) => {
      let settled = false;
      const settle = (err: AllocationError | null): void => {
        if (settled) return;
        settled = true;
        if (err === null) {
          resolve({ matchId: config.matchId, hostId: config.hostId, wsUrl: o.urlTemplate.replaceAll("{port}", String(port)).replaceAll("{matchId}", config.matchId) });
        } else {
          reject(err);
          this.stop(child, `allocation failed: ${err.reason}`);
        }
      };
      const deadline = (what: string): NodeJS.Timeout => setTimeout(() => settle(new AllocationError("timeout", `${what} timed out`)), o.readyTimeoutMs);
      let waitTimer = deadline("ready");
      child.timers.push(waitTimer);

      proc.on("message", (raw: unknown) => {
        const msg = raw as MatchToAgent;
        if (typeof msg !== "object" || msg === null || typeof (msg as { t?: unknown }).t !== "string") return;
        switch (msg.t) {
          case "ready": {
            if (child.state !== "booting") return;
            clearTimeout(waitTimer);
            child.state = "allocating";
            this.send(child, { t: "jwks", keys: [...this.jwks] });
            this.send(child, { t: "allocate", config });
            waitTimer = deadline("allocate");
            child.timers.push(waitTimer);
            return;
          }
          case "phase": {
            if (child.state === "allocating") {
              clearTimeout(waitTimer);
              child.state = "running";
              child.timers.push(setTimeout(() => this.stop(child, "hard time cap"), o.maxMinutes * 60_000));
              settle(null);
            }
            this.listener?.onPhase(child.matchId, msg.phase, msg.freeSlots);
            return;
          }
          case "player":
            this.listener?.onPlayer(child.matchId, msg.accountId, msg.event);
            return;
          case "metrics":
            this.listener?.onMetrics(child.matchId, msg.m);
            return;
          case "result":
            child.gotResult = true;
            this.listener?.onResult(child.matchId, msg.summary);
            return;
          case "exit":
            child.exitReason ??= `exit ${msg.code}`;
            return;
        }
      });

      proc.on("error", (err) => {
        this.log(`${tag} spawn error: ${err.message}`);
        settle(new AllocationError("crashed", `spawn failed: ${err.message}`));
      });

      proc.on("exit", (code, signal) => {
        for (const t of child.timers) clearTimeout(t);
        const wasState = child.state;
        child.state = "exited";
        this.children.delete(child.matchId);
        this.usedPorts.delete(child.port);
        const exitCode = code ?? (signal ? 128 : 1);
        const reason = child.exitReason ?? (signal ? `signal ${signal}` : `exit ${exitCode}`);
        if (wasState === "booting" || wasState === "allocating") settle(new AllocationError("crashed", `match process exited during allocation (${reason})`));
        else this.listener?.onExit(child.matchId, exitCode, reason);
        this.log(`${tag} exited: ${reason}`);
      });
    });
  }

  private send(child: Child, message: AgentToMatch): void {
    if (child.proc.connected) child.proc.send(message);
  }

  private stop(child: Child, reason: string): void {
    if (child.state === "exited" || child.state === "stopping") return;
    child.exitReason ??= reason;
    child.state = child.state === "running" ? "stopping" : child.state;
    this.send(child, { t: "drain" });
    child.proc.kill("SIGTERM");
    const grace = setTimeout(() => {
      if (child.proc.exitCode === null && child.proc.signalCode === null) child.proc.kill("SIGKILL");
    }, this.options.killGraceMs ?? 10_000);
    grace.unref();
    child.timers.push(grace);
  }

  release(matchId: string): void {
    const child = this.children.get(matchId);
    if (child) this.stop(child, "released");
  }

  pushJwks(keys: readonly Jwk[]): void {
    this.jwks = keys;
    for (const child of this.children.values()) if (child.state === "allocating" || child.state === "running") this.send(child, { t: "jwks", keys: [...keys] });
  }

  async shutdown(): Promise<void> {
    const waits = [...this.children.values()].map(
      (child) =>
        new Promise<void>((done) => {
          if (child.state === "exited") return done();
          child.proc.once("exit", () => done());
          this.stop(child, "api shutdown");
        }),
    );
    await Promise.all(waits);
  }
}
