import { Camera, type IObserver, type Scene } from "@babylonjs/core";
import type { WeaponEvent } from "@twobullets/shared";
import type { CombatView, DamageEvent, ShotEvent } from "../combat/types";
import { AmmoPanel } from "./AmmoPanel";
import type { Crosshair } from "./Crosshair";
import { DamageNumbers, type DamageHit } from "./DamageNumbers";
import { el } from "./dom";
import { HealthPanel } from "./HealthPanel";
import { HitMarker } from "./HitMarker";
import { KillNotice } from "./KillNotice";
import { ScopeOverlay } from "./ScopeOverlay";

const DEG_TO_RAD = Math.PI / 180;
/** Scope overlay replaces the view once ADS is nearly complete. */
const SCOPE_ADS_THRESHOLD = 0.9;
/** Crosshair is fully faded by this ADS blend. */
const CROSSHAIR_FADE_END = 0.6;

/** Every combat-driven HUD element, wired to a {@link CombatView}. Lives in one layer that the Hud shows/hides. */
export class CombatHud {
  private readonly layer: HTMLDivElement;
  private readonly scope: ScopeOverlay;
  private readonly hitMarker: HitMarker;
  private readonly damageNumbers: DamageNumbers;
  private readonly killNotice: KillNotice;
  private readonly health: HealthPanel;
  private readonly ammo: AmmoPanel;
  private readonly observers: IObserver[];

  /** DEV preview overrides (see Hud.debugPreview). */
  healthOverride: number | null = null;
  scopeOverride = false;

  constructor(
    parent: HTMLElement,
    private readonly combat: CombatView,
    private readonly scene: Scene,
    private readonly crosshair: Crosshair,
  ) {
    this.layer = el("div", "tb-combat", undefined, parent);
    this.scope = new ScopeOverlay(this.layer);
    const hurt = el("div", "tb-hurt", undefined, this.layer);
    this.damageNumbers = new DamageNumbers(this.layer);
    this.hitMarker = new HitMarker(this.layer);
    this.killNotice = new KillNotice(this.layer);
    this.health = new HealthPanel(this.layer, hurt);
    this.ammo = new AmmoPanel(this.layer);

    this.observers = [
      combat.onShot.add(this.handleShot),
      combat.onWeaponEvent.add(this.handleWeaponEvent),
      combat.onDamage.add(this.handleDamage),
    ];
  }

  set visible(visible: boolean) {
    this.layer.hidden = !visible;
  }

  get visible(): boolean {
    return !this.layer.hidden;
  }

  /** Per frame, after scene.render(). */
  update(now: number): void {
    const combat = this.combat;
    const state = combat.weaponState;
    const weapon = combat.activeWeapon;
    const camera = mainCamera(this.scene);
    const engine = this.scene.getEngine();
    const renderWidth = engine.getRenderWidth(true);
    const renderHeight = engine.getRenderHeight(true);
    const cssPerRenderPixel = engine.getHardwareScalingLevel();

    // Crosshair runs even while the layer is hidden so it doesn't animate from stale values when play resumes.
    if (camera) {
      const viewportCssHeight = renderHeight * camera.viewport.height * cssPerRenderPixel;
      const aspect = (renderWidth * camera.viewport.width) / Math.max(1, renderHeight * camera.viewport.height);
      this.crosshair.setSpreadPx(spreadToPixels(combat.spreadDegrees, camera, aspect, viewportCssHeight));
    }
    const scoped = this.scopeOverride || (weapon.ads.scoped && combat.adsBlend > SCOPE_ADS_THRESHOLD);
    this.crosshair.setOpacity(scoped ? 0 : Math.max(0, 1 - combat.adsBlend / CROSSHAIR_FADE_END));

    if (this.layer.hidden) return;
    this.scope.setActive(scoped);
    this.ammo.update(state, weapon, combat.phaseProgress);
    this.health.update(this.healthOverride ?? combat.health, combat.maxHealth);
    this.damageNumbers.update(now, camera, renderWidth, renderHeight, cssPerRenderPixel);
  }

  dispose(): void {
    for (const observer of this.observers) observer.remove();
    this.observers.length = 0;
    this.layer.remove();
  }

  /** Shows a hit exactly as a real `onDamage` event would. */
  showHit(hit: DamageHit, weaponName: string, distance: number): void {
    const now = performance.now();
    this.hitMarker.show(hit.zone, hit.killed, now);
    this.damageNumbers.add(hit, now);
    if (hit.killed) {
      this.killNotice.notify({ targetId: hit.targetId, headshot: hit.zone === "head", weaponName, distance });
    }
  }

  private readonly handleShot = (_event: ShotEvent): void => {
    this.crosshair.kick();
  };

  private readonly handleWeaponEvent = (event: WeaponEvent): void => {
    switch (event.type) {
      case "equipStarted":
        this.ammo.onEquip();
        break;
      case "reloadFinished":
        this.ammo.onReloadFinished();
        break;
      case "dryFire":
        this.ammo.onDryFire();
        break;
      case "reloadStarted":
      case "reloadCancelled":
        // Prompt and progress bar follow weaponState.phase each frame.
        break;
    }
  };

  private readonly handleDamage = (event: DamageEvent): void => {
    this.showHit(event, event.weapon.name, event.distance);
  };
}

/** The gameplay camera: first of `activeCameras` when a multi-camera setup (e.g. a viewmodel pass) is in use. */
function mainCamera(scene: Scene): Camera | null {
  return scene.activeCameras?.[0] ?? scene.activeCamera;
}

/**
 * Screen-space radius of a spread cone: px = tan(spread) / tan(fovY / 2) × (viewport height / 2).
 * Babylon's `camera.fov` is vertical unless fovMode is FOVMODE_HORIZONTAL_FIXED.
 */
function spreadToPixels(spreadDegrees: number, camera: Camera, aspect: number, viewportCssHeight: number): number {
  const halfFov =
    camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED
      ? Math.atan(Math.tan(camera.fov / 2) / aspect)
      : camera.fov / 2;
  return (Math.tan(spreadDegrees * DEG_TO_RAD) / Math.tan(halfFov)) * (viewportCssHeight / 2);
}
