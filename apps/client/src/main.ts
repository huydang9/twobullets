import { netLaunchSearch, shouldShowMenu, startMenu, type MatchLaunch } from "./menu";
import { setJoinTokenProvider } from "./net/handshake";

const canvas = document.getElementById("game");
const hudRoot = document.getElementById("hud");
if (!(canvas instanceof HTMLCanvasElement) || !(hudRoot instanceof HTMLDivElement)) {
  throw new Error("index.html is missing #game canvas or #hud root");
}

function reportStartFailure(err: unknown): void {
  console.error("[twobullets] failed to start", err);
  hudRoot!.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
}

/** Game module loaded on demand, so the menu shows before Babylon and Havok download. */
async function startGame(): Promise<void> {
  const { Game } = await import("./game/Game");
  await Game.create(canvas as HTMLCanvasElement, hudRoot as HTMLDivElement);
}

/**
 * Networked match from the menu: join tokens come from server-api instead of `/dev/token`, and the net flags
 * Game.create reads are in the URL only for its synchronous start (menu/launch.ts; README-wiring.md has the Game.ts
 * option that replaces this).
 */
async function startNetworkedGame(launch: MatchLaunch): Promise<void> {
  const { Game } = await import("./game/Game");
  setJoinTokenProvider(() => launch.tokens());
  const menuUrl = window.location.href;
  const url = new URL(menuUrl);
  url.search = netLaunchSearch(url.search, launch);
  window.history.replaceState(window.history.state, "", url);
  let started: Promise<unknown>;
  try {
    started = Game.create(canvas as HTMLCanvasElement, hudRoot as HTMLDivElement);
  } finally {
    // A reload mid-match lands on the menu, which offers "Rejoin".
    window.history.replaceState(window.history.state, "", menuUrl);
  }
  await started.catch((err: unknown) => {
    reportStartFailure(err);
    throw err;
  });
}

// Production: the menu is the entry point. DEV: the menu unless the URL has game flags (`?map=`, `?bots=1`, `?net=`,
// `?bench=`, …), which start the game directly as before.
if (shouldShowMenu(window.location.search) || (!import.meta.env.DEV && !new URLSearchParams(window.location.search).has("bots"))) {
  startMenu({ parent: document.body, launchMatch: startNetworkedGame });
} else {
  startGame().catch(reportStartFailure);
}
