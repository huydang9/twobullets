import { Vector3, type PhysicsBody, type RawTexture, type Scene, type TargetCamera, type TransformNode } from "@babylonjs/core";
import {
  ITEMS,
  createEquipmentWorld,
  createFirePatch,
  createSmokeCloud,
  flashExposure,
  resolveThrowOrigin,
  snapshotThrowables,
  spawnThrowable,
  stepEquipmentWorld,
  throwId,
  throwLaunch,
  type ConsumableItemId,
  type EquipmentWorld,
  type EquipmentWorldEvent,
  type ThrowableKind,
  type ThrowableSnapshot,
  type ThrowEvent,
} from "@twobullets/shared";
import type { AssetLibrary } from "../../assets";
import type { Environment } from "../../world/environment";
import type { DetonationEvent, EquipmentView, FlashEvent, ThrowableBounceEvent, UseEvent } from "../types";
import { createEquipmentAtlas, createNoiseTexture } from "./equipmentAtlas";
import { ExplosionEffects } from "./ExplosionEffects";
import { FireRenderer } from "./FireRenderer";
import { FlashOverlay } from "./FlashOverlay";
import { EQ_POOL_CAPS, EquipmentFx } from "./fxPools";
import { ItemMeshLibrary } from "./itemMeshes";
import { SmokeRenderer } from "./SmokeRenderer";
import { CameraShake, EquipmentLights, HavokWorldRay, TICK_SECONDS, TickClock, equipmentFxSettings, type TickSource } from "./support";
import { ThrowArc } from "./ThrowArc";
import { ThrowableRenderer } from "./ThrowableRenderer";
import { ThrowableViewmodel, createHandsFrame, type HandsFrame } from "./ThrowableViewmodel";

export interface EquipmentPresentationOptions {
  readonly scene: Scene;
  readonly camera: TargetCamera;
  /** Fixed simulation tick (player.onTick): throwable interpolation and DEV previews step on it. */
  readonly onTick: TickSource;
  /** Tick-accurate eye position (for the underhand arc check and DEV throws). */
  getEyeToRef(result: Vector3): Vector3;
  readonly physicsBody?: PhysicsBody;
  /** Camera-space node carrying the viewmodel's sway and bob (Viewmodel.motion). */
  readonly handsParent: TransformNode;
  readonly environment: Pick<Environment, "sun" | "skyFill" | "addShadowCaster">;
  readonly assets: AssetLibrary | null;
}

/** Owner slot for DEV preview throwables, so their ids never collide with real ones. */
const DEBUG_OWNER_SLOT = 0x7ff0;
const DEBUG_OWNER = -2;
const DEBUG_SEED = 0x51de;
/** Underhand throws start 0.55 m below the eye; overhand 0.05 m above. */
const UNDERHAND_DROP = 0.3;

interface HandsScript {
  kind: "throw" | "use";
  start: number;
  throwable: ThrowableKind;
  style: "overhand" | "underhand";
  cook: boolean;
  item: ConsumableItemId;
  seconds: number;
  step: number;
}

/**
 * Everything the local player sees of equipment: first-person hands for throwables and items, grenades in flight,
 * the trajectory preview, detonations (frag, flash, smoke pop, molotov shatter) with lights and camera shake, smoke
 * clouds, fire patches and the flashbang white-out. Reads EquipmentView (events at tick time, state per frame) and
 * never affects gameplay. Constructed by WeaponPresentation; DEV previews work before a view is attached.
 */
export class EquipmentPresentation {
  readonly settings = equipmentFxSettings;
  readonly items: ItemMeshLibrary;
  readonly hands: ThrowableViewmodel;
  readonly shake = new CameraShake();

  private view: EquipmentView | null = null;
  private readonly viewObservers: { remove(): void }[] = [];
  private readonly clock: TickClock;
  private readonly tickObserver: { remove(): void };
  private readonly atlas: RawTexture;
  private readonly noise: RawTexture;
  private readonly fx: EquipmentFx;
  private readonly lights: EquipmentLights;
  private readonly ray: HavokWorldRay;
  private readonly throwables: ThrowableRenderer;
  private readonly arc: ThrowArc;
  private readonly explosions: ExplosionEffects;
  private readonly smoke: SmokeRenderer;
  private readonly fire: FireRenderer;
  private readonly flash: FlashOverlay;
  private readonly frame: HandsFrame = createHandsFrame();
  private readonly eye = new Vector3();
  private time = 0;
  /** A DEV flash preview runs on its own timer instead of the gameplay blind timer. */
  private flashPreviewUntil = 0;

  // DEV previews.
  private readonly debugWorld: EquipmentWorld = createEquipmentWorld(DEBUG_SEED, 24);
  private readonly debugEvents: EquipmentWorldEvent[] = [];
  private debugSnapshots: readonly ThrowableSnapshot[] = [];
  private debugCounter = 0;
  private script: HandsScript | null = null;

  constructor(private readonly options: EquipmentPresentationOptions) {
    const { scene, camera, environment } = options;
    this.atlas = createEquipmentAtlas(scene);
    this.noise = createNoiseTexture(scene);
    this.fx = new EquipmentFx(scene, this.atlas);
    this.lights = new EquipmentLights(scene);
    this.ray = new HavokWorldRay(scene, options.physicsBody);
    this.items = new ItemMeshLibrary(scene);
    this.hands = new ThrowableViewmodel(scene, options.handsParent, options.assets, environment, this.items, this.fx);
    this.throwables = new ThrowableRenderer(this.items, environment, this.fx);
    this.arc = new ThrowArc(this.fx, this.ray);
    this.explosions = new ExplosionEffects(this.fx, this.lights, this.shake, camera.position);
    this.smoke = new SmokeRenderer(scene, camera, environment, this.noise, this.fx, this.settings);
    this.fire = new FireRenderer(camera, this.fx, this.lights, this.settings);
    this.flash = new FlashOverlay(scene);
    this.clock = new TickClock(options.onTick);
    this.tickObserver = options.onTick.add(() => this.onTick());
  }

  /** Connects the local player's equipment (replaces any previous view). */
  attach(view: EquipmentView): void {
    this.detach();
    this.view = view;
    this.viewObservers.push(
      view.onThrow.add((event) => this.handleThrow(event)),
      view.onThrowableBounce.add((event) => this.handleBounce(event)),
      view.onDetonate.add((event) => this.handleDetonate(event)),
      view.onFlash.add((event) => this.handleFlash(event)),
      view.onUse.add((event) => this.handleUse(event)),
    );
  }

  detach(): void {
    for (const observer of this.viewObservers) observer.remove();
    this.viewObservers.length = 0;
    this.view = null;
  }

  /** True while hands, a pulled pin, an item in use or being down means the gun must be put away. */
  get handsBusy(): boolean {
    const view = this.view;
    if (this.hands.visible || this.script) return true;
    if (!view) return false;
    return view.throwState.phase !== "idle" || view.use !== null || view.vitals.life !== "alive";
  }

  /** 0..1 flashbang white-out this frame, for fading the HUD (`hud.setFlashWhiteout`). */
  get flashWhiteout(): number {
    return this.flash.whiteout;
  }

  /** Per render frame before scene.render (after the player and equipment updates). */
  update(dt: number): void {
    this.time += dt;
    this.clock.advance(dt);
    this.fillFrame();
    const vitals = this.view?.vitals;
    this.flash.update(dt, vitals && this.time >= this.flashPreviewUntil ? vitals.blindSeconds : null);
  }

  /** scene.onBeforeRender, after the viewmodel pose is composed. Returns the camera shake to add to the punch. */
  render(dt: number): Vector3 {
    const alpha = this.clock.alpha;
    const fx = this.fx;
    fx.begin();
    this.lights.beginFrame();
    this.hands.update(dt, this.frame);
    this.throwables.render(dt, alpha);

    const view = this.view;
    if (view && this.settings.throwArc && (!this.frame.underhand || this.settings.underhandArc)) {
      this.arc.render(dt, view.throwArc, view.cookProgress);
    }

    this.smoke.beginFrame();
    this.fire.beginFrame();
    if (view) {
      this.smoke.syncList(view.smokes, alpha);
      this.fire.syncList(view.fires, alpha);
    }
    this.smoke.syncList(this.debugWorld.smokes, alpha);
    this.fire.syncList(this.debugWorld.fires, alpha);
    this.smoke.render(dt);
    this.fire.render(dt);

    fx.step(dt);
    fx.end();
    this.lights.update(dt);
    return this.shake.update(dt, this.settings.cameraShake);
  }

  dispose(): void {
    this.detach();
    this.tickObserver.remove();
    this.clock.dispose();
    this.hands.dispose();
    this.throwables.dispose();
    this.smoke.dispose();
    this.flash.dispose();
    this.lights.dispose();
    this.fx.dispose();
    this.items.dispose();
    this.atlas.dispose();
    this.noise.dispose();
  }

  // --- DEV previews (console: __twobullets.presentation.debugThrow("frag")) ------------------------------------------

  /** Plays the draw → pin → (cook) → throw on the hands and throws a preview grenade from the camera. */
  debugThrow(kind: ThrowableKind = "frag", style: "overhand" | "underhand" = "overhand", cook = false): void {
    this.script = { kind: "throw", start: this.time, throwable: kind, style, cook, item: "bandage", seconds: 0, step: 0 };
  }

  /** Plays the item-use hands for `itemId` over its use time (or `seconds`). */
  debugUse(itemId: ConsumableItemId = "bandage", seconds?: number): void {
    this.script = { kind: "use", start: this.time, throwable: "frag", style: "overhand", cook: false, item: itemId, seconds: seconds ?? ITEMS[itemId].useSeconds, step: 0 };
    this.hands.useStarted(itemId);
  }

  /** Spawns a preview smoke cloud on the ground `distance` m ahead. */
  debugSmoke(distance = 9): void {
    const ground = this.groundAhead(distance);
    if (!ground) return;
    const cloud = createSmokeCloud(this.nextDebugId(), ground, DEBUG_SEED ^ this.debugCounter, this.ray.cast);
    this.debugWorld.smokes = [...this.debugWorld.smokes, cloud];
    this.explosions.detonate("smoke", ground, { x: 0, y: 1, z: 0 });
  }

  /** Spawns a preview fire patch on the ground `distance` m ahead. */
  debugFire(distance = 6): void {
    const ground = this.groundAhead(distance);
    if (!ground) return;
    const patch = createFirePatch(this.nextDebugId(), DEBUG_OWNER, ground, { x: 0, y: 1, z: 0 }, DEBUG_SEED ^ this.debugCounter, this.ray.cast);
    if (!patch) return;
    this.debugWorld.fires = [...this.debugWorld.fires, patch];
    this.explosions.detonate("molotov", ground, { x: 0, y: 1, z: 0 });
  }

  /** Whites out at `strength` 0..1 for `seconds` (default: the gameplay duration for that strength). */
  debugFlash(strength = 1, seconds = strength * 5): void {
    this.flashPreviewUntil = this.time + seconds;
    this.flash.flash(strength, seconds);
  }

  /** A detonation effect `distance` m ahead on the ground (frag by default). */
  debugExplosion(kind: ThrowableKind = "frag", distance = 8): void {
    const ground = this.groundAhead(distance);
    if (ground) this.explosions.detonate(kind, ground, { x: 0, y: 1, z: 0 });
  }

  /** Clears preview clouds, fires, grenades and pooled effects. */
  debugClear(): void {
    this.debugWorld.smokes = [];
    this.debugWorld.fires = [];
    this.debugWorld.throwables.count = 0;
    this.debugSnapshots = [];
    this.fx.clear();
    this.flash.clear();
  }

  /** Pool usage and draw counts. */
  stats(): Record<string, string | number> {
    const fx = this.fx;
    return {
      additiveParticles: `${fx.additive.active}/${fx.additive.capacity}`,
      alphaParticles: `${fx.alpha.active}/${fx.alpha.capacity}`,
      decals: `${fx.decals.active}/${fx.decals.capacity}`,
      throwables: this.throwables.active,
      smokeClouds: this.smoke.activeClouds,
      smokePuffsDrawn: this.smoke.drawnPuffs,
      smokePuffsInside: this.smoke.insidePuffs,
      firePatches: this.fire.activePatches,
      flameTongues: this.fire.drawnTongues,
      lights: this.lights.active,
      arcDots: this.arc.drawn,
      caps: JSON.stringify(EQ_POOL_CAPS),
    };
  }

  // --- Internals ------------------------------------------------------------------------------------------------------

  private onTick(): void {
    this.stepDebugWorld();
    const renderer = this.throwables;
    renderer.beginTick();
    if (this.view) renderer.syncList(this.view.throwables);
    renderer.syncList(this.debugSnapshots);
    renderer.endTick();
  }

  private fillFrame(): void {
    const frame = this.frame;
    const script = this.script;
    if (script) {
      this.runScript(script, frame);
      return;
    }
    const view = this.view;
    if (!view) {
      frame.phase = "idle";
      frame.kind = null;
      frame.useItem = null;
      return;
    }
    const state = view.throwState;
    frame.phase = state.phase;
    frame.kind = state.kind;
    frame.cookProgress = view.cookProgress;
    const use = view.use;
    frame.useItem = use?.itemId ?? null;
    frame.useProgress = use?.progress ?? 0;
    const arc = view.throwArc;
    if (arc.style) {
      frame.underhand = arc.style === "underhand";
    } else if (arc.visible && arc.count > 0) {
      this.options.getEyeToRef(this.eye);
      frame.underhand = arc.points[1]! < this.eye.y - UNDERHAND_DROP;
    }
  }

  private runScript(script: HandsScript, frame: HandsFrame): void {
    const t = this.time - script.start;
    if (script.kind === "use") {
      frame.phase = "idle";
      frame.kind = null;
      frame.useItem = script.item;
      frame.useProgress = Math.min(1, t / script.seconds);
      if (t >= script.seconds) {
        this.hands.putAway();
        this.script = null;
        frame.useItem = null;
      }
      return;
    }
    // Draw 0.5 s, pin at 0.7 s, optional cook at 1.0 s, release at 1.6 s (2.4 s when cooking), gone 0.35 s later.
    const pin = 0.7;
    const cookAt = 1.0;
    const release = script.cook ? 2.4 : 1.6;
    frame.kind = script.throwable;
    frame.underhand = script.style === "underhand";
    frame.useItem = null;
    frame.cookProgress = script.cook && t > cookAt ? Math.min(1, (t - cookAt) / ITEMS[script.throwable].fuseSeconds) : 0;
    if (script.step === 0) {
      this.hands.equip(script.throwable);
      script.step = 1;
    }
    if (script.step === 1 && t >= pin) {
      this.hands.pinPulled();
      script.step = 2;
    }
    if (script.step === 2 && script.cook && t >= cookAt) {
      this.hands.cookStarted();
      script.step = 3;
    }
    if (script.step < 4 && t >= release) {
      this.hands.released(script.style);
      this.spawnDebugThrow(script, script.cook ? Math.max(0.3, ITEMS[script.throwable].fuseSeconds - (release - cookAt)) : ITEMS[script.throwable].fuseSeconds);
      script.step = 4;
    }
    frame.phase = t < 0.5 ? "equipping" : t < pin ? "ready" : t < release ? (script.cook && t >= cookAt ? "cooking" : "primed") : "releasing";
    if (t >= release + 0.35) {
      this.hands.putAway();
      this.script = null;
      frame.phase = "idle";
    }
  }

  private spawnDebugThrow(script: HandsScript, fuse: number): void {
    const camera = this.options.camera;
    const eye = this.options.getEyeToRef(this.eye);
    const yaw = camera.rotation.y;
    const pitch = camera.rotation.x;
    const ctx = { eye: { x: eye.x, y: eye.y, z: eye.z }, yaw, pitch, velocity: { x: 0, y: 0, z: 0 } };
    const launch = throwLaunch(ctx, script.style);
    const position = resolveThrowOrigin(ctx.eye, launch.hand, this.ray.cast);
    const world = this.debugWorld;
    spawnThrowable(world.throwables, { id: this.nextDebugId(), owner: DEBUG_OWNER, kind: script.throwable, position, velocity: launch.velocity, fuse });
  }

  private stepDebugWorld(): void {
    const world = this.debugWorld;
    if (world.throwables.count === 0 && world.smokes.length === 0 && world.fires.length === 0) {
      if (this.debugSnapshots.length > 0) this.debugSnapshots = [];
      return;
    }
    const events = this.debugEvents;
    events.length = 0;
    stepEquipmentWorld(world, TICK_SECONDS, this.ray.cast, [], events);
    this.debugSnapshots = world.throwables.count > 0 ? snapshotThrowables(world.throwables) : [];
    for (const event of events) {
      if (event.type === "bounce") {
        this.throwables.bounce(event.id, event.position, event.normal, event.impactSpeed);
      } else if (event.type === "detonate") {
        this.explosions.detonate(event.kind, event.position, event.normal);
        if (event.kind === "flash") this.previewFlashExposure(event.position);
      }
    }
  }

  private previewFlashExposure(position: { x: number; y: number; z: number }): void {
    const camera = this.options.camera;
    const eye = camera.position;
    const forward = camera.getForwardRay(1).direction;
    const occluded = this.ray.cast({ x: position.x, y: position.y + 0.15, z: position.z }, { x: eye.x, y: eye.y, z: eye.z }) !== null;
    const exposure = flashExposure({ x: eye.x, y: eye.y, z: eye.z }, { x: forward.x, y: forward.y, z: forward.z }, position, occluded);
    if (exposure.blind > 0) this.debugFlash(exposure.blind, exposure.blindSeconds);
  }

  private groundAhead(distance: number): { x: number; y: number; z: number } | null {
    const camera = this.options.camera;
    const yaw = camera.rotation.y;
    const x = camera.position.x + Math.sin(yaw) * distance;
    const z = camera.position.z + Math.cos(yaw) * distance;
    const hit = this.ray.cast({ x, y: camera.position.y + 4, z }, { x, y: camera.position.y - 40, z });
    if (!hit) {
      console.warn("[equipment] no ground ahead for the preview (physics unavailable?)");
      return null;
    }
    return hit.point;
  }

  private nextDebugId(): number {
    return throwId(DEBUG_OWNER_SLOT, ++this.debugCounter);
  }

  private handleThrow(event: ThrowEvent): void {
    if (this.script) this.script = null;
    switch (event.type) {
      case "throwEquipStarted":
        this.hands.equip(event.kind);
        break;
      case "pinPulled":
        this.hands.pinPulled();
        break;
      case "cookStarted":
        this.hands.cookStarted();
        break;
      case "throwReleased":
        this.hands.released(event.style);
        break;
      case "pinReturned":
      case "throwableHolstered":
      case "throwablesDepleted":
        this.hands.putAway();
        break;
    }
  }

  private handleBounce(event: ThrowableBounceEvent): void {
    this.throwables.bounce(event.id, event.position, event.normal, event.impactSpeed);
  }

  private handleDetonate(event: DetonationEvent): void {
    this.explosions.detonate(event.kind, event.position, event.normal);
  }

  private handleFlash(event: FlashEvent): void {
    this.flash.flash(event.exposure.blind, event.exposure.blindSeconds);
  }

  private handleUse(event: UseEvent): void {
    switch (event.type) {
      case "started":
        this.script = null;
        this.hands.useStarted(event.itemId);
        break;
      case "cancelled":
      case "completed":
        this.hands.putAway();
        break;
    }
  }
}
