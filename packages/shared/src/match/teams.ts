// Match size and team modes (mirror of @twobullets/contracts match.ts, which this package can't import). The host
// picks 2..20 players and solo (1) / duo (2) / squad (4); bots fill empty slots. Slots are dense 0..maxPlayers-1 with
// slot = team · teamSize + member, so the last team may be partial (10 players in squads = 4, 4, 2).

export type TeamMode = "solo" | "duo" | "squad";

export const TEAM_MODES: readonly TeamMode[] = ["solo", "duo", "squad"];
export const TEAM_MODE_SIZE: Readonly<Record<TeamMode, number>> = { solo: 1, duo: 2, squad: 4 };
export const MIN_MATCH_PLAYERS = 2;
/** Also the wire limit (5-bit slot and team fields). */
export const MAX_MATCH_PLAYERS = 20;
export const DEFAULT_MATCH_PLAYERS = 10;
export const DEFAULT_TEAM_MODE: TeamMode = "duo";

export function clampMaxPlayers(n: number): number {
  return Number.isFinite(n) ? Math.min(MAX_MATCH_PLAYERS, Math.max(MIN_MATCH_PLAYERS, Math.round(n))) : DEFAULT_MATCH_PLAYERS;
}

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

/** Members of `team` in a match of `maxPlayers` (the last team may be short). */
export function teamMembers(team: number, teamSize: number, maxPlayers: number): number {
  return Math.max(0, Math.min(teamSize, maxPlayers - team * teamSize));
}

export function teamModeOfSize(size: number): TeamMode | null {
  return size === 1 ? "solo" : size === 2 ? "duo" : size === 4 ? "squad" : null;
}

export function parseTeamMode(value: string | null | undefined): TeamMode | null {
  return value === "solo" || value === "duo" || value === "squad" ? value : null;
}
