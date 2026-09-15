import { getBuildingPrefab, type BuildingPrefabId } from "../../buildings/prefabs";
import { distance, distanceToRect, pointInPolygon, polygonBounds, rectCorners, round3 } from "../../layout/geometry";
import type { RoadSpec } from "../../layout/roads";
import { hash2 } from "../../terrain/noise";
import type { Vec2Tuple } from "../../types";
import { BUILDING_EDGE, prefabRect, ROAD_GAP, ROW_GAP, type BuildingCandidate } from "./buildings";
import type { AreaFeature, UrbanOptions } from "./types";

/**
 * Dense city mode. OSM maps Saigon's big buildings but few of the tube houses that wall every street, so rows of tube
 * houses are laid along the real street frontages: front faces the street at the road gap, neighbours packed
 * `ROW_GAP` apart, a walk-through gap every few houses, none on parks, pitches, school grounds, water or mapped
 * footprints, and none round the open center. Frontage slots and OSM footprints share one ranking (distance from the
 * center, weighted by street class), and a per-cell quota spreads the building cap over the map. Deterministic: slot
 * ids and house variants come from road order and hashes, never from placement results.
 */

/** Synthetic ids start here, far above OSM way ids, and stay `bld_<digits>` so validation messages name them. */
const FRONTAGE_ID_BASE = 9_000_000_000_000;
/** Spacing between row houses: a little over the placement check's `ROW_GAP`, so float noise never rejects a neighbour, m. */
const ROW_PITCH_GAP = ROW_GAP + 0.04;
/** Walk-through gap between rows, m. */
const ROW_BREAK = 3;
/** Slots keep this far from segment ends (corners, junction mouths), m. */
const SEGMENT_MARGIN = 2;
const DEFAULTS: Required<UrbanOptions> = { openCenter: 40, rowLength: 6, cellQuota: 10 };

/** Areas kept free of row houses: open spaces, grounds of institutions, water and woods. */
function isOpenArea(tags: AreaFeature["tags"]): boolean {
  if (tags.leisure || tags.natural || tags.water || tags.waterway) return true;
  if (tags.landuse && ["grass", "recreation_ground", "cemetery", "construction", "railway", "forest", "meadow", "village_green", "religious", "military", "basin", "reservoir"].includes(tags.landuse)) return true;
  return tags.amenity !== undefined && ["school", "university", "college", "hospital", "parking", "place_of_worship", "kindergarten", "marketplace", "bus_station", "fuel", "grave_yard"].includes(tags.amenity);
}

/** Street class weight for ranking: main roads first, then residential streets, then alleys. */
export function streetWeight(width: number): number {
  return width >= 7 ? 1 : width >= 5.5 ? 1.35 : 1.7;
}

export function urbanDefaults(options: UrbanOptions): Required<UrbanOptions> {
  return { ...DEFAULTS, ...options };
}

interface Blocker {
  readonly polygon: readonly Vec2Tuple[];
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function blockers(polygons: readonly (readonly Vec2Tuple[])[]): Blocker[] {
  return polygons.map((polygon) => ({ polygon, ...polygonBounds(polygon) }));
}

/** Frontage slots along every road, both sides, as fixed-placement building candidates. */
export function frontageCandidates(roads: readonly RoadSpec[], footprints: readonly AreaFeature[], areas: readonly AreaFeature[], urban: UrbanOptions): BuildingCandidate[] {
  const options = urbanDefaults(urban);
  const solid = blockers(footprints.map((f) => f.outer));
  const open = blockers(areas.filter((a) => isOpenArea(a.tags)).map((a) => a.outer));
  const inside = (list: readonly Blocker[], x: number, z: number) => list.some((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && pointInPolygon(b.polygon, x, z));
  const out: BuildingCandidate[] = [];
  let serial = 0;

  roads.forEach((road, roadIndex) => {
    const half = (road.width ?? 5) / 2;
    const weight = streetWeight(road.width ?? 5);
    for (let i = 0; i + 1 < road.points.length; i++) {
      const [ax, az] = road.points[i]!;
      const [bx, bz] = road.points[i + 1]!;
      const length = distance(ax, az, bx, bz);
      if (length < 12) continue;
      const dx = (bx - ax) / length;
      const dz = (bz - az) / length;
      for (const side of [1, -1] as const) {
        // Outward normal on this side; houses face back along it.
        const nx = -dz * side;
        const nz = dx * side;
        const yaw = round3(Math.atan2(-nx, -nz)) || 0;
        let along = SEGMENT_MARGIN;
        let inRow = 0;
        let row: BuildingCandidate[] = [];
        const closeRow = () => {
          // A row is placed as a unit: ranked by its member nearest the center, members in street order.
          const rowRank = row.reduce((m, c) => Math.min(m, distance(c.centroid[0], c.centroid[1], 0, 0)), Infinity) * weight;
          row.forEach((c, index) => out.push({ ...c, rank: round3(rowRank + index * 0.001) }));
          row = [];
        };
        let rowLength = options.rowLength - 1 + (hash2(roadIndex, i * 2 + (side > 0 ? 1 : 0), 0x70b3) % 3);
        let previous: BuildingPrefabId | null = null;
        for (let k = 0; ; k++) {
          const prefab = variant(roadIndex, i, side, k, road.width ?? 5, previous);
          previous = prefab;
          const def = getBuildingPrefab(prefab);
          const width = def.bounds.max[0] - def.bounds.min[0];
          if (along + width > length - SEGMENT_MARGIN) break;
          const setback = half + ROAD_GAP + 0.2 + def.bounds.max[2];
          const mid = along + width / 2 - (def.bounds.min[0] + def.bounds.max[0]) / 2;
          const position: Vec2Tuple = [round3(ax + dx * mid + nx * setback), round3(az + dz * mid + nz * setback)];
          along += width + ROW_PITCH_GAP;
          const lastInRow = ++inRow >= rowLength;
          if (lastInRow) {
            along += ROW_BREAK;
            inRow = 0;
            rowLength = options.rowLength - 1 + (hash2(roadIndex, i * 2 + k, 0x70b4) % 3);
          }
          const flush = () => {
            if (lastInRow) closeRow();
          };
          const rect = prefabRect(prefab, position, yaw);
          const [cx, cz] = rect.center;
          if (Math.abs(cx) > BUILDING_EDGE || Math.abs(cz) > BUILDING_EDGE) {
            flush();
            continue;
          }
          if (distance(cx, cz, 0, 0) < options.openCenter + rect.halfExtents[1]) {
            flush();
            continue;
          }
          const probes = [rect.center, ...rectCorners(rect)];
          if (probes.some(([x, z]) => inside(open, x, z) || inside(solid, x, z))) {
            flush();
            continue;
          }
          if (solid.some((b) => b.maxX >= cx - 12 && b.minX <= cx + 12 && b.maxZ >= cz - 12 && b.minZ <= cz + 12 && distanceToRect(rect, (b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2) === 0)) {
            flush();
            continue;
          }
          const id = FRONTAGE_ID_BASE + serial++;
          const area = width * (def.bounds.max[2] - def.bounds.min[2]);
          row.push({
            osmId: id,
            tags: { building: "house", "building:levels": String(STORIES[prefab] ?? 2) },
            area,
            rect: { center: rect.center, axis: [dx, dz], halfLength: rect.halfExtents[1], halfWidth: rect.halfExtents[0] },
            centroid: rect.center,
            prefab,
            fixed: { position, yaw },
          });
          flush();
        }
        if (row.length > 0) closeRow();
      }
    }
  });
  return out;
}

/** City prefabs placed before everything else when OSM maps their footprint. */
const LANDMARKS = new Set<BuildingPrefabId>(["highrise_apartment", "office_tower", "apartment_block", "church", "pagoda", "school", "market_hall", "petrol_station"]);

/** Stories of the frontage prefabs, recorded as `building:levels` on their candidates. */
const STORIES: Partial<Record<BuildingPrefabId, number>> = {
  tube_house_2: 2,
  tube_house_3: 3,
  tube_house_4: 4,
  tube_house_narrow: 3,
  tube_house_wide: 3,
  tube_house_planters: 3,
  tube_house_shed: 2,
  tube_house_mezzanine: 2,
  shophouse_french: 2,
  cafe_terrace: 2,
  shop_kiosk: 1,
};

/** Frontage mix by street class, [prefab, weight]: taller shophouses on main roads, low houses down the alleys. */
const FRONTAGE_MIX: readonly (readonly (readonly [BuildingPrefabId, number])[])[] = [
  [["tube_house_3", 22], ["tube_house_4", 18], ["tube_house_planters", 14], ["tube_house_wide", 10], ["tube_house_mezzanine", 10], ["shophouse_french", 8], ["cafe_terrace", 6], ["shop_kiosk", 4], ["tube_house_narrow", 4], ["tube_house_2", 4]],
  [["tube_house_2", 18], ["tube_house_3", 18], ["tube_house_planters", 12], ["tube_house_narrow", 12], ["tube_house_shed", 12], ["tube_house_mezzanine", 8], ["tube_house_wide", 6], ["cafe_terrace", 6], ["shop_kiosk", 5], ["tube_house_4", 3]],
  [["tube_house_2", 28], ["tube_house_narrow", 22], ["tube_house_shed", 20], ["tube_house_3", 16], ["tube_house_planters", 8], ["shop_kiosk", 6]],
];

/** A seeded pick from the street's mix that never repeats the house next door. */
function variant(roadIndex: number, segment: number, side: number, k: number, width: number, previous: BuildingPrefabId | null): BuildingPrefabId {
  const mix = FRONTAGE_MIX[width >= 7 ? 0 : width >= 5.5 ? 1 : 2]!;
  const total = mix.reduce((sum, [, w]) => sum + w, 0);
  let r = ((hash2(roadIndex * 4 + (side > 0 ? 1 : 0), segment * 1024 + k, 0x7b11) >>> 0) / 4294967296) * total;
  let index = 0;
  while (index < mix.length - 1 && r >= mix[index]![1]) r -= mix[index++]![1];
  if (mix[index]![0] === previous) index = (index + 1) % mix.length;
  return mix[index]![0];
}

/** Ranks OSM footprints like frontage slots (a small bonus: real buildings first at equal distance). */
export function rankFootprints(candidates: readonly BuildingCandidate[], roads: readonly RoadSpec[]): BuildingCandidate[] {
  return candidates.map((c) => {
    let weight = 1.7;
    let best = 40;
    for (const road of roads) {
      for (let i = 0; i + 1 < road.points.length; i++) {
        const [ax, az] = road.points[i]!;
        const [bx, bz] = road.points[i + 1]!;
        const d = segmentDistanceSq(c.centroid[0], c.centroid[1], ax, az, bx, bz);
        if (d < best * best) {
          best = Math.sqrt(d);
          weight = streetWeight(road.width ?? 5);
        }
      }
    }
    // Real footprints go ahead of generated frontage; landmarks (named, or towers, schools, places of worship…) first.
    const factor = LANDMARKS.has(c.prefab) || c.tags.name ? 0.02 : c.prefab.startsWith("tube_house") ? 0.5 : 0.3;
    return { ...c, rank: round3(distance(c.centroid[0], c.centroid[1], 0, 0) * weight * factor) };
  });
}

function segmentDistanceSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lengthSq = abx * abx + abz * abz;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / lengthSq)) : 0;
  const x = ax + abx * t - px;
  const z = az + abz * t - pz;
  return x * x + z * z;
}
