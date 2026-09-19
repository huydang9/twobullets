import { BOT_ACCOUNT_PREFIX } from "@twobullets/contracts/claims";
import {
  BOT_DIFFICULTIES,
  DEFAULT_MATCH_PLAYERS,
  DEFAULT_TEAM_MODE,
  MAX_MATCH_PLAYERS,
  MIN_MATCH_PLAYERS,
  TEAM_MODE_SIZE,
  TEAM_MODES,
  teamCount,
  type BotDifficulty,
  type MatchConfig,
  type TeamAssignment,
  type TeamMode,
} from "@twobullets/contracts/match";
import type { CatalogResponse, MapInfo, MatchSettings } from "@twobullets/contracts/rest";
import { CONTENT_HASH, PROTOCOL_VERSION } from "@twobullets/protocol/version";

// The one place server-api turns lobby/queue settings into a `MatchConfig` (packages/contracts/src/match.ts, match-size
// contract: dense slots, slot = team · teamSize + member, last team may be partial, bots fill via rules.fillWithBots).

export const MAPS: readonly MapInfo[] = [
  { id: "v1", name: { vi: "Bản đồ v1", en: "Map v1" }, sizeM: 500, available: true, kind: "handmade" },
  { id: "arena", name: { vi: "Sân tập", en: "Arena" }, sizeM: 120, available: true, kind: "dev" },
  // Invented like Map v1: a 184 m maze of concrete, glass, mirror and hedge walls round a central watchtower.
  { id: "mazebr", name: { vi: "Mê Cung", en: "Maze" }, sizeM: 184, available: true, kind: "handmade" },
  // Real-world maps: the `<countryCode>-<place>` ids of packages/shared/src/map/real (the client's map picker and the
  // match server's level registry use the same ids).
  { id: "vn-hangxanh", name: { vi: "Ngã Tư Hàng Xanh", en: "Hang Xanh Junction (Vietnam)" }, sizeM: 500, available: true, kind: "realWorld" },
  // Shown as Phú Nhuận: the id keeps the street name the map was first generated under, so saved preferences, lobby
  // settings and the terrain seed stay valid. Player-visible names stay non-political (map/real/convert/names.ts).
  { id: "vn-phandangluu", name: { vi: "Phú Nhuận", en: "Phu Nhuan (Vietnam)" }, sizeM: 500, available: true, kind: "realWorld" },
];
export const DEFAULT_MAP_ID = "v1";

const MODE_NAMES: Record<TeamMode, { vi: string; en: string }> = {
  solo: { vi: "Đơn", en: "Solo" },
  duo: { vi: "Đôi", en: "Duo" },
  squad: { vi: "Tổ đội", en: "Squad" },
};

export function catalog(options: { queueStartAfterSec: number; inviteRequired: boolean }): CatalogResponse {
  return {
    modes: TEAM_MODES.map((mode) => ({ mode, teamSize: TEAM_MODE_SIZE[mode], name: MODE_NAMES[mode] })),
    minPlayers: MIN_MATCH_PLAYERS,
    maxPlayers: MAX_MATCH_PLAYERS,
    defaultPlayers: DEFAULT_MATCH_PLAYERS,
    defaultMode: DEFAULT_TEAM_MODE,
    maps: MAPS,
    defaultMapId: DEFAULT_MAP_ID,
    languages: ["vi", "en"],
    defaultLanguage: "vi",
    queueStartAfterSec: options.queueStartAfterSec,
    inviteRequired: options.inviteRequired,
  };
}

export function isTeamMode(value: unknown): value is TeamMode {
  return typeof value === "string" && (TEAM_MODES as readonly string[]).includes(value);
}

export type SettingsError = "mode" | "maxPlayers" | "mapId" | "fillWithBots" | "botDifficulty";

/** Validates client settings; missing optional fields take defaults. */
export function parseSettings(input: Partial<Record<keyof MatchSettings, unknown>>, base?: MatchSettings): MatchSettings | SettingsError {
  const mode = input.mode ?? base?.mode ?? DEFAULT_TEAM_MODE;
  if (!isTeamMode(mode)) return "mode";
  const maxPlayers = input.maxPlayers ?? base?.maxPlayers ?? DEFAULT_MATCH_PLAYERS;
  if (typeof maxPlayers !== "number" || !Number.isInteger(maxPlayers) || maxPlayers < MIN_MATCH_PLAYERS || maxPlayers > MAX_MATCH_PLAYERS) return "maxPlayers";
  const mapId = input.mapId ?? base?.mapId ?? DEFAULT_MAP_ID;
  if (typeof mapId !== "string" || !MAPS.some((m) => m.id === mapId && m.available)) return "mapId";
  const fillWithBots = input.fillWithBots ?? base?.fillWithBots ?? true;
  if (typeof fillWithBots !== "boolean") return "fillWithBots";
  const botDifficulty = input.botDifficulty ?? base?.botDifficulty;
  if (botDifficulty === undefined) return { mode, maxPlayers, mapId, fillWithBots };
  if (!isBotDifficulty(botDifficulty)) return "botDifficulty";
  return { mode, maxPlayers, mapId, fillWithBots, botDifficulty };
}

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return typeof value === "string" && (BOT_DIFFICULTIES as readonly string[]).includes(value);
}

export function teamsOf(settings: MatchSettings): { teamCount: number; teamSize: number } {
  return { teamCount: teamCount(settings.maxPlayers, settings.mode), teamSize: TEAM_MODE_SIZE[settings.mode] };
}

/** Seats in team `teamId` (the last team may be partial). */
export function teamCapacity(settings: MatchSettings, teamId: number): number {
  const { teamCount: count, teamSize } = teamsOf(settings);
  if (teamId < 0 || teamId >= count) return 0;
  return Math.min(teamSize, settings.maxPlayers - teamId * teamSize);
}

export interface SeatedPlayer {
  readonly accountId: string;
  readonly teamId: number;
}

export interface BuildMatchConfigInput {
  readonly matchId: string;
  readonly hostId: string;
  readonly region: string;
  readonly matchSeed: number;
  readonly settings: MatchSettings;
  readonly humans: readonly SeatedPlayer[];
  /** Lobby host: the only account the match server lets end the match for everyone. Omitted for quick-queue matches. */
  readonly hostAccountId?: string | undefined;
}

/**
 * Roster = humans on their teams, then (when `fillWithBots`) `bot:<n>` ids in every free seat, so the match process
 * knows exactly who may join and how many bots to spawn. Throws on an over-full team (callers seat within capacity).
 */
export function buildMatchConfig(input: BuildMatchConfigInput): MatchConfig {
  const { settings } = input;
  const { teamCount: count, teamSize } = teamsOf(settings);
  const teams: string[][] = Array.from({ length: count }, () => []);
  for (const h of input.humans) {
    const team = teams[h.teamId];
    if (team === undefined) throw new Error(`team ${h.teamId} out of range 0..${count - 1}`);
    if (team.length >= teamCapacity(settings, h.teamId)) throw new Error(`team ${h.teamId} is full`);
    team.push(h.accountId);
  }
  if (settings.fillWithBots) {
    let bot = 0;
    for (let t = 0; t < count; t++) {
      const cap = teamCapacity(settings, t);
      while (teams[t]!.length < cap) teams[t]!.push(`${BOT_ACCOUNT_PREFIX}${bot++}`);
    }
  }
  const assignments: TeamAssignment[] = [];
  teams.forEach((accountIds, teamId) => {
    if (accountIds.length > 0) assignments.push({ teamId, accountIds });
  });
  return {
    matchId: input.matchId,
    hostId: input.hostId,
    region: input.region,
    protocolVersion: PROTOCOL_VERSION,
    contentHash: CONTENT_HASH >>> 0,
    mapId: settings.mapId,
    matchSeed: input.matchSeed >>> 0,
    maxPlayers: settings.maxPlayers,
    maxTeamSize: teamSize,
    teamMode: settings.mode,
    teams: assignments,
    rules: { friendlyFire: true, reviveSeconds: 5, bodyBlocking: true, fillWithBots: settings.fillWithBots },
    ...(settings.botDifficulty !== undefined ? { botDifficulty: settings.botDifficulty } : {}),
    // Only a seated human can be the host; a stale id would leave the match with nobody able to end it.
    ...(input.hostAccountId !== undefined && input.humans.some((h) => h.accountId === input.hostAccountId) ? { hostAccountId: input.hostAccountId } : {}),
  };
}

/** Fill-style seating for strangers from the queue: team 0 first, then team 1, … */
export function seatInOrder(settings: MatchSettings, accountIds: readonly string[]): SeatedPlayer[] {
  const { teamCount: count } = teamsOf(settings);
  const out: SeatedPlayer[] = [];
  let team = 0;
  let used = 0;
  for (const accountId of accountIds) {
    while (team < count && used >= teamCapacity(settings, team)) {
      team++;
      used = 0;
    }
    if (team >= count) break;
    out.push({ accountId, teamId: team });
    used++;
  }
  return out;
}
