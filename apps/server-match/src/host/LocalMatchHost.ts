import type { MatchConfig, MatchMetrics } from "@twobullets/contracts";
import type { Clock } from "@twobullets/netcode";
import { DisconnectReason } from "@twobullets/protocol";
import type { HavokModule, ServerLevel } from "@twobullets/sim";
import { ServerMatch, type ServerMatchOptions } from "../match/ServerMatch";
import { TickScheduler, type TimerApi } from "../sched/TickScheduler";
import { createWindowSummary, WindowStats, type WindowSummary } from "../sched/WindowStats";
import type { MatchDirectory } from "../session/SessionManager";
import type { MatchHost } from "./MatchHost";

// In-process MatchHost (ADR 0004). `single-match`: one match per process, 1 ms spin (launch default). `packed`: several
// matches on one scheduler and one Havok module, 2 ms spin. Packed worker threads + external transport (ADR 0004 B1)
// are not built yet: this runs every match on the main thread.

export type HostMode = "single-match" | "packed";

export interface LocalMatchHostOptions {
  readonly mode: HostMode;
  readonly hostId: string;
  readonly clock: Clock;
  readonly timers?: TimerApi;
  readonly havok: HavokModule;
  readonly level: ServerLevel;
  readonly resumeSecret: Uint8Array;
  readonly tickRate?: number;
  readonly spinMs?: number;
  readonly match?: Partial<Pick<ServerMatchOptions, "idleTimeoutMs" | "reconnectGraceMs" | "onTickEnd" | "datagramRateLimit" | "datagramKickRate">>;
  readonly onPlayer?: (matchId: string, accountId: string, event: "joined" | "left") => void;
  readonly onHitch?: (behindMs: number, tick: number) => void;
}

export interface HostMetrics {
  readonly tick: number;
  readonly windowMs: number;
  readonly matches: number;
  readonly players: number;
  readonly connected: number;
  readonly work: WindowSummary;
  readonly lateness: WindowSummary;
  readonly overruns: number;
  readonly hitches: number;
  readonly bytesOutPerSec: number;
  readonly snapshotsPerSec: number;
  readonly snapshotsSkipped: number;
  readonly inputsDropped: number;
  readonly rssBytes: number;
  readonly perMatch: MatchMetrics[];
}

interface MatchEntry {
  readonly match: ServerMatch;
  readonly work: WindowStats;
  lastBytesOut: number;
  lastSent: number;
  lastSkipped: number;
}

export class LocalMatchHost implements MatchHost, MatchDirectory {
  readonly mode: HostMode;
  readonly hostId: string;
  readonly scheduler: TickScheduler;
  private readonly options: LocalMatchHostOptions;
  private readonly clock: Clock;
  private readonly entries = new Map<string, MatchEntry>();
  private list: MatchEntry[] = [];
  private readonly pumps: (() => void)[] = [];
  private draining = false;
  private lastMetricsMs: number;
  private readonly workSummary = createWindowSummary();
  private readonly latenessSummary = createWindowSummary();
  private readonly matchWorkSummary = createWindowSummary();

  constructor(options: LocalMatchHostOptions) {
    this.options = options;
    this.mode = options.mode;
    this.hostId = options.hostId;
    this.clock = options.clock;
    this.lastMetricsMs = options.clock.now();
    this.scheduler = new TickScheduler({
      clock: options.clock,
      timers: options.timers,
      tickRate: options.tickRate,
      spinMs: options.spinMs ?? (options.mode === "packed" ? 2 : 1),
      onTick: this.onTick,
      beforeTicks: this.runPumps,
      onHitch: options.onHitch,
    });
  }

  get accepting(): boolean {
    return !this.draining;
  }

  get matches(): readonly ServerMatch[] {
    return this.list.map((e) => e.match);
  }

  createMatch(config: MatchConfig): ServerMatch {
    if (this.draining) throw new Error("host is draining");
    if (this.mode === "single-match" && this.entries.size > 0) throw new Error("single-match mode runs one match per process");
    if (this.entries.has(config.matchId)) throw new Error(`match ${config.matchId} exists`);
    const o = this.options;
    const match = new ServerMatch({
      ...o.match,
      config,
      havok: o.havok,
      level: o.level,
      clock: o.clock,
      startTick: this.scheduler.nextTick,
      resumeSecret: o.resumeSecret,
      tickRate: o.tickRate,
      onPlayer: o.onPlayer ? (accountId, event) => o.onPlayer!(config.matchId, accountId, event) : undefined,
    });
    const entry: MatchEntry = { match, work: new WindowStats(), lastBytesOut: 0, lastSent: 0, lastSkipped: 0 };
    this.entries.set(config.matchId, entry);
    this.list = [...this.list, entry];
    return match;
  }

  findMatch(matchId: string): ServerMatch | undefined {
    return this.entries.get(matchId)?.match;
  }

  /** `autoLoop` false: ticks only run from `scheduler.pump()` (virtual-clock tests). */
  start(autoLoop = true): void {
    this.lastMetricsMs = this.clock.now();
    this.scheduler.start(this.scheduler.nextTick, autoLoop);
  }

  /** Runs `fn` on every scheduler turn before due ticks (fake-net link conditioners). Returns a remover. */
  addPump(fn: () => void): () => void {
    this.pumps.push(fn);
    return () => {
      const i = this.pumps.indexOf(fn);
      if (i >= 0) this.pumps.splice(i, 1);
    };
  }

  drain(): Promise<void> {
    this.draining = true;
    this.scheduler.stop();
    for (const e of this.list) e.match.end(DisconnectReason.serverShutdown);
    return Promise.resolve();
  }

  /** Flushes the metric windows (call once per second, outside ticks). */
  collectMetrics(): HostMetrics {
    const now = this.clock.now();
    const windowMs = Math.max(1, now - this.lastMetricsMs);
    this.lastMetricsMs = now;
    const s = this.scheduler;
    const work = { ...s.work.flush(this.workSummary) };
    const lateness = { ...s.lateness.flush(this.latenessSummary) };
    const rssBytes = process.memoryUsage.rss();
    const havokHeapBytes = (this.options.havok as { HEAPU8?: Uint8Array }).HEAPU8?.byteLength ?? 0;
    let players = 0;
    let connected = 0;
    let bytes = 0;
    let sent = 0;
    let skipped = 0;
    let dropped = 0;
    const perMatch: MatchMetrics[] = [];
    for (const e of this.list) {
      const m = e.match;
      const st = m.snapshots.stats;
      const dBytes = st.bytesOut - e.lastBytesOut;
      const dSent = st.sent - e.lastSent;
      const dSkipped = st.skipped - e.lastSkipped;
      e.lastBytesOut = st.bytesOut;
      e.lastSent = st.sent;
      e.lastSkipped = st.skipped;
      let matchDropped = 0;
      for (const p of m.players) matchDropped += p.inputs.stats.late + p.inputs.stats.tooEarly + p.inputs.stats.rateLimited;
      const mw = e.work.flush(this.matchWorkSummary);
      const conn = m.connectedCount;
      players += m.playerCount;
      connected += conn;
      bytes += dBytes;
      sent += dSent;
      skipped += dSkipped;
      dropped += matchDropped;
      perMatch.push({
        tick: s.nextTick,
        players: m.playerCount,
        tickWorkP50Ms: mw.p50,
        tickWorkP99Ms: mw.p99,
        tickLatenessP99Ms: lateness.p99,
        overruns: s.overruns,
        hitches: s.hitches,
        gcPauseMaxMs: 0,
        rssBytes,
        havokHeapBytes,
        inputsDropped: matchDropped,
        snapshotsSkipped: dSkipped,
        bytesOutPerPlayer: conn > 0 ? (dBytes * 1000) / windowMs / conn : 0,
      });
    }
    return {
      tick: s.nextTick,
      windowMs,
      matches: this.list.length,
      players,
      connected,
      work,
      lateness,
      overruns: s.overruns,
      hitches: s.hitches,
      bytesOutPerSec: (bytes * 1000) / windowMs,
      snapshotsPerSec: (sent * 1000) / windowMs,
      snapshotsSkipped: skipped,
      inputsDropped: dropped,
      rssBytes,
      perMatch,
    };
  }

  private readonly onTick = (tick: number): void => {
    const list = this.list;
    const clock = this.clock;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      const t0 = clock.now();
      e.match.tick(tick);
      e.work.add(clock.now() - t0);
    }
  };

  private readonly runPumps = (): void => {
    const pumps = this.pumps;
    for (let i = 0; i < pumps.length; i++) pumps[i]!();
  };
}
