import { sinCos, smoothstep, TWO_PI } from "../terrain/math";
import { fbm, hash2 } from "../terrain/noise";
import type { Terrain } from "../terrain/terrain";
import { TERRAIN_SURFACES, type FlattenRegion, type MapData, type PropPlacement, type PropScatter, type Vec2Tuple } from "../types";
import type { ResolvedBuilding } from "./buildings";
import { distanceToRect, pointInPolygon, polygonBounds, polygonEdgeDistance, segmentDistance, SpatialHash, type OrientedRect } from "./geometry";
import { getMapProp, type MapPropDef, type PropCategory } from "./props";
import { mapPaths } from "./roads";

/**
 * Seeded scatter rule. Extends MapData's PropScatter with the knobs map v1 needs; every extra field is optional, so
 * a plain PropScatter still expands.
 */
export interface ScatterRule extends PropScatter {
  /** Defaults to a hash of `id`. */
  readonly seed?: number;
  /** Noise density mask: clearings and clumps. `threshold` 0..1 is the noise level where density reaches half. */
  readonly mask?: { readonly wavelength: number; readonly threshold: number; readonly softness?: number };
  /** Density fades to zero this far inside the area outline, m. */
  readonly edgeFade?: number;
  /** Only on slopes at least this steep (rocks on hillsides), degrees. */
  readonly minSlopeDegrees?: number;
  /** Keep off flattened POI pads. Default: true for trees and rocks. */
  readonly avoidPads?: boolean;
  /** Extra distance from road edges and building outlines, m. Default per category. */
  readonly clearance?: number;
  /** Areas to leave empty. */
  readonly exclude?: readonly (readonly Vec2Tuple[])[];
  /** Tilt instances to the terrain normal. Default from the prop catalog. */
  readonly alignToTerrain?: boolean;
  /** Each accepted lattice spot seeds `count` [min, max] instances within `radius` (cover clusters); `density` then counts clusters. */
  readonly cluster?: { readonly count: readonly [min: number, max: number]; readonly radius: number };
  /**
   * Visual-only detail (grass): skipped by `buildMapLayout` and expanded on the client around the viewer with
   * `ScatterContext.expandRegion`. Never collides.
   */
  readonly detail?: boolean;
}

/** Floats per instance: x, y, z, yaw, scale, normal x, normal z (normal y = sqrt(1 - nx² - nz²)). */
export const INSTANCE_STRIDE = 7;
/** Scales are quantized to 1/SCALE_STEPS so instances of one prop share a handful of physics shapes. */
export const SCALE_STEPS = 20;

const DEFAULT_CLEARANCE: Readonly<Record<PropCategory, number>> = { tree: 2.5, rock: 1.5, prop: 1, bush: 1, grass: 0.3 };

interface PathSegment {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly halfWidth: number;
}

interface Circle {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}

type AreaRegion = Extract<FlattenRegion, { shape: "circle" | "rect" }>;

const CELL = 24;
const MAX_PATH_HALF_WIDTH = 6;

/**
 * Everything scatter placement tests against: paths (roads, ramps), buildings, pads, explicit props and already
 * placed instances. Rules expand in order, and each accepted collidable instance reserves its footprint.
 */
export class ScatterContext {
  private readonly paths = new SpatialHash<PathSegment>(CELL);
  private readonly buildings = new SpatialHash<OrientedRect>(CELL);
  private readonly blockers = new SpatialHash<OrientedRect>(CELL);
  private readonly occupied = new SpatialHash<Circle>(CELL);
  private readonly pads: readonly AreaRegion[];
  private readonly weights = [0, 0, 0, 0];
  private readonly normal = { x: 0, y: 1, z: 0 };

  private readonly map: Pick<MapData, "flatten" | "spawns" | "terrain">;
  private readonly terrain: Terrain;

  constructor(map: Pick<MapData, "flatten" | "spawns" | "terrain">, terrain: Terrain, buildings: readonly ResolvedBuilding[]) {
    this.map = map;
    this.terrain = terrain;
    for (const path of mapPaths(map)) {
      for (let i = 0; i + 1 < path.points.length; i++) {
        const [ax, az] = path.points[i]!;
        const [bx, bz] = path.points[i + 1]!;
        const segment = { ax, az, bx, bz, halfWidth: path.halfWidth };
        const cx = (ax + bx) / 2;
        const cz = (az + bz) / 2;
        this.paths.insert(segment, cx, cz, Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az)) / 2);
      }
    }
    for (const building of buildings) {
      const [hx, hz] = building.bounds.halfExtents;
      this.buildings.insert(building.bounds, building.bounds.center[0], building.bounds.center[1], Math.sqrt(hx * hx + hz * hz));
    }
    this.pads = map.flatten.filter((region): region is AreaRegion => region.shape !== "polyline");
    // Spawns stay clear so nobody starts inside a trunk.
    for (const spawn of map.spawns) this.reserve(spawn.position[0], spawn.position[1], 2.5);
  }

  /** Reserves the footprint of an explicitly placed prop: boxes as rectangles, everything else as a circle. */
  addPlacedProp(placement: PropPlacement): void {
    const def = getMapProp(placement.prop);
    const scale = placement.scale ?? 1;
    const [x, , z] = placement.position;
    if (def.collision.kind === "box") {
      const [sx, , sz] = def.collision.size;
      const rect: OrientedRect = { center: [x, z], halfExtents: [(sx * scale) / 2, (sz * scale) / 2], yaw: placement.yaw };
      this.blockers.insert(rect, x, z, (Math.max(sx, sz) * scale) / 2 + 1);
    } else {
      this.reserve(x, z, def.footprint * scale);
    }
  }

  private reserve(x: number, z: number, radius: number): void {
    this.occupied.insert({ x, z, radius }, x, z, radius);
  }

  /** Expands a rule over its whole area, appending instances per prop to `out`. Returns the instance count. */
  expand(rule: ScatterRule, out: Map<string, number[]>): number {
    const bounds = polygonBounds(rule.area);
    return this.expandRegion(rule, bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, out, !rule.detail);
  }

  /**
   * Expands a rule inside a world rectangle. Candidates come from a lattice anchored at the world origin, so any
   * rectangle yields exactly the instances a whole-area expansion would place there (before occupancy).
   */
  expandRegion(rule: ScatterRule, minX: number, minZ: number, maxX: number, maxZ: number, out: Map<string, number[]>, reserve = false): number {
    if (rule.props.length === 0 || rule.density <= 0) return 0;
    const compiled = compileRule(rule);
    const { seed, spacing } = compiled;
    const area = polygonBounds(rule.area);
    const x0 = Math.max(minX, area.minX);
    const z0 = Math.max(minZ, area.minZ);
    const x1 = Math.min(maxX, area.maxX);
    const z1 = Math.min(maxZ, area.maxZ);
    let count = 0;

    for (let j = Math.floor(z0 / spacing); j * spacing < z1; j++) {
      for (let i = Math.floor(x0 / spacing); i * spacing < x1; i++) {
        const h = hash2(i, j, seed);
        const x = (i + 0.1 + 0.8 * unit(h, 1, seed)) * spacing;
        const z = (j + 0.1 + 0.8 * unit(h, 2, seed)) * spacing;
        if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
        if (!pointInPolygon(rule.area, x, z)) continue;
        if (rule.exclude?.some((polygon) => pointInPolygon(polygon, x, z))) continue;

        let chance = 1;
        if (rule.mask) {
          const noise = (fbm(x / rule.mask.wavelength, z / rule.mask.wavelength, 3, seed ^ 0x51ed) + 1) / 2;
          const soft = rule.mask.softness ?? 0.08;
          chance *= smoothstep(rule.mask.threshold - soft, rule.mask.threshold + soft, noise);
        }
        if (rule.edgeFade) chance *= smoothstep(0, rule.edgeFade, polygonEdgeDistance(rule.area, x, z));
        if (unit(h, 3, seed) >= chance) continue;

        if (!rule.cluster) {
          if (this.place(compiled, x, z, h, out, reserve)) count++;
          continue;
        }
        const [least, most] = rule.cluster.count;
        const members = least + Math.floor(unit(h, 7, seed) * (most - least + 1));
        for (let m = 0; m < members; m++) {
          const hm = hash2(h | 0, 100 + m, seed);
          const { sin, cos } = sinCos(unit(hm, 1, seed) * TWO_PI);
          const r = rule.cluster.radius * Math.sqrt(unit(hm, 2, seed));
          if (this.place(compiled, x + cos * r, z + sin * r, hm, out, reserve)) count++;
        }
      }
    }
    return count;
  }

  /** Per-spot tests and placement for one candidate; `h` seeds its prop, scale and yaw. */
  private place(rule: CompiledRule, x: number, z: number, h: number, out: Map<string, number[]>, reserve: boolean): boolean {
    const { source, seed } = rule;
    const half = this.map.terrain.size / 2 - 2;
    if (x < -half || x > half || z < -half || z > half) return false;
    const slope = this.terrain.slopeTanAt(x, z);
    if (slope > rule.maxTan || slope < rule.minTan) return false;
    if (rule.excluded.size > 0 && rule.excluded.has(this.dominantSurface(x, z))) return false;

    const def = rule.defs[pickWeighted(source.props, unit(h, 4, seed) * rule.totalWeight)]!;
    const [scaleMin, scaleMax] = source.scaleRange ?? [1, 1];
    const scale = quantizeScale(scaleMin + (scaleMax - scaleMin) * unit(h, 5, seed));
    const radius = def.footprint * scale;
    const clearance = source.clearance ?? DEFAULT_CLEARANCE[def.category];
    const avoidPads = source.avoidPads ?? (def.category === "tree" || def.category === "rock");

    if (avoidPads && this.onPad(x, z, radius + 1)) return false;
    if (this.nearPath(x, z, radius + clearance)) return false;
    if (this.nearBuilding(x, z, radius + clearance)) return false;
    if (this.nearBlocker(x, z, radius + 0.3)) return false;
    if (def.category !== "grass" && this.nearOccupied(x, z, radius)) return false;

    this.push(out, def, x, z, unit(h, 6, seed) * TWO_PI, scale, source.alignToTerrain ?? def.alignToTerrain ?? false);
    if (reserve && def.category !== "grass") this.reserve(x, z, radius);
    return true;
  }

  /** Resolves an explicit placement into the instance format. */
  pushPlaced(placement: PropPlacement, out: Map<string, number[]>): void {
    const def = getMapProp(placement.prop);
    const [x, y, z] = placement.position;
    const align = placement.alignToTerrain ?? def.alignToTerrain ?? false;
    const snap = placement.snapToTerrain ?? false;
    this.push(out, def, x, z, placement.yaw, placement.scale ?? 1, align, snap ? undefined : y);
  }

  private push(out: Map<string, number[]>, def: MapPropDef, x: number, z: number, yaw: number, scale: number, align: boolean, fixedY?: number): void {
    let nx = 0;
    let nz = 0;
    if (align) {
      this.terrain.sampleNormal(x, z, this.normal);
      nx = this.normal.x;
      nz = this.normal.z;
    }
    const y = fixedY ?? this.terrain.sampleHeight(x, z) - (def.sink ?? 0) * scale;
    let list = out.get(def.id);
    if (!list) out.set(def.id, (list = []));
    list.push(x, y, z, yaw, scale, nx, nz);
  }

  private dominantSurface(x: number, z: number): number {
    const w = this.terrain.surfaceWeightsAt(x, z, this.weights);
    let best = 0;
    for (let k = 1; k < 4; k++) if (w[k]! > w[best]!) best = k;
    return best;
  }

  private onPad(x: number, z: number, margin: number): boolean {
    for (const pad of this.pads) {
      if (pad.shape === "circle") {
        const dx = x - pad.center[0];
        const dz = z - pad.center[1];
        if (dx * dx + dz * dz < (pad.radius + margin) * (pad.radius + margin)) return true;
      } else if (distanceToRect({ center: pad.center, halfExtents: pad.halfExtents, yaw: pad.yaw ?? 0 }, x, z) < margin) {
        return true;
      }
    }
    return false;
  }

  private nearPath(x: number, z: number, margin: number): boolean {
    return this.paths.query(x, z, margin + MAX_PATH_HALF_WIDTH, (s) => segmentDistance(x, z, s.ax, s.az, s.bx, s.bz) < s.halfWidth + margin);
  }

  private nearBuilding(x: number, z: number, margin: number): boolean {
    return this.buildings.query(x, z, margin, (rect) => distanceToRect(rect, x, z) < margin);
  }

  private nearBlocker(x: number, z: number, margin: number): boolean {
    return this.blockers.query(x, z, margin, (rect) => distanceToRect(rect, x, z) < margin);
  }

  private nearOccupied(x: number, z: number, radius: number): boolean {
    return this.occupied.query(x, z, radius, (c) => (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) < (c.radius + radius) * (c.radius + radius));
  }
}

interface CompiledRule {
  readonly source: ScatterRule;
  readonly seed: number;
  readonly spacing: number;
  readonly defs: readonly MapPropDef[];
  readonly totalWeight: number;
  readonly maxTan: number;
  readonly minTan: number;
  readonly excluded: ReadonlySet<number>;
}

function compileRule(rule: ScatterRule): CompiledRule {
  return {
    source: rule,
    seed: rule.seed ?? seedFromId(rule.id),
    spacing: 10 / Math.sqrt(rule.density),
    defs: rule.props.map((p) => getMapProp(p.prop)),
    totalWeight: rule.props.reduce((sum, p) => sum + p.weight, 0),
    maxTan: rule.maxSlopeDegrees === undefined ? Infinity : tanDegrees(rule.maxSlopeDegrees),
    minTan: rule.minSlopeDegrees === undefined ? -1 : tanDegrees(rule.minSlopeDegrees),
    excluded: new Set((rule.excludeSurfaces ?? []).map((s) => TERRAIN_SURFACES.indexOf(s))),
  };
}

function unit(h: number, k: number, seed: number): number {
  return hash2(h | 0, k, seed) / 4294967296;
}

function quantizeScale(scale: number): number {
  return Math.round(scale * SCALE_STEPS) / SCALE_STEPS;
}

function pickWeighted(entries: readonly { readonly weight: number }[], value: number): number {
  let acc = 0;
  for (let i = 0; i < entries.length; i++) {
    acc += entries[i]!.weight;
    if (value < acc) return i;
  }
  return entries.length - 1;
}

function tanDegrees(degrees: number): number {
  const { sin, cos } = sinCos((degrees * Math.PI) / 180);
  return sin / cos;
}

/** FNV-1a of a string, as a uint32 seed. */
export function seedFromId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
