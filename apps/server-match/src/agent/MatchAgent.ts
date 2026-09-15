import type { AgentToMatch, MatchConfig, MatchToAgent } from "@twobullets/contracts";
import { DisconnectReason, isCompatible } from "@twobullets/protocol";
import type { RunningServer } from "../app";
import { ed25519KeyFromJwk } from "../auth/joinToken";
import { resolveServerLevel, type MatchLevel } from "../level/serverLevel";
import type { BrLifecycleOptions } from "../match/BrLifecycle";
import type { ServerMatch } from "../match/ServerMatch";

// `--mode=agent` (plan.md P3, packages/contracts/src/agent.ts): one match per process, driven by the host agent
// (server-api's LocalProcessAllocator) over the Node IPC channel.
//   → jwks {keys}           verifier keys (again on rotation)
//   → allocate {config}     compat check (exit 3) → level for mapId (exit 4 if unknown) → createMatch with the roster,
//                           hostId, team mode and rules → `phase Warmup` (the allocation ack)
//   ← phase / player        on every lifecycle change and join/leave
//   ← result, exit 0        when the match ends (after the end linger), or on drain/SIGTERM (cancelled/aborted)

export const EXIT_INCOMPATIBLE = 3;
export const EXIT_BAD_CONFIG = 4;

export interface MatchAgentOptions {
  readonly server: RunningServer;
  readonly send: (message: MatchToAgent) => void;
  /** Stops the process: the caller stops the server, sends `exit` and exits. */
  readonly exit: (code: number) => void;
  readonly lifecycle?: BrLifecycleOptions;
  readonly log?: (line: string) => void;
}

export class MatchAgent {
  private readonly o: MatchAgentOptions;
  private match: ServerMatch | null = null;
  private allocating = false;
  private stopping = false;

  constructor(options: MatchAgentOptions) {
    this.o = options;
  }

  get current(): ServerMatch | null {
    return this.match;
  }

  onMessage(message: AgentToMatch): void {
    if (typeof message !== "object" || message === null) return;
    switch (message.t) {
      case "jwks":
        try {
          this.o.server.verifier.setKeys(message.keys.map((k) => ed25519KeyFromJwk(k)));
          this.log(`[agent] jwks: ${message.keys.map((k) => k.kid).join(", ") || "(none)"}`);
        } catch (err) {
          this.log(`[agent] bad jwks ignored: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      case "allocate":
        void this.allocate(message.config);
        return;
      case "drain":
        this.drain();
        return;
      case "cert":
        return;
    }
  }

  /** Drain or SIGTERM: a running match reports cancelled/aborted, then the process stops. */
  drain(): void {
    if (this.stopping) return;
    this.stopping = true;
    const match = this.match;
    if (match !== null && !match.isClosed) {
      this.log(`[agent] drain: ending match ${match.id} (${match.lifecycle?.phase ?? match.phase})`);
      match.abort(DisconnectReason.serverShutdown);
    }
    this.o.exit(0);
  }

  private async allocate(config: MatchConfig): Promise<void> {
    if (this.match !== null || this.allocating || this.stopping) {
      this.log(`[agent] allocate ${config.matchId} ignored: one match per process`);
      return;
    }
    this.allocating = true;
    if (!isCompatible(config.protocolVersion, config.contentHash)) {
      this.log(`[agent] allocate ${config.matchId} refused: pv ${config.protocolVersion} ch 0x${(config.contentHash >>> 0).toString(16)} is not this build`);
      this.o.exit(EXIT_INCOMPATIBLE);
      return;
    }
    const server = this.o.server;
    const started = performance.now();
    let match: ServerMatch;
    let level: MatchLevel;
    try {
      level = await resolveServerLevel(config.mapId, { log: this.o.log });
      server.host.hostId = config.hostId;
      match = server.host.createMatch(config, {
        level,
        lifecycle: this.o.lifecycle ?? {},
        onPhase: (phase) => this.o.send({ t: "phase", phase, freeSlots: this.match?.freeSlots ?? config.maxPlayers }),
        onResult: (summary) => {
          this.log(`[agent] result ${summary.outcome}: winner ${summary.winningTeamId ?? "none"}, ${summary.players.length} players`);
          this.o.send({ t: "result", summary, files: [] });
        },
        onClosed: () => {
          if (this.stopping) return;
          this.stopping = true;
          this.o.exit(0);
        },
      });
      this.match = match;
      await match.ready;
    } catch (err) {
      this.log(`[agent] allocate ${config.matchId} failed: ${err instanceof Error ? err.message : String(err)}`);
      this.o.exit(EXIT_BAD_CONFIG);
      return;
    }
    const humans = config.teams.reduce((n, t) => n + t.accountIds.filter((id) => !id.startsWith("bot:")).length, 0);
    this.log(
      `[agent] allocated ${config.matchId} on ${config.mapId} (${level.source}, map load ${level.loadMs.toFixed(0)} ms, ready in ${(performance.now() - started).toFixed(0)} ms): ` +
        `${config.maxPlayers} players ${config.teamMode ?? `teams of ${config.maxTeamSize}`}, ${humans} humans, hid ${config.hostId}, rss ${(process.memoryUsage.rss() / 1e6).toFixed(0)} MB`,
    );
  }

  private log(line: string): void {
    this.o.log?.(line);
  }
}
