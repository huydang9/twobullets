import { clampMaxPlayers, DEFAULT_MATCH_PLAYERS, DEFAULT_TEAM_MODE, TEAM_MODE_SIZE, teamCount, type DevJoinTokenResponse, type MatchConfig, type MatchToAgent, type TeamMode } from "@twobullets/contracts";
import { LinkConditioner, NETWORK_PROFILES, type Clock, type NetworkProfileName, type Session } from "@twobullets/netcode";
import { CONTENT_HASH, DisconnectReason, PROTOCOL_VERSION } from "@twobullets/protocol";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { createHash } from "node:crypto";
import { createDevClaims, DEV_JOIN_SECRET_DEFAULT, devHmacKey, JoinTokenVerifier, signDevJoinToken } from "./auth/joinToken";
import { LocalMatchHost, type HostMetrics } from "./host/LocalMatchHost";
import { arenaMatchLevel, resolveServerLevel } from "./level/serverLevel";
import type { BrLifecycleOptions } from "./match/BrLifecycle";
import type { ServerMatch } from "./match/ServerMatch";
import { SessionManager } from "./session/SessionManager";
import { startWsServer, type WsServerHandle } from "./transport/wsServer";

// Process wiring shared by main.ts and the localhost smoke test: Havok → host + matches → sessions → WS listener.
// `agent` mode (spawned by server-api, plan.md P3) starts with no match, no dev tokens and no HS256 key: the host agent
// pushes the JWKS and one `allocate` (see agent/MatchAgent.ts).

export type ServerMode = "local" | "single-match" | "packed" | "agent";

/** `sandbox`: M4 endless warmup (damage, respawns). `br`: the battle royale loop (always on in agent mode). */
export type MatchFlow = "sandbox" | "br";

export interface ServerOptions {
  readonly mode: ServerMode;
  readonly host: string;
  readonly port: number;
  /** Packed mode: matches on the one scheduler. */
  readonly matches?: number;
  readonly fakeNet?: NetworkProfileName | null;
  readonly devJoinSecret?: string;
  readonly resumeSecret?: string;
  readonly matchSeed?: number;
  /** 2..20 player slots (`--max-players`, default 10). */
  readonly maxPlayers?: number;
  /** `--team-mode` (default duo). */
  readonly teamMode?: TeamMode;
  /** Local modes: `--map` (default arena). */
  readonly mapId?: string;
  /** Local modes: `--flow` (default sandbox). */
  readonly flow?: MatchFlow;
  /** BR timings (`--warmup-seconds`, `--time-scale`, …); agent mode applies them to the allocated match. */
  readonly lifecycle?: BrLifecycleOptions;
  readonly clock?: Clock;
  readonly log?: (line: string) => void;
}

export interface RunningServer {
  readonly port: number;
  readonly host: LocalMatchHost;
  readonly sessions: SessionManager;
  readonly ws: WsServerHandle;
  readonly verifier: JoinTokenVerifier;
  /** Local modes: the matches created at boot. Agent mode: empty until allocation (see `host.matches`). */
  readonly matches: readonly ServerMatch[];
  readonly mode: ServerMode;
  /** Metrics for the last window; also sweeps Hello timeouts. Call once per second. */
  second(): HostMetrics;
  stop(): Promise<void>;
}

export const LOCAL_HOST_ID = "local-host";

export function localMatchConfig(matchId: string, matchSeed: number, maxPlayers: number = DEFAULT_MATCH_PLAYERS, teamMode: TeamMode = DEFAULT_TEAM_MODE): MatchConfig {
  return {
    matchId,
    hostId: LOCAL_HOST_ID,
    region: "local",
    protocolVersion: PROTOCOL_VERSION,
    contentHash: CONTENT_HASH,
    mapId: "arena",
    matchSeed: matchSeed >>> 0,
    maxPlayers: clampMaxPlayers(maxPlayers),
    maxTeamSize: TEAM_MODE_SIZE[teamMode],
    teamMode,
    teams: [],
    rules: { friendlyFire: true, reviveSeconds: 5, bodyBlocking: true, fillWithBots: true },
  };
}

const PERFORMANCE_CLOCK: Clock = { now: () => performance.now() };

/** `stop()`: how long sockets get to finish their close handshake before they are terminated, ms. */
export const STOP_CLOSE_GRACE_MS = 2000;

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const clock = options.clock ?? PERFORMANCE_CLOCK;
  const log = options.log ?? ((line: string) => console.log(line));
  const devSecret = options.devJoinSecret ?? DEV_JOIN_SECRET_DEFAULT;
  const resumeSecret = createHash("sha256").update(options.resumeSecret ?? `resume:${devSecret}:${process.pid}:${Date.now()}`).digest();
  const havok = await loadHavok();
  const agent = options.mode === "agent";
  const mapId = options.mapId ?? "arena";
  const level = agent || mapId === "arena" ? arenaMatchLevel() : await resolveServerLevel(mapId, { log });

  const host = new LocalMatchHost({
    mode: options.mode === "packed" ? "packed" : "single-match",
    hostId: agent ? "unallocated" : LOCAL_HOST_ID,
    clock,
    havok,
    level,
    resumeSecret,
    onPlayer: agent ? (_matchId, accountId, event) => sendToAgent({ t: "player", accountId, event }) : undefined,
    onHitch: (behind, tick) => log(`[sched] hitch: ${behind.toFixed(0)} ms behind at tick ${tick}`),
  });
  const count = agent ? 0 : options.mode === "packed" ? Math.max(1, options.matches ?? 2) : 1;
  const seed = options.matchSeed ?? 0x7b2b;
  const matches: ServerMatch[] = [];
  const lifecycle = options.flow === "br" ? (options.lifecycle ?? {}) : null;
  for (let i = 0; i < count; i++) {
    const config = { ...localMatchConfig(count === 1 ? "local" : `local-${i}`, seed + i, options.maxPlayers, options.teamMode), mapId };
    matches.push(host.createMatch(config, { lifecycle }));
  }
  await Promise.all(matches.map((m) => m.ready));

  // M3: dev HS256 tokens through the production verifier. Agent mode has no dev key: the host agent's JWKS (EdDSA) only.
  const verifier = new JoinTokenVerifier({ keys: agent ? [] : [devHmacKey(devSecret)], nowSec: () => Date.now() / 1000 });
  const sessions = new SessionManager({ directory: host, verifier, clock, log });

  const devTokens =
    options.mode === "single-match" || agent
      ? undefined
      : (sub: string, team: number, publicUrl: string): DevJoinTokenResponse => {
          const matchId = matches[0]!.id;
          const claims = createDevClaims({ sub, team, matchId, hostId: LOCAL_HOST_ID, protocolVersion: PROTOCOL_VERSION, contentHash: CONTENT_HASH, nowSec: Date.now() / 1000 });
          return { token: signDevJoinToken(claims, devSecret), matchId, url: `${publicUrl}/m/${matchId}`, expiresAt: claims.exp * 1000 };
        };

  let linkSeed = 1;
  const removers = new Map<Session, () => void>();
  const profile = options.fakeNet ? NETWORK_PROFILES[options.fakeNet] : null;
  const ws = await startWsServer({
    host: options.host,
    port: options.port,
    clock,
    sessions,
    devTokens,
    devTeamCount: teamCount(options.maxPlayers ?? DEFAULT_MATCH_PLAYERS, options.teamMode ?? DEFAULT_TEAM_MODE),
    log,
    wrapSession:
      profile === null
        ? undefined
        : (raw) => {
            // Server-side impairment of both directions (full RTT); keeps the inner transport kind.
            const lc = new LinkConditioner(raw, { up: profile.up, down: profile.down }, clock, linkSeed++);
            // Bytes "in flight" on the emulated link aren't a send queue: backpressure reads the real socket only.
            const session: Session = {
              kind: lc.kind,
              maxDatagramSize: lc.maxDatagramSize,
              sendDatagram: (b) => lc.sendDatagram(b),
              sendStream: (b) => lc.sendStream(b),
              onDatagram: (cb) => lc.onDatagram(cb),
              onStream: (cb) => lc.onStream(cb),
              queuedBytes: () => raw.queuedBytes(),
              close: (code) => lc.close(code),
            };
            removers.set(session, host.addPump(() => lc.pump()));
            return session;
          },
    onSessionClosed: (session) => {
      removers.get(session)?.();
      removers.delete(session);
    },
  });

  host.start();
  sendToAgent({ t: "ready", udpPort: 0, wsPort: ws.port });

  return {
    port: ws.port,
    host,
    sessions,
    ws,
    verifier,
    matches,
    mode: options.mode,
    second() {
      sessions.sweep(clock.now());
      return host.collectMetrics();
    },
    async stop() {
      await host.drain();
      sessions.closePending(DisconnectReason.serverShutdown);
      // Every session got Disconnect and a close frame; wait for the close handshakes (one round trip each, longer on a
      // real network or a busy tab) before anything is terminated, which the browser would report as 1006. Returns as
      // soon as the last socket closed.
      const deadline = Date.now() + STOP_CLOSE_GRACE_MS;
      while (ws.connectionCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      await ws.close();
    },
  };
}

let agentSendsPending = 0;

/** Host agent IPC (platform.md A8) when spawned with an IPC channel; a no-op otherwise. */
export function sendToAgent(message: MatchToAgent): void {
  if (typeof process.send !== "function" || !process.connected) return;
  agentSendsPending++;
  process.send(message, undefined, undefined, () => agentSendsPending--);
}

/** Waits until queued IPC messages are handed to the channel (call before `process.exit`). */
export async function flushAgentMessages(timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (agentSendsPending > 0 && process.connected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}
