import { DEFAULT_BOT_DIFFICULTY, type BotDifficulty } from "@twobullets/shared";

// URL flags of the offline bot match (docs/bots/design.md §11).

export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ["easy", "normal", "hard"];

export interface OfflineMatchOptions {
  /** `?bots=1`: offline match on Map v1. */
  readonly enabled: boolean;
  /** `&difficulty=easy|normal|hard` (default normal); the play overlay can change it before the start. */
  readonly difficulty: BotDifficulty;
  /** `&seed=<u32>`; null = random (printed to the console). */
  readonly seed: number | null;
  /** `&teams=2..5` (default 5). */
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
  return {
    enabled: params.get("bots") === "1",
    difficulty: BOT_DIFFICULTIES.includes(difficulty as BotDifficulty) ? (difficulty as BotDifficulty) : DEFAULT_BOT_DIFFICULTY,
    seed: seed !== null && /^\d+$/.test(seed) ? Number(seed) >>> 0 : null,
    teams: Number.isInteger(teams) && teams >= 2 && teams <= 5 ? teams : 5,
    teammate: params.get("teammate") !== "none",
    zoneScale: dev && zoneScale > 0 && zoneScale <= 10 ? zoneScale : 1,
    botDebug: dev && params.get("botDebug") === "1",
    spectate: dev && params.get("spectate") === "1",
    botsPassive: dev && params.get("botsPassive") === "1",
    trace: dev && params.get("matchTrace") === "1",
    skip: new Set(dev ? (params.get("matchSkip") ?? "").split(",").filter(Boolean) : []),
  };
}

/** Reloads the page into a fresh match: same flags, the chosen difficulty, a new random seed. */
export function reloadNewMatch(difficulty: BotDifficulty): void {
  const url = new URL(window.location.href);
  url.searchParams.set("difficulty", difficulty);
  url.searchParams.delete("seed");
  window.location.assign(url.toString());
}
