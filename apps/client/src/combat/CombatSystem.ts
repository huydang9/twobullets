import { Observable, Vector3, type Observer, type Scene } from "@babylonjs/core";
import {
  DEFAULT_LOADOUT,
  computeDamage,
  createWeaponState,
  currentSpreadDegrees,
  getWeaponDef,
  spawnProjectiles,
  stepProjectiles,
  stepWeapon,
  type LevelData,
  type Projectile,
  type ProjectileImpact,
  type WeaponContext,
  type WeaponDef,
  type WeaponEvent,
  type WeaponState,
} from "@twobullets/shared";
import type { InputManager } from "../input/InputManager";
import type { PlayerController, PlayerTick } from "../player/PlayerController";
import { TargetRange } from "../targets/TargetRange";
import type { Environment } from "../world/environment";
import { CombatInputQueue } from "./CombatInputQueue";
import { HavokRaycaster } from "./HavokRaycaster";
import { HitboxRegistry } from "./hitboxes";
import type { CombatView, DamageEvent, ImpactEvent, ShotEvent } from "./types";

const PLAYER_MAX_HEALTH = 100;
/**
 * The simulated ADS blend moves in 60 Hz steps; the rendered blend chases it at slightly above the sim's own rate,
 * which reads as continuous motion on high refresh screens while lagging at most about a tick.
 */
const ADS_SMOOTH_RATE_SCALE = 1.25;
/** Scoped weapons barely zoom until the blend passes this range, then snap to full magnification. */
const SCOPE_ZOOM_START = 0.72;
const SCOPE_ZOOM_END = 0.92;
const SCOPE_PRE_ZOOM = 0.15;

/**
 * Local player's weapons: ticks the shared weapon simulation in lockstep with movement, flies projectiles
 * against Havok, applies damage to target dummies, and drives ADS modifiers on the player.
 */
export class CombatSystem implements CombatView {
  readonly onShot = new Observable<ShotEvent>();
  readonly onWeaponEvent = new Observable<WeaponEvent>();
  readonly onImpact = new Observable<ImpactEvent>();
  readonly onDamage = new Observable<DamageEvent>();

  weaponState: WeaponState = createWeaponState(DEFAULT_LOADOUT);
  spreadDegrees = 0;
  projectiles: readonly Projectile[] = [];
  health = PLAYER_MAX_HEALTH;
  readonly maxHealth = PLAYER_MAX_HEALTH;
  /** Render-smoothed ADS blend, 0..1 (weaponState.adsBlend only changes at the tick rate). */
  adsBlend = 0;

  readonly targets: TargetRange;
  private readonly hitboxes = new HitboxRegistry();
  private readonly raycaster: HavokRaycaster;
  private readonly inputQueue: CombatInputQueue;
  private readonly tickObserver: Observer<PlayerTick>;
  private readonly eye = new Vector3();
  private nextProjectileId = 1;
  private readonly allocateProjectileId = (): number => this.nextProjectileId++;

  constructor(
    scene: Scene,
    input: InputManager,
    private readonly player: PlayerController,
    level: LevelData,
    environment: Environment,
  ) {
    this.inputQueue = new CombatInputQueue(input);
    this.raycaster = new HavokRaycaster(scene, this.hitboxes);
    this.targets = new TargetRange(scene, level.targets, this.hitboxes, environment);
    this.tickObserver = player.onTick.add((tick) => this.tick(tick));
  }

  get activeWeapon(): WeaponDef {
    const slot = this.weaponState.slots[this.weaponState.activeIndex];
    if (!slot) throw new Error("No active weapon slot");
    return getWeaponDef(slot.id);
  }

  get phaseProgress(): number | null {
    const { phase, phaseTimer } = this.weaponState;
    if (phase === "ready") return null;
    const def = this.activeWeapon;
    const total = phase === "reloading" ? def.reloadSeconds : def.equipSeconds;
    return total > 0 ? Math.min(1, Math.max(0, 1 - phaseTimer / total)) : 1;
  }

  /** Per render frame, after player.update: queues untaken input, ADS zoom/modifiers and dummy animation. */
  update(dt: number): void {
    const state = this.weaponState;
    this.inputQueue.endFrame(state.activeIndex, state.slots.length);

    const def = this.activeWeapon;
    const maxStep = (ADS_SMOOTH_RATE_SCALE * dt) / Math.max(def.ads.seconds, 1e-3);
    this.adsBlend += Math.min(maxStep, Math.max(-maxStep, state.adsBlend - this.adsBlend));

    const zoom = def.ads.scoped ? scopeZoomCurve(this.adsBlend) : this.adsBlend;
    const modifiers = this.player.modifiers;
    modifiers.speedScale = def.moveSpeedScale * lerp(1, def.ads.moveSpeedScale, this.adsBlend);
    modifiers.allowSprint = !(this.inputQueue.isFireHeld || this.inputQueue.isAimHeld);
    // Sensitivity follows the zoom so scoped aim speed matches the magnification on screen.
    modifiers.sensitivityScale = lerp(1, def.ads.sensitivityScale, zoom);
    this.player.setZoom(def.ads.fovDegrees, zoom);

    this.targets.update(dt);
  }

  dispose(): void {
    this.tickObserver.remove();
    this.targets.dispose();
    this.onShot.clear();
    this.onWeaponEvent.clear();
    this.onImpact.clear();
    this.onDamage.clear();
  }

  private tick({ dt, state: move }: PlayerTick): void {
    const player = this.player;
    const eye = player.getEyeToRef(this.eye);
    const aim = player.getAim();
    const ctx: WeaponContext = {
      eye: { x: eye.x, y: eye.y, z: eye.z },
      yaw: aim.yaw,
      pitch: aim.pitch,
      horizontalSpeed: Math.hypot(move.velocity.x, move.velocity.z),
      grounded: move.grounded,
      sprinting: move.sprinting,
    };

    const input = this.inputQueue.take(this.weaponState.activeIndex, this.weaponState.slots.length);
    const result = stepWeapon(this.weaponState, input, ctx, dt);
    this.weaponState = result.state;
    this.spreadDegrees = currentSpreadDegrees(result.state, ctx);

    for (const event of result.events) this.onWeaponEvent.notifyObservers(event);

    let projectiles = this.projectiles;
    if (result.shots.length > 0) {
      const spawned: Projectile[] = [...projectiles];
      for (const shot of result.shots) {
        player.kickAim(shot.recoilUp, shot.recoilRight);
        spawned.push(...spawnProjectiles(shot, this.allocateProjectileId));
        this.onShot.notifyObservers({ weapon: getWeaponDef(shot.weaponId), shot });
      }
      projectiles = spawned;
    }

    if (projectiles.length === 0) {
      this.projectiles = projectiles;
      return;
    }
    this.raycaster.ignoreBody = player.physicsBody;
    const flight = stepProjectiles(projectiles, dt, this.raycaster.cast);
    this.projectiles = flight.alive;
    for (const impact of flight.impacts) this.resolveImpact(impact);
  }

  private resolveImpact({ projectile, hit, distance }: ProjectileImpact): void {
    const weapon = getWeaponDef(projectile.weaponId);
    const point = new Vector3(hit.point.x, hit.point.y, hit.point.z);
    const normal = new Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    const hitbox = hit.colliderId !== null ? this.hitboxes.get(hit.colliderId) : undefined;

    if (!hitbox) {
      this.onImpact.notifyObservers({ weapon, point, normal, surface: "world", targetId: null, zone: null });
      return;
    }

    const { owner, zone } = hitbox;
    this.onImpact.notifyObservers({ weapon, point, normal, surface: "target", targetId: owner.id, zone });
    const v = projectile.velocity;
    const damage = owner.applyDamage({
      colliderId: hitbox.colliderId,
      zone,
      amount: computeDamage(weapon, zone, distance),
      point,
      direction: new Vector3(v.x, v.y, v.z).normalize(),
    });
    if (!damage) return;
    this.onDamage.notifyObservers({
      weapon,
      targetId: owner.id,
      zone,
      amount: damage.amount,
      remainingHealth: damage.remainingHealth,
      killed: damage.killed,
      point,
      distance,
    });
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** A slight early zoom, then most of the magnification lands just before the scope overlay appears. */
function scopeZoomCurve(blend: number): number {
  return SCOPE_PRE_ZOOM * Math.min(blend / SCOPE_ZOOM_START, 1) + (1 - SCOPE_PRE_ZOOM) * smoothstep(SCOPE_ZOOM_START, SCOPE_ZOOM_END, blend);
}
