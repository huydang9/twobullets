import { distance, pointInPolygon, round3 } from "../../layout/geometry";
import type { PointOfInterest, PoiKind, Vec2Tuple } from "../../types";
import { clusterPoints, type PlacedBuilding } from "./buildings";
import { centroid } from "./geometry";
import type { AreaFeature, PlaceConfig, PointFeature, Polygon } from "./types";

/** POI spacing rules for real maps (passed to `validateMapLayout`): villages sit closer than Map v1's authored POIs. */
export const REAL_POI_SPACING = { poiSpacing: 200, minorPoiSpacing: 130, minorPoiRadius: 40 } as const;
/** Spawn groups (POIs) wanted per map, so 10+ teams can start apart. */
export const TARGET_POIS = 10;

const DEFAULT_DIRECTIONS = ["North", "South", "East", "West"] as const;
const DEFAULT_GENERIC = ["Hamlet", "Farm", "Woods"] as const;
const SETTLEMENT_PLACES = new Set(["city", "town", "village", "hamlet", "suburb", "quarter", "neighbourhood"]);
const MINOR_PLACES = new Set(["isolated_dwelling", "farm", "allotments"]);
const LANDMARK_TOURISM = new Set(["attraction", "museum", "viewpoint", "artwork"]);
const BIG_PREFABS = new Set(["barn", "warehouse", "barracks", "house_two_story"]);

export interface PoiReport {
  readonly settlements: number;
  readonly landmarks: number;
  readonly outskirtsBuildings: number;
}

interface Group {
  members: PlacedBuilding[];
  center: Vec2Tuple;
  radius: number;
}

function groupOf(members: PlacedBuilding[]): Group {
  let x = 0;
  let z = 0;
  for (const b of members) [x, z] = [x + b.bounds.center[0], z + b.bounds.center[1]];
  const center: Vec2Tuple = [x / members.length, z / members.length];
  const radius = members.reduce((r, b) => Math.max(r, distance(center[0], center[1], b.bounds.center[0], b.bounds.center[1]) + 8), 0);
  return { members, center, radius };
}

/** Splits a sprawling group into k parts (farthest-point seeds, 12 Lloyd iterations). */
function split(group: Group, k: number): Group[] {
  const points = group.members.map((b) => b.bounds.center);
  const seeds: Vec2Tuple[] = [points[0]!];
  while (seeds.length < k) {
    let best = points[0]!;
    let bestDistance = -1;
    for (const p of points) {
      const d = Math.min(...seeds.map((s) => distance(p[0], p[1], s[0], s[1])));
      if (d > bestDistance) [best, bestDistance] = [p, d];
    }
    seeds.push(best);
  }
  let assignment: number[] = [];
  for (let iteration = 0; iteration < 12; iteration++) {
    assignment = points.map((p) => {
      let best = 0;
      for (let s = 1; s < seeds.length; s++) if (distance(p[0], p[1], seeds[s]![0], seeds[s]![1]) < distance(p[0], p[1], seeds[best]![0], seeds[best]![1])) best = s;
      return best;
    });
    for (let s = 0; s < seeds.length; s++) {
      const mine = points.filter((_, i) => assignment[i] === s);
      if (mine.length > 0) seeds[s] = [mine.reduce((a, p) => a + p[0], 0) / mine.length, mine.reduce((a, p) => a + p[1], 0) / mine.length];
    }
  }
  return seeds.map((_, s) => group.members.filter((_, i) => assignment[i] === s)).filter((m) => m.length > 0).map(groupOf);
}

function spacingOk(center: Vec2Tuple, radius: number, accepted: readonly { center: Vec2Tuple; radius: number }[]): boolean {
  const { poiSpacing, minorPoiSpacing, minorPoiRadius } = REAL_POI_SPACING;
  return accepted.every((other) => {
    const d = distance(center[0], center[1], other.center[0], other.center[1]);
    const needed = radius <= minorPoiRadius || other.radius <= minorPoiRadius ? Math.max(minorPoiSpacing, radius + other.radius + 40) : poiSpacing;
    return d >= needed;
  });
}

interface NameSource {
  readonly name: string;
  readonly at: Vec2Tuple;
  /** Lower is better. */
  readonly rank: number;
}

/** Named things that can label a POI, best first: settlements, farmsteads and localities, landmarks, named areas, amenities. */
function nameSources(points: readonly PointFeature[], areas: readonly AreaFeature[], buildingAreas: readonly AreaFeature[], config: PlaceConfig): NameSource[] {
  const out: NameSource[] = [];
  // The place itself, for villages OSM has no place node for.
  if (config.localName) out.push({ name: config.localName, at: [0, 0], rank: 0.5 });
  for (const p of points) {
    const name = p.tags.name;
    if (!name) continue;
    const t = p.tags;
    const rank = t.place && SETTLEMENT_PLACES.has(t.place) ? 0 : t.place && MINOR_PLACES.has(t.place) ? 1 : t.place === "locality" ? 2 : t.amenity === "place_of_worship" || t.historic || (t.tourism && LANDMARK_TOURISM.has(t.tourism)) ? 3 : t.amenity ? 5 : 6;
    if (rank < 5) out.push({ name, at: p.at, rank });
  }
  for (const a of [...areas, ...buildingAreas]) {
    const name = a.tags.name;
    if (!name || a.tags.highway) continue;
    const t = a.tags;
    const rank = t.amenity === "place_of_worship" || t.historic || (t.tourism && LANDMARK_TOURISM.has(t.tourism)) ? 3 : t.landuse || t.natural || t.leisure ? 4 : 5;
    if (rank < 5) out.push({ name, at: centroid(a.outer), rank });
  }
  return out;
}

function direction(from: Vec2Tuple, to: Vec2Tuple, words: readonly [string, string, string, string]): string {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  if (Math.abs(dz) >= Math.abs(dx)) return dz >= 0 ? words[0] : words[1];
  return dx >= 0 ? words[2] : words[3];
}

export interface PoiResult {
  readonly pois: PointOfInterest[];
  /** Building id → POI id (buildings outside every POI are outskirts). */
  readonly membership: ReadonlyMap<string, string>;
  readonly report: PoiReport;
}

/**
 * POIs from the placed buildings: settlement clusters (40 m linkage; sprawling ones split into ~90 m parts), accepted
 * biggest first under `REAL_POI_SPACING` (a crowded one shrinks to a minor POI of radius 40 when that fits). When fewer
 * than `TARGET_POIS` result, named localities and then open ground far from other POIs become landmark POIs (woods or
 * fields) so every team still gets its own spawn group. Names come from OSM (diacritics kept), with a direction word
 * when several POIs share one.
 */
export function convertPois(
  buildings: readonly PlacedBuilding[],
  config: PlaceConfig,
  points: readonly PointFeature[],
  areas: readonly AreaFeature[],
  buildingAreas: readonly AreaFeature[],
  water: readonly Polygon[],
  isolated: (x: number, z: number) => boolean = () => false,
): PoiResult {
  const labels = clusterPoints(buildings.map((b) => b.bounds.center), 40);
  const byLabel = new Map<number, PlacedBuilding[]>();
  buildings.forEach((b, i) => byLabel.set(labels[i]!, [...(byLabel.get(labels[i]!) ?? []), b]));
  const groups: Group[] = [];
  for (const members of byLabel.values()) {
    const group = groupOf(members);
    if (group.radius > 110) groups.push(...split(group, Math.ceil(group.radius / 90)));
    else groups.push(group);
  }
  const weight = (g: Group) => g.members.reduce((sum, b) => sum + (BIG_PREFABS.has(b.prefab) ? 2 : 1), 0);
  const candidates = groups
    .filter((g) => g.members.length >= 2 || (g.members.length === 1 && g.members[0]!.area >= 150))
    .sort((a, b) => weight(b) - weight(a) || a.center[0] - b.center[0] || a.center[1] - b.center[1]);

  interface Draft {
    center: Vec2Tuple;
    radius: number;
    members: PlacedBuilding[];
    landmark: "forest" | "farm" | null;
    name?: string;
  }
  const accepted: Draft[] = [];
  for (const g of candidates) {
    const center: Vec2Tuple = [round3(g.center[0]), round3(g.center[1])];
    const radius = Math.round(Math.min(100, Math.max(25, g.radius + 6)));
    if (spacingOk(center, radius, accepted)) accepted.push({ center, radius, members: g.members, landmark: null });
    else if (radius > REAL_POI_SPACING.minorPoiRadius && spacingOk(center, REAL_POI_SPACING.minorPoiRadius, accepted)) accepted.push({ center, radius: REAL_POI_SPACING.minorPoiRadius, members: g.members, landmark: null });
  }
  const settlements = accepted.length;

  // Landmarks: named localities first, then the open spot farthest from every POI.
  const forests = areas.filter((a) => a.tags.landuse === "forest" || a.tags.natural === "wood");
  const inWater = (x: number, z: number) => water.some((w) => pointInPolygon(w, x, z));
  const landmarkRadius = 30;
  const usable = (p: Vec2Tuple) => Math.abs(p[0]) <= 380 && Math.abs(p[1]) <= 380 && !inWater(p[0], p[1]) && !isolated(p[0], p[1]) && !buildings.some((b) => distance(p[0], p[1], b.bounds.center[0], b.bounds.center[1]) < 25);
  const landmarkKind = (p: Vec2Tuple): "forest" | "farm" => (forests.some((f) => pointInPolygon(f.outer, p[0], p[1])) ? "forest" : "farm");
  const localities = points.filter((p) => p.tags.name && (p.tags.place === "locality" || p.tags.place === "isolated_dwelling" || p.tags.place === "hamlet")).sort((a, b) => a.id - b.id);
  for (const p of localities) {
    if (accepted.length >= TARGET_POIS) break;
    const center: Vec2Tuple = [round3(p.at[0]), round3(p.at[1])];
    if (usable(center) && spacingOk(center, landmarkRadius, accepted)) accepted.push({ center, radius: landmarkRadius, members: [], landmark: landmarkKind(center), name: p.tags.name! });
  }
  while (accepted.length < TARGET_POIS) {
    let best: Vec2Tuple | null = null;
    let bestScore = -1;
    for (let z = -360; z <= 360; z += 30) {
      for (let x = -360; x <= 360; x += 30) {
        const p: Vec2Tuple = [x, z];
        if (!usable(p) || !spacingOk(p, landmarkRadius, accepted)) continue;
        const score = accepted.reduce((m, a) => Math.min(m, distance(x, z, a.center[0], a.center[1])), Infinity);
        if (score > bestScore) [best, bestScore] = [p, score];
      }
    }
    if (!best) break;
    accepted.push({ center: best, radius: landmarkRadius, members: [], landmark: landmarkKind(best) });
  }

  // Names: POIs in importance order take the best unused named thing nearby; a POI with nothing left reuses the nearest
  // settlement name (or the generic word) with a direction, then a number.
  const words = config.directionWords ?? DEFAULT_DIRECTIONS;
  const generic = config.genericNames ?? DEFAULT_GENERIC;
  const sources = nameSources(points, areas, buildingAreas, config);
  const usedSources = new Set<string>();
  const usedNames = new Set<string>();
  const named = accepted.map((draft) => {
    const fallback = draft.landmark === "forest" ? generic[2] : draft.landmark === "farm" || isFarm(draft.members) ? generic[1] : generic[0];
    /** First unused of: base, base (direction), generic (direction), generic (direction) k. */
    const unique = (base: string, from: Vec2Tuple | null): string => {
      const facing = direction(from ?? [0, 0], draft.center, words);
      for (const option of [base, `${base} (${facing})`, `${fallback} (${facing})`]) if (!usedNames.has(option)) return option;
      for (let k = 2; ; k++) if (!usedNames.has(`${fallback} (${facing}) ${k}`)) return `${fallback} (${facing}) ${k}`;
    };
    let name: string;
    if (draft.name && !usedNames.has(draft.name)) {
      name = draft.name;
    } else {
      const reach = draft.radius + 70;
      const near = sources
        .map((s) => ({ s, d: distance(draft.center[0], draft.center[1], s.at[0], s.at[1]) }))
        .filter(({ s, d }) => d <= (s.rank < 1 ? Math.max(reach, 320) : reach))
        .sort((a, b) => a.s.rank - b.s.rank || a.d - b.d || (a.s.name < b.s.name ? -1 : 1));
      const fresh = near.find(({ s }) => !usedSources.has(s.name) && !usedNames.has(s.name));
      if (fresh) {
        name = fresh.s.name;
      } else {
        const settlement = sources.filter((s) => s.rank < 1).sort((a, b) => distance(draft.center[0], draft.center[1], a.at[0], a.at[1]) - distance(draft.center[0], draft.center[1], b.at[0], b.at[1]))[0];
        const base = draft.landmark || !settlement ? fallback : settlement.name;
        name = unique(base, draft.landmark || !settlement ? null : settlement.at);
      }
    }
    usedSources.add(name);
    usedNames.add(name);
    return { draft, name };
  });

  let tierTwo = 0;
  const pois: PointOfInterest[] = named.map(({ draft, name }, i) => {
    const count = draft.members.length;
    const kind: PoiKind = draft.landmark ?? (isFarm(draft.members) ? "farm" : count >= 10 ? "town" : "village");
    let lootTier: 0 | 1 | 2 = count >= 10 ? 2 : count >= 4 ? 1 : 0;
    if (lootTier === 2 && tierTwo >= 3) lootTier = 1;
    if (lootTier === 2) tierTwo++;
    return { id: `poi_${String(i + 1).padStart(2, "0")}`, name, kind, center: draft.center, radius: draft.radius, lootTier };
  });

  const membership = new Map<string, string>();
  accepted.forEach((draft, i) => {
    for (const b of draft.members) membership.set(b.id, pois[i]!.id);
  });
  // Leftover buildings join a POI they stand close to; the rest are outskirts.
  let outskirts = 0;
  for (const b of buildings) {
    if (membership.has(b.id)) continue;
    const near = pois.find((p) => p.kind !== "forest" && distance(p.center[0], p.center[1], b.bounds.center[0], b.bounds.center[1]) <= p.radius + 25);
    if (near) membership.set(b.id, near.id);
    else outskirts++;
  }
  return { pois, membership, report: { settlements, landmarks: pois.length - settlements, outskirtsBuildings: outskirts } };
}

function isFarm(members: readonly PlacedBuilding[]): boolean {
  if (members.length === 0) return false;
  const farm = members.filter((b) => b.prefab === "barn" || b.prefab.startsWith("container")).length;
  return farm / members.length >= 0.4;
}
