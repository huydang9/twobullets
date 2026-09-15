import { TEAM_MODE_SIZE, teamCount, type JoinClaims, type MatchConfig, type MatchPhase, type MatchResult, type TeamMode } from "@twobullets/contracts";
import { createMemorySessionPair, LinkConditioner, ManualClock, NETWORK_PROFILES, type MemorySession, type NetworkProfile, type Session } from "@twobullets/netcode";
import { CONTENT_HASH, PROTOCOL_VERSION, type Mutable, type OwnerMoveBlock } from "@twobullets/protocol";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import type { HavokModule } from "@twobullets/sim";
import { localMatchConfig, LOCAL_HOST_ID } from "../src/app";
import { createDevClaims, devHmacKey, JoinTokenVerifier, signDevJoinToken } from "../src/auth/joinToken";
import { HeadlessClient } from "../src/dev/HeadlessClient";
import { LocalMatchHost } from "../src/host/LocalMatchHost";
import type { ServerMatch, ServerMatchOptions } from "../src/match/ServerMatch";
import type { BrLifecycleOptions } from "../src/match/BrLifecycle";
import type { MatchLevel } from "../src/level/serverLevel";
import { SessionManager } from "../src/session/SessionManager";
import { createOwnerBlock } from "@twobullets/netcode/replication";

// In-process server + clients on a virtual clock: memory Session pairs wrapped in LinkConditioners (netcode.md §11.3).

export const SECRET = "harness-secret";
/** Unix seconds at virtual time 0. */
const EPOCH_SEC = 1_800_000_000;

export interface Harness {
  readonly clock: ManualClock;
  readonly host: LocalMatchHost;
  readonly match: ServerMatch;
  readonly sessions: SessionManager;
  readonly clients: HeadlessClient[];
  readonly links: LinkConditioner[];
  readonly serverEnds: DeferredCloseSession[];
  /** Server owner blocks recorded at the end of every tick, keyed `tick * 32 + slot`. */
  readonly ownerHistory: Map<number, OwnerMoveBlock>;
  /** Lifecycle phases reported by the match (onPhase), results (onResult) and whether it closed. */
  readonly lifecyclePhases: MatchPhase[];
  readonly results: MatchResult[];
  readonly closed: { value: boolean };
  token(overrides?: Partial<JoinClaims> & { secret?: string }): string;
  connect(options?: { token?: string; profile?: NetworkProfile; seed?: number; protocolVersion?: number; leadTicks?: number; team?: number; interpDelayMs?: number }): HeadlessClient;
  run(ms: number, stepMs?: number): void;
  /** Accepts a bare memory session (no client attached), e.g. one that never sends Hello. */
  acceptRaw(session: MemorySession): void;
  dispose(): Promise<void>;
}

let subCounter = 0;

/**
 * Server end adapter: memory sessions close synchronously, which would drop a Disconnect queued in the same delivery
 * turn. Real transports flush sends before closing, so closes here run on the harness's next step.
 */
class DeferredCloseSession implements Session {
  readonly inner: MemorySession;
  private readonly pending: (() => void)[];
  constructor(inner: MemorySession, pending: (() => void)[]) {
    this.inner = inner;
    this.pending = pending;
  }
  get kind() {
    return this.inner.kind;
  }
  get maxDatagramSize() {
    return this.inner.maxDatagramSize;
  }
  get closed() {
    return this.inner.closed;
  }
  sendDatagram(bytes: Uint8Array) {
    return this.inner.sendDatagram(bytes);
  }
  sendStream(bytes: Uint8Array) {
    this.inner.sendStream(bytes);
  }
  onDatagram(cb: (bytes: Uint8Array, recvTimeMs: number) => void) {
    this.inner.onDatagram(cb);
  }
  onStream(cb: (bytes: Uint8Array) => void) {
    this.inner.onStream(cb);
  }
  queuedBytes() {
    return this.inner.queuedBytes();
  }
  close(code: number) {
    this.pending.push(() => this.inner.close(code));
  }
}

export interface HarnessOptions {
  readonly recordOwners?: boolean;
  /** Runs after the owner recording at the end of every tick. */
  readonly onTickEnd?: (tick: number, match: ServerMatch) => void;
  readonly combat?: ServerMatchOptions["combat"];
  /** Match size and mode (default 10 duo). With a mode, default tokens fill teams in order (team = floor(i / size)). */
  readonly maxPlayers?: number;
  readonly teamMode?: TeamMode;
  /** Battle royale loop (default: M4 sandbox). */
  readonly lifecycle?: BrLifecycleOptions;
  /** Default: the arena. */
  readonly level?: MatchLevel;
  /** Edits the local match config (roster, rules). */
  readonly configure?: (config: MatchConfig) => MatchConfig;
}

export async function createHarness(havok: HavokModule, options: HarnessOptions = {}): Promise<Harness> {
  const clock = new ManualClock(10_000);
  const ownerHistory = new Map<number, OwnerMoveBlock>();
  const scratch: Mutable<OwnerMoveBlock> = createOwnerBlock();
  const host = new LocalMatchHost({
    mode: "single-match",
    hostId: LOCAL_HOST_ID,
    clock,
    havok,
    level: ARENA_LEVEL,
    resumeSecret: Buffer.alloc(32, 7),
    match: {
      combat: options.combat,
      onTickEnd:
        options.recordOwners || options.onTickEnd
          ? (tick, m) => {
              if (options.recordOwners) {
                for (const p of m.players) {
                  if (m.ownerBlockOf(p.slot, scratch)) ownerHistory.set(tick * 32 + p.slot, { ...scratch });
                }
              }
              options.onTickEnd?.(tick, m);
            }
          : undefined,
    },
  });
  const lifecyclePhases: MatchPhase[] = [];
  const results: MatchResult[] = [];
  const closed = { value: false };
  const baseConfig = localMatchConfig("local", 1234, options.maxPlayers, options.teamMode);
  const match = host.createMatch(options.configure ? options.configure(baseConfig) : baseConfig, {
    lifecycle: options.lifecycle ?? null,
    ...(options.level ? { level: options.level } : {}),
    onPhase: (phase) => lifecyclePhases.push(phase),
    onResult: (result) => results.push(result),
    onClosed: () => (closed.value = true),
  });
  await match.ready;
  const verifier = new JoinTokenVerifier({ keys: [devHmacKey(SECRET)], nowSec: () => EPOCH_SEC + clock.now() / 1000 });
  const sessions = new SessionManager({ directory: host, verifier, clock });
  host.start(false);

  const clients: HeadlessClient[] = [];
  const links: LinkConditioner[] = [];
  const serverEnds: DeferredCloseSession[] = [];
  const pendingCloses: (() => void)[] = [];

  const harness: Harness = {
    clock,
    host,
    match,
    sessions,
    clients,
    links,
    serverEnds,
    ownerHistory,
    lifecyclePhases,
    results,
    closed,
    token(overrides = {}) {
      const { secret, ...claimOverrides } = overrides;
      const base = createDevClaims({
        sub: `player-${++subCounter}`,
        team: options.teamMode ? Math.floor(clients.length / TEAM_MODE_SIZE[options.teamMode]) % teamCount(options.maxPlayers ?? 10, options.teamMode) : clients.length % 5,
        matchId: "local",
        hostId: LOCAL_HOST_ID,
        protocolVersion: PROTOCOL_VERSION,
        contentHash: CONTENT_HASH,
        nowSec: EPOCH_SEC + clock.now() / 1000,
      });
      return signDevJoinToken({ ...base, ...claimOverrides }, secret ?? SECRET);
    },
    connect(o = {}) {
      const [clientEnd, rawServerEnd] = createMemorySessionPair({ clock, kind: "webtransport", maxDatagramSize: 1200 });
      const serverEnd = new DeferredCloseSession(rawServerEnd, pendingCloses);
      const link = new LinkConditioner(clientEnd, o.profile ?? NETWORK_PROFILES.lan, clock, o.seed ?? clients.length + 1);
      sessions.accept(serverEnd, { pathMatchId: "local" });
      const client = new HeadlessClient({
        session: link,
        clock,
        token: o.token ?? harness.token(o.team !== undefined ? { team: o.team } : {}),
        seed: o.seed ?? 100 + clients.length,
        leadTicks: o.leadTicks ?? 3,
        protocolVersion: o.protocolVersion,
        interpDelayMs: o.interpDelayMs,
      });
      clients.push(client);
      links.push(link);
      serverEnds.push(serverEnd);
      client.hello();
      return client;
    },
    run(ms, stepMs = 1) {
      for (let t = 0; t < ms; t += stepMs) {
        clock.advance(stepMs);
        while (pendingCloses.length > 0) pendingCloses.shift()!();
        for (const l of links) l.pump();
        host.scheduler.pump();
        for (const c of clients) c.update();
        for (const l of links) l.pump();
      }
      sessions.sweep(clock.now());
      while (pendingCloses.length > 0) pendingCloses.shift()!();
    },
    acceptRaw(session) {
      return sessions.accept(new DeferredCloseSession(session, pendingCloses));
    },
    async dispose() {
      await host.drain();
    },
  };
  return harness;
}
