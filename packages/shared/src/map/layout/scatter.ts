import { getBuildingPrefab } from "../buildings/prefabs";
import { sinCos, smoothstep, TWO_PI } from "../terrain/math";
import { fbm, hash2 } from "../terrain/noise";
import type { Terrain } from "../terrain/terrain";
import { TERRAIN_SURFACES, type FlattenRegion, type MapData, type PropPlacement, type PropScatter, type Vec2Tuple } from "../types";
import type { ResolvedBuilding } from "./buildings";
import { distanceToRect, offsetPoint, pointInPolygon, polygonBounds, polygonEdgeDistance, segmentDistance, SpatialHash, type OrientedRect } from "./geometry";
import { getMapProp, type MapPropDef, type PropCategory } from "./props";
import { mapPaths } from "./roads";

/**
 * A coverage/density field on a regular grid, row-major from `origin` (the south-west sample). `values` holds one
 * digit "0".."9" per cell, so a 10 m grid over a 1 km map is a readable ~17 KB string in a generated module instead of
 * 17 000 numbers. Sampled bilinearly; outside the grid the edge samples extend.
 */
export interface WeightGrid {
  readonly origin: Vec2Tuple;
  readonly spacing: number;
  readonly columns: number;
  readonly rows: number;
  /** `columns × rows` digits "0".."9", row-major: weight = digit / 9. */
  readonly values: string;
}

const ZERO_CODE = 48;

/** Bilinear weight 0..1 at a world point; edge samples extend outside the grid. */
export function sampleWeightGrid(grid: WeightGrid, x: number, z: number): number {
  const { columns, rows, values } = grid;
  const gx = Math.min(columns - 1, Math.max(0, (x - grid.origin[0]) / grid.spacing));
  const gz = Math.min(rows - 1, Math.max(0, (z - grid.origin[1]) / grid.spacing));
  const ix = Math.min(columns - 2, Math.floor(gx));
  const iz = Math.min(rows - 2, Math.floor(gz));
  const tx = gx - ix;
  const tz = gz - iz;
  const at = (i: number, j: number) => values.charCodeAt(j * columns + i) - ZERO_CODE;
  const a = at(ix, iz) + (at(ix + 1, iz) - at(ix, iz)) * tx;
  const b = at(ix, iz + 1) + (at(ix + 1, iz + 1) - at(ix, iz + 1)) * tx;
  return (a + (b - a) * tz) / 9;
}

/**
 * Seeded scatter rule. Extends MapData's PropScatter with the knobs map v1 needs; every extra field is optional, so
 * a plain PropScatter still expands.
 */
export interface ScatterRule extends PropScatter {
  /** Defaults to a hash of `id`. */
  readonly seed?: number;
  /** Noise density mask: clearings and clumps. `threshold` 0..1 is the noise level where density reaches half. */
  readonly mask?: { readonly wavelength: number; readonly threshold: number; readonly softness?: number };
  /**
   * Density weight per world cell, multiplied into the spot's chance (real-world maps: the wilderness coverage mask,
   * which is 0 over the mapped city and rises to 1 in the empty ground). One grid is shared by every rule that uses it.
   */
  readonly weightGrid?: WeightGrid;
  /** Uses `1 - weight` instead, so one shared grid can drive both the wilderness rules and the city-only ones. */
  readonly weightGridInvert?: boolean;
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
  /**
   * Each accepted lattice spot seeds `count` [min, max] instances within `radius` (cover clusters); `density` then counts clusters.
   * `anchor`: with probability `chance` the first member is one large piece from its own palette, near the cluster center.
   */
  readonly cluster?: {
    readonly count: readonly [min: number, max: number];
    readonly radius: number;
    readonly anchor?: { readonly props: PropScatter["props"]; readonly chance: number; readonly scaleRange?: readonly [min: number, max: number] };
  };
  /** Candidate spots instead of the jittered lattice (hand-picked spots that still need terrain-aware yaw or tests); `density` and `mask` are ignored. */
  readonly spots?: readonly Vec2Tuple[];
  /** Only this far inside the area outline, m (wood edges). */
  readonly edgeBand?: number;
  /** Minimum distance between this rule's own instances, m. Not tiling-safe, so not for detail rules. */
  readonly minDistance?: number;
  /** Skips spots with hard cover (see `isHardCover`, buildings included) within this distance: fills cover gaps only. */
  readonly bareRadius?: number;
  /**
   * Turns each instance's front (local +Z) downhill and seats it on the terrain half a footprint downhill, so the back
   * sinks into the slope (open scanned rock faces).
   */
  readonly faceDownhill?: boolean;
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

/** Clearance kept between collidable scatter and building entrances, m (beyond the collider). */
export const ENTRANCE_CLEARANCE = 1.5;

/** Blocks movement and bullets and hides at least a crouched player side-on: trunks from 0.2 m radius, boxes from 0.9 m tall and wide. */
export function isHardCover(def: MapPropDef, scale = 1): boolean {
  const c = def.collision;
  if (c.kind === "cylinder") return c.radius * scale >= 0.2;
  return c.kind === "box" && c.bulletproof && c.size[1] * scale >= 0.9 && Math.max(c.size[0], c.size[2]) * scale >= 0.9;
}

/** Horizontal reach of a prop's collider from its origin, m at `scale`. */
export function colliderReach(def: MapPropDef, scale = 1): number {
  const c = def.collision;
  if (c.kind === "none") return 0;
  if (c.kind === "cylinder") return c.radius * scale;
  return (Math.sqrt(c.size[0] * c.size[0] + c.size[2] * c.size[2]) / 2) * scale;
}

interface Palette {
  readonly props: PropScatter["props"];
  readonly defs: readonly MapPropDef[];
  readonly totalWeight: number;
  readonly scaleRange: readonly [number, number];
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
  private readonly cover = new SpatialHash<Circle>(CELL);
  private readonly entrances = new SpatialHash<Circle>(CELL);
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
      const reach = Math.sqrt(hx * hx + hz * hz);
      this.buildings.insert(building.bounds, building.bounds.center[0], building.bounds.center[1], reach);
      this.cover.insert({ x: building.bounds.center[0], z: building.bounds.center[1], radius: reach }, building.bounds.center[0], building.bounds.center[1], reach);
      if (!building.stackOn) {
        for (const [lx, , lz] of getBuildingPrefab(building.prefab).entrances) {
          const [ex, ez] = offsetPoint([building.position[0], building.position[2]], building.yaw, lx, lz);
          this.entrances.insert({ x: ex, z: ez, radius: 0 }, ex, ez, 0);
        }
      }
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
    if (isHardCover(def, scale)) this.cover.insert({ x, z, radius: 0 }, x, z, 0);
  }

  private reserve(x: number, z: number, radius: number): void {
    this.occupied.insert({ x, z, radius }, x, z, radius);
  }

  /** Expands a rule over its whole area, appending instances per prop to `out`. Returns the instance count. */
  expand(rule: ScatterRule, out: Map<string, number[]>): number {
    if (rule.spots) return this.expandSpots(rule, out);
    const bounds = polygonBounds(rule.area);
    return this.expandRegion(rule, bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, out, !rule.detail);
  }

  private expandSpots(rule: ScatterRule, out: Map<string, number[]>): number {
    const compiled = compileRule(rule);
    const spacing = rule.minDistance ? new SpatialHash<Circle>(CELL) : null;
    let count = 0;
    rule.spots!.forEach(([x, z], index) => {
      if (this.place(compiled, compiled.palette, x, z, hash2(index, 0x5b07, compiled.seed), out, true, spacing)) count++;
    });
    return count;
  }

  /**
   * Expands a rule inside a world rectangle. Candidates come from a lattice anchored at the world origin, so any
   * rectangle yields exactly the instances a whole-area expansion would place there (before occupancy).
   */
  expandRegion(rule: ScatterRule, minX: number, minZ: number, maxX: number, maxZ: number, out: Map<string, number[]>, reserve = false): number {
    if (rule.props.length === 0 || rule.density <= 0) return 0;
    const compiled = compileRule(rule);
    const { seed, spacing } = compiled;
    const own = rule.minDistance ? new SpatialHash<Circle>(CELL) : null;
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
        if (inExclusion(compiled.exclusions, x, z)) continue;

        let chance = 1;
        // Cheapest test first: the coverage weight is zero over most of a city map.
        if (rule.weightGrid) {
          const w = sampleWeightGrid(rule.weightGrid, x, z);
          chance = rule.weightGridInvert ? 1 - w : w;
          if (chance <= 0) continue;
        }
        if (rule.mask) {
          const noise = (fbm(x / rule.mask.wavelength, z / rule.mask.wavelength, 3, seed ^ 0x51ed) + 1) / 2;
          const soft = rule.mask.softness ?? 0.08;
          chance *= smoothstep(rule.mask.threshold - soft, rule.mask.threshold + soft, noise);
        }
        if (rule.edgeFade) chance *= smoothstep(0, rule.edgeFade, polygonEdgeDistance(rule.area, x, z));
        if (rule.edgeBand !== undefined && polygonEdgeDistance(rule.area, x, z) > rule.edgeBand) continue;
        if (unit(h, 3, seed) >= chance) continue;

        if (!rule.cluster) {
          if (this.place(compiled, compiled.palette, x, z, h, out, reserve, own)) count++;
          continue;
        }
        const [least, most] = rule.cluster.count;
        const members = least + Math.floor(unit(h, 7, seed) * (most - least + 1));
        const anchored = compiled.anchor !== null && unit(h, 8, seed) < rule.cluster.anchor!.chance;
        for (let m = 0; m < members; m++) {
          const hm = hash2(h | 0, 100 + m, seed);
          const { sin, cos } = sinCos(unit(hm, 1, seed) * TWO_PI);
          const anchor = anchored && m === 0;
          const r = rule.cluster.radius * (anchor ? 0.3 : 1) * Math.sqrt(unit(hm, 2, seed));
          // Members spill up to `radius` from the center, so they need the exclusion test too.
          if (inExclusion(compiled.exclusions, x + cos * r, z + sin * r)) continue;
          if (this.place(compiled, anchor ? compiled.anchor! : compiled.palette, x + cos * r, z + sin * r, hm, out, reserve, own)) count++;
        }
      }
    }
    return count;
  }

  /** Per-spot tests and placement for one candidate; `h` seeds its prop, scale and yaw. `own` holds the rule's instances for `minDistance`. */
  private place(rule: CompiledRule, palette: Palette, x: number, z: number, h: number, out: Map<string, number[]>, reserve: boolean, own: SpatialHash<Circle> | null = null): boolean {
    const { source, seed } = rule;
    const half = this.map.terrain.size / 2 - 2;
    if (x < -half || x > half || z < -half || z > half) return false;
    const slope = this.terrain.slopeTanAt(x, z);
    if (slope > rule.maxTan || slope < rule.minTan) return false;
    if (rule.excluded.size > 0 && rule.excluded.has(this.dominantSurface(x, z))) return false;

    const def = palette.defs[pickWeighted(palette.props, unit(h, 4, seed) * palette.totalWeight)]!;
    const [scaleMin, scaleMax] = palette.scaleRange;
    const scale = quantizeScale(scaleMin + (scaleMax - scaleMin) * unit(h, 5, seed));
    const radius = def.footprint * scale;
    const clearance = source.clearance ?? DEFAULT_CLEARANCE[def.category];
    const avoidPads = source.avoidPads ?? (def.category === "tree" || def.category === "rock");

    if (avoidPads && this.onPad(x, z, radius + 1)) return false;
    if (this.nearPath(x, z, radius + clearance)) return false;
    if (this.nearBuilding(x, z, radius + clearance)) return false;
    if (this.nearBlocker(x, z, radius + 0.3)) return false;
    if (def.category !== "grass" && this.nearOccupied(x, z, radius)) return false;
    if (def.collision.kind !== "none" && this.nearEntrance(x, z, colliderReach(def, scale) + ENTRANCE_CLEARANCE)) return false;
    if (own && source.minDistance && nearPoint(own, x, z, source.minDistance)) return false;
    if (source.bareRadius && nearPoint(this.cover, x, z, source.bareRadius)) return false;

    let yaw = unit(h, 6, seed) * TWO_PI;
    let fixedY: number | undefined;
    if (source.faceDownhill) {
      this.terrain.sampleNormal(x, z, this.normal);
      const horizontal = Math.sqrt(this.normal.x * this.normal.x + this.normal.z * this.normal.z);
      if (horizontal > 1e-6) {
        // Front (local +Z) is (sin yaw, cos yaw) in world XZ; the normal's horizontal part points downhill.
        // Rounded so an engine's last-ulp atan2 difference can't change the layout checksum.
        yaw = Math.round(Math.atan2(this.normal.x, this.normal.z) * 1e4) / 1e4;
        const ahead = radius / 2 / horizontal;
        fixedY = this.terrain.sampleHeight(x + this.normal.x * ahead, z + this.normal.z * ahead) - (def.sink ?? 0) * scale;
      }
    }

    this.push(out, def, x, z, yaw, scale, source.alignToTerrain ?? def.alignToTerrain ?? false, fixedY);
    if (reserve && def.category !== "grass") this.reserve(x, z, radius);
    if (reserve && isHardCover(def, scale)) this.cover.insert({ x, z, radius: 0 }, x, z, 0);
    own?.insert({ x, z, radius: 0 }, x, z, 0);
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

  private nearEntrance(x: number, z: number, margin: number): boolean {
    return nearPoint(this.entrances, x, z, margin);
  }

  private nearOccupied(x: number, z: number, radius: number): boolean {
    return this.occupied.query(x, z, radius, (c) => (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) < (c.radius + radius) * (c.radius + radius));
  }
}

function nearPoint(hash: SpatialHash<Circle>, x: number, z: number, distance: number): boolean {
  return hash.query(x, z, distance, (c) => (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z) < (distance + c.radius) * (distance + c.radius));
}

interface CompiledRule {
  readonly source: ScatterRule;
  readonly seed: number;
  readonly spacing: number;
  readonly palette: Palette;
  readonly anchor: Palette | null;
  readonly maxTan: number;
  readonly minTan: number;
  readonly excluded: ReadonlySet<number>;
  readonly exclusions: readonly Exclusion[];
}

/** An `exclude` polygon with its bounds: a point outside the bounds is never inside (ray-cast parity), so most tests skip the polygon walk. */
interface Exclusion {
  readonly polygon: readonly Vec2Tuple[];
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

function inExclusion(exclusions: readonly Exclusion[], x: number, z: number): boolean {
  for (const e of exclusions) {
    if (x >= e.minX && x <= e.maxX && z >= e.minZ && z <= e.maxZ && pointInPolygon(e.polygon, x, z)) return true;
  }
  return false;
}

function compileRule(rule: ScatterRule): CompiledRule {
  return {
    source: rule,
    seed: rule.seed ?? seedFromId(rule.id),
    spacing: 10 / Math.sqrt(rule.density),
    palette: compilePalette(rule.props, rule.scaleRange),
    anchor: rule.cluster?.anchor ? compilePalette(rule.cluster.anchor.props, rule.cluster.anchor.scaleRange ?? rule.scaleRange) : null,
    maxTan: rule.maxSlopeDegrees === undefined ? Infinity : tanDegrees(rule.maxSlopeDegrees),
    minTan: rule.minSlopeDegrees === undefined ? -1 : tanDegrees(rule.minSlopeDegrees),
    excluded: new Set((rule.excludeSurfaces ?? []).map((s) => TERRAIN_SURFACES.indexOf(s))),
    exclusions: (rule.exclude ?? []).map((polygon) => ({ polygon, ...polygonBounds(polygon) })),
  };
}

function compilePalette(props: PropScatter["props"], scaleRange: readonly [number, number] | undefined): Palette {
  return { props, defs: props.map((p) => getMapProp(p.prop)), totalWeight: props.reduce((sum, p) => sum + p.weight, 0), scaleRange: scaleRange ?? [1, 1] };
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
