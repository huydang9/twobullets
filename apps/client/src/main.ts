import type { GameLaunch } from "./game/launch";
import { netGameLaunch, shouldShowMenu, startMenu, type MatchLaunch } from "./menu";
import { showFatalError } from "./ui/FatalError";

const canvas = document.getElementById("game");
const hudRoot = document.getElementById("hud");
if (!(canvas instanceof HTMLCanvasElement) || !(hudRoot instanceof HTMLDivElement)) {
  throw new Error("index.html is missing #game canvas or #hud root");
}

/** A failed start (map chunk, terrain, nav grid, assets…) shows the error over the loading card instead of hanging. */
function reportStartFailure(err: unknown): void {
  showFatalError(err, "start");
}

/** Game module loaded on demand, so the menu shows before Babylon and Havok download. */
async function startGame(launch: GameLaunch): Promise<void> {
  const { Game } = await import("./game/Game");
  await Game.create(canvas as HTMLCanvasElement, hudRoot as HTMLDivElement, launch);
}

/** Networked match from the menu: join tokens from server-api, the match's map, the exit hook back to the menu. */
async function startNetworkedGame(launch: MatchLaunch): Promise<void> {
  await startGame(netGameLaunch(launch)).catch((err: unknown) => {
    reportStartFailure(err);
    throw err;
  });
}

/** Production practice: the menu reloads with `?bots=1&players&mode&difficulty&map` (menu/launch.ts `practiceSearch`). */
async function startPractice(search: string): Promise<void> {
  const { readOfflineMatchOptions } = await import("./match/options");
  await startGame({ kind: "practice", options: readOfflineMatchOptions(search, false), mapId: new URLSearchParams(search).get("map") ?? "v1" });
}

// Production: the menu is the entry point, `?bots=` is practice. DEV: the menu unless the URL has game flags (`?map=`,
// `?bots=1`, `?net=`, `?bench=`, …), which start the game directly.
const search = window.location.search;
const practice = !import.meta.env.DEV && new URLSearchParams(search).has("bots");
if (practice) {
  startPractice(search).catch(reportStartFailure);
} else if (shouldShowMenu(search) || !import.meta.env.DEV) {
  startMenu({ parent: document.body, launchMatch: startNetworkedGame });
} else {
  startGame({ kind: "dev" }).catch(reportStartFailure);
}
