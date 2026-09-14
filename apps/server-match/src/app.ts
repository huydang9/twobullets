import type { DevJoinTokenResponse, MatchConfig, MatchToAgent } from "@twobullets/contracts";
import { LinkConditioner, NETWORK_PROFILES, type Clock, type NetworkProfileName, type Session } from "@twobullets/netcode";
import { CONTENT_HASH, PROTOCOL_VERSION } from "@twobullets/protocol";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { createHash } from "node:crypto";
import { createDevClaims, DEV_JOIN_SECRET_DEFAULT, devHmacKey, JoinTokenVerifier, signDevJoinToken } from "./auth/joinToken";
import { LocalMatchHost, type HostMetrics } from "./host/LocalMatchHost";
import type { ServerMatch } from "./match/ServerMatch";
import { SessionManager } from "./session/SessionManager";
import { startWsServer, type WsServerHandle } from "./transport/wsServer";

// Process wiring shared by main.ts and the localhost smoke test: Havok → host + matches → sessions → WS listener.

export type ServerMode = "local" | "single-match" | "packed";

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
  readonly clock?: Clock;
  readonly log?: (line: string) => void;
}

export interface RunningServer {
  readonly port: number;
  readonly host: LocalMatchHost;
  readonly sessions: SessionManager;
  readonly ws: WsServerHandle;
  readonly matches: readonly ServerMatch[];
  /** Metrics for the last window; also sweeps Hello timeouts. Call once per second. */
  second(): HostMetrics;
  stop(): Promise<void>;
}

export const LOCAL_HOST_ID = "local-host";

export function localMatchConfig(matchId: string, matchSeed: number): MatchConfig {
  return {
    matchId,
    hostId: LOCAL_HOST_ID,
    region: "local",
    protocolVersion: PROTOCOL_VERSION,
    contentHash: CONTENT_HASH,
    mapId: "arena",
    matchSeed: matchSeed >>> 0,
    maxPlayers: 10,
    maxTeamSize: 2,
    teams: [],
    rules: { friendlyFire: true, reviveSeconds: 5, bodyBlocking: true, fillWithBots: true },
  };
}

const PERFORMANCE_CLOCK: Clock = { now: () => performance.now() };

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const clock = options.clock ?? PERFORMANCE_CLOCK;
  const log = options.log ?? ((line: string) => console.log(line));
  const devSecret = options.devJoinSecret ?? DEV_JOIN_SECRET_DEFAULT;
  const resumeSecret = createHash("sha256").update(options.resumeSecret ?? `resume:${devSecret}:${process.pid}:${Date.now()}`).digest();
  const havok = await loadHavok();

  const host = new LocalMatchHost({
    mode: options.mode === "packed" ? "packed" : "single-match",
    hostId: LOCAL_HOST_ID,
    clock,
    havok,
    level: ARENA_LEVEL,
    resumeSecret,
    onHitch: (behind, tick) => log(`[sched] hitch: ${behind.toFixed(0)} ms behind at tick ${tick}`),
  });
  const count = options.mode === "packed" ? Math.max(1, options.matches ?? 2) : 1;
  const seed = options.matchSeed ?? 0x7b2b;
  const matches: ServerMatch[] = [];
  for (let i = 0; i < count; i++) matches.push(host.createMatch(localMatchConfig(count === 1 ? "local" : `local-${i}`, seed + i)));
  await Promise.all(matches.map((m) => m.ready));

  // M3: dev HS256 tokens through the production verifier. Production adds the agent's JWKS (EdDSA keys) via setKeys.
  const verifier = new JoinTokenVerifier({ keys: [devHmacKey(devSecret)], nowSec: () => Date.now() / 1000 });
  const sessions = new SessionManager({ directory: host, verifier, clock, log });

  const devTokens =
    options.mode === "single-match"
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
    matches,
    second() {
      sessions.sweep(clock.now());
      return host.collectMetrics();
    },
    async stop() {
      await host.drain();
      // Let the Disconnect frames and close handshakes flush before sockets are terminated.
      const deadline = Date.now() + 250;
      while (ws.connectionCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      await ws.close();
    },
  };
}

/** Host agent IPC (platform.md A8) when spawned with an IPC channel; a no-op otherwise. */
export function sendToAgent(message: MatchToAgent): void {
  if (typeof process.send === "function") process.send(message);
}
