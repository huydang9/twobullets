import { Camera, Vector3, type IObserver, type Scene } from "@babylonjs/core";
import type { WeaponEvent } from "@twobullets/shared";
import type { CombatView, DamageEvent, ShotEvent } from "../combat/types";
import { AmmoPanel } from "./AmmoPanel";
import { Compass } from "./Compass";
import type { Crosshair } from "./Crosshair";
import { DamageNumbers, type DamageHit } from "./DamageNumbers";
import { el } from "./dom";
import { HealthPanel } from "./HealthPanel";
import { HitMarker } from "./HitMarker";
import { KillFeed } from "./KillFeed";
import { KillNotice } from "./KillNotice";
import { ReloadIndicator } from "./ReloadIndicator";
import { ScopeOverlay } from "./ScopeOverlay";
import { WeaponSlots } from "./WeaponSlots";

/** Floating world-space damage numbers. Off for the realistic HUD; the component is kept for debugging/modes. */
export const SHOW_DAMAGE_NUMBERS = false;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
/** Scope overlay replaces the view once ADS is nearly complete. */
const SCOPE_ADS_THRESHOLD = 0.9;
/** Crosshair is fully faded by this ADS blend (sights/optics on the 3D model take over). */
const CROSSHAIR_FADE_END = 0.35;

/** DEV preview of a reload with no real weapon state behind it. */
interface ReloadPreview {
  readonly startedAt: number;
  readonly seconds: number;
}

/** Every combat-driven HUD element, wired to a {@link CombatView}. Lives in one layer that the Hud shows/hides. */
export class CombatHud {
  private readonly layer: HTMLDivElement;
  private readonly scope: ScopeOverlay;
  private readonly compass: Compass;
  private readonly hitMarker: HitMarker;
  private readonly damageNumbers: DamageNumbers | undefined;
  private readonly reload: ReloadIndicator;
  private readonly killFeed: KillFeed;
  private readonly killNotice: KillNotice;
  private readonly health: HealthPanel;
  private readonly slots: WeaponSlots;
  private readonly ammo: AmmoPanel;
  private readonly observers: IObserver[];
  private readonly forwardAxis: Vector3;
  private readonly forward = new Vector3();
  private bearing = 0;

  /** DEV preview overrides (see Hud.debugPreview). */
  healthOverride: number | null = null;
  scopeOverride = false;
  bearingOverride: number | null = null;
  reloadPreview: ReloadPreview | null = null;

  constructor(
    parent: HTMLElement,
    private readonly combat: CombatView,
    private readonly scene: Scene,
    private readonly crosshair: Crosshair,
  ) {
    this.forwardAxis = Vector3.Forward(scene.useRightHandedSystem);
    // DOM order is stacking order: scope and vignettes at the back, readouts on top.
    this.layer = el("div", "tb-combat", undefined, parent);
    this.scope = new ScopeOverlay(this.layer);
    const vignettes = el("div", "tb-vignettes", undefined, this.layer);
    this.damageNumbers = SHOW_DAMAGE_NUMBERS ? new DamageNumbers(this.layer) : undefined;
    this.hitMarker = new HitMarker(this.layer);
    this.reload = new ReloadIndicator(this.layer);
    this.compass = new Compass(this.layer);
    this.killFeed = new KillFeed(this.layer);
    this.killNotice = new KillNotice(this.layer);

    const dock = el("div", "tb-dock", undefined, this.layer);
    this.slots = new WeaponSlots(dock);
    this.health = new HealthPanel(dock, vignettes);
    this.ammo = new AmmoPanel(dock);

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
    this.compass.update(this.bearingOverride ?? this.cameraBearing(camera));

    const active = state.slots[state.activeIndex];
    if (active) this.ammo.update(active, weapon, state.phase);
    this.slots.update(state);
    this.health.update(this.healthOverride ?? combat.health, combat.maxHealth);

    const preview = this.reloadPreview;
    if (preview) {
      const elapsed = (now - preview.startedAt) / 1000;
      if (elapsed >= preview.seconds) this.reloadPreview = null;
      this.reload.update(elapsed >= preview.seconds ? null : elapsed / preview.seconds, preview.seconds - elapsed);
    } else {
      const reloading = state.phase === "reloading";
      this.reload.update(reloading ? (combat.phaseProgress ?? 0) : null, state.phaseTimer);
    }

    this.damageNumbers?.update(now, camera, renderWidth, renderHeight, cssPerRenderPixel);
  }

  dispose(): void {
    for (const observer of this.observers) observer.remove();
    this.observers.length = 0;
    this.layer.remove();
  }

  /** Shows a hit exactly as a real `onDamage` event would. */
  showHit(hit: DamageHit, weaponName: string, distance: number): void {
    const now = performance.now();
    this.hitMarker.show(hit.killed, now);
    this.damageNumbers?.add(hit, now);
    if (hit.killed) {
      const kill = { targetId: hit.targetId, headshot: hit.zone === "head", weaponName, distance };
      this.killFeed.push(kill, now);
      this.killNotice.notify(kill);
    }
  }

  /**
   * Compass bearing of the camera's view direction, degrees: atan2(x, z), so +Z = 0 (north) and +X = 90 (east).
   * Keeps the last bearing when looking straight up/down, where the horizontal direction is undefined.
   */
  private cameraBearing(camera: Camera | null): number {
    if (camera) {
      const f = this.forward;
      camera.getDirectionToRef(this.forwardAxis, f);
      if (f.x * f.x + f.z * f.z > 1e-6) this.bearing = Math.atan2(f.x, f.z) * RAD_TO_DEG;
    }
    return this.bearing;
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
        // The reload ring and hints follow weaponState.phase each frame.
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
