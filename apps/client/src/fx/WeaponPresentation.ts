import { Ray, Vector3, type DynamicTexture, type Observer, type Scene } from "@babylonjs/core";
import {
  MOVEMENT,
  SIMULATION,
  getWeaponDef,
  type FiredShot,
  type HitZone,
  type Projectile,
  type WeaponDef,
  type WeaponEvent,
  type WeaponId,
} from "@twobullets/shared";
import type { AssetLibrary } from "../assets";
import { AudioDirector } from "../audio/AudioDirector";
import type { CombatView, DamageEvent, ImpactEvent, ShotEvent } from "../combat/types";
import type { PlayerController } from "../player/PlayerController";
import { VIEWMODEL_RENDERING_GROUP, Viewmodel, type ViewmodelFrame } from "../viewmodel/Viewmodel";
import { VIEWMODEL_PROFILES } from "../viewmodel/weaponProfiles";
import type { Environment } from "../world/environment";
import { createFxAtlas } from "./fxAtlas";
import { FxBatch } from "./FxBatch";
import { ImpactEffects } from "./ImpactEffects";
import { MuzzleFlash } from "./MuzzleFlash";
import { ParticlePool } from "./ParticlePool";
import { ShellCasings } from "./ShellCasings";
import { Tracers } from "./Tracers";

const MAX_SHOTS_PER_FRAME = 16;
const MAX_PENDING_EJECTS = 8;
const MAX_IMPACT_SOUNDS_PER_FRAME = 3;
const TICK_SECONDS = 1 / SIMULATION.tickRate;
const HIT_ZONE_RANK: Readonly<Record<HitZone, number>> = { limb: 0, body: 1, head: 2 };

interface PendingEject {
  time: number;
  weaponId: WeaponId;
}

/**
 * Everything the local player sees and hears of their weapon: viewmodel, camera punch, muzzle flash, tracers,
 * impacts, shell casings and audio. Pure presentation; reads CombatView and never affects gameplay.
 *
 * Runs in two steps per frame: `update` (before scene.render) turns combat events into clips and sounds, and a
 * scene.onBeforeRender step, after Babylon has applied this frame's animations, poses the viewmodel and places
 * effects on the animated muzzle and ejection port.
 */
export class WeaponPresentation {
  private readonly viewmodel: Viewmodel;
  private readonly atlas: DynamicTexture;
  private readonly worldAdditive: FxBatch;
  private readonly worldAlpha: FxBatch;
  private readonly decalBatch: FxBatch;
  private readonly viewmodelAdditive: FxBatch;
  private readonly sparks: ParticlePool;
  private readonly dust: ParticlePool;
  private readonly impacts: ImpactEffects;
  private readonly tracers: Tracers;
  private readonly flash: MuzzleFlash;
  private readonly casings: ShellCasings;
  /** All game audio (DEV console: `__audio.help()`). */
  readonly audio: AudioDirector;

  private readonly shotObserver: Observer<ShotEvent>;
  private readonly weaponObserver: Observer<WeaponEvent>;
  private readonly impactObserver: Observer<ImpactEvent>;
  private readonly damageObserver: Observer<DamageEvent>;
  private readonly renderObserver: Observer<Scene>;

  private readonly pendingShots: (FiredShot | null)[] = new Array<FiredShot | null>(MAX_SHOTS_PER_FRAME).fill(null);
  private readonly pendingShotEmpty: boolean[] = new Array<boolean>(MAX_SHOTS_PER_FRAME).fill(false);
  private pendingShotCount = 0;
  private readonly ejects: PendingEject[] = Array.from({ length: MAX_PENDING_EJECTS }, (): PendingEject => ({ time: Infinity, weaponId: "rifle" }));
  private impactSoundsThisFrame = 0;
  private hitZone: HitZone | null = null;
  private hitKilled = false;

  private time = 0;
  private dt = 0;
  private readonly lastPunch = new Vector3();
  private readonly frame: ViewmodelFrame;

  private readonly muzzle = new Vector3();
  private readonly muzzleForward = new Vector3();
  private readonly eject = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly forward = new Vector3();

  // DEV preview state (see debug* methods).
  private previewWeapon: WeaponId | null = null;
  private previewCombatWeapon: WeaponId | null = null;
  private readonly debugProjectiles: DebugProjectile[] = [];
  private nextDebugId = -1;

  constructor(
    private readonly scene: Scene,
    private readonly player: PlayerController,
    private readonly combat: CombatView,
    assets: AssetLibrary | null,
    environment: Environment,
  ) {
    this.audio = new AudioDirector(scene, player, combat);
    const initial = combat.activeWeapon;
    this.viewmodel = new Viewmodel(scene, player.camera, environment, assets, initial.id);
    this.frame = {
      weaponId: initial.id,
      def: initial,
      phase: "ready",
      adsBlend: 0,
      yaw: 0,
      pitch: 0,
      velocity: player.moveState.velocity,
      grounded: true,
      sprinting: false,
    };

    this.atlas = createFxAtlas(scene);
    const atlas = this.atlas;
    // alphaIndex orders the world batches: decals under dust under glowing additive effects.
    this.decalBatch = new FxBatch("fx_decals", scene, atlas, { capacity: 64, blend: "alpha", renderingGroupId: 0, alphaIndex: 0, zOffset: -2 });
    this.worldAlpha = new FxBatch("fx_worldAlpha", scene, atlas, { capacity: 192, blend: "alpha", renderingGroupId: 0, alphaIndex: 1 });
    this.worldAdditive = new FxBatch("fx_worldAdditive", scene, atlas, { capacity: 1024, blend: "additive", renderingGroupId: 0, alphaIndex: 2 });
    this.viewmodelAdditive = new FxBatch("fx_viewmodelAdditive", scene, atlas, {
      capacity: 16,
      blend: "additive",
      renderingGroupId: VIEWMODEL_RENDERING_GROUP,
      alphaIndex: 0,
    });
    this.sparks = new ParticlePool(768, this.worldAdditive);
    this.dust = new ParticlePool(160, this.worldAlpha);
    this.impacts = new ImpactEffects(this.sparks, this.dust, this.decalBatch);
    this.tracers = new Tracers(this.worldAdditive);
    this.flash = new MuzzleFlash(scene, this.viewmodelAdditive);
    this.casings = new ShellCasings(scene);
    this.casings.onBounce = (position) => this.audio.casing(this.frame.weaponId, position);

    this.shotObserver = combat.onShot.add((event) => this.handleShot(event.shot));
    this.weaponObserver = combat.onWeaponEvent.add((event) => this.handleWeaponEvent(event));
    this.impactObserver = combat.onImpact.add((event) =>
      this.handleImpact(event.weapon.id, event.point, event.normal, event.surface, event.zone),
    );
    this.damageObserver = combat.onDamage.add((event) => this.handleDamage(event.zone, event.killed, event.point));
    this.renderObserver = scene.onBeforeRenderObservable.add(() => this.afterAnimations());
  }

  /** Per render frame, after combat.update and before scene.render. */
  update(dt: number): void {
    this.time += dt;
    this.dt = dt;
    const frame = this.fillFrame();
    this.viewmodel.advance(dt);

    for (let i = 0; i < this.pendingShotCount; i++) {
      const shot = this.pendingShots[i] as FiredShot;
      const plan = this.viewmodel.fire(shot.recoilUp, shot.recoilRight, frame.adsBlend, this.pendingShotEmpty[i] === true);
      this.audio.actionCycle(shot.weaponId, plan);
      if (plan.ejectAt !== null) this.scheduleEject(shot.weaponId, this.time + plan.ejectAt);
    }

    if (this.hitZone !== null) {
      this.audio.hitConfirm(this.hitZone, this.hitKilled);
      this.hitZone = null;
      this.hitKilled = false;
    }
    this.impactSoundsThisFrame = 0;
    this.audio.update(dt);
  }

  dispose(): void {
    this.combat.onShot.remove(this.shotObserver);
    this.combat.onWeaponEvent.remove(this.weaponObserver);
    this.combat.onImpact.remove(this.impactObserver);
    this.combat.onDamage.remove(this.damageObserver);
    this.scene.onBeforeRenderObservable.remove(this.renderObserver);
    this.player.setCameraPunch(0, 0, 0);
    this.viewmodel.dispose();
    this.worldAdditive.dispose();
    this.worldAlpha.dispose();
    this.decalBatch.dispose();
    this.viewmodelAdditive.dispose();
    this.flash.dispose();
    this.casings.dispose();
    this.atlas.dispose();
    this.audio.dispose();
  }

  // --- DEV preview helpers (console: __twobullets.presentation.debugFire("sniper")) -------------------------------

  /** Presents a fake shot from the camera (viewmodel kick, flash, tracer, impact via scene picking, audio). */
  debugFire(weaponId?: WeaponId): void {
    if (weaponId) this.debugEquip(weaponId);
    const def = getWeaponDef(weaponId ?? this.viewmodel.weaponId);
    const camera = this.player.camera;
    const origin = camera.position.clone();
    const forward = camera.getDirection(Vector3.Forward());
    const directions: Vector3[] = [];
    const cone = def.pellets > 1 ? 0.05 : 0.004;
    for (let i = 0; i < def.pellets; i++) {
      const jitter = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).scaleInPlace(cone);
      directions.push(forward.add(jitter).normalize());
    }
    const shotId = this.nextDebugId--;
    const shot: FiredShot = { weaponId: def.id, shotId, origin, directions, recoilUp: 0, recoilRight: 0 };
    this.handleShot(shot);
    for (const direction of directions) {
      const ray = new Ray(origin, direction, def.maxRangeMeters);
      const hit = this.scene.pickWithRay(ray, (mesh) => mesh.isPickable && mesh.isEnabled() && mesh.renderingGroupId === 0);
      const projectile = new DebugProjectile(this.nextDebugId--, shotId, def, origin, direction);
      if (hit?.hit && hit.pickedPoint) {
        projectile.hitDistance = hit.distance;
        projectile.hitPoint.copyFrom(hit.pickedPoint);
        projectile.hitNormal.copyFrom(hit.getNormal(true) ?? direction.negate());
      }
      this.debugProjectiles.push(projectile);
    }
  }

  /** Plays the reload clips and sounds for the displayed weapon. */
  debugReload(empty = false): void {
    const def = getWeaponDef(this.viewmodel.weaponId);
    this.audio.weapon.reloadStarted(def.id, this.viewmodel.startReload(def.reloadSeconds, empty));
  }

  /** Shows `weaponId` until the real active weapon changes. */
  debugEquip(weaponId: WeaponId): void {
    if (this.previewWeapon === weaponId) return;
    this.previewWeapon = weaponId;
    this.previewCombatWeapon = this.combat.activeWeapon.id;
    const def = getWeaponDef(weaponId);
    this.frame.weaponId = weaponId;
    this.frame.def = def;
    this.viewmodel.equip(weaponId, def.equipSeconds);
    this.audio.weapon.equip(weaponId);
  }

  debugDryFire(): void {
    this.handleWeaponEvent({ type: "dryFire", weaponId: this.viewmodel.weaponId });
  }

  /** Target hit burst + hit sound 4 m in front of the camera. */
  debugHit(zone: HitZone = "body", killed = false): void {
    const camera = this.player.camera;
    const forward = camera.getDirection(Vector3.Forward());
    const point = camera.position.add(forward.scale(4));
    this.handleImpact(this.viewmodel.weaponId, point, forward.negate(), "target", zone);
    this.handleDamage(zone, killed, point);
  }

  // --- Frame steps --------------------------------------------------------------------------------------------------

  /** scene.onBeforeRender: animations for this frame are applied, world matrices are not yet computed. */
  private afterAnimations(): void {
    const dt = this.dt;
    const camera = this.player.camera;
    this.viewmodel.update(this.frame);
    this.viewmodel.getMuzzleToRef(this.muzzle, this.muzzleForward);
    this.viewmodel.getCameraAxesToRef(this.right, this.up, this.forward);
    const punch = this.viewmodel.punch;
    this.player.setCameraPunch(punch.x, punch.y, punch.z);
    this.lastPunch.copyFrom(punch);

    for (let i = 0; i < this.pendingShotCount; i++) {
      const shot = this.pendingShots[i] as FiredShot;
      this.pendingShots[i] = null;
      this.tracers.recordShot(shot, this.muzzle);
      this.flash.trigger(VIEWMODEL_PROFILES[shot.weaponId]);
    }
    this.pendingShotCount = 0;
    for (const pending of this.ejects) {
      if (pending.time > this.time) continue;
      pending.time = Infinity;
      this.ejectCasing(pending.weaponId);
    }

    this.stepDebugProjectiles(dt);

    this.worldAdditive.begin();
    this.worldAlpha.begin();
    this.decalBatch.begin();
    this.viewmodelAdditive.begin();
    this.flash.update(dt, this.muzzle, this.muzzleForward, this.viewmodel.visible);
    this.tracers.update(dt, camera.position, this.combat.projectiles, this.debugProjectiles);
    this.sparks.update(dt);
    this.dust.update(dt);
    this.impacts.update(dt);
    this.worldAdditive.end();
    this.worldAlpha.end();
    this.decalBatch.end();
    this.viewmodelAdditive.end();

    this.casings.update(dt);
  }

  // --- Event handling ----------------------------------------------------------------------------------------------

  private handleShot(shot: FiredShot): void {
    this.audio.shot(shot.weaponId);
    if (this.pendingShotCount >= MAX_SHOTS_PER_FRAME) return;
    // Shot events fire after the tick's state update, so the magazine already excludes this round.
    this.pendingShotEmpty[this.pendingShotCount] = shot.weaponId === this.combat.activeWeapon.id && this.activeMagazine() === 0;
    this.pendingShots[this.pendingShotCount++] = shot;
  }

  private handleWeaponEvent(event: WeaponEvent): void {
    switch (event.type) {
      case "equipStarted":
        this.viewmodel.equip(event.weaponId, event.seconds);
        this.audio.weapon.equip(event.weaponId);
        break;
      case "reloadStarted":
        // The magazine is refilled when the reload finishes, so it still reads 0 for an empty reload.
        this.audio.weapon.reloadStarted(event.weaponId, this.viewmodel.startReload(event.seconds, this.activeMagazine() === 0));
        break;
      case "reloadCancelled":
        this.viewmodel.cancelReload();
        this.audio.weapon.reloadCancelled();
        break;
      case "dryFire":
        this.viewmodel.onDryFire();
        this.audio.weapon.dryFire(event.weaponId);
        break;
      case "reloadFinished":
        break;
    }
  }

  private handleImpact(weaponId: WeaponId, point: Vector3, normal: Vector3, surface: "world" | "target", zone: HitZone | null): void {
    if (surface === "world") this.impacts.world(point, normal, weaponId === "sniper");
    else this.impacts.target(point, normal, zone);
    this.tracers.noteImpact(weaponId, point);
    if (this.impactSoundsThisFrame < MAX_IMPACT_SOUNDS_PER_FRAME) {
      this.impactSoundsThisFrame++;
      this.audio.impact(weaponId, point, normal, surface === "target");
    }
  }

  private handleDamage(zone: HitZone, killed: boolean, point: Vector3): void {
    if (this.hitZone === null || HIT_ZONE_RANK[zone] > HIT_ZONE_RANK[this.hitZone]) this.hitZone = zone;
    if (killed) {
      this.hitKilled = true;
      this.impacts.kill(point);
    }
  }

  // --- Helpers -----------------------------------------------------------------------------------------------------

  private fillFrame(): ViewmodelFrame {
    const combat = this.combat;
    const combatWeapon = combat.activeWeapon;
    if (this.previewWeapon !== null && combatWeapon.id !== this.previewCombatWeapon) this.previewWeapon = null;
    const def = this.previewWeapon !== null ? getWeaponDef(this.previewWeapon) : combatWeapon;

    const move = this.player.moveState;
    const rotation = this.player.camera.rotation;
    const frame = this.frame;
    frame.weaponId = def.id;
    frame.def = def;
    frame.phase = this.previewWeapon !== null ? "ready" : combat.weaponState.phase;
    frame.adsBlend = this.previewWeapon !== null ? 0 : combat.adsBlend;
    frame.yaw = rotation.y - this.lastPunch.y;
    frame.pitch = rotation.x - this.lastPunch.x;
    frame.velocity = move.velocity;
    frame.grounded = move.grounded;
    frame.sprinting = move.sprinting;
    return frame;
  }

  private activeMagazine(): number {
    const state = this.combat.weaponState;
    return state.slots[state.activeIndex]?.magazine ?? -1;
  }

  private scheduleEject(weaponId: WeaponId, time: number): void {
    const slot = this.ejects.find((pending) => pending.time === Infinity) ?? this.ejects[0];
    if (!slot) return;
    slot.time = time;
    slot.weaponId = weaponId;
  }

  private ejectCasing(weaponId: WeaponId): void {
    this.viewmodel.getEjectPortToRef(this.eject);
    const move = this.player.moveState;
    const eyeHeight = move.stance === "crouch" ? MOVEMENT.crouchEyeHeight : MOVEMENT.standEyeHeight;
    const floorY = this.player.camera.position.y - eyeHeight;
    this.casings.eject(weaponId, this.eject, this.right, this.up, this.forward, move.velocity, floorY);
  }

  private stepDebugProjectiles(dt: number): void {
    for (let i = this.debugProjectiles.length - 1; i >= 0; i--) {
      const projectile = this.debugProjectiles[i] as DebugProjectile;
      projectile.advance(dt);
      if (projectile.distance >= projectile.hitDistance) {
        this.debugProjectiles.splice(i, 1);
        if (projectile.hitDistance < Infinity) {
          this.handleImpact(projectile.weaponId, projectile.hitPoint, projectile.hitNormal, "world", null);
        }
      } else if (projectile.distance > projectile.maxRange) {
        this.debugProjectiles.splice(i, 1);
      }
    }
  }
}

/** Straight-line stand-in for a combat projectile, used only by debugFire(). */
class DebugProjectile implements Projectile {
  readonly weaponId: WeaponId;
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly maxRange: number;
  distance = 0;
  age = 0;
  hitDistance = Infinity;
  readonly hitPoint = new Vector3();
  readonly hitNormal = new Vector3();
  private readonly speed: number;

  constructor(
    readonly id: number,
    readonly shotId: number,
    def: WeaponDef,
    origin: Vector3,
    direction: Vector3,
  ) {
    this.weaponId = def.id;
    this.speed = def.muzzleVelocity;
    this.maxRange = def.maxRangeMeters;
    this.position = origin.clone();
    this.velocity = direction.scale(this.speed);
    // Combat steps a projectile once in the tick it spawns; mirror that so the first frame looks the same.
    this.advance(TICK_SECONDS);
  }

  advance(dt: number): void {
    const step = Math.min(this.speed * dt, this.hitDistance - this.distance);
    const k = step / this.speed;
    this.position.addInPlaceFromFloats(this.velocity.x * k, this.velocity.y * k, this.velocity.z * k);
    this.distance += this.speed * dt;
    this.age += dt;
  }
}
