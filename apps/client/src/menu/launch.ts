import type { TeamMode } from "@twobullets/contracts/match";
import type { AccountView, JoinMatchResponse } from "@twobullets/contracts/rest";
import type { BotDifficulty } from "@twobullets/shared";
import type { NetLaunch, NetMatchExit } from "../game/launch";
import type { IssuedJoinToken } from "../platform/joinToken";

// How the menu hands over to the game (README-wiring.md): a networked match becomes `Game.create(…, { kind: "net" })`;
// practice reloads with `?bots=1…` flags, which main.ts turns into `{ kind: "practice" }` (DEV reads them directly).

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
  /** The game is done with the match (in-game results closed, or the player left). */
  readonly onExit?: (exit: NetMatchExit) => void;
}

/** The game launch for a match the front door joined. */
export function netGameLaunch(launch: MatchLaunch): NetLaunch {
  return {
    kind: "net",
    wsUrl: launch.join.wsUrl,
    accountId: launch.account.id,
    teamId: launch.join.teamId,
    mapId: launch.mapId,
    matchId: launch.join.matchId,
    tokens: launch.tokens,
    ...(launch.onExit ? { onExit: launch.onExit } : {}),
  };
}

/** Path of the menu (no flags except `?lang=`), for "back to menu" after a match. */
export function menuSearch(currentSearch: string): string {
  const lang = new URLSearchParams(currentSearch).get("lang");
  return lang ? `?lang=${encodeURIComponent(lang)}` : "";
}
