import type { PlayerDebugState } from "@twobullets/shared";
import { Crosshair } from "./Crosshair";
import { el } from "./dom";
import { PlayOverlay } from "./PlayOverlay";
import { StatsPanel } from "./StatsPanel";
import "./hud.css";

export interface HudState {
  readonly fps: number;
  readonly player: PlayerDebugState;
}

export interface HudHandlers {
  /** User clicked the "click to play" overlay; should request pointer lock. */
  readonly onPlayClick: () => void;
}

/** DOM overlay: click-to-play menu, crosshair and debug readout. */
export class Hud {
  private readonly overlay: PlayOverlay;
  private readonly crosshair: Crosshair;
  private readonly stats: StatsPanel;
  private readonly container: HTMLDivElement;
  private readonly inspectorTag: HTMLDivElement;
  private locked = false;
  private inspectorOpen = false;

  constructor(root: HTMLDivElement, handlers: HudHandlers) {
    this.container = el("div", "tb-hud", undefined, root);
    this.stats = new StatsPanel(this.container, import.meta.env.DEV);
    this.crosshair = new Crosshair(this.container);
    this.overlay = new PlayOverlay(this.container, handlers.onPlayClick);
    this.inspectorTag = el("div", "tb-inspector-tag", "INSPECTOR OPEN · F9 TO CLOSE", this.container);
    this.refreshVisibility();
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.overlay.setLocked(locked);
    this.refreshVisibility();
  }

  /** Toggles the debug stats panel (F3). */
  toggleStats(): void {
    this.stats.visible = !this.stats.visible;
  }

  /** While the Babylon Inspector is open the menu must not cover the canvas or eat its clicks. */
  setInspectorOpen(open: boolean): void {
    this.inspectorOpen = open;
    this.refreshVisibility();
  }

  /** Called every frame. Must not allocate DOM nodes or thrash layout. */
  update(state: HudState): void {
    this.stats.update(state.fps, state.player);
  }

  private refreshVisibility(): void {
    this.overlay.visible = !this.locked && !this.inspectorOpen;
    this.crosshair.visible = this.locked;
    this.inspectorTag.hidden = !this.inspectorOpen || this.locked;
    this.container.classList.toggle("tb-hud--inspector", this.inspectorOpen);
  }
}
