import type { TeamMode } from "@twobullets/contracts/match";
import type { AccountView, JoinMatchResponse } from "@twobullets/contracts/rest";
import type { BotDifficulty } from "@twobullets/shared";
import type { IssuedJoinToken } from "../platform/joinToken";

// How the menu hands over to the game. Game.create still reads its mode from URL flags, so a networked launch writes
// `?net=<wsUrl>&netId=<account>&team=<n>&map=<id>` for the synchronous start of Game.create and puts the menu URL back
// right after (a reload then lands on the menu, which offers "Rejoin"). README-wiring.md has the Game.ts option that
// replaces this shim and enables networked play and practice in production builds.

/** Query params that don't start the game by themselves. */
const MENU_PARAMS = new Set(["lang"]);

/** The menu is the entry point unless the URL carries game flags (`?map=`, `?bots=1`, `?net=`, `?bench=`, …). */
export function shouldShowMenu(search: string): boolean {
  for (const key of new URLSearchParams(search).keys()) if (!MENU_PARAMS.has(key)) return false;
  return true;
}

export interface PracticeSettings {
  readonly difficulty: BotDifficulty;
  readonly mode: TeamMode;
  readonly players: number;
  readonly mapId: string;
}

/** Offline bot match flags (match/options.ts), keeping `?lang=`. */
export function practiceSearch(currentSearch: string, settings: PracticeSettings): string {
  const params = new URLSearchParams();
  params.set("bots", "1");
  params.set("players", String(settings.players));
  params.set("mode", settings.mode);
  params.set("difficulty", settings.difficulty);
  params.set("map", settings.mapId);
  const lang = new URLSearchParams(currentSearch).get("lang");
  if (lang) params.set("lang", lang);
  return `?${params.toString()}`;
}

export interface MatchLaunch {
  readonly join: JoinMatchResponse;
  /** The lobby's map. Networked matches may still run the arena until server-match loads maps. */
  readonly mapId: string;
  readonly account: AccountView;
  /** Join tokens for this match: the first is `join`, rejoins fetch fresh ones. */
  readonly tokens: () => Promise<IssuedJoinToken>;
}

/** The dev net flags Game.create reads (net/NetGame.ts `readNetConfig`). */
export function netLaunchSearch(currentSearch: string, launch: MatchLaunch): string {
  const params = new URLSearchParams();
  params.set("net", launch.join.wsUrl);
  params.set("netId", launch.account.id);
  params.set("team", String(launch.join.teamId));
  params.set("map", launch.mapId);
  const lang = new URLSearchParams(currentSearch).get("lang");
  if (lang) params.set("lang", lang);
  return `?${params.toString()}`;
}

/** Path of the menu (no flags except `?lang=`), for "back to menu" after a match. */
export function menuSearch(currentSearch: string): string {
  const lang = new URLSearchParams(currentSearch).get("lang");
  return lang ? `?lang=${encodeURIComponent(lang)}` : "";
}
