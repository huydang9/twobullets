import { PhysicsRaycastResult, Vector3, type HavokPlugin, type IRaycastQuery, type PhysicsBody, type Scene, type TransformNode } from "@babylonjs/core";
import { CollisionLayer } from "../combat/hitboxes";
import type { Vec3Like } from "./acoustics";
import { surfaceFromName, taggedSurface, type SurfaceProvider } from "./surfaces";
import type { AcousticSurface } from "./types";

/** Havok casts per frame shared by occlusion, surface lookups and the enclosure probe. */
const RAYS_PER_FRAME = 10;
const OCCLUSION_CACHE_SECONDS = 0.15;
const ENCLOSURE_REACH = 30;
/** Up, then four 45° diagonals; a ceiling overhead counts double. */
const ENCLOSURE_DIRECTIONS = [
  { x: 0, y: 1, z: 0, weight: 2 },
  { x: 0.7071, y: 0.7071, z: 0, weight: 1 },
  { x: -0.7071, y: 0.7071, z: 0, weight: 1 },
  { x: 0, y: 0.7071, z: 0.7071, weight: 1 },
  { x: 0, y: 0.7071, z: -0.7071, weight: 1 },
] as const;
const ENCLOSURE_WEIGHT = ENCLOSURE_DIRECTIONS.reduce((sum, d) => sum + d.weight, 0);

/** Positional enclosure hook for room volumes (buildings): 0 = outdoors, 1 = inside a room, null = unknown. */
export type EnclosureProvider = (position: Vec3Like) => number | null;

interface CastHit {
  readonly node: TransformNode | null;
  readonly fraction: number;
}

/**
 * World queries for audio, all throttled to a fixed ray budget per frame: listener→source occlusion, the surface
 * under a footstep or bullet impact, and a provisional indoor/outdoor estimate (rays up from the listener looking for
 * a ceiling) until buildings expose room volumes.
 */
export class AudioWorldProbe {
  /** Positional surface providers (e.g. terrain mask), consulted when a ray hit doesn't name its material. */
  readonly surfaceProviders: SurfaceProvider[] = [];
  enclosureProvider: EnclosureProvider | null = null;
  /** DEV: forces the indoor estimate (0..1), or null for the live probe. */
  enclosureOverride: number | null = null;
  /** Rays cast this frame / skipped for budget, for the debug overlay. */
  raysThisFrame = 0;
  raysSkipped = 0;

  private readonly plugin: HavokPlugin | null;
  private readonly result = new PhysicsRaycastResult();
  private readonly query: IRaycastQuery = { shouldHitTriggers: false, collideWith: ~(CollisionLayer.hitbox | CollisionLayer.blocker) };
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly occlusionCache = new Map<string, { blocked: boolean; time: number }>();
  private readonly enclosureHits: number[] = ENCLOSURE_DIRECTIONS.map(() => 0);
  private enclosureIndex = 0;
  private enclosureValue = 0;
  private lastSurface: AcousticSurface = "concrete";
  private time = 0;

  constructor(scene: Scene, ignoreBody: PhysicsBody | undefined) {
    const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
    this.plugin = plugin && "raycast" in plugin ? (plugin as HavokPlugin) : null;
    this.query.ignoreBody = ignoreBody;
  }

  /** Smoothed enclosure 0 (open air) … 1 (roofed), for reverb and ambience. */
  get enclosure(): number {
    return this.enclosureOverride ?? this.enclosureValue;
  }

  /** Once per frame: resets the ray budget and advances the enclosure probe by one ray. */
  update(dt: number, listener: Vec3Like): void {
    this.time += dt;
    this.raysThisFrame = 0;
    const provided = this.enclosureProvider?.(listener) ?? null;
    let target: number;
    if (provided !== null) {
      target = provided;
    } else {
      const i = this.enclosureIndex;
      this.enclosureIndex = (i + 1) % ENCLOSURE_DIRECTIONS.length;
      const dir = ENCLOSURE_DIRECTIONS[i] as (typeof ENCLOSURE_DIRECTIONS)[number];
      const hit = this.cast(listener.x, listener.y, listener.z, listener.x + dir.x * ENCLOSURE_REACH, listener.y + dir.y * ENCLOSURE_REACH, listener.z + dir.z * ENCLOSURE_REACH);
      if (hit !== undefined) this.enclosureHits[i] = hit ? dir.weight : 0;
      target = this.enclosureHits.reduce((sum, h) => sum + h, 0) / ENCLOSURE_WEIGHT;
    }
    this.enclosureValue += (target - this.enclosureValue) * (1 - Math.exp(-dt / 0.35));
  }

  /** True when level geometry blocks the straight path between listener and source. */
  isOccluded(listener: Vec3Like, source: Vec3Like): boolean {
    const dx = source.x - listener.x;
    const dy = source.y - listener.y;
    const dz = source.z - listener.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1.5) return false;
    const key = `${Math.round(source.x)},${Math.round(source.y)},${Math.round(source.z)}|${Math.round(listener.x)},${Math.round(listener.y)},${Math.round(listener.z)}`;
    const cached = this.occlusionCache.get(key);
    if (cached && this.time - cached.time < OCCLUSION_CACHE_SECONDS) return cached.blocked;
    // Stop short of the source: impacts and footsteps sit on the surface that would otherwise "block" them.
    const k = (length - 0.35) / length;
    const hit = this.cast(listener.x, listener.y, listener.z, listener.x + dx * k, listener.y + dy * k, listener.z + dz * k);
    if (hit === undefined) return cached?.blocked ?? false;
    const blocked = hit !== null;
    if (this.occlusionCache.size > 256) this.occlusionCache.clear();
    this.occlusionCache.set(key, { blocked, time: this.time });
    return blocked;
  }

  /** Surface under a foot position. */
  surfaceBelow(feet: Vec3Like): AcousticSurface {
    const hit = this.cast(feet.x, feet.y + 0.3, feet.z, feet.x, feet.y - 1.2, feet.z);
    return this.resolve(hit, feet);
  }

  /** Surface at a bullet impact point. */
  surfaceAtImpact(point: Vec3Like, normal: Vec3Like | undefined): AcousticSurface {
    const n = normal ?? { x: 0, y: 1, z: 0 };
    const hit = this.cast(point.x + n.x * 0.15, point.y + n.y * 0.15, point.z + n.z * 0.15, point.x - n.x * 0.25, point.y - n.y * 0.25, point.z - n.z * 0.25);
    return this.resolve(hit, point);
  }

  private resolve(hit: CastHit | null | undefined, at: Vec3Like): AcousticSurface {
    const node = hit?.node;
    const surface = taggedSurface(node) ?? this.providerSurface(at) ?? surfaceFromName(node) ?? (hit === undefined ? this.lastSurface : "concrete");
    this.lastSurface = surface;
    return surface;
  }

  private providerSurface(at: Vec3Like): AcousticSurface | null {
    for (const provider of this.surfaceProviders) {
      const surface = provider.surfaceAt(at.x, at.y, at.z);
      if (surface) return surface;
    }
    return null;
  }

  /** null = clear, undefined = not cast (over budget or no physics). */
  private cast(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): CastHit | null | undefined {
    if (!this.plugin) return undefined;
    if (this.raysThisFrame >= RAYS_PER_FRAME) {
      this.raysSkipped++;
      return undefined;
    }
    this.raysThisFrame++;
    this.plugin.raycast(this.from.set(fx, fy, fz), this.to.set(tx, ty, tz), this.result, this.query);
    if (!this.result.hasHit) return null;
    const length = Math.hypot(tx - fx, ty - fy, tz - fz);
    return { node: this.result.body?.transformNode ?? null, fraction: length > 0 ? this.result.hitDistance / length : 0 };
  }
}
