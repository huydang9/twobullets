import { Game } from "./game/Game";

const canvas = document.getElementById("game");
const hudRoot = document.getElementById("hud");
if (!(canvas instanceof HTMLCanvasElement) || !(hudRoot instanceof HTMLDivElement)) {
  throw new Error("index.html is missing #game canvas or #hud root");
}

Game.create(canvas, hudRoot).catch((err: unknown) => {
  console.error("[twobullets] failed to start", err);
  hudRoot.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
