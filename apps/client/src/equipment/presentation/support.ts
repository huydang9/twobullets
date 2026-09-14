import { Color3, PhysicsRaycastResult, PointLight, Vector3, type HavokPlugin, type IRaycastQuery, type PhysicsBody, type Scene } from "@babylonjs/core";
import { SIMULATION, type RayHit, type RaycastFn, type Vec3 } from "@twobullets/shared";
import { CollisionLayer } from "../../combat/hitboxes";
import { Spring } from "../../viewmodel/Spring";

export const TICK_SECONDS = 1 / SIMULATION.tickRate;

/** Live presentation switches (DEV console: `__twobullets.presentation.equipment.settings`). */
export const equipmentFxSettings = {
  /** Trajectory preview while the pin is pulled. PUBG has none; on for offline testing. */
  throwArc: true,
  /** Also show the preview for underhand (aimed) throws, which land close and clutter the view. */
  underhandArc: false,
  smoke: true,
  /** Draws the gameplay puffs as hard magenta spheres (what bots and sight checks use). */
  smokeDebug: false,
  fire: true,
  /** Camera shake and punch from explosions. */
  cameraShake: true,
};
export type EquipmentFxSettings = typeof equipmentFxSettings;

/** Anything that notifies once per fixed simulation tick (PlayerController.onTick). */
export interface TickSource {
  add(callback: () => void): { remove(): void };
}

/**
 * Render-side mirror of the player's fixed-tick accumulator: counts ticks as they fire and yields the interpolation
 * alpha between the last two tick states, exactly like the interpolated camera.
 */
export class TickClock {
  private accumulator = 0;
  private ticks = 0;
  private readonly observer: { remove(): void };

  constructor(onTick: TickSource) {
    this.observer = onTick.add(() => this.ticks++);
  }

  /** Once per render frame, after the player has run this frame's ticks. */
  advance(dt: number): void {
    this.accumulator += dt - this.ticks * TICK_SECONDS;
    this.ticks = 0;
    if (this.accumulator < 0) this.accumulator = 0;
    else if (this.accumulator >= TICK_SECONDS) this.accumulator %= TICK_SECONDS;
  }

  /** 0..1 between the previous and the latest tick. */
  get alpha(): number {
    return this.accumulator / TICK_SECONDS;
  }

  dispose(): void {
    this.observer.remove();
  }
}

/** Static-world Havok segment casts (no hitbox triggers, no player blockers), for presentation probes and DEV previews. */
export class HavokWorldRay {
  private readonly plugin: HavokPlugin | null;
  private readonly result = new PhysicsRaycastResult();
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly query: IRaycastQuery = { shouldHitTriggers: false, collideWith: ~(CollisionLayer.hitbox | CollisionLayer.blocker) };

  constructor(scene: Scene, ignoreBody?: PhysicsBody) {
    const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
    this.plugin = plugin && "raycast" in plugin ? (plugin as HavokPlugin) : null;
    this.query.ignoreBody = ignoreBody;
  }

  /** Casts `from` → `to`; writes the hit into the refs and returns the hit fraction, or -1. */
  castToRef(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, point: Vector3, normal: Vector3): number {
    if (!this.plugin) return -1;
    this.from.set(fx, fy, fz);
    this.to.set(tx, ty, tz);
    this.plugin.raycast(this.from, this.to, this.result, this.query);
    if (!this.result.hasHit) return -1;
    point.copyFrom(this.result.hitPointWorld);
    normal.copyFrom(this.result.hitNormalWorld).normalize();
    const length = Vector3.Distance(this.from, this.to);
    return length > 0 ? Math.min(1, this.result.hitDistance / length) : 0;
  }

  /** The shared-rules RaycastFn shape (allocates a hit record; DEV previews only). */
  readonly cast: RaycastFn = (from: Vec3, to: Vec3): RayHit | null => {
    const point = new Vector3();
    const normal = new Vector3();
    const fraction = this.castToRef(from.x, from.y, from.z, to.x, to.y, to.z, point, normal);
    if (fraction < 0) return null;
    return { point: { x: point.x, y: point.y, z: point.z }, normal: { x: normal.x, y: normal.y, z: normal.z }, fraction, colliderId: null };
  };
}

/**
 * Explosion camera feel: a punch (pitch kick with random yaw/roll, springs) plus a decaying high-frequency shake.
 * Output radians are added to the viewmodel's own punch before it reaches `player.setCameraPunch`.
 */
export class CameraShake {
  readonly offset = new Vector3();
  private readonly pitch = new Spring(9, 0.35);
  private readonly yaw = new Spring(9, 0.35);
  private readonly roll = new Spring(7, 0.3);
  private trauma = 0;
  private time = 0;
  private readonly seed = Math.random() * 100;

  /** `strength` 0..1 (1 = grenade at your feet). */
  add(strength: number): void {
    if (strength <= 0) return;
    this.trauma = Math.min(1, this.trauma + strength);
    this.pitch.kick(-0.07 * strength);
    this.yaw.kick((Math.random() * 2 - 1) * 0.03 * strength);
    this.roll.kick((Math.random() * 2 - 1) * 0.05 * strength);
  }

  update(dt: number, enabled: boolean): Vector3 {
    this.time += dt;
    if (this.trauma === 0 && this.settled()) {
      this.offset.setAll(0);
      return this.offset;
    }
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const shake = this.trauma * this.trauma * 0.025;
    const t = this.time * 38 + this.seed;
    const p = this.pitch.update(dt) + shake * (Math.sin(t) * 0.6 + Math.sin(t * 1.93 + 1.1) * 0.4);
    const y = this.yaw.update(dt) + shake * (Math.sin(t * 1.21 + 2.3) * 0.6 + Math.sin(t * 2.37) * 0.4);
    const r = this.roll.update(dt) + shake * 1.5 * Math.sin(t * 0.87 + 0.7);
    if (enabled) this.offset.set(p, y, r);
    else this.offset.setAll(0);
    return this.offset;
  }

  private settled(): boolean {
    return isAtRest(this.pitch) && isAtRest(this.yaw) && isAtRest(this.roll);
  }
}

function isAtRest(spring: Spring): boolean {
  return Math.abs(spring.value) < 1e-5 && Math.abs(spring.velocity) < 1e-4;
}

const LIGHT_COUNT = 2;
const MAX_FLASHES = 6;

class LightFlash {
  readonly position = new Vector3();
  readonly color = new Color3();
  peak = 0;
  range = 10;
  duration = 0.2;
  age = Infinity;
}

/**
 * Pooled world point lights shared by explosions and fires. They are created once and stay enabled at zero intensity,
 * so nothing ever changes shader defines. Each frame explosions claim lights first (brightest), then fires nearest
 * the camera. Note: materials use Babylon's default of 4 simultaneous lights, and the sun, sky fill and muzzle flash
 * take three, so only the first equipment light reaches them unless `maxSimultaneousLights` is raised.
 */
export class EquipmentLights {
  private readonly lights: PointLight[];
  private readonly flashes = Array.from({ length: MAX_FLASHES }, () => new LightFlash());
  private readonly firePositions = Array.from({ length: LIGHT_COUNT }, () => new Vector3());
  private readonly fireIntensity = new Float32Array(LIGHT_COUNT);
  private readonly fireDistance = new Float32Array(LIGHT_COUNT);
  private fireCount = 0;
  private readonly fireColor = new Color3(1, 0.5, 0.18);

  constructor(scene: Scene) {
    this.lights = Array.from({ length: LIGHT_COUNT }, (_, i) => {
      const light = new PointLight(`eq_light${i}`, Vector3.Zero(), scene);
      light.intensity = 0;
      light.range = 12;
      light.specular = new Color3(0.2, 0.15, 0.1);
      return light;
    });
  }

  flash(position: Vector3, color: Color3, peak: number, range: number, duration: number): void {
    let slot = this.flashes[0]!;
    for (let i = 0; i < this.flashes.length; i++) {
      const flash = this.flashes[i]!;
      if (flash.age >= flash.duration) {
        slot = flash;
        break;
      }
      if (flash.age / flash.duration > slot.age / slot.duration) slot = flash;
    }
    slot.position.copyFrom(position);
    slot.color.copyFrom(color);
    slot.peak = peak;
    slot.range = range;
    slot.duration = duration;
    slot.age = 0;
  }

  /** Clears last frame's fire requests; call before `requestFire`. */
  beginFrame(): void {
    this.fireCount = 0;
  }

  /** Offers a flickering fire light; the nearest requests win. */
  requestFire(position: Vector3, intensity: number, cameraDistance: number): void {
    let index = this.fireCount;
    if (index >= LIGHT_COUNT) {
      index = 0;
      for (let i = 1; i < LIGHT_COUNT; i++) if (this.fireDistance[i]! > this.fireDistance[index]!) index = i;
      if (this.fireDistance[index]! <= cameraDistance) return;
    } else {
      this.fireCount++;
    }
    this.firePositions[index]!.copyFrom(position);
    this.fireIntensity[index] = intensity;
    this.fireDistance[index] = cameraDistance;
  }

  update(dt: number): void {
    let used = 0;
    // Explosions, brightest first (at most LIGHT_COUNT at once; a spam simply reuses the lights).
    for (let pass = 0; pass < LIGHT_COUNT; pass++) {
      let best: LightFlash | null = null;
      let bestIntensity = 0;
      for (let i = 0; i < this.flashes.length; i++) {
        const flash = this.flashes[i]!;
        if (flash.age >= flash.duration) continue;
        const t = flash.age / flash.duration;
        const intensity = flash.peak * (1 - t) * (1 - t);
        if (intensity > bestIntensity && !this.claimed(flash, used)) {
          best = flash;
          bestIntensity = intensity;
        }
      }
      if (!best) break;
      const light = this.lights[used]!;
      light.position.copyFrom(best.position);
      light.diffuse.copyFrom(best.color);
      light.range = best.range;
      light.intensity = bestIntensity;
      this.claimedFlashes[used] = best;
      used++;
    }
    for (let i = 0; i < this.fireCount && used < LIGHT_COUNT; i++, used++) {
      const light = this.lights[used]!;
      light.position.copyFrom(this.firePositions[i]!);
      light.diffuse.copyFrom(this.fireColor);
      light.range = 9;
      light.intensity = this.fireIntensity[i]!;
    }
    for (let i = used; i < LIGHT_COUNT; i++) {
      const light = this.lights[i]!;
      if (light.intensity !== 0) light.intensity = 0;
    }
    for (let i = 0; i < LIGHT_COUNT; i++) this.claimedFlashes[i] = null;
    for (let i = 0; i < this.flashes.length; i++) this.flashes[i]!.age += dt;
  }

  /** Lights currently lit (for stats). */
  get active(): number {
    let n = 0;
    for (const light of this.lights) if (light.intensity > 0) n++;
    return n;
  }

  dispose(): void {
    for (const light of this.lights) light.dispose();
  }

  private readonly claimedFlashes: (LightFlash | null)[] = new Array<LightFlash | null>(LIGHT_COUNT).fill(null);

  private claimed(flash: LightFlash, used: number): boolean {
    for (let i = 0; i < used; i++) if (this.claimedFlashes[i] === flash) return true;
    return false;
  }
}

/** Distance falloff for explosion feel: 1 within `full` m, 0 beyond `range` m, eased. */
export function proximity(distance: number, full: number, range: number): number {
  const t = Math.min(1, Math.max(0, (range - distance) / (range - full)));
  return t * t;
}
