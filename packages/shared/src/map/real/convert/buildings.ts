import { getBuildingPrefab, type BuildingPrefabId } from "../../buildings/prefabs";
import { hash2 } from "../../terrain/noise";
import { sinCos } from "../../terrain/math";
import type { LayoutBuilding } from "../../layout/buildings";
import { distance, distanceToRect, offsetPoint, pointInPolygon, polygonEdgeDistance, rectCorners, rectsOverlap, round3, SpatialHash, type OrientedRect } from "../../layout/geometry";
import type { MapPath } from "../../layout/roads";
import type { Vec2Tuple } from "../../types";
import { centroid, minAreaRect, type MinRect } from "./geometry";
import type { AreaFeature, OsmTags, Polygon } from "./types";

/** Buildings stay this far inside the playable edge (the border foothills start 40 m in), m. */
export const BUILDING_EDGE = 445;
/** Gap between a building's outline and a road or creek edge, m (validation needs 1). */
export const ROAD_GAP = 1.6;
/** Gap between building outlines, m (validation needs 1; pads need a little more). */
export const BUILDING_GAP = 2;
/** Gap between a building's outline and a water area, m. */
export const WATER_GAP = 5;
/** Default building cap per map. */
export const DEFAULT_BUILDING_CAP = 90;
/** Gap between neighbouring row houses in a city frontage row, m (urban validation keeps 0.1). */
export const ROW_GAP = 0.12;
/** At most this many of each expensive or odd prefab per map. */
const PREFAB_LIMITS: Partial<Record<BuildingPrefabId, number>> = { warehouse: 4, barracks: 5, watchtower: 4, container_open: 6, container_open_blue: 6, container_closed: 4 };

const RELIGIOUS = new Set(["church", "chapel", "cathedral", "shrine", "temple", "mosque", "bell_tower", "wayside_shrine", "religious", "monastery"]);
const SMALL_SHEDS = new Set(["garage", "garages", "shed", "hut", "cabin", "kiosk", "storage_tank", "boathouse"]);
const FARM = new Set(["barn", "farm_auxiliary", "stable", "cowshed", "sty", "agricultural", "silo", "granary", "greenhouse"]);
const INDUSTRIAL = new Set(["industrial", "warehouse", "commercial", "retail", "supermarket", "hangar", "manufacture", "factory", "service"]);
const INSTITUTIONAL = new Set(["school", "civic", "public", "office", "hotel", "apartments", "dormitory", "hospital", "government", "kindergarten", "college", "university", "transportation", "train_station", "fire_station"]);
const SKIPPED = new Set(["roof", "carport", "construction", "transformer_tower", "bunker", "ruins_foundation", "no", "collapsed", "grandstand", "bridge", "toilets"]);

/** A footprint the converter considered, with the prefab it maps to. */
export interface BuildingCandidate {
  readonly osmId: number;
  readonly tags: OsmTags;
  /** Footprint area, m². */
  readonly area: number;
  readonly rect: MinRect;
  readonly centroid: Vec2Tuple;
  readonly prefab: BuildingPrefabId;
  /** Urban frontage rows: an exact placement (no push-back) packed `ROW_GAP` from its neighbours. */
  readonly fixed?: { readonly position: Vec2Tuple; readonly yaw: number };
  /** Urban placement priority, lower first (distance from the center weighted by street class). */
  readonly rank?: number;
}

/** A building placed on the map, before terrain snapping. */
export interface PlacedBuilding extends LayoutBuilding {
  readonly osmId: number;
  /** Footprint area of the OSM outline, m². */
  readonly area: number;
  /** Whole prefab outline in world XZ (for spacing and pads). */
  readonly bounds: OrientedRect;
  /** How far the placement moved from the real footprint center, m. */
  readonly displacement: number;
}

export function buildingId(osmId: number): string {
  return osmId < 0 ? `bld_r${-osmId}` : `bld_${osmId}`;
}

/** Deterministic 0..1 from an OSM id and a salt. */
function unitHash(osmId: number, salt: number): number {
  return hash2(osmId | 0, Math.floor(osmId / 4294967296) | 0, 0x7ea1 + salt) / 4294967296;
}

/** Picks the prefab for a footprint (null: skipped). */
export function prefabFor(tags: OsmTags, area: number, rect: MinRect): BuildingPrefabId | null {
  const kind = tags.building ?? "yes";
  if (SKIPPED.has(kind) || tags["building:part"] || tags.location === "underground") return null;
  if (area < 20) return null;
  const length = rect.halfLength * 2;
  const width = rect.halfWidth * 2;
  const ruined = kind === "ruins" || tags.ruins === "yes" || tags.abandoned === "yes";
  const levels = Number.parseFloat(tags["building:levels"] ?? "");
  if (RELIGIOUS.has(kind) || tags.amenity === "place_of_worship") return area < 70 ? "watchtower" : "barn";
  if (SMALL_SHEDS.has(kind) || area < 38) {
    if (area >= 60) return "house_small";
    return unitHash(0, Math.round(area * 10)) < 0.5 ? "container_open" : "container_open_blue";
  }
  if (FARM.has(kind)) return area >= 300 && width >= 14 ? "warehouse" : area >= 130 ? "barn" : "house_small";
  if (INDUSTRIAL.has(kind)) return area >= 320 && width >= 13 ? "warehouse" : area >= 150 && length / width >= 1.6 ? "barracks" : area >= 110 ? "house_two_story" : "house_small";
  if (INSTITUTIONAL.has(kind)) return area >= 170 && length / width >= 1.5 ? "barracks" : area >= 110 ? "house_two_story" : "house_small";
  // Houses and untagged buildings.
  // Long farmhouse wings read best as the plank barn (the flat-roofed barracks look military).
  if (length >= 17 && length / width >= 1.6 && area >= 150) return "barn";
  if (area >= 260) return length / width >= 1.25 ? "barn" : "house_two_story";
  if (area >= 125 || levels >= 2) return "house_two_story";
  return ruined ? "house_small_ruined" : "house_small";
}

/** Tube house variant for a city footprint: by `building:levels` when tagged, else a seeded mix (mostly 2–3 stories). */
export function tubeHouseFor(osmId: number, levels: number, salt = 0): BuildingPrefabId {
  if (levels >= 4) return "tube_house_4";
  if (levels >= 3) return "tube_house_3";
  if (levels >= 1) return "tube_house_2";
  const r = unitHash(osmId, 7 + salt);
  return r < 0.45 ? "tube_house_2" : r < 0.85 ? "tube_house_3" : "tube_house_4";
}

/**
 * City mapping (`PlaceConfig.urban`): narrow houses and small shops become tube houses, big footprints become flat-roofed
 * blocks (barracks, warehouses) or two-story houses. No barns, containers or ruins in a city street.
 */
export function urbanPrefabFor(osmId: number, tags: OsmTags, area: number, rect: MinRect): BuildingPrefabId | null {
  const kind = tags.building ?? "yes";
  if (SKIPPED.has(kind) || tags["building:part"] || tags.location === "underground") return null;
  if (area < 20) return null;
  const length = rect.halfLength * 2;
  const width = rect.halfWidth * 2;
  const levels = Number.parseFloat(tags["building:levels"] ?? "");
  const big = (): BuildingPrefabId => (area >= 600 && width >= 14 ? "warehouse" : area >= 170 && length / width >= 1.5 ? "barracks" : "house_two_story");
  if (RELIGIOUS.has(kind) || tags.amenity === "place_of_worship" || INDUSTRIAL.has(kind) || INSTITUTIONAL.has(kind)) return area >= 110 ? big() : tubeHouseFor(osmId, levels);
  if (SMALL_SHEDS.has(kind) || FARM.has(kind)) return tubeHouseFor(osmId, 2);
  if (width <= 9 || area < 150) return tubeHouseFor(osmId, Number.isFinite(levels) ? levels : 0);
  return big();
}

/** Footprints inside the building edge that map to a prefab. */
export function buildingCandidates(features: readonly AreaFeature[], urban = false): BuildingCandidate[] {
  const out: BuildingCandidate[] = [];
  for (const feature of features) {
    const c = centroid(feature.outer);
    if (Math.abs(c[0]) > BUILDING_EDGE || Math.abs(c[1]) > BUILDING_EDGE) continue;
    const rect = minAreaRect(feature.outer);
    if (urban) {
      const prefab = urbanPrefabFor(feature.id, feature.tags, feature.area, rect);
      if (prefab) out.push({ osmId: feature.id, tags: feature.tags, area: feature.area, rect, centroid: c, prefab });
      continue;
    }
    let prefab = prefabFor(feature.tags, feature.area, rect);
    if (!prefab) continue;
    // A few real houses become ruins (deterministic per OSM id), like the fictional map's mix.
    if (prefab === "house_small" && unitHash(feature.id, 1) < 0.12) prefab = "house_small_ruined";
    out.push({ osmId: feature.id, tags: feature.tags, area: feature.area, rect, centroid: c, prefab });
  }
  return out.sort((a, b) => a.osmId - b.osmId);
}

/** Yaw for a prefab-local axis: `localLong` "x" turns local +X toward `axis`, "z" turns local +Z toward it. */
function yawAlong(axis: Vec2Tuple, localLong: "x" | "z"): number {
  // Local +X → (cos yaw, −sin yaw); local +Z → (sin yaw, cos yaw).
  return localLong === "x" ? Math.atan2(-axis[1], axis[0]) : Math.atan2(axis[0], axis[1]);
}

function normalizeYaw(yaw: number): number {
  let y = yaw;
  while (y > Math.PI) y -= 2 * Math.PI;
  while (y <= -Math.PI) y += 2 * Math.PI;
  return Math.round(y * 1000) / 1000;
}

export function prefabRect(prefab: BuildingPrefabId, position: Vec2Tuple, yaw: number, margin = 0): OrientedRect {
  const { min, max } = getBuildingPrefab(prefab).bounds;
  const center = offsetPoint(position, yaw, (min[0] + max[0]) / 2, (min[2] + max[2]) / 2);
  return { center, halfExtents: [(max[0] - min[0]) / 2 + margin, (max[2] - min[2]) / 2 + margin], yaw };
}

interface Segment {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly halfWidth: number;
}

/** Road, creek and water tests for placements. */
export class PlacementSpace {
  private readonly segments = new SpatialHash<Segment>(24);
  private readonly placed = new SpatialHash<OrientedRect>(24);
  private readonly water: readonly { polygon: Polygon; minX: number; maxX: number; minZ: number; maxZ: number }[];

  constructor(
    paths: readonly MapPath[],
    water: readonly Polygon[],
  ) {
    for (const path of paths) {
      for (let i = 0; i + 1 < path.points.length; i++) {
        const [ax, az] = path.points[i]!;
        const [bx, bz] = path.points[i + 1]!;
        this.segments.insert({ ax, az, bx, bz, halfWidth: path.halfWidth }, (ax + bx) / 2, (az + bz) / 2, distance(ax, az, bx, bz) / 2 + path.halfWidth);
      }
    }
    this.water = water.map((polygon) => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const [x, z] of polygon) [minX, maxX, minZ, maxZ] = [Math.min(minX, x), Math.max(maxX, x), Math.min(minZ, z), Math.max(maxZ, z)];
      return { polygon, minX, maxX, minZ, maxZ };
    });
  }

  /** Nearest road (or creek) point within `radius`, or null. */
  nearestPath(x: number, z: number, radius: number): Vec2Tuple | null {
    let best: Vec2Tuple | null = null;
    let bestDistance = radius;
    this.segments.query(x, z, radius, (s) => {
      const abx = s.bx - s.ax;
      const abz = s.bz - s.az;
      const lengthSq = abx * abx + abz * abz;
      const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * abx + (z - s.az) * abz) / lengthSq)) : 0;
      const px = s.ax + abx * t;
      const pz = s.az + abz * t;
      const d = distance(x, z, px, pz) - s.halfWidth;
      if (d < bestDistance) [best, bestDistance] = [[px, pz], d];
    });
    return best;
  }

  /** True when the rect clears roads and creeks by `gap` (sampled along each nearby segment every meter). */
  clearOfPaths(rect: OrientedRect, gap: number): boolean {
    const reach = Math.sqrt(rect.halfExtents[0] * rect.halfExtents[0] + rect.halfExtents[1] * rect.halfExtents[1]);
    return !this.segments.query(rect.center[0], rect.center[1], reach + gap + 8, (s) => {
      const steps = Math.max(1, Math.ceil(distance(s.ax, s.az, s.bx, s.bz)));
      for (let k = 0; k <= steps; k++) {
        if (distanceToRect(rect, s.ax + ((s.bx - s.ax) * k) / steps, s.az + ((s.bz - s.az) * k) / steps) < s.halfWidth + gap) return true;
      }
      return false;
    });
  }

  clearOfWater(rect: OrientedRect, gap: number): boolean {
    const points = [rect.center, ...rectCorners(rect)];
    for (const w of this.water) {
      const [cx, cz] = rect.center;
      if (cx < w.minX - 40 || cx > w.maxX + 40 || cz < w.minZ - 40 || cz > w.maxZ + 40) continue;
      for (const [x, z] of points) {
        if (pointInPolygon(w.polygon, x, z) || polygonEdgeDistance(w.polygon, x, z) < gap) return false;
      }
    }
    return true;
  }

  insideWater(x: number, z: number): boolean {
    return this.water.some((w) => x >= w.minX && x <= w.maxX && z >= w.minZ && z <= w.maxZ && pointInPolygon(w.polygon, x, z));
  }

  clearOfPlaced(rect: OrientedRect, gap: number): boolean {
    const reach = Math.sqrt(rect.halfExtents[0] * rect.halfExtents[0] + rect.halfExtents[1] * rect.halfExtents[1]);
    return !this.placed.query(rect.center[0], rect.center[1], reach + gap + 20, (other) => rectsOverlap(rect, other, gap));
  }

  addPlaced(rect: OrientedRect): void {
    const reach = Math.sqrt(rect.halfExtents[0] * rect.halfExtents[0] + rect.halfExtents[1] * rect.halfExtents[1]);
    this.placed.insert(rect, rect.center[0], rect.center[1], reach);
  }
}

/** Candidate yaws of a prefab over a footprint: its long axis along the footprint's (both ways; four ways when either is square). */
function candidateYaws(prefab: BuildingPrefabId, rect: MinRect): number[] {
  const { min, max } = getBuildingPrefab(prefab).bounds;
  const sx = max[0] - min[0];
  const sz = max[2] - min[2];
  const prefabSquare = Math.abs(sx - sz) / Math.max(sx, sz) < 0.15;
  const footprintSquare = rect.halfLength < rect.halfWidth * 1.2;
  const base = yawAlong(rect.axis, sx >= sz ? "x" : "z");
  const yaws = [base, base + Math.PI];
  if (prefabSquare || footprintSquare) yaws.push(base + Math.PI / 2, base - Math.PI / 2);
  return yaws.map(normalizeYaw);
}

export interface PlacementReport {
  readonly candidates: number;
  readonly placed: number;
  /** Dropped because nothing near the footprint cleared roads, water and neighbours. */
  readonly droppedConflicts: number;
  /** Dropped by the building cap (outskirts first). */
  readonly droppedCap: number;
  readonly pushedBack: number;
}

/**
 * Places candidates in priority order: every settlement cluster gets a share of the cap by its size, core buildings first,
 * then the rest by footprint size. Each building faces its nearest road (entrance, local +Z, toward it) and is pushed
 * back from the road or nudged sideways up to 8 m when it would touch a road, a creek, water or a neighbour; otherwise
 * dropped. `excluded` ids are skipped (dropped by a later validation or reachability pass).
 */
export function placeBuildings(
  candidates: readonly BuildingCandidate[],
  space: PlacementSpace,
  options: { readonly cap: number; readonly excluded: ReadonlySet<string>; readonly cellQuota?: number },
): { buildings: PlacedBuilding[]; report: PlacementReport } {
  const usable = candidates.filter((c) => !options.excluded.has(buildingId(c.osmId)));
  const ordered = options.cellQuota !== undefined ? rankedOrder(usable) : priorityOrder(usable, options.cap);
  const perCell = new Map<string, number>();
  const buildings: PlacedBuilding[] = [];
  const perPrefab = new Map<BuildingPrefabId, number>();
  let conflicts = 0;
  let pushed = 0;

  for (const candidate of ordered) {
    if (buildings.length >= options.cap) break;
    let prefab = candidate.prefab;
    const limit = PREFAB_LIMITS[prefab];
    if (limit !== undefined && (perPrefab.get(prefab) ?? 0) >= limit) {
      prefab = prefab === "warehouse" || prefab === "barracks" ? (options.cellQuota !== undefined ? "house_two_story" : "barn") : prefab === "watchtower" ? "house_small" : prefab.startsWith("container") ? "container_closed" : prefab;
      if ((perPrefab.get(prefab) ?? 0) >= (PREFAB_LIMITS[prefab] ?? Infinity)) continue;
    }
    let cell = "";
    if (options.cellQuota !== undefined) {
      const at = candidate.fixed?.position ?? candidate.rect.center;
      cell = `${Math.floor(at[0] / 100)},${Math.floor(at[1] / 100)}`;
      if ((perCell.get(cell) ?? 0) >= options.cellQuota) continue;
    }
    const placement = candidate.fixed ? placeFixed(candidate, prefab, space) : placeOne(candidate, prefab, space);
    if (!placement) {
      conflicts++;
      continue;
    }
    if (cell) perCell.set(cell, (perCell.get(cell) ?? 0) + 1);
    if (placement.displacement > 0.5) pushed++;
    perPrefab.set(prefab, (perPrefab.get(prefab) ?? 0) + 1);
    space.addPlaced(placement.bounds);
    buildings.push(placement);
  }
  return {
    buildings,
    report: { candidates: candidates.length, placed: buildings.length, droppedConflicts: conflicts, droppedCap: Math.max(0, usable.length - buildings.length - conflicts), pushedBack: pushed },
  };
}

function placeOne(candidate: BuildingCandidate, prefab: BuildingPrefabId, space: PlacementSpace): PlacedBuilding | null {
  const [cx, cz] = candidate.rect.center;
  const road = space.nearestPath(cx, cz, 70);
  const toRoad: Vec2Tuple = road ? normalize(road[0] - cx, road[1] - cz) : [0, 0];
  const yaws = candidateYaws(prefab, candidate.rect)
    .map((yaw) => {
      const { sin, cos } = sinCos(yaw);
      return { yaw, facing: sin * toRoad[0] + cos * toRoad[1] };
    })
    .sort((a, b) => b.facing - a.facing || a.yaw - b.yaw);
  const { min, max } = getBuildingPrefab(prefab).bounds;
  const localCenter: Vec2Tuple = [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2];

  // Best-facing yaw first; within it, the smallest move: back from the road, then sideways.
  for (const { yaw } of yaws.slice(0, 2)) {
    const { sin, cos } = sinCos(yaw);
    const front: Vec2Tuple = [sin, cos];
    const right: Vec2Tuple = [cos, -sin];
    for (const [back, side] of OFFSETS) {
      const rectCenter: Vec2Tuple = [cx - front[0] * back + right[0] * side, cz - front[1] * back + right[1] * side];
      const [ox, oz] = offsetPoint([0, 0], yaw, localCenter[0], localCenter[1]);
      const position: Vec2Tuple = [round3(rectCenter[0] - ox), round3(rectCenter[1] - oz)];
      const bounds = prefabRect(prefab, position, yaw);
      if (bounds.center[0] < -BUILDING_EDGE || bounds.center[0] > BUILDING_EDGE || bounds.center[1] < -BUILDING_EDGE || bounds.center[1] > BUILDING_EDGE) continue;
      if (!rectCorners(bounds).every(([x, z]) => Math.abs(x) <= BUILDING_EDGE + 5 && Math.abs(z) <= BUILDING_EDGE + 5)) continue;
      if (!space.clearOfPaths(bounds, ROAD_GAP)) continue;
      if (!space.clearOfPlaced(bounds, BUILDING_GAP)) continue;
      if (!space.clearOfWater(bounds, WATER_GAP)) continue;
      return {
        id: buildingId(candidate.osmId),
        prefab,
        position: [position[0], 0, position[1]],
        yaw,
        snapToTerrain: true,
        osmId: candidate.osmId,
        area: Math.round(candidate.area),
        bounds,
        displacement: round3(Math.sqrt(back * back + side * side)),
      };
    }
  }
  return null;
}

/** An urban row house at its frontage slot, packed against its neighbours; null when anything is in the way. */
function placeFixed(candidate: BuildingCandidate, prefab: BuildingPrefabId, space: PlacementSpace): PlacedBuilding | null {
  const { position, yaw } = candidate.fixed!;
  const bounds = prefabRect(prefab, position, yaw);
  if (!rectCorners(bounds).every(([x, z]) => Math.abs(x) <= BUILDING_EDGE + 5 && Math.abs(z) <= BUILDING_EDGE + 5)) return null;
  if (!space.clearOfPaths(bounds, ROAD_GAP)) return null;
  if (!space.clearOfPlaced(bounds, ROW_GAP)) return null;
  if (!space.clearOfWater(bounds, WATER_GAP)) return null;
  return { id: buildingId(candidate.osmId), prefab, position: [position[0], 0, position[1]], yaw, snapToTerrain: true, osmId: candidate.osmId, area: Math.round(candidate.area), bounds, displacement: 0 };
}

/** Urban order: by `rank` (OSM footprints and frontage slots interleaved), then id. */
function rankedOrder(candidates: readonly BuildingCandidate[]): BuildingCandidate[] {
  return [...candidates].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.osmId - b.osmId);
}

/** [back, side] offsets tried in order of distance, m. */
const OFFSETS: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let back = 0; back <= 8; back++) for (const side of [0, 1.5, -1.5, 3, -3, 5, -5]) out.push([back, side]);
  return out.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[0] - b[0] || b[1] - a[1]);
})();

function normalize(x: number, z: number): Vec2Tuple {
  const length = Math.sqrt(x * x + z * z);
  return length > 1e-9 ? [x / length, z / length] : [0, 0];
}

/** Clusters candidates by single linkage at `link` m (grid-accelerated); returns cluster index per candidate. */
export function clusterPoints(points: readonly Vec2Tuple[], link: number): number[] {
  const parent = points.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const hash = new SpatialHash<number>(link);
  points.forEach(([x, z], i) => hash.insert(i, x, z, 0));
  points.forEach(([x, z], i) => {
    hash.query(x, z, link, (j) => {
      if (j !== i && distance(x, z, points[j]![0], points[j]![1]) <= link) parent[find(i)] = find(j);
    });
  });
  const labels = new Map<number, number>();
  return points.map((_, i) => {
    const root = find(i);
    if (!labels.has(root)) labels.set(root, labels.size);
    return labels.get(root)!;
  });
}

/**
 * Cap-aware order: each settlement cluster (45 m linkage) gets a quota proportional to its size (at least 2), filled
 * core-first (most neighbours within 60 m), round-robin across clusters; everything else follows by footprint area.
 */
function priorityOrder(candidates: readonly BuildingCandidate[], cap: number): BuildingCandidate[] {
  const labels = clusterPoints(candidates.map((c) => c.centroid), 45);
  const clusters = new Map<number, BuildingCandidate[]>();
  candidates.forEach((c, i) => {
    const list = clusters.get(labels[i]!) ?? [];
    list.push(c);
    clusters.set(labels[i]!, list);
  });
  const neighbours = (c: BuildingCandidate) => candidates.reduce((n, o) => n + (o !== c && distance(c.centroid[0], c.centroid[1], o.centroid[0], o.centroid[1]) < 60 ? 1 : 0), 0);
  const score = new Map(candidates.map((c) => [c, neighbours(c) * 4 + Math.min(c.area, 400) / 40] as const));
  const lists = [...clusters.values()]
    .map((list) => list.sort((a, b) => score.get(b)! - score.get(a)! || b.area - a.area || a.osmId - b.osmId))
    .sort((a, b) => b.length - a.length || a[0]!.osmId - b[0]!.osmId);
  const total = candidates.length;
  // Placement drops some, so quotas aim a little over the cap.
  const quotas = lists.map((list) => Math.min(list.length, Math.max(2, Math.floor((cap * 1.3 * list.length) / Math.max(1, total)))));
  const order: BuildingCandidate[] = [];
  const taken = new Set<BuildingCandidate>();
  for (let round = 0; ; round++) {
    let any = false;
    lists.forEach((list, k) => {
      if (round < quotas[k]!) {
        order.push(list[round]!);
        taken.add(list[round]!);
        any = true;
      }
    });
    if (!any) break;
  }
  const rest = candidates.filter((c) => !taken.has(c)).sort((a, b) => score.get(b)! - score.get(a)! || a.osmId - b.osmId);
  return [...order, ...rest];
}
