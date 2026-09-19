import { PhysicsRaycastResult, Vector3, type HavokPlugin, type IRaycastQuery, type PhysicsBody, type Scene, type TransformNode } from "@babylonjs/core";
import { CollisionLayer } from "../combat/hitboxes";
import { SPACE, smoothstep, type SpaceMeasure, type Vec3Like } from "./acoustics";
import type { MapPropAudio } from "./MapPropAudio";
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

/**
 * Horizontal directions the space probe measures the room with: the four world axes and the four diagonals. A maze
 * lattice is axis-aligned, so the axis pair straight across a corridor reads its width exactly; the diagonals catch a
 * space whose narrow axis is not one of them, and all eight together give the mean free path.
 */
const SPACE_DIRECTIONS = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
  { x: 0.7071, z: 0.7071 },
  { x: -0.7071, z: -0.7071 },
  { x: 0.7071, z: -0.7071 },
  { x: -0.7071, z: 0.7071 },
] as const;
/** Opposite pairs in SPACE_DIRECTIONS: a span through the listener is one pair added together. */
const SPACE_PAIRS = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
] as const;
/** Seconds the measured space takes to follow the listener. Slow enough that a doorway doesn't flicker the reverb. */
const SPACE_SMOOTHING = 0.3;

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
  /**
   * Sounds that belong to the placed map props themselves — a bullet through a hedge, a glazed pane switching mode.
   * Registered by `MapRuntime.attach` alongside the surface and enclosure providers, and driven by `AudioDirector`.
   */
  mapProps: MapPropAudio | null = null;
  /** DEV: forces the indoor estimate (0..1), or null for the live probe. */
  enclosureOverride: number | null = null;
  /** DEV: forces the measured space, or null for the live probe. */
  spaceOverride: SpaceMeasure | null = null;
  /** Rays cast this frame / skipped for budget, for the debug overlay. */
  raysThisFrame = 0;
  raysSkipped = 0;

  private readonly plugin: HavokPlugin | null;
  private readonly result = new PhysicsRaycastResult();
  private readonly query: IRaycastQuery = { shouldHitTriggers: false, collideWith: ~(CollisionLayer.hitbox | CollisionLayer.blocker) };
  /**
   * Space rays see every wall that is physically there, which is not the same set as the ones that stop a bullet: a
   * glazed pane in its shoot-through mode and a chainlink fence both live on the blocker layer, and both reflect
   * sound. Characters are not walls, so the player layer is out — a teammate beside you must not shrink the corridor.
   */
  private readonly spaceQuery: IRaycastQuery = { shouldHitTriggers: false, collideWith: ~(CollisionLayer.hitbox | CollisionLayer.player) };
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly occlusionCache = new Map<string, { blocked: boolean; time: number }>();
  private readonly enclosureHits: number[] = ENCLOSURE_DIRECTIONS.map(() => 0);
  private enclosureIndex = 0;
  private enclosureValue = 0;
  /** Distance to whatever stands in each SPACE_DIRECTIONS direction, m; SPACE.reach means nothing within reach. */
  private readonly spaceHits = new Float64Array(SPACE_DIRECTIONS.length).fill(SPACE.reach);
  private spaceIndex = 0;
  private readonly spaceValue = { width: 2 * SPACE.reach, meanFreePath: SPACE.reach };
  private lastSurface: AcousticSurface = "concrete";
  private impactNodeName = "";
  private time = 0;

  constructor(scene: Scene, ignoreBody: PhysicsBody | undefined) {
    const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
    this.plugin = plugin && "raycast" in plugin ? (plugin as HavokPlugin) : null;
    this.query.ignoreBody = ignoreBody;
    this.spaceQuery.ignoreBody = ignoreBody;
  }

  /** Smoothed enclosure 0 (open air) … 1 (roofed), for reverb and ambience. */
  get enclosure(): number {
    return this.enclosureOverride ?? this.enclosureValue;
  }

  /**
   * Smoothed spans of the space around the listener, m — what {@link roomFromSpace} turns into reverb. Open ground
   * measures `2 * SPACE.reach` across with `SPACE.reach` of mean free path, which is the old open-field mix exactly.
   */
  get space(): SpaceMeasure {
    return this.spaceOverride ?? this.spaceValue;
  }

  /**
   * How much a sound should couple into the room reverb, 0..1: the roof overhead or the walls either side, whichever
   * says more. Voices scale their `room` send by this. They used to scale it by {@link enclosure} alone, which is 0
   * in an open-topped corridor — exactly the space that rings most.
   */
  get roomSend(): number {
    return Math.max(this.enclosure, 1 - smoothstep(SPACE.tight, SPACE.loose, this.space.width));
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
    this.updateSpace(dt, listener);
  }

  /**
   * One horizontal ray per frame, round-robin: the whole fan refreshes in eight frames (~130 ms, about a metre of
   * sprinting and well inside the smoothing). It costs one ray out of the same per-frame budget the enclosure probe
   * draws on; the budget itself is unchanged.
   */
  private updateSpace(dt: number, listener: Vec3Like): void {
    const i = this.spaceIndex;
    this.spaceIndex = (i + 1) % SPACE_DIRECTIONS.length;
    const dir = SPACE_DIRECTIONS[i] as (typeof SPACE_DIRECTIONS)[number];
    const hit = this.cast(listener.x, listener.y, listener.z, listener.x + dir.x * SPACE.reach, listener.y, listener.z + dir.z * SPACE.reach, this.spaceQuery);
    if (hit !== undefined) this.spaceHits[i] = hit === null ? SPACE.reach : hit.fraction * SPACE.reach;

    let width = Infinity;
    let total = 0;
    for (const pair of SPACE_PAIRS) {
      const span = (this.spaceHits[pair[0]] as number) + (this.spaceHits[pair[1]] as number);
      if (span < width) width = span;
    }
    for (let k = 0; k < this.spaceHits.length; k++) total += this.spaceHits[k] as number;
    const follow = 1 - Math.exp(-dt / SPACE_SMOOTHING);
    this.spaceValue.width += (width - this.spaceValue.width) * follow;
    this.spaceValue.meanFreePath += (total / this.spaceHits.length - this.spaceValue.meanFreePath) * follow;
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
    this.impactNodeName = hit?.node?.name ?? "";
    return this.resolve(hit, point);
  }

  /**
   * Name of the node the last {@link surfaceAtImpact} ray hit, "" when it hit nothing or was over budget. Prop
   * colliders are named `propCollider_<prop>_<scale>`, which is how audio picks out one specific prop where its
   * material alone isn't enough (audio/glassBlocked.ts).
   */
  get impactNode(): string {
    return this.impactNodeName;
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
  private cast(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number, query: IRaycastQuery = this.query): CastHit | null | undefined {
    if (!this.plugin) return undefined;
    if (this.raysThisFrame >= RAYS_PER_FRAME) {
      this.raysSkipped++;
      return undefined;
    }
    this.raysThisFrame++;
    this.plugin.raycast(this.from.set(fx, fy, fz), this.to.set(tx, ty, tz), this.result, query);
    if (!this.result.hasHit) return null;
    const length = Math.hypot(tx - fx, ty - fy, tz - fz);
    return { node: this.result.body?.transformNode ?? null, fraction: length > 0 ? this.result.hitDistance / length : 0 };
  }
}
