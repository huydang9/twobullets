import { Vector3, type Scene } from "@babylonjs/core";
import type { HitZone, PlayerDebugState } from "@twobullets/shared";
import type { CombatView } from "../combat/types";
import { CombatHud } from "./CombatHud";
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

/** DEV-only scripted previews, see {@link Hud.debugPreview}. */
export type HudPreview =
  | "demo"
  | "body"
  | "limb"
  | "head"
  | "kill"
  | "headkill"
  | "shotgun"
  | "spray"
  | "hurt"
  | "lowhealth"
  | "heal"
  | "scope"
  | "compass"
  | "feed"
  | "reload";

/** Frame deltas above this (tab switch, breakpoint) are clamped so smoothing doesn't jump. */
const MAX_DT = 0.1;

/** Duration of the "compass" preview sweep, ms. */
const COMPASS_SWEEP_MS = 4000;

/** DOM overlay: click-to-play menu, crosshair, combat HUD and debug readout. */
export class Hud {
  private readonly overlay: PlayOverlay;
  private readonly crosshair: Crosshair;
  private readonly stats: StatsPanel;
  private readonly container: HTMLDivElement;
  private readonly inspectorTag: HTMLDivElement;
  private combat: CombatHud | undefined;
  private scene: Scene | undefined;
  private locked = false;
  private inspectorOpen = false;
  private forceVisible = false;
  private lastUpdate = -1;

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

  /** Attribution lines listed under "Credits" in the play overlay (plain text). */
  setCredits(lines: readonly string[]): void {
    this.overlay.setCredits(lines);
  }

  /** Connects combat HUD elements (compass, ammo, slots, health, hit markers, kill feed, crosshair spread, scope). */
  attachCombat(combat: CombatView, scene: Scene): void {
    this.combat?.dispose();
    this.scene = scene;
    this.combat = new CombatHud(this.container, combat, scene, this.crosshair);
    this.refreshVisibility();
  }

  /** Called every frame after scene.render(). Must not allocate DOM nodes or thrash layout. */
  update(state: HudState): void {
    const now = performance.now();
    const dt = this.lastUpdate < 0 ? 0 : Math.min((now - this.lastUpdate) / 1000, MAX_DT);
    this.lastUpdate = now;

    this.combat?.update(now);
    this.crosshair.update(dt);
    this.stats.update(state.fps, state.player);
  }

  /**
   * DEV only: fakes combat feedback so the HUD can be previewed before combat fires real events.
   * From the console: `__twobullets.hud.debugForceVisible(true)` to show the combat HUD without pointer lock, then
   * `__twobullets.hud.debugPreview("demo")` (or "body" | "limb" | "head" | "kill" | "headkill" | "shotgun" | "spray" |
   * "hurt" | "lowhealth" | "heal" | "scope" | "compass" | "feed" | "reload"). "scope" toggles; "heal" clears health
   * overrides. Pass `delaySeconds` to click back into the game before it plays.
   * Credits: `__twobullets.hud.setCredits(["Rifle model by X (CC-BY 4.0)"])`.
   */
  debugPreview(kind: HudPreview = "demo", delaySeconds = 0): void {
    if (!import.meta.env.DEV) return;
    if (delaySeconds > 0) {
      setTimeout(() => this.debugPreview(kind), delaySeconds * 1000);
      return;
    }
    const combat = this.combat;
    const camera = this.scene?.activeCameras?.[0] ?? this.scene?.activeCamera;
    if (!combat || !camera) {
      console.warn("[hud] debugPreview needs attachCombat() and an active camera");
      return;
    }

    const later = (ms: number, fn: () => void): void => void setTimeout(fn, ms);
    const kill = (targetId: string, weaponName: string, zone: HitZone, distance: number): void =>
      combat.showHit({ targetId, zone, amount: 100, killed: true, point: camera.globalPosition }, weaponName, distance);
    const hit = (targetId: string, zone: HitZone, amount: number, killed = false, spreadMeters = 0.25): void => {
      const forward = camera.getDirection(Vector3.Forward());
      const right = camera.getDirection(Vector3.Right()).scaleInPlace((Math.random() * 2 - 1) * spreadMeters);
      const up = camera.getDirection(Vector3.Up()).scaleInPlace((Math.random() * 2 - 1) * spreadMeters);
      const distance = 12;
      const point = camera.globalPosition.add(forward.scaleInPlace(distance)).addInPlace(right).addInPlace(up);
      this.crosshair.kick();
      combat.showHit({ targetId, zone, amount, killed, point }, "AR-4", distance);
    };

    switch (kind) {
      case "body":
      case "limb":
      case "head":
        hit("dummy-1", kind, kind === "head" ? 50 : kind === "body" ? 25 : 20);
        break;
      case "kill":
        hit("dummy-1", "body", 25, true);
        break;
      case "headkill":
        hit("dummy-1", "head", 50, true);
        break;
      case "shotgun":
        for (let i = 0; i < 8; i++) hit("dummy-2", i === 0 ? "head" : i < 6 ? "body" : "limb", 12, false, 0.5);
        break;
      case "spray":
        for (let i = 0; i < 6; i++) later(i * 100, () => hit("dummy-3", "body", 25, i === 5));
        break;
      case "hurt":
        combat.healthOverride = Math.max(0, (combat.healthOverride ?? 100) - 30);
        if (combat.healthOverride === 0) later(1200, () => (combat.healthOverride = null));
        break;
      case "lowhealth":
        combat.healthOverride = 9;
        break;
      case "heal":
        combat.healthOverride = null;
        break;
      case "scope":
        combat.scopeOverride = !combat.scopeOverride;
        break;
      case "compass": {
        const start = performance.now();
        const sweep = (): void => {
          const t = (performance.now() - start) / COMPASS_SWEEP_MS;
          combat.bearingOverride = t < 1 ? t * 360 : null;
          if (t < 1) requestAnimationFrame(sweep);
        };
        sweep();
        break;
      }
      case "feed":
        kill("dummy-1", "AR-4", "head", 42);
        later(600, () => kill("dummy-2", "P-9", "body", 12));
        later(1200, () => kill("target_dummy-7", "K-98", "head", 186));
        break;
      case "reload":
        combat.reloadPreview = { startedAt: performance.now(), seconds: 2.4 };
        break;
      case "demo":
        this.debugPreview("body");
        later(350, () => this.debugPreview("head"));
        later(900, () => this.debugPreview("spray"));
        later(2200, () => this.debugPreview("shotgun"));
        later(2900, () => this.debugPreview("headkill"));
        later(3600, () => this.debugPreview("hurt"));
        later(4200, () => this.debugPreview("reload"));
        later(4800, () => this.debugPreview("compass"));
        break;
    }
  }

  /** DEV only: shows the crosshair and combat HUD (and hides the play overlay) without pointer lock. */
  debugForceVisible(visible: boolean): void {
    if (!import.meta.env.DEV) return;
    this.forceVisible = visible;
    this.refreshVisibility();
  }

  private refreshVisibility(): void {
    const playing = this.locked || this.forceVisible;
    this.overlay.visible = !playing && !this.inspectorOpen;
    this.crosshair.visible = playing;
    this.inspectorTag.hidden = !this.inspectorOpen || playing;
    this.container.classList.toggle("tb-hud--inspector", this.inspectorOpen);
    if (this.combat) this.combat.visible = playing && !this.inspectorOpen;
  }
}
