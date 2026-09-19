import { Color3, Ray, Vector3, type DynamicTexture, type Observer, type Scene } from "@babylonjs/core";
import {
  MOVEMENT,
  SIMULATION,
  getWeaponDef,
  type ConsumableItemId,
  type FiredShot,
  type ThrowableKind,
  type HitZone,
  type Vec3,
  type Projectile,
  type WeaponDef,
  type WeaponEvent,
  type WeaponId,
} from "@twobullets/shared";
import type { AssetLibrary } from "../assets";
import { AudioDirector } from "../audio/AudioDirector";
import type { CombatView, DamageEvent, ImpactEvent, PenetrationEvent, ShotEvent } from "../combat/types";

/** What a shot-through pane does about it: `MirrorWalls` implements this (world/props). */
export interface PaneHoles {
  /** The map props these panes are — a kind comes in more than one length — so a round through some other kind of pane
   * is never offered to them. */
  readonly paneProps: readonly string[];
  /** Cuts a see-through hole at a world point; false when no pane of theirs is there. */
  punch(point: Vector3): boolean;
  /** How wide the hole it cuts is, m. */
  readonly holeDiameter: number;
}
import { EquipmentPresentation } from "../equipment/presentation/EquipmentPresentation";
import type { ItemMeshLibrary } from "../equipment/presentation/itemMeshes";
import type { EquipmentView } from "../equipment/types";
import type { PlayerController } from "../player/PlayerController";
import type { TargetRange } from "../targets/TargetRange";
import { VIEWMODEL_RENDERING_GROUP, Viewmodel, type ViewmodelFrame } from "../viewmodel/Viewmodel";
import { VIEWMODEL_PROFILES } from "../viewmodel/weaponProfiles";
import type { Environment } from "../world/environment";
import { BLOOD_ATLAS_COLUMNS, BLOOD_ATLAS_ROWS, createBloodAtlas } from "./bloodAtlas";
import {
  BLOOD_DECAL_BATCH_CAPACITY,
  BLOOD_PARTICLE_BATCH_CAPACITY,
  BloodEffects,
  HavokBloodWorld,
  type BloodBody,
} from "./BloodEffects";
import { bloodSettings, type BloodSettings } from "./bloodSettings";
import { createFxAtlas, FxCell } from "./fxAtlas";
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
/** On-screen floor for blood mist, px (half size), so a hit still reads as a puff through a scope at 150 m. */
const BLOOD_MIST_MIN_PIXELS = 3;
/** Remote (bot) bullets drawn as tracers and tested for near misses at once. */
const REMOTE_PROJECTILE_CAPACITY = 64;
const REMOTE_FLASH_CAPACITY = 16;
const REMOTE_FLASH_SECONDS = 0.05;
/** Third-person flashes read at distance: bigger than the viewmodel's. */
const REMOTE_FLASH_SCALE = 2.2;
const REMOTE_PROJECTILE_ID_BASE = 1 << 28;
const REMOTE_FLASH_CORE = Color3.FromHexString("#fff2b0");
const REMOTE_FLASH_GLOW = Color3.FromHexString("#ff8a2a");

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
  private readonly bloodAtlas: DynamicTexture;
  private readonly bloodParticles: FxBatch;
  private readonly bloodDecals: FxBatch;
  private readonly blood: BloodEffects;
  private readonly bodies = new Map<string, BloodBody>();
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
  /** Throwables, items, smoke, fire and flash visuals (DEV console: `__twobullets.presentation.equipment`). */
  readonly equipment: EquipmentPresentation;
  /** DEV/settings hook: lowers the gun (holster) regardless of equipment state. */
  weaponLowered = false;

  private readonly shotObserver: Observer<ShotEvent>;
  private readonly weaponObserver: Observer<WeaponEvent>;
  private readonly impactObserver: Observer<ImpactEvent>;
  private readonly penetrateObserver: Observer<PenetrationEvent>;
  /** Panes that open when they are shot through (the map's mirrors), or null off a map. */
  private panes: PaneHoles | null = null;
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
  private readonly shotDirection = new Vector3();

  // Remote actors (offline match bots): straight-line bullets for tracers and near misses, world-space muzzle flashes.
  private readonly remoteProjectiles = Array.from({ length: REMOTE_PROJECTILE_CAPACITY }, () => new RemoteProjectile());
  private readonly remoteFlashes = Array.from({ length: REMOTE_FLASH_CAPACITY }, () => ({ position: new Vector3(), forward: new Vector3(), remaining: 0, size: 0, rotation: 0 }));
  private readonly tracerExtra: Projectile[] = [];
  private nextRemoteId = REMOTE_PROJECTILE_ID_BASE;
  private readonly remoteMuzzle = new Vector3();
  private readonly remotePoint = new Vector3();
  private readonly remoteNormal = new Vector3();
  private readonly remoteDirection = new Vector3();
  private readonly flashTip = new Vector3();

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
    // Capacity is per quad, and a bullet hole through glass is two of them (cracked rim, then the bore).
    this.decalBatch = new FxBatch("fx_decals", scene, atlas, { capacity: 192, blend: "alpha", renderingGroupId: 0, alphaIndex: 0, zOffset: -2 });
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

    // Blood: textured, fogged alpha batches. Decals draw before bullet holes so holes stay on top.
    this.bloodAtlas = createBloodAtlas(scene);
    const bloodLayout = { atlasColumns: BLOOD_ATLAS_COLUMNS, atlasRows: BLOOD_ATLAS_ROWS, textureColor: true, fog: true } as const;
    this.bloodDecals = new FxBatch("fx_bloodDecals", scene, this.bloodAtlas, {
      ...bloodLayout,
      capacity: BLOOD_DECAL_BATCH_CAPACITY,
      blend: "alpha",
      renderingGroupId: 0,
      alphaIndex: -1,
      zOffset: -2,
    });
    this.bloodParticles = new FxBatch("fx_bloodParticles", scene, this.bloodAtlas, {
      ...bloodLayout,
      capacity: BLOOD_PARTICLE_BATCH_CAPACITY,
      blend: "alpha",
      renderingGroupId: 0,
      alphaIndex: 1,
      minSpritePixels: BLOOD_MIST_MIN_PIXELS,
    });
    this.blood = new BloodEffects(this.bloodParticles, this.bloodDecals, new HavokBloodWorld(scene, player.physicsBody), environment.sun.direction);
    // CombatView doesn't expose targets, but CombatSystem does (read-only use, as in AudioDirector).
    const range = (combat as Partial<{ readonly targets: TargetRange }>).targets;
    for (const dummy of range?.dummies ?? []) this.bodies.set(dummy.id, dummy.soldier);

    this.shotObserver = combat.onShot.add((event) => this.handleShot(event.shot));
    this.weaponObserver = combat.onWeaponEvent.add((event) => this.handleWeaponEvent(event));
    this.impactObserver = combat.onImpact.add((event) =>
      this.handleImpact(event.weapon.id, event.point, event.normal, event.surface, event.zone, event.targetId, event.pane ?? null),
    );
    // A round through a glazed or mirrored pane: a bullet hole, nothing else. The event's vectors are reused by the
    // emitter, and both of these copy them on the spot.
    this.penetrateObserver = combat.onPenetrate.add((event) => this.handlePenetration(event));
    this.damageObserver = combat.onDamage.add((event) => this.handleDamage(event.zone, event.killed, event.targetId));
    this.equipment = new EquipmentPresentation({
      scene,
      camera: player.camera,
      onTick: player.onTick,
      getEyeToRef: (result) => player.getEyeToRef(result),
      physicsBody: player.physicsBody,
      handsParent: this.viewmodel.motion,
      environment,
      assets,
    });
    this.renderObserver = scene.onBeforeRenderObservable.add(() => this.afterAnimations());
  }

  /**
   * Connects the map's mirror panes (`world/props/MirrorWalls`, Game.ts wiring). A round crossing one takes a piece of
   * the pane away, which is the pane's own business — this only forwards where it was hit. Without it, rounds through a
   * mirror still mark it, they just don't open it.
   */
  attachPanes(panes: PaneHoles | null): void {
    this.panes = panes;
  }

  /** Connects the local player's equipment: hands, grenades, smoke, fire, flash (Game.ts wiring). */
  attachEquipment(equipment: EquipmentView): void {
    this.equipment.attach(equipment);
  }

  // --- Remote actors (offline match bots; remote players later) ------------------------------------------------------

  /** A character blood wounds attach to, by the damageable id its hits report (bots register their soldiers). */
  registerBody(id: string, body: BloodBody): void {
    this.bodies.set(id, body);
  }

  unregisterBody(id: string): void {
    this.bodies.delete(id);
  }

  /**
   * A shot by an actor the client doesn't simulate: spatial gunshot, world-space muzzle flash and tracers from `muzzle`
   * (the third-person rifle), near-miss cracks. `forward` is the unit barrel direction.
   */
  playRemoteShot(shot: FiredShot, muzzle: Vec3, forward: Vec3): void {
    this.audio.remoteShot(shot.weaponId, muzzle);
    this.remoteMuzzle.set(muzzle.x, muzzle.y, muzzle.z);
    this.tracers.recordShot(shot, this.remoteMuzzle);
    const def = getWeaponDef(shot.weaponId);
    for (let i = 0; i < shot.directions.length; i++) {
      const projectile = this.remoteProjectiles.find((p) => !p.active) ?? oldestRemote(this.remoteProjectiles);
      projectile.launch(this.nextRemoteId++, shot.shotId, def, shot.origin, shot.directions[i]!);
    }
    const flash = this.remoteFlashes.find((f) => f.remaining <= 0) ?? this.remoteFlashes[0]!;
    const profile = VIEWMODEL_PROFILES[shot.weaponId].muzzleFlash;
    flash.position.set(muzzle.x, muzzle.y, muzzle.z);
    flash.forward.set(forward.x, forward.y, forward.z);
    flash.remaining = REMOTE_FLASH_SECONDS;
    flash.size = profile.size * REMOTE_FLASH_SCALE * (0.8 + Math.random() * 0.4);
    flash.rotation = Math.random() * Math.PI * 2;
  }

  /**
   * A remote bullet struck: ends its tracer, then dust and a bullet hole on the world, or blood on the registered body
   * `targetId` (null for the local player, who gets no wound decals). `direction` is the unit bullet direction.
   */
  playRemoteImpact(weaponId: WeaponId, point: Vec3, normal: Vec3, direction: Vec3, hit: { readonly targetId: string | null; readonly zone: HitZone } | null): void {
    const p = this.remotePoint.set(point.x, point.y, point.z);
    const n = this.remoteNormal.set(normal.x, normal.y, normal.z);
    this.remoteDirection.set(direction.x, direction.y, direction.z);
    for (const projectile of this.remoteProjectiles) if (projectile.active && projectile.weaponId === weaponId) projectile.stopAt(p);
    this.tracers.noteImpact(weaponId, p);
    let sound = this.impactSoundsThisFrame < MAX_IMPACT_SOUNDS_PER_FRAME;
    if (!hit) {
      this.impacts.world(p, n, weaponId === "sniper");
      if (sound) this.audio.remoteImpact(weaponId, p, n, null);
    } else if (hit.targetId !== null) {
      const first = this.blood.hit(hit.targetId, this.bodies.get(hit.targetId) ?? null, p, n, this.remoteDirection, hit.zone, weaponId === "sniper");
      sound &&= first;
      if (sound) this.audio.remoteImpact(weaponId, p, n, hit.zone);
    }
    if (sound) this.impactSoundsThisFrame++;
  }

  /** The body `targetId` died from its pending hit: a bigger burst and a pool. */
  playRemoteKill(targetId: string): void {
    this.blood.kill(targetId);
  }

  /** Procedural throwable and consumable models, shared with the loot renderer (`presentationLootModels`). */
  get itemMeshes(): ItemMeshLibrary {
    return this.equipment.items;
  }

  /** Per render frame, after combat.update and before scene.render. */
  update(dt: number): void {
    this.time += dt;
    this.dt = dt;
    const frame = this.fillFrame();
    this.equipment.update(dt);
    this.viewmodel.setStowed(this.equipment.handsBusy || !this.combat.armed || this.weaponLowered);
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
    this.combat.onPenetrate.remove(this.penetrateObserver);
    this.combat.onDamage.remove(this.damageObserver);
    this.scene.onBeforeRenderObservable.remove(this.renderObserver);
    this.player.setCameraPunch(0, 0, 0);
    this.equipment.dispose();
    this.viewmodel.dispose();
    this.worldAdditive.dispose();
    this.worldAlpha.dispose();
    this.decalBatch.dispose();
    this.viewmodelAdditive.dispose();
    this.bloodParticles.dispose();
    this.bloodDecals.dispose();
    this.bloodAtlas.dispose();
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

  /**
   * Blood hit (mist, droplets, splatter on whatever is within reach behind it, drip below) plus flesh and
   * hit-confirm sounds, `distance` m in front of the camera. No body, so no wounds or pool.
   */
  debugHit(zone: HitZone = "body", killed = false, distance = 4): void {
    const camera = this.player.camera;
    const forward = camera.getDirection(Vector3.Forward());
    const point = camera.position.add(forward.scale(distance));
    this.handleImpact(this.viewmodel.weaponId, point, forward.negate(), "target", zone, "debug");
    this.handleDamage(zone, killed, "debug");
  }

  /** Tweaks the live blood settings (e.g. `{ intensity: 0.5 }`, `{ enabled: false }`) and logs them with pool usage. */
  debugBlood(settings: Partial<BloodSettings> = {}): void {
    Object.assign(bloodSettings, settings);
    if (!bloodSettings.enabled) this.blood.clear();
    console.info("[blood]", { ...bloodSettings }, this.blood.stats());
  }

  // Equipment previews (the full set, including `debugFire` for fire patches, is on `presentation.equipment`).

  /** Draw, pin, (cook,) throw on the hands and a real-physics preview grenade from the camera. */
  debugThrow(kind: ThrowableKind = "frag", style: "overhand" | "underhand" = "overhand", cook = false): void {
    this.equipment.debugThrow(kind, style, cook);
  }

  debugSmoke(distance?: number): void {
    this.equipment.debugSmoke(distance);
  }

  /** Molotov fire patch preview (`debugFire` already fires the gun). */
  debugMolotov(distance?: number): void {
    this.equipment.debugFire(distance);
  }

  debugFlash(strength?: number, seconds?: number): void {
    this.equipment.debugFlash(strength, seconds);
  }

  debugExplosion(kind?: ThrowableKind, distance?: number): void {
    this.equipment.debugExplosion(kind, distance);
  }

  debugUse(itemId?: ConsumableItemId, seconds?: number): void {
    this.equipment.debugUse(itemId, seconds);
  }

  // --- Frame steps --------------------------------------------------------------------------------------------------

  /** scene.onBeforeRender: animations for this frame are applied, world matrices are not yet computed. */
  private afterAnimations(): void {
    const dt = this.dt;
    const camera = this.player.camera;
    this.viewmodel.update(this.frame);
    this.viewmodel.getMuzzleToRef(this.muzzle, this.muzzleForward);
    this.viewmodel.getCameraAxesToRef(this.right, this.up, this.forward);
    // Explosion shake layers on the weapon's own punch; both are visual only.
    const shake = this.equipment.render(dt);
    this.lastPunch.copyFrom(this.viewmodel.punch).addInPlace(shake);
    this.player.setCameraPunch(this.lastPunch.x, this.lastPunch.y, this.lastPunch.z);

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
    const extra = this.tracerExtra;
    extra.length = 0;
    for (let i = 0; i < this.debugProjectiles.length; i++) extra.push(this.debugProjectiles[i]!);
    const remoteShots = this.audio.remoteShots;
    remoteShots.length = 0;
    for (const projectile of this.remoteProjectiles) {
      if (!projectile.active || !projectile.advance(dt)) continue;
      extra.push(projectile);
      remoteShots.push(projectile);
    }

    this.worldAdditive.begin();
    this.worldAlpha.begin();
    this.decalBatch.begin();
    this.viewmodelAdditive.begin();
    this.bloodParticles.begin();
    this.bloodDecals.begin();
    this.flash.update(dt, this.muzzle, this.muzzleForward, this.viewmodel.visible);
    this.tracers.update(dt, camera.position, this.combat.projectiles, extra);
    this.drawRemoteFlashes(dt);
    this.sparks.update(dt);
    this.dust.update(dt);
    this.impacts.update(dt);
    this.blood.update(dt);
    this.worldAdditive.end();
    this.worldAlpha.end();
    this.decalBatch.end();
    this.viewmodelAdditive.end();
    this.bloodParticles.end();
    this.bloodDecals.end();

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

  /**
   * A round crossed a pane. A mirror cuts itself a hole you can look through and gets a ring of crazing round it; glass
   * you could already see through gets the hole drawn on it instead.
   */
  private handlePenetration(event: PenetrationEvent): void {
    const panes = this.panes;
    const aperture = panes && panes.paneProps.includes(event.prop) && panes.punch(event.point) ? panes.holeDiameter : 0;
    this.impacts.pierce(event.point, event.normal, aperture);
  }

  private handleImpact(
    weaponId: WeaponId,
    point: Vector3,
    normal: Vector3,
    surface: "world" | "target",
    zone: HitZone | null,
    targetId: string | null,
    pane: string | null = null,
  ): void {
    this.tracers.noteImpact(weaponId, point);
    let sound = this.impactSoundsThisFrame < MAX_IMPACT_SOUNDS_PER_FRAME;
    if (surface === "world") {
      this.impacts.world(point, normal, weaponId === "sniper");
      // The round stopped in a pane you could see straight through: it was armoured this second, and now you know.
      if (pane) this.impacts.paneStop(point, normal);
      if (sound) this.audio.impact(weaponId, point, normal);
    } else {
      const id = targetId ?? "";
      const hitZone = zone ?? "body";
      // Every shot is the local player's for now, so the bullet came from the camera.
      this.shotDirection.copyFrom(point).subtractInPlace(this.player.camera.position).normalize();
      const firstOnTarget = this.blood.hit(id, this.bodies.get(id) ?? null, point, normal, this.shotDirection, hitZone, weaponId === "sniper");
      sound &&= firstOnTarget;
      if (sound) this.audio.fleshImpact(weaponId, point, hitZone);
    }
    if (sound) this.impactSoundsThisFrame++;
  }

  private handleDamage(zone: HitZone, killed: boolean, targetId: string): void {
    if (this.hitZone === null || HIT_ZONE_RANK[zone] > HIT_ZONE_RANK[this.hitZone]) this.hitZone = zone;
    if (killed) {
      this.hitKilled = true;
      this.blood.kill(targetId);
    }
  }

  // --- Helpers -----------------------------------------------------------------------------------------------------

  private drawRemoteFlashes(dt: number): void {
    for (const flash of this.remoteFlashes) {
      if (flash.remaining <= 0) continue;
      flash.remaining -= dt;
      const size = flash.size;
      const f = flash.forward;
      this.flashTip.set(flash.position.x + f.x * size * 3, flash.position.y + f.y * size * 3, flash.position.z + f.z * size * 3);
      this.worldAdditive.sprite(flash.position, size * 2.2, 0, FxCell.glow, REMOTE_FLASH_GLOW, 0.45);
      this.worldAdditive.sprite(flash.position, size * 1.3, flash.rotation, FxCell.star, REMOTE_FLASH_CORE, 1, 1.4);
      this.worldAdditive.streak(flash.position, this.flashTip, size * 0.8, FxCell.flame, REMOTE_FLASH_GLOW, 1, 1, 0.9);
    }
  }

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
          this.handleImpact(projectile.weaponId, projectile.hitPoint, projectile.hitNormal, "world", null, null);
        }
      } else if (projectile.distance > projectile.maxRange) {
        this.debugProjectiles.splice(i, 1);
      }
    }
  }
}

/** Straight-line visual bullet of a remote shooter; the shooter's simulation decides hits (impact events stop it). */
class RemoteProjectile implements Projectile {
  id = 0;
  shotId = 0;
  weaponId: WeaponId = "rifle";
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  distance = 0;
  age = 0;
  active = false;
  private readonly origin = new Vector3();
  private readonly direction = new Vector3();
  private readonly tmp = new Vector3();
  private speed = 1;
  private maxRange = 0;
  private stopDistance = Infinity;

  launch(id: number, shotId: number, def: WeaponDef, origin: Vec3, direction: Vec3): void {
    this.id = id;
    this.shotId = shotId;
    this.weaponId = def.id;
    this.speed = def.muzzleVelocity;
    this.maxRange = def.maxRangeMeters;
    this.origin.set(origin.x, origin.y, origin.z);
    this.direction.set(direction.x, direction.y, direction.z);
    this.velocity.copyFrom(this.direction).scaleInPlace(this.speed);
    this.position.copyFrom(this.origin);
    this.distance = 0;
    this.age = 0;
    this.stopDistance = Infinity;
    this.active = true;
  }

  /** Ends the flight at `point` when it lies on this bullet's line (within 0.6 m) ahead of the muzzle. */
  stopAt(point: Vector3): void {
    point.subtractToRef(this.origin, this.tmp);
    const along = Vector3.Dot(this.tmp, this.direction);
    if (along < 0 || along > this.stopDistance) return;
    if (this.tmp.lengthSquared() - along * along > 0.36) return;
    this.stopDistance = along;
  }

  /** Returns false once the bullet is gone (hit or out of range). */
  advance(dt: number): boolean {
    this.age += dt;
    this.distance = Math.min(this.distance + this.speed * dt, this.stopDistance);
    if (this.distance >= this.stopDistance || this.distance > this.maxRange || this.age > 3) {
      this.active = false;
      return false;
    }
    this.position.copyFrom(this.direction).scaleInPlace(this.distance).addInPlace(this.origin);
    return true;
  }
}

function oldestRemote(projectiles: readonly RemoteProjectile[]): RemoteProjectile {
  let oldest = projectiles[0]!;
  for (const projectile of projectiles) if (projectile.age > oldest.age) oldest = projectile;
  return oldest;
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
