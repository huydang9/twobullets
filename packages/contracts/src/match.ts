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

/** Host-picked team mode; the team size is `TEAM_MODE_SIZE[mode]`. */
export type TeamMode = "solo" | "duo" | "squad";

export const TEAM_MODES: readonly TeamMode[] = ["solo", "duo", "squad"];
export const TEAM_MODE_SIZE: Readonly<Record<TeamMode, number>> = { solo: 1, duo: 2, squad: 4 };
export const MIN_MATCH_PLAYERS = 2;
/** Wire limit too: slots and team ids are 5-bit fields (protocol v3). */
export const MAX_MATCH_PLAYERS = 20;
export const DEFAULT_MATCH_PLAYERS = 10;
export const DEFAULT_TEAM_MODE: TeamMode = "duo";

// Slots are dense 0..maxPlayers-1 and slot = teamId · teamSize + member, so the last team may be partial (10 players
// in squads = 4, 4, 2). Mirrored in @twobullets/shared/match/teams (shared can't import this package).

/** Teams in a match: ceil(maxPlayers / team size). */
export function teamCount(maxPlayers: number, mode: TeamMode): number {
  return Math.ceil(clampMaxPlayers(maxPlayers) / TEAM_MODE_SIZE[mode]);
}
export function teamOfSlot(slot: number, teamSize: number): number {
  return Math.floor(slot / teamSize);
}
export function memberOfSlot(slot: number, teamSize: number): number {
  return slot % teamSize;
}
export function slotOf(teamId: number, member: number, teamSize: number): number {
  return teamId * teamSize + member;
}
export function clampMaxPlayers(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_MATCH_PLAYERS, Math.max(MIN_MATCH_PLAYERS, Math.round(n))) : DEFAULT_MATCH_PLAYERS;
}
/** Mode of a team size (1 solo, 2 duo, 4 squad); null for other sizes. */
export function teamModeOfSize(size: number): TeamMode | null {
  return size === 1 ? "solo" : size === 2 ? "duo" : size === 4 ? "squad" : null;
}
/** `config.teamMode`, else derived from `maxTeamSize` (duo when that is not 1/2/4). */
export function matchTeamMode(config: Pick<MatchConfig, "teamMode" | "maxTeamSize">): TeamMode {
  return config.teamMode ?? teamModeOfSize(config.maxTeamSize) ?? DEFAULT_TEAM_MODE;
}

export interface TeamAssignment {
  /** 0..teamCount-1 (up to 19 in solo). */
  readonly teamId: number;
  /** 1..team size account ids; bots use `bot:<n>` ids. */
  readonly accountIds: readonly string[];
}

/** Server bot tuning (mirrors @twobullets/shared/bots `BotDifficulty`). */
export type BotDifficulty = "easy" | "normal" | "hard";
export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ["easy", "normal", "hard"];
export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = "normal";

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
  /** MIN_MATCH_PLAYERS..MAX_MATCH_PLAYERS; slots are 0..maxPlayers-1. */
  readonly maxPlayers: number;
  /** = TEAM_MODE_SIZE[teamMode]. */
  readonly maxTeamSize: number;
  /** Absent in older configs: derive with `matchTeamMode`. Bots fill empty slots when `rules.fillWithBots`. */
  readonly teamMode?: TeamMode;
  readonly teams: readonly TeamAssignment[];
  readonly rules: MatchRules;
  /** Server bots (`bot:<n>` seats and `rules.fillWithBots` fills). Absent = DEFAULT_BOT_DIFFICULTY. */
  readonly botDifficulty?: BotDifficulty;
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
 * `GET /dev/token?sub=<accountId>&team=<0..teamCount-1>` on a match server started with `--mode=local` (M3 dev only; production
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
