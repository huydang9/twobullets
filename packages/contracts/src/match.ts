// Match-level contracts shared by server-match, the host agent, server-api and bots. Plain JSON-serializable data;
// this package imports nothing (ADR 0005).

/**
 * Server lifecycle (platform.md §3.1) with the gameplay phase names of C23 (`LandingSelect`, `Glide` ends when all
 * players have landed or at the 90 s cap).
 */
export type MatchPhase =
  | "Booting"
  | "Idle"
  | "Allocated"
  | "Warmup"
  | "LandingSelect"
  | "Glide"
  | "Combat"
  | "Ended"
  | "Reporting"
  | "Cancelled"
  | "Crashed"
  | "Exited";

/** The gameplay subset sent to clients (`PhaseChange`); `End` is the lifecycle's `Ended`. */
export type GameplayPhase = "Warmup" | "LandingSelect" | "Glide" | "Combat" | "End";

export interface TeamAssignment {
  /** 0..4 */
  readonly teamId: number;
  /** 1–2 account ids; bots use `bot:<n>` ids. */
  readonly accountIds: readonly string[];
}

export interface MatchRules {
  readonly friendlyFire: boolean;
  /** Knocked players are revived by a teammate in this many seconds; 0 disables knock-down. */
  readonly reviveSeconds: number;
  readonly bodyBlocking: boolean;
  /** Fill empty slots with lobby bots. */
  readonly fillWithBots: boolean;
}

export interface MatchConfig {
  readonly matchId: string;
  readonly hostId: string;
  readonly region: string;
  /** Exact compat key the process must run (D10). */
  readonly protocolVersion: number;
  readonly contentHash: number;
  readonly mapId: string;
  /** u32; seeds loot and spawn layout. */
  readonly matchSeed: number;
  readonly maxPlayers: number;
  readonly maxTeamSize: number;
  readonly teams: readonly TeamAssignment[];
  readonly rules: MatchRules;
}

/** Join JWT claims (ADR 0106, D17). Verified offline against cached JWKS; the header carries `kid`. */
export interface JoinClaims {
  readonly iss: string;
  readonly aud: "match";
  /** Account id. */
  readonly sub: string;
  /** Match id. */
  readonly mid: string;
  /** Host or allocation id. */
  readonly hid: string;
  readonly team: number;
  /** Protocol version. */
  readonly pv: number;
  /** Content hash (C13). */
  readonly ch: number;
  /** Increments on each re-issue for (sub, mid); a newer epoch evicts the older connection. */
  readonly epoch: number;
  /** Issued for a reconnect. */
  readonly rc: boolean;
  /** Single-use, 128-bit random. */
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

/** Periodic match metrics (D20); no per-match labels upstream. */
export interface MatchMetrics {
  readonly tick: number;
  readonly players: number;
  readonly tickWorkP50Ms: number;
  readonly tickWorkP99Ms: number;
  readonly tickLatenessP99Ms: number;
  readonly overruns: number;
  readonly hitches: number;
  readonly gcPauseMaxMs: number;
  readonly rssBytes: number;
  readonly havokHeapBytes: number;
  readonly inputsDropped: number;
  readonly snapshotsSkipped: number;
  readonly bytesOutPerPlayer: number;
}

export interface PlayerResult {
  readonly accountId: string;
  readonly teamId: number;
  readonly bot: boolean;
  /** 1 = winning team. */
  readonly placement: number;
  readonly kills: number;
  readonly knocks: number;
  readonly revives: number;
  readonly damageDealt: number;
  readonly survivedMs: number;
}

export interface MatchResult {
  readonly matchId: string;
  readonly protocolVersion: number;
  readonly contentHash: number;
  readonly outcome: "completed" | "cancelled" | "aborted";
  /** Epoch ms. */
  readonly startedAt: number;
  readonly endedAt: number;
  readonly winningTeamId: number | null;
  readonly players: readonly PlayerResult[];
}

/**
 * `GET /dev/token?sub=<accountId>&team=<0..4>` on a match server started with `--mode=local` (M3 dev only; production
 * tokens come from server-api). The token is a single-use join JWT; fetch a new one for every connect.
 */
export interface DevJoinTokenResponse {
  readonly token: string;
  readonly matchId: string;
  /** WebSocket URL to connect to, e.g. `ws://localhost:7350/m/local`. */
  readonly url: string;
  /** Epoch ms. */
  readonly expiresAt: number;
}
