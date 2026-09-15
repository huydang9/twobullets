import { clampMaxPlayers, DEFAULT_BOT_DIFFICULTY, DEFAULT_MATCH_PLAYERS, DEFAULT_TEAM_MODE, parseTeamMode, TEAM_MODE_SIZE, teamCount, TEAM_MODES, type BotDifficulty, type TeamMode } from "@twobullets/shared";

// URL flags of the offline bot match (docs/bots/design.md §11).

export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ["easy", "normal", "hard"];
/** Match sizes offered on the play overlay (any 2..20 works through `&players=`). */
export const MATCH_SIZE_PRESETS: readonly number[] = [10, 16, 20];
export { TEAM_MODES };

export interface OfflineMatchOptions {
  /** `?bots=1`: offline match on Map v1. */
  readonly enabled: boolean;
  /** `&difficulty=easy|normal|hard` (default normal); the play overlay can change it before the start. */
  readonly difficulty: BotDifficulty;
  /** `&seed=<u32>`; null = random (printed to the console). */
  readonly seed: number | null;
  /** `&players=2..20` (default 10); bots fill every slot the human doesn't take. */
  readonly maxPlayers: number;
  /** `&mode=solo|duo|squad` (default duo). */
  readonly teamMode: TeamMode;
  /** Teams: ceil(maxPlayers / team size). Legacy `&teams=2..5` sets maxPlayers = teams × size when `players` is absent. */
  readonly teams: number;
  /** `&teammate=bot|none` (default bot). */
  readonly teammate: boolean;
  /** DEV `&zoneScale=0.25`: time scale of the zone and phase timings. */
  readonly zoneScale: number;
  /** DEV `&botDebug=1`: labels, paths, perception rays, rig hitboxes (F7 toggles). */
  readonly botDebug: boolean;
  /** DEV `&spectate=1`: bots-only match with a follow camera ([ ] cycle). */
  readonly spectate: boolean;
  /** DEV `&botsPassive=1`: bots never fire. */
  readonly botsPassive: boolean;
  /**
   * DEV `&matchTrace=1`: breadcrumbs of the start path and the first frames/ticks in `localStorage["tb.matchTrace"]`
   * (survives a hung tab: reload and read it) plus console warnings for slow steps.
   */
  readonly trace: boolean;
  /** DEV `&matchSkip=bodies,hud,fx,wall,equipment,sim`: turns match client parts off to bisect a problem. */
  readonly skip: ReadonlySet<string>;
}

export function readOfflineMatchOptions(search: string, dev: boolean = import.meta.env.DEV): OfflineMatchOptions {
  const params = new URLSearchParams(search);
  const difficulty = params.get("difficulty");
  const seed = params.get("seed");
  const teams = Number(params.get("teams"));
  const zoneScale = Number(params.get("zoneScale"));
  const teamMode = parseTeamMode(params.get("mode")) ?? DEFAULT_TEAM_MODE;
  const players = Number(params.get("players"));
  const maxPlayers = params.get("players") !== null && Number.isInteger(players)
    ? clampMaxPlayers(players)
    : Number.isInteger(teams) && teams >= 2 && teams <= 20
      ? clampMaxPlayers(teams * TEAM_MODE_SIZE[teamMode])
      : DEFAULT_MATCH_PLAYERS;
  return {
    enabled: params.get("bots") === "1",
    difficulty: BOT_DIFFICULTIES.includes(difficulty as BotDifficulty) ? (difficulty as BotDifficulty) : DEFAULT_BOT_DIFFICULTY,
    seed: seed !== null && /^\d+$/.test(seed) ? Number(seed) >>> 0 : null,
    maxPlayers,
    teamMode,
    teams: teamCount(maxPlayers, teamMode),
    teammate: params.get("teammate") !== "none",
    zoneScale: dev && zoneScale > 0 && zoneScale <= 10 ? zoneScale : 1,
    botDebug: dev && params.get("botDebug") === "1",
    spectate: dev && params.get("spectate") === "1",
    botsPassive: dev && params.get("botsPassive") === "1",
    trace: dev && params.get("matchTrace") === "1",
    skip: new Set(dev ? (params.get("matchSkip") ?? "").split(",").filter(Boolean) : []),
  };
}

/** Reloads the page into a fresh match: same flags, the chosen difficulty and size, a new random seed. */
export function reloadNewMatch(difficulty: BotDifficulty, size?: { readonly maxPlayers: number; readonly teamMode: TeamMode }): void {
  const url = new URL(window.location.href);
  url.searchParams.set("difficulty", difficulty);
  if (size) writeMatchSize(url, size.maxPlayers, size.teamMode);
  url.searchParams.delete("seed");
  window.location.assign(url.toString());
}

/** Writes `players` and `mode` (dropping the legacy `teams`) so a reload keeps the picked size. */
export function writeMatchSize(url: URL, maxPlayers: number, teamMode: TeamMode): void {
  url.searchParams.set("players", String(maxPlayers));
  url.searchParams.set("mode", teamMode);
  url.searchParams.delete("teams");
}
