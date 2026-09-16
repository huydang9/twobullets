import { bandAlong, distance, pointInPolygon, polylineLength, round3 } from "../../layout/geometry";
import type { LineOpening } from "../../layout/placement";
import type { RoadSpec } from "../../layout/roads";
import type { ScatterRule } from "../../layout/scatter";
import type { PointOfInterest, PropScatter, Vec2Tuple } from "../../types";
import type { FenceLine } from "../fences";
import { REAL_TERRAIN } from "./elevation";
import { clipPolylineToSquare, clipRingToSquare, simplifyPolyline, simplifyRing } from "./geometry";
import type { AreaFeature, LineFeature, PlaceConfig, Polygon } from "./types";
import type { Wilderness } from "./wilderness";

type Palette = PropScatter["props"];

const CONIFERS: Palette = [
  { prop: "tree_fir_b", weight: 5 },
  { prop: "tree_fir_a", weight: 3 },
  { prop: "tree_broadleaf_a", weight: 1 },
  { prop: "tree_fir_young", weight: 0.4 },
];
const DECIDUOUS: Palette = [
  { prop: "tree_broadleaf_a", weight: 3 },
  { prop: "tree_broadleaf_b", weight: 2 },
  { prop: "tree_fir_b", weight: 1 },
];
const TROPICAL: Palette = [
  { prop: "tree_broadleaf_a", weight: 3 },
  { prop: "tree_broadleaf_b", weight: 3 },
];
const UNDERGROWTH: Palette = [
  { prop: "fern", weight: 4 },
  { prop: "bush_a", weight: 2 },
  { prop: "bush_b", weight: 1 },
  { prop: "bush_c", weight: 1 },
  { prop: "rock_small", weight: 1 },
];
const BUSHES: Palette = [
  { prop: "bush_a", weight: 2 },
  { prop: "bush_b", weight: 1 },
  { prop: "bush_c", weight: 1 },
];
/**
 * Tropical woodland for the wilderness: Map v1's broadleaf kit plus the Vietnamese palms. Only one palm variant is
 * used: a palm trunk blocks bullets, so its batches are never distance-culled, and each extra kind of tree costs a draw
 * call per map cell it lands in. The canopy layer takes the same palm at a larger scale instead (`vn_palm_coconut_trio`
 * stays in the catalog for hand placement).
 */
const WILD_CANOPY: Palette = [
  { prop: "tree_broadleaf_a", weight: 2 },
  { prop: "vn_palm_coconut", weight: 1 },
];
const WILD_FOREST: Palette = [
  { prop: "tree_broadleaf_b", weight: 3 },
  { prop: "tree_broadleaf_a", weight: 2 },
  { prop: "vn_palm_coconut", weight: 2 },
];
const WILD_THICKET: Palette = [
  { prop: "vn_bamboo_clump", weight: 3 },
  { prop: "vn_banana_plant", weight: 2 },
];
const WILD_UNDERGROWTH: Palette = [
  { prop: "fern", weight: 3 },
  { prop: "vn_tropical_shrub_1", weight: 2 },
  { prop: "vn_tropical_shrub_3", weight: 2 },
  { prop: "vn_tropical_shrub_5", weight: 2 },
  { prop: "bush_a", weight: 1.5 },
  { prop: "bush_c", weight: 1 },
  { prop: "vn_monstera", weight: 1 },
];

/** Scatter areas stay this far inside the playable edge, m. */
const SCATTER_CLIP = 244;
/** Forest, wood and scrub outlines smaller than this become loose trees instead of their own rule, m². */
const MIN_WOOD_AREA = 1500;
const MAX_WOOD_RULES = 28;

export function isWater(tags: AreaFeature["tags"]): boolean {
  return tags.natural === "water" || tags.waterway === "riverbank" || tags.landuse === "reservoir" || tags.landuse === "basin" || tags.water !== undefined;
}

/** Water areas clipped to the playable square and simplified; tiny ponds (under 120 m²) are ignored. */
export function waterPolygons(areas: readonly AreaFeature[]): Polygon[] {
  return areas
    .filter((a) => isWater(a.tags) && a.area >= 120)
    .map((a) => clipRingToSquare(simplifyRing(a.outer, 1), REAL_TERRAIN.playableHalfExtent))
    .filter((ring) => ring.length >= 3)
    .map((ring) => ring.map((p): Vec2Tuple => [round3(p[0]), round3(p[1])]));
}

/**
 * Cuts road ends that run into water (piers, boat ramps, roads under a mapped river outline) back to 1 m before the bank,
 * so the only roads crossing water are bridges and causeways with land at both ends. Roads left shorter than 10 m go.
 */
export function trimRoadsAtWater(roads: readonly RoadSpec[], water: readonly Polygon[]): RoadSpec[] {
  if (water.length === 0) return [...roads];
  const inWater = (p: Vec2Tuple) => water.some((w) => pointInPolygon(w, p[0], p[1]));
  const out: RoadSpec[] = [];
  for (const road of roads) {
    const samples: Vec2Tuple[] = [];
    for (let i = 0; i + 1 < road.points.length; i++) {
      const [ax, az] = road.points[i]!;
      const [bx, bz] = road.points[i + 1]!;
      const steps = Math.max(1, Math.ceil(distance(ax, az, bx, bz)));
      for (let k = 0; k < steps; k++) samples.push([round3(ax + ((bx - ax) * k) / steps), round3(az + ((bz - az) * k) / steps)]);
    }
    samples.push(road.points[road.points.length - 1]!);
    let first = 0;
    let last = samples.length - 1;
    while (first <= last && inWater(samples[first]!)) first++;
    while (last >= first && inWater(samples[last]!)) last--;
    if (first === 0 && last === samples.length - 1) {
      out.push(road);
      continue;
    }
    first = first === 0 ? 0 : Math.min(last, first + 1);
    last = last === samples.length - 1 ? last : Math.max(first, last - 1);
    const kept = samples.slice(first, last + 1);
    if (kept.length < 2 || polylineLength(kept) < 10) continue;
    // Keep the original vertices between the cut points.
    const points: Vec2Tuple[] = [kept[0]!];
    for (const p of road.points) {
      const index = samples.findIndex((s) => s[0] === p[0] && s[1] === p[1]);
      if (index > first && index < last) points.push(p);
    }
    points.push(kept[kept.length - 1]!);
    out.push({ ...road, points });
  }
  return out;
}

export interface WaterEdges {
  readonly fences: FenceLine[];
  /** Fence length, m. */
  readonly length: number;
}

/**
 * Water is not walkable: every water outline gets a wooden fence (movement blocker, bullets pass), with gaps where
 * roads cross, and roads running through water get railings on both shoulders. Edges on the map boundary are skipped
 * (the out-of-bounds rule covers them).
 */
export function waterEdges(water: readonly Polygon[], roads: readonly RoadSpec[], bridged: (x: number, z: number) => boolean = () => false): WaterEdges {
  const fences: FenceLine[] = [];
  let length = 0;
  const onBoundary = (a: Vec2Tuple, b: Vec2Tuple) => (Math.abs(a[0]) >= 499.9 && Math.abs(b[0]) >= 499.9 && a[0] * b[0] > 0) || (Math.abs(a[1]) >= 499.9 && Math.abs(b[1]) >= 499.9 && a[1] * b[1] > 0);

  for (const ring of water) {
    // Walk the closed ring as open runs split at boundary edges.
    const runs: Vec2Tuple[][] = [];
    let run: Vec2Tuple[] = [];
    const n = ring.length;
    let startIndex = 0;
    for (let i = 0; i < n; i++) if (onBoundary(ring[i]!, ring[(i + 1) % n]!)) startIndex = (i + 1) % n;
    for (let k = 0; k <= n; k++) {
      const a = ring[(startIndex + k) % n]!;
      const b = ring[(startIndex + k + 1) % n]!;
      if (run.length === 0) run.push(a);
      if (k === n || onBoundary(a, b)) {
        if (run.length >= 2) runs.push(run);
        run = [];
        continue;
      }
      run.push(b);
    }
    for (const run of runs) {
      // Where a bank meets the map edge, the fence runs 12 m on into the border so nobody walks round its end.
      const extend = (p: Vec2Tuple): Vec2Tuple | null =>
        Math.abs(p[0]) >= 499.9 ? [p[0] > 0 ? 512 : -512, p[1]] : Math.abs(p[1]) >= 499.9 ? [p[0], p[1] > 0 ? 512 : -512] : null;
      const head = extend(run[0]!);
      const tail = extend(run[run.length - 1]!);
      const piece = [...(head ? [head] : []), ...run, ...(tail ? [tail] : [])];
      const gaps = roadGaps(piece, roads);
      fences.push(gaps.length > 0 ? { points: piece, gaps } : { points: piece });
      length += polylineLength(piece);
    }
  }

  // Railings where roads cross water (bridges and causeways).
  const inWater = (x: number, z: number) => water.some((w) => pointInPolygon(w, x, z));
  for (const road of roads) {
    const width = road.width ?? 5;
    const samples: Vec2Tuple[] = [];
    for (let i = 0; i + 1 < road.points.length; i++) {
      const [ax, az] = road.points[i]!;
      const [bx, bz] = road.points[i + 1]!;
      const steps = Math.max(1, Math.ceil(distance(ax, az, bx, bz) / 2));
      for (let k = 0; k < steps; k++) samples.push([ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps]);
    }
    samples.push(road.points[road.points.length - 1]!);
    // Runs of samples inside water, extended 4 m onto the banks so the railings overlap the bank fence.
    const wet = samples.map(([x, z]) => inWater(x, z));
    for (let i = 0; i < samples.length; i++) {
      if (!wet[i] || (i > 0 && wet[i - 1])) continue;
      let end = i;
      while (end + 1 < samples.length && wet[end + 1]) end++;
      const run = samples.slice(Math.max(0, i - 2), Math.min(samples.length, end + 3));
      const middle = samples[Math.floor((i + end) / 2)]!;
      if (run.length >= 2 && !bridged(middle[0], middle[1])) {
        for (const side of [1, -1] as const) {
          const line = simplifyPolyline(bandAlong(run, width / 2 + 1.2, width / 2 + 1.2, side).slice(0, run.length), 0.3);
          fences.push({ points: line.map((p): Vec2Tuple => [round3(p[0]), round3(p[1])]) });
          length += polylineLength(line);
        }
      }
      i = end;
    }
  }
  return { fences, length: Math.round(length) };
}

/** Distances along `points` where a road crosses it, widened to the road plus 0.9 m per side. */
function roadGaps(points: readonly Vec2Tuple[], roads: readonly RoadSpec[]): [number, number][] {
  const gaps: [number, number][] = [];
  let travelled = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i]!;
    const [bx, bz] = points[i + 1]!;
    const segment = distance(ax, az, bx, bz);
    for (const road of roads) {
      for (let j = 0; j + 1 < road.points.length; j++) {
        const t = intersect(ax, az, bx, bz, road.points[j]![0], road.points[j]![1], road.points[j + 1]![0], road.points[j + 1]![1]);
        if (t === null) continue;
        const at = travelled + t * segment;
        // Railings run 1.2 m off the road edge, just outside the gap, so they close its ends.
        const half = (road.width ?? 5) / 2 + 0.9;
        gaps.push([Math.max(0, at - half), at + half]);
      }
    }
    travelled += segment;
  }
  gaps.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const gap of gaps) {
    const last = merged[merged.length - 1];
    if (last && gap[0] <= last[1]) last[1] = Math.max(last[1], gap[1]);
    else merged.push([round3(gap[0]), round3(gap[1])]);
  }
  return merged.map(([a, b]) => [round3(a), round3(b)]);
}

/** Parameter along a–b where it crosses c–d, or null. */
function intersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number | null {
  const rx = bx - ax;
  const rz = bz - az;
  const sx = dx - cx;
  const sz = dz - cz;
  const denominator = rx * sz - rz * sx;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / denominator;
  const u = ((cx - ax) * rz - (cz - az) * rx) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Scatter outlines are stored to 0.1 m. */
const round1 = (v: number) => Math.round(v * 10) / 10;

function circle(center: Vec2Tuple, radius: number, sides = 16): Vec2Tuple[] {
  return Array.from({ length: sides }, (_, i): Vec2Tuple => {
    const a = (i / sides) * Math.PI * 2;
    return [round1(center[0] + Math.cos(a) * radius), round1(center[1] + Math.sin(a) * radius)];
  });
}

function areaRing(feature: AreaFeature, tolerance = 2): Vec2Tuple[] {
  return clipRingToSquare(simplifyRing(feature.outer, tolerance), SCATTER_CLIP).map((p): Vec2Tuple => [round1(p[0]), round1(p[1])]);
}

function holes(feature: AreaFeature): Vec2Tuple[][] {
  return feature.holes.map((h) => clipRingToSquare(simplifyRing(h, 2), SCATTER_CLIP).map((p): Vec2Tuple => [round1(p[0]), round1(p[1])])).filter((h) => h.length >= 3);
}

function roundRing(points: readonly Vec2Tuple[]): Vec2Tuple[] {
  return points.map((p): Vec2Tuple => [round1(p[0]), round1(p[1])]);
}

export interface LanduseReport {
  readonly forestHa: number;
  readonly fieldHa: number;
  readonly waterHa: number;
  readonly rules: number;
}

/**
 * Woodland for the ground the OSM square never covers: canopy, forest, bamboo thickets, undergrowth and rock/log cover,
 * all multiplied by the wilderness coverage weight so the trees thin out as they approach the city and stop at its
 * streets. Clearing masks keep it from becoming a wall of trunks, and every rule keeps the trees' own clearance, so bots
 * and players always have a way through.
 */
export function wildernessScatters(wilderness: Wilderness, playable: readonly Vec2Tuple[]): ScatterRule[] {
  const { weights } = wilderness;
  const d = wilderness.options.density;
  const wild = { weightGrid: weights, area: playable, excludeSurfaces: ["road", "dirt"] as const };
  return [
    // Big trunks first, so the smaller trees grow around them.
    { id: "wild_canopy", ...wild, props: WILD_CANOPY, density: 0.4 * d, mask: { wavelength: 140, threshold: 0.3, softness: 0.15 }, maxSlopeDegrees: 32, minDistance: 9, scaleRange: [1, 1.35] },
    { id: "wild_forest", ...wild, props: WILD_FOREST, density: 2 * d, mask: { wavelength: 80, threshold: 0.36, softness: 0.1 }, maxSlopeDegrees: 35, scaleRange: [0.8, 1.25] },
    { id: "wild_thicket", ...wild, props: WILD_THICKET, density: 2.4 * d, mask: { wavelength: 50, threshold: 0.42, softness: 0.12 }, maxSlopeDegrees: 38, clearance: 1, scaleRange: [0.85, 1.3] },
    { id: "wild_undergrowth", ...wild, props: WILD_UNDERGROWTH, density: 3.5 * d, mask: { wavelength: 60, threshold: 0.28, softness: 0.18 }, maxSlopeDegrees: 40, scaleRange: [0.75, 1.3] },
    // Cover to fight from. One boulder and one log type only: both block bullets, so they are never distance-culled and
    // every extra kind of them costs a draw call per map cell it lands in (docs/perf/benchmark.md).
    {
      id: "wild_cover",
      ...wild,
      props: [
        { prop: "rock_boulder_large", weight: 1.5 },
        { prop: "rock_small", weight: 2 },
        { prop: "bush_c", weight: 2 },
      ],
      density: 0.11 * d,
      // Fallen logs only as cluster anchors, so they gather in a handful of spots instead of dotting every map cell.
      cluster: { count: [2, 4], radius: 7, anchor: { props: [{ prop: "rock_boulder_large", weight: 2 }, { prop: "log_fallen", weight: 3 }], chance: 0.3, scaleRange: [0.9, 1.3] } },
      mask: { wavelength: 160, threshold: 0.42, softness: 0.12 },
      maxSlopeDegrees: 30,
      scaleRange: [0.7, 1.2],
    },
    // Loose rock on the hillsides (Map v1's slope layers, which only fire on real relief).
    { id: "wild_slope_rocks", ...wild, props: [{ prop: "rock_small", weight: 4 }, { prop: "rock_boulder_large", weight: 1 }], density: 0.5 * d, minSlopeDegrees: 12, maxSlopeDegrees: 45, scaleRange: [0.7, 1.4] },
  ];
}

/**
 * Scatter rules from land use, in the spirit of Map v1: forests and woods (one rule each, largest first, plus
 * undergrowth), scrub and wetland bushes, orchards, garden trees in residential areas, tree rows, hay in farmland, then
 * the map-wide cover layers (field cover clusters, lone oaks, slope rocks, gap-filling boulders, meadow bushes, grass).
 * Water and fence gaps are excluded from every rule; POI cores stay free of field cover.
 */
export function convertLanduse(
  areas: readonly AreaFeature[],
  lines: readonly LineFeature[],
  roads: readonly RoadSpec[],
  pois: readonly PointOfInterest[],
  water: readonly Polygon[],
  openings: readonly LineOpening[],
  config: PlaceConfig,
  wilderness: Wilderness | null = null,
): { scatters: ScatterRule[]; report: LanduseReport } {
  const tropical = config.climate === "tropical";
  // City maps: street trees, parks and urban cover (parked cars, utility boxes, barrels) instead of village groves.
  const urban = config.urban !== undefined;
  const forestPalette = tropical ? TROPICAL : CONIFERS;
  const openPalette = tropical ? TROPICAL : DECIDUOUS;
  const playable: Vec2Tuple[] = [[-SCATTER_CLIP, -SCATTER_CLIP], [SCATTER_CLIP, -SCATTER_CLIP], [SCATTER_CLIP, SCATTER_CLIP], [-SCATTER_CLIP, SCATTER_CLIP]];
  const poiCores = pois.filter((p) => p.kind !== "forest").map((p) => circle(p.center, p.radius + 8));
  const openingZones = openings.map((o) => circle(o.center, o.width / 2 + 3, 10));
  const waterZones = water.map((w) => [...w]);
  const blocked = [...waterZones, ...openingZones];

  const woods = areas
    .filter((a) => (a.tags.landuse === "forest" || a.tags.natural === "wood") && a.area >= MIN_WOOD_AREA)
    .sort((a, b) => b.area - a.area || a.id - b.id)
    .slice(0, MAX_WOOD_RULES);
  const wetland = areas.filter((a) => a.tags.natural === "wetland" && a.area >= MIN_WOOD_AREA).sort((a, b) => b.area - a.area || a.id - b.id).slice(0, 16);
  const scrub = areas.filter((a) => (a.tags.natural === "scrub" || a.tags.natural === "heath") && a.area >= 600).sort((a, b) => b.area - a.area || a.id - b.id).slice(0, 12);
  const orchards = areas.filter((a) => a.tags.landuse === "orchard" || a.tags.landuse === "vineyard").sort((a, b) => b.area - a.area || a.id - b.id).slice(0, 8);
  const residential = areas.filter((a) => a.tags.landuse === "residential" || a.tags.leisure === "garden" || a.tags.leisure === "park").sort((a, b) => b.area - a.area || a.id - b.id).slice(0, 12);
  const farmland = areas.filter((a) => a.tags.landuse === "farmland" || a.tags.landuse === "meadow" || a.tags.landuse === "grass").sort((a, b) => b.area - a.area || a.id - b.id).slice(0, 20);
  const woodRings = woods.map((w) => areaRing(w)).filter((r) => r.length >= 3);

  const rules: ScatterRule[] = [];
  const add = (rule: ScatterRule) => {
    if (rule.area.length >= 3) rules.push({ ...rule, exclude: [...(rule.exclude ?? []), ...blocked] });
  };

  // Big trunks first, so smaller trees grow round them.
  woods.forEach((wood, i) => {
    const area = woodRings[i];
    if (!area) return;
    const id = `wood_${i + 1}`;
    add({ id: `${id}_oaks`, props: [{ prop: "tree_oak_fungi", weight: 1 }], area, density: 0.04, mask: { wavelength: 80, threshold: 0.32 }, edgeFade: 20, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: holes(wood), minDistance: 14, scaleRange: [0.9, 1.1] });
  });
  if (!urban) add({ id: "field_oaks", props: [{ prop: "tree_oak_large", weight: 1 }], area: playable, density: 0.012, maxSlopeDegrees: 14, excludeSurfaces: ["road", "dirt"], exclude: [...poiCores, ...woodRings], minDistance: 55, scaleRange: [0.85, 1.15] });
  woods.forEach((wood, i) => {
    const area = woodRings[i];
    if (!area) return;
    const id = `wood_${i + 1}`;
    add({ id, props: forestPalette, area, density: 1.5, mask: { wavelength: 80, threshold: 0.32 }, edgeFade: 12, maxSlopeDegrees: 38, excludeSurfaces: ["road"], exclude: holes(wood), scaleRange: [0.75, 1.3] });
    if (wood.area >= 5000) add({ id: `${id}_under`, props: UNDERGROWTH, area, density: 1.6, mask: { wavelength: 60, threshold: 0.3 }, edgeFade: 10, maxSlopeDegrees: 40, excludeSurfaces: ["road"], exclude: holes(wood), scaleRange: [0.7, 1.3] });
  });
  wetland.forEach((w, i) => {
    const area = areaRing(w);
    add({ id: `wetland_${i + 1}`, props: [...TROPICAL.map((p) => ({ prop: p.prop, weight: p.weight * 0.3 })), ...BUSHES, { prop: "fern", weight: 2 }], area, density: 0.9, mask: { wavelength: 50, threshold: 0.4 }, edgeFade: 6, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: holes(w), scaleRange: [0.7, 1.2] });
  });
  scrub.forEach((s, i) => {
    add({ id: `scrub_${i + 1}`, props: [...BUSHES, { prop: "tree_fir_young", weight: tropical ? 0 : 0.3 }, { prop: "tree_broadleaf_b", weight: 0.2 }], area: areaRing(s), density: 1, mask: { wavelength: 40, threshold: 0.35 }, maxSlopeDegrees: 35, excludeSurfaces: ["road"], scaleRange: [0.7, 1.2] });
  });
  orchards.forEach((o, i) => {
    add({ id: `orchard_${i + 1}`, props: [{ prop: "tree_broadleaf_a", weight: 2 }, { prop: "tree_broadleaf_b", weight: 1 }], area: areaRing(o), density: 0.9, maxSlopeDegrees: 20, excludeSurfaces: ["road"], clearance: 1.5, scaleRange: [0.7, 0.9] });
  });
  residential.forEach((r, i) => {
    add({ id: `gardens_${i + 1}`, props: [{ prop: "tree_broadleaf_b", weight: 1 }, { prop: "bush_c", weight: 2 }, { prop: "bush_a", weight: 2 }], area: areaRing(r), density: urban ? 0.12 : 0.5, avoidPads: false, clearance: 2.5, excludeSurfaces: ["road"], scaleRange: [0.7, 1.1] });
  });
  // Tree rows: a 5 m band along each row.
  lines
    .filter((l) => l.tags.natural === "tree_row")
    .sort((a, b) => a.id - b.id)
    .forEach((row, i) => {
      for (const piece of clipPolylineToSquare(row.points, SCATTER_CLIP)) {
        if (polylineLength(piece) < 20) continue;
        const band = roundRing([...bandAlong(piece, 0, 2.5, 1), ...bandAlong(piece, 0, 2.5, -1).reverse()]);
        add({ id: `tree_row_${i + 1}_${rules.length}`, props: openPalette, area: band, density: 3, clearance: 1, maxSlopeDegrees: 30, scaleRange: [0.9, 1.2] });
      }
    });
  farmland.slice(0, 10).forEach((f, i) => {
    add({ id: `hay_${i + 1}`, props: [{ prop: tropical ? "hay_bale_wall" : "hay_bale_stack", weight: 1 }], area: areaRing(f), density: 0.012, maxSlopeDegrees: 12, excludeSurfaces: ["road", "rock"], exclude: poiCores, minDistance: 55 });
  });

  // Groves between settlements and tree lines along roads outside them break long sightlines (Map v1's feedback: no
  // big blank fields).
  if (urban) {
    areas
      .filter((a) => ["park", "garden", "playground"].includes(a.tags.leisure ?? "") || ["grass", "village_green"].includes(a.tags.landuse ?? "") || a.tags.place === "square")
      .filter((a) => a.area >= 150)
      .sort((a, b) => b.area - a.area || a.id - b.id)
      .slice(0, 16)
      .forEach((park, i) => {
        const area = areaRing(park, 1);
        add({ id: `park_${i + 1}_trees`, props: TROPICAL, area, density: 0.45, clearance: 2, maxSlopeDegrees: 30, excludeSurfaces: ["road"], scaleRange: [0.9, 1.3] });
        add({ id: `park_${i + 1}_bushes`, props: BUSHES, area, density: 0.8, maxSlopeDegrees: 30, excludeSurfaces: ["road"], scaleRange: [0.8, 1.3] });
      });
    // Street trees in the gaps along streets (houses and their pads keep them out of the frontage).
    roads
      .filter((road) => (road.width ?? 5) >= 5.5 && polylineLength(road.points) >= 40)
      .forEach((road) => {
        for (const side of [1, -1] as const) {
          const inner = (road.width ?? 5) / 2 + 3;
          add({ id: `${road.id}_street_trees_${side > 0 ? "r" : "l"}`, props: TROPICAL, area: roundRing(bandAlong(road.points, inner, inner + 4, side)), density: 2.4, clearance: 0.8, minDistance: 7, maxSlopeDegrees: 30, scaleRange: [0.85, 1.2] });
        }
      });
  }
  if (!urban) add({ id: "groves", props: openPalette, area: playable, density: 1.3, mask: { wavelength: 100, threshold: 0.58, softness: 0.05 }, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: [...poiCores, ...woodRings], scaleRange: [0.8, 1.3] });
  roads
    .filter((road) => !urban && polylineLength(road.points) >= 60)
    .forEach((road) => {
      for (const side of [1, -1] as const) {
        const inner = (road.width ?? 5) / 2 + 2.5;
        add({ id: `${road.id}_trees_${side > 0 ? "r" : "l"}`, props: openPalette, area: roundRing(bandAlong(road.points, inner, inner + 5, side)), density: 1.6, mask: { wavelength: 45, threshold: 0.45 }, clearance: 1, maxSlopeDegrees: 30, exclude: poiCores, scaleRange: [0.85, 1.25] });
      }
    });

  // Empty ground the OSM square never covers: hills with tropical woodland, in the spirit of Map v1's fields.
  if (wilderness) for (const rule of wildernessScatters(wilderness, playable)) add(rule);

  // Map-wide cover (Map v1's layers). City dressing stays in the city: the inverted weight keeps it out of the woods.
  const cityOnly = wilderness ? { weightGrid: wilderness.weights, weightGridInvert: true } : {};
  if (urban) {
    add({
      ...cityOnly,
      id: "urban_cover",
      props: [
        { prop: "car_covered", weight: 3 },
        { prop: "utility_box", weight: 2 },
        { prop: "barrel_rusty", weight: 1.5 },
        { prop: "road_barrier", weight: 1 },
        { prop: "bush_c", weight: 1 },
      ],
      area: playable,
      density: 0.035,
      cluster: { count: [1, 3], radius: 5, anchor: { props: [{ prop: "car_wreck", weight: 1 }, { prop: "pipe_stack", weight: 1 }], chance: 0.15, scaleRange: [0.95, 1.05] } },
      maxSlopeDegrees: 20,
      excludeSurfaces: ["road"],
      scaleRange: [0.95, 1.05],
    });
  } else add({
    id: "field_cover",
    props: [
      { prop: "rock_boulder_b", weight: 1 },
      { prop: "rock_moss_a", weight: 1 },
      { prop: "rock_boulder_a", weight: 1.5 },
      { prop: "rock_moss_b", weight: 1.5 },
      { prop: "bush_c", weight: 2.5 },
      { prop: "log_fallen", weight: 0.5 },
      { prop: tropical ? "tree_broadleaf_b" : "tree_fir_young", weight: 0.4 },
    ],
    area: playable,
    exclude: [...poiCores, ...woodRings],
    density: 0.045,
    cluster: { count: [2, 4], radius: 7, anchor: { props: [{ prop: "rock_boulder_large", weight: 3 }, { prop: "log_mossy", weight: 2 }], chance: 0.12, scaleRange: [0.8, 1.3] } },
    mask: { wavelength: 160, threshold: 0.3, softness: 0.15 },
    maxSlopeDegrees: 30,
    excludeSurfaces: ["road"],
    scaleRange: [0.7, 1.2],
  });
  // Map v1's slope layers, for the real relief. A wilderness map dresses its own hills with `wild_slope_rocks`, whose
  // palette is deliberately narrow: bullet-blocking props are never distance-culled, so each extra kind of them costs a
  // draw call per map cell it lands in (docs/perf/benchmark.md).
  if (!wilderness) {
    add({ id: "slope_boulders", props: [{ prop: "rock_boulder_large", weight: 1 }], area: playable, density: 0.1, minSlopeDegrees: 18, maxSlopeDegrees: 35, exclude: poiCores, minDistance: 25, scaleRange: [0.9, 1.6] });
    add({ id: "slope_faces", props: [{ prop: "rock_face_large", weight: 1 }], area: playable, density: 0.1, minSlopeDegrees: 25, maxSlopeDegrees: 45, exclude: poiCores, minDistance: 40, faceDownhill: true, scaleRange: [0.9, 1.2] });
    add({ id: "slope_rocks", props: [{ prop: "rock_small", weight: 4 }, { prop: "rock_moss_b", weight: 1 }, { prop: "rock_boulder_a", weight: 1 }], area: playable, density: 0.6, minSlopeDegrees: 17, maxSlopeDegrees: 60, scaleRange: [0.7, 1.4] });
  }
  add({ ...(urban ? cityOnly : {}), id: "cover_fill", props: [{ prop: urban ? "car_covered" : "rock_boulder_large", weight: 1 }], area: playable, density: 0.06, bareRadius: 25, maxSlopeDegrees: 30, excludeSurfaces: ["road"], exclude: [...woodRings, ...poiCores], scaleRange: [0.9, 1.3] });
  add({ id: "meadow_bushes", props: BUSHES, area: playable, density: urban ? 0.05 : 0.12, mask: { wavelength: 70, threshold: 0.45 }, maxSlopeDegrees: 30, excludeSurfaces: ["road", "rock"], scaleRange: [0.7, 1.3] });
  // Grass (client-side detail around the viewer): water zones only, fence gaps don't matter for it.
  rules.push({ id: "grass", props: [{ prop: "grass_clump_short", weight: 3 }, { prop: "grass_clump_medium", weight: 2 }, { prop: "grass_clump_tall", weight: 1 }], area: playable, density: 30, mask: { wavelength: 28, threshold: 0.42, softness: 0.2 }, maxSlopeDegrees: 35, excludeSurfaces: ["road", "dirt", "rock"], exclude: waterZones, scaleRange: [0.7, 1.3], detail: true });

  const ha = (list: readonly AreaFeature[]) => Math.round(list.reduce((sum, a) => sum + a.area, 0) / 1000) / 10;
  return {
    scatters: rules,
    report: { forestHa: ha(areas.filter((a) => a.tags.landuse === "forest" || a.tags.natural === "wood")), fieldHa: ha(areas.filter((a) => a.tags.landuse === "farmland" || a.tags.landuse === "meadow")), waterHa: Math.round(water.reduce((s, w) => s + polygonArea(w), 0) / 1000) / 10, rules: rules.length },
  };
}

function polygonArea(ring: Polygon): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  return Math.abs(sum) / 2;
}

/** True when (x, z) lies inside any polygon. */
export function insideAny(polygons: readonly Polygon[], x: number, z: number): boolean {
  return polygons.some((p) => pointInPolygon(p, x, z));
}
