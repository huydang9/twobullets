import { clampMaxPlayers, DEFAULT_MATCH_PLAYERS, DEFAULT_TEAM_MODE, TEAM_MODES, type TeamMode } from "@twobullets/contracts/match";
import type { BotDifficulty } from "@twobullets/shared";
import { browserStorage, type KeyValueStorage } from "../platform/SessionStore";

// Last choices on the menu (quick play, new lobbies, offline practice), so the next visit starts from them.

export const DIFFICULTIES: readonly BotDifficulty[] = ["easy", "normal", "hard"];
export const SIZE_PRESETS: readonly number[] = [10, 16, 20];

export interface MenuPreferences {
  readonly mode: TeamMode;
  readonly players: number;
  /** Networked lobbies. */
  readonly mapId: string;
  readonly fillWithBots: boolean;
  readonly practiceDifficulty: BotDifficulty;
  readonly practiceMode: TeamMode;
  readonly practicePlayers: number;
  readonly practiceMapId: string;
}

export const DEFAULT_PREFERENCES: MenuPreferences = {
  mode: DEFAULT_TEAM_MODE,
  players: DEFAULT_MATCH_PLAYERS,
  mapId: "v1",
  fillWithBots: true,
  practiceDifficulty: "normal",
  practiceMode: DEFAULT_TEAM_MODE,
  practicePlayers: DEFAULT_MATCH_PLAYERS,
  practiceMapId: "v1",
};

const KEY = "tb.menu.prefs";

export function parsePreferences(raw: string | null): MenuPreferences {
  let saved: Partial<Record<keyof MenuPreferences, unknown>> = {};
  try {
    saved = raw ? (JSON.parse(raw) as typeof saved) : {};
  } catch {
    saved = {};
  }
  const mode = (value: unknown, fallback: TeamMode): TeamMode => (TEAM_MODES.includes(value as TeamMode) ? (value as TeamMode) : fallback);
  const players = (value: unknown, fallback: number): number => (typeof value === "number" ? clampMaxPlayers(value) : fallback);
  const id = (value: unknown, fallback: string): string => (typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value) ? value : fallback);
  const d = DEFAULT_PREFERENCES;
  return {
    mode: mode(saved.mode, d.mode),
    players: players(saved.players, d.players),
    mapId: id(saved.mapId, d.mapId),
    fillWithBots: typeof saved.fillWithBots === "boolean" ? saved.fillWithBots : d.fillWithBots,
    practiceDifficulty: DIFFICULTIES.includes(saved.practiceDifficulty as BotDifficulty) ? (saved.practiceDifficulty as BotDifficulty) : d.practiceDifficulty,
    practiceMode: mode(saved.practiceMode, d.practiceMode),
    practicePlayers: players(saved.practicePlayers, d.practicePlayers),
    practiceMapId: id(saved.practiceMapId, d.practiceMapId),
  };
}

export class PreferenceStore {
  private value: MenuPreferences;
  private readonly storage: KeyValueStorage | null;

  constructor(storage: KeyValueStorage | null = browserStorage("local")) {
    this.storage = storage;
    let raw: string | null = null;
    try {
      raw = storage?.getItem(KEY) ?? null;
    } catch {
      raw = null;
    }
    this.value = parsePreferences(raw);
  }

  get current(): MenuPreferences {
    return this.value;
  }

  update(patch: Partial<MenuPreferences>): MenuPreferences {
    this.value = { ...this.value, ...patch };
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.value));
    } catch {
      // Memory only.
    }
    return this.value;
  }
}
