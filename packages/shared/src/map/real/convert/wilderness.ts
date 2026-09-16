/**
 * Wilderness: the empty ground of a real-world map, filled the way Map v1 fills its fields.
 *
 * A 1 km square of a real city keeps only as many buildings as the cap allows, so the built-up part is a core a few
 * hundred meters across and the rest is flat grass with an alley grid on it, which reads as unfinished. This module
 * finds that ground with a coverage mask over the map grid — buildings, water and mapped areas are "city", main streets
 * and creeks keep a narrower verge, and the alleys count for nothing — turns the distance from the city into a 0..1
 * wilderness weight, and produces two things from it:
 *
 * - a `heightGrid` terrain feature of gentle hills and ridges that is exactly 0 over the city, so the mapped part keeps
 *   its real elevation and no building ends up on a slope;
 * - a `WeightGrid` the forest scatter rules multiply into their density, so the woodland thins out toward the streets.
 *
 * Pure and deterministic: seeded integer-hash noise only, no `Math.random`.
 */
import type { FlattenRegion, TerrainFeature, TerrainSpec, Vec2Tuple } from "../../types";
import type { RoadSpec } from "../../layout/roads";
import type { WeightGrid } from "../../layout/scatter";
import { pointInPolygon, polygonBounds, polylineDistance, rectCorners, type OrientedRect } from "../../layout/geometry";
import { smoothstep } from "../../terrain/math";
import { fbm, ridged, subSeed } from "../../terrain/noise";
import type { AreaFeature, Polygon } from "./types";
import { HEIGHT_GRID_SPACING } from "./elevation";

/** Coverage mask cell size, m (129 × 129 over the 1280 m square). */
export const COVERAGE_SPACING = 10;

/** Roads at least this wide count as streets that keep a cleared verge; narrower ones are alleys the woods grow around, m. */
const MAIN_ROAD_WIDTH = 5.5;

/** Margins added around mapped things when the coverage mask is rasterized, m. */
const MARGIN = {
  /** Beyond a main street's carriageway edge. */
  road: 6,
  /** Around a building the map places. */
  building: 26,
  /** Around a mapped land-use, leisure or water area (parks, schoolyards, pitches, woods: already dressed). */
  area: 12,
  /** Around a dry creek bed. */
  creek: 10,
  /** Around a bridge deck, so both ramps and the ground they land on stay level. */
  bridge: 30,
} as const;

export interface WildernessOptions {
  /** Hill height where the wilderness is at full strength, m. Default 15. */
  readonly relief?: number;
  /** Extra height as the ground approaches the playable edge, so the map rises into the border mountains, m. Default 13. */
  readonly edgeRise?: number;
  /** Steepest step between neighbouring height samples, degrees. Keeps every slope walkable. Default 14. */
  readonly maxSlopeDegrees?: number;
  /** Distance from the built-up city over which hills and trees ramp in, m. Default 90. */
  readonly ramp?: number;
  /** Cleared verge along the main streets and creeks, m. Default 30. */
  readonly roadRamp?: number;
  /**
   * Distance over which the hills themselves come up, m. Default 150, much longer than `ramp`: every road is flattened
   * along a path smoothed over about 40 m, so the ground has to change slowly or the alleys crossing it end up in
   * cuttings whose banks are at the edge of what a player can climb.
   */
  readonly hillRamp?: number;
  /** Multiplies every wilderness scatter density. Default 1. */
  readonly density?: number;
}

export interface WildernessReport {
  /** Ground with a wilderness weight above 0.5, ha. */
  readonly areaHa: number;
  /** Ground with any wilderness weight at all, ha. */
  readonly touchedHa: number;
  /** Share of the playable square that counts as mapped city, 0..1. */
  readonly cityRatio: number;
  /** Tallest wilderness hill above the city level, m. */
  readonly peak: number;
  /** Steepest neighbouring-sample slope of the wilderness grid inside the playable square, degrees. */
  readonly maxSlopeDegrees: number;
}

export interface Wilderness {
  /** Density weight for the forest scatter rules (0 over the city). */
  readonly weights: WeightGrid;
  /** Hills to add to the terrain, as a `heightGrid` feature covering the whole square. */
  readonly feature: Extract<TerrainFeature, { kind: "heightGrid" }>;
  readonly options: Required<WildernessOptions>;
  readonly report: WildernessReport;
}

export interface WildernessInput {
  readonly seed: number;
  readonly terrain: Pick<TerrainSpec, "size" | "playableHalfExtent">;
  /**
   * Outlines of the buildings the map will place. Not the OSM footprints: a dense city square has an alley and a
   * footprint almost everywhere, while the building cap keeps the built-up part to a core, and it is the ground outside
   * that core the player sees as empty.
   */
  readonly buildings: readonly OrientedRect[];
  /** Bridge decks. Their approaches have to stay level, or the bridge no longer meets the banks and validation drops it. */
  readonly bridges?: readonly OrientedRect[];
  /** Mapped land use, natural, leisure and water areas. */
  readonly areas: readonly AreaFeature[];
  readonly roads: readonly RoadSpec[];
  readonly creeks: readonly FlattenRegion[];
  readonly water: readonly Polygon[];
  readonly options?: WildernessOptions;
}

export function wildernessDefaults(options: WildernessOptions = {}): Required<WildernessOptions> {
  return {
    relief: options.relief ?? 15,
    edgeRise: options.edgeRise ?? 13,
    maxSlopeDegrees: options.maxSlopeDegrees ?? 14,
    ramp: options.ramp ?? 90,
    roadRamp: options.roadRamp ?? 30,
    hillRamp: options.hillRamp ?? 150,
    density: options.density ?? 1,
  };
}

/** A square with less open ground than this at full strength is left exactly as it was, ha. */
export const MIN_WILDERNESS_HA = 2;

/**
 * Coverage mask → wilderness weight → hills. Returns null when the place has no empty ground worth filling
 * (`MIN_WILDERNESS_HA`), so a densely mapped square is left exactly as it was.
 */
export function buildWilderness(input: WildernessInput): Wilderness | null {
  const built = measureWilderness(input);
  return built.report.areaHa < MIN_WILDERNESS_HA ? null : built;
}

/** `buildWilderness` without the "is it worth it" test: always returns the mask and hills, for tooling and tests. */
export function measureWilderness(input: WildernessInput): Wilderness {
  const options = wildernessDefaults(input.options);
  const { size, playableHalfExtent } = input.terrain;
  const half = size / 2;
  const columns = Math.round(size / COVERAGE_SPACING) + 1;
  const rows = columns;
  /** Built-up ground: buildings, water and mapped areas. The woods stop well short of it. */
  const city = new Uint8Array(columns * rows);
  /** Main streets and creek beds: they only keep a verge clear, so the woods can close in behind them. */
  const verge = new Uint8Array(columns * rows);
  const worldX = (i: number) => -half + i * COVERAGE_SPACING;
  const worldZ = (j: number) => -half + j * COVERAGE_SPACING;
  const index = (v: number) => Math.round((v + half) / COVERAGE_SPACING);
  const clampIndex = (i: number) => (i < 0 ? 0 : i >= columns ? columns - 1 : i);

  /** Marks every cell whose centre lies within `margin` of the shape `distance` measures. */
  const markNear = (mask: Uint8Array, minX: number, minZ: number, maxX: number, maxZ: number, margin: number, distance: (x: number, z: number) => number) => {
    const i0 = clampIndex(index(minX - margin) - 1);
    const i1 = clampIndex(index(maxX + margin) + 1);
    const j0 = clampIndex(index(minZ - margin) - 1);
    const j1 = clampIndex(index(maxZ + margin) + 1);
    for (let j = j0; j <= j1; j++) {
      const z = worldZ(j);
      const row = j * columns;
      for (let i = i0; i <= i1; i++) {
        if (mask[row + i]) continue;
        if (distance(worldX(i), z) <= margin) mask[row + i] = 1;
      }
    }
  };

  for (const road of input.roads) {
    if ((road.width ?? 5) < MAIN_ROAD_WIDTH) continue;
    const bounds = polygonBounds(road.points);
    const margin = (road.width ?? 5) / 2 + MARGIN.road;
    markNear(verge, bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, margin, (x, z) => polylineDistance(road.points, x, z));
  }
  for (const creek of input.creeks) {
    if (creek.shape !== "polyline") continue;
    const points = creek.points.map((p): Vec2Tuple => [p[0], p[1]]);
    const bounds = polygonBounds(points);
    markNear(verge, bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, creek.width / 2 + MARGIN.creek, (x, z) => polylineDistance(points, x, z));
  }
  const markArea = (mask: Uint8Array, ring: Polygon, margin: number) => {
    if (ring.length < 3) return;
    const bounds = polygonBounds(ring);
    const closed = ring[ring.length - 1]! === ring[0]! ? ring : [...ring, ring[0]!];
    markNear(mask, bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ, margin, (x, z) => (pointInPolygon(ring, x, z) ? 0 : polylineDistance(closed, x, z)));
  };
  for (const rect of input.buildings) markArea(city, rectCorners(rect), MARGIN.building);
  for (const rect of input.bridges ?? []) markArea(city, rectCorners(rect), MARGIN.bridge);
  for (const area of input.areas) markArea(city, area.outer, MARGIN.area);
  for (const ring of input.water) markArea(city, ring, MARGIN.area);

  const cityDistance = euclideanDistance(city, columns, rows, COVERAGE_SPACING);
  const vergeDistance = euclideanDistance(verge, columns, rows, COVERAGE_SPACING);
  // Trees may close in on a street after a short verge, and fill the blocks between the alleys; the ground under them
  // has to come up far more slowly, over `hillRamp`, so those alleys never end up in a cutting.
  const weight = new Float64Array(columns * rows);
  const hillWeight = new Float64Array(columns * rows);
  for (let k = 0; k < weight.length; k++) {
    weight[k] = Math.min(smoothstep(0, options.ramp, cityDistance[k]!), smoothstep(0, options.roadRamp, vergeDistance[k]!));
    hillWeight[k] = Math.min(smoothstep(0, options.hillRamp, cityDistance[k]!), smoothstep(0, options.hillRamp, vergeDistance[k]!));
  }

  const sample = (x: number, z: number) => bilinear(hillWeight, columns, rows, (x + half) / COVERAGE_SPACING, (z + half) / COVERAGE_SPACING);

  // Hills on a 20 m grid, so they line up with the real-elevation grid the village maps use.
  const count = Math.round(size / HEIGHT_GRID_SPACING) + 1;
  const hills = new Float64Array(count * count);
  const seeds = { hills: subSeed(input.seed, 41), ridges: subSeed(input.seed, 42) };
  for (let j = 0; j < count; j++) {
    for (let i = 0; i < count; i++) {
      const x = -half + i * HEIGHT_GRID_SPACING;
      const z = -half + j * HEIGHT_GRID_SPACING;
      const w = sample(x, z);
      if (w <= 0) continue;
      // Two octaves only, on long wavelengths: the roads crossing this ground are flattened along a path smoothed over
      // ~40 m, so short, sharp landforms would leave them in deep cuttings with banks at the edge of what a player can climb.
      const rolling = (fbm(x / 260, z / 260, 2, seeds.hills) + 1) / 2;
      const crest = ridged(x / 420, z / 420, 2, seeds.ridges);
      const edge = smoothstep(190, playableHalfExtent - 20, Math.max(Math.abs(x), Math.abs(z)));
      hills[j * count + i] = w * (options.relief * (0.2 + 0.8 * rolling) * (0.55 + 0.75 * crest) + options.edgeRise * edge);
    }
  }
  limitSlope(hills, count, HEIGHT_GRID_SPACING, options.maxSlopeDegrees, (i, j) => sample(-half + i * HEIGHT_GRID_SPACING, -half + j * HEIGHT_GRID_SPACING));

  const heights: number[] = [];
  for (let k = 0; k < hills.length; k++) heights.push(Math.round(Math.max(0, hills[k]!) * 100) / 100);

  // Report and the "is there anything to do here" test, over the playable square only.
  const cellHa = (COVERAGE_SPACING * COVERAGE_SPACING) / 10000;
  let full = 0;
  let touched = 0;
  let builtUp = 0;
  let playableCells = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      if (Math.abs(worldX(i)) > playableHalfExtent || Math.abs(worldZ(j)) > playableHalfExtent) continue;
      playableCells++;
      const w = weight[j * columns + i]!;
      if (city[j * columns + i]) builtUp++;
      if (w > 0.5) full++;
      if (w > 0) touched++;
    }
  }
  let peak = 0;
  let maxTan = 0;
  for (let j = 0; j < count; j++) {
    for (let i = 0; i < count; i++) {
      const x = -half + i * HEIGHT_GRID_SPACING;
      const z = -half + j * HEIGHT_GRID_SPACING;
      if (Math.abs(x) > playableHalfExtent || Math.abs(z) > playableHalfExtent) continue;
      const h = heights[j * count + i]!;
      peak = Math.max(peak, h);
      if (i + 1 < count) maxTan = Math.max(maxTan, Math.abs(heights[j * count + i + 1]! - h) / HEIGHT_GRID_SPACING);
      if (j + 1 < count) maxTan = Math.max(maxTan, Math.abs(heights[(j + 1) * count + i]! - h) / HEIGHT_GRID_SPACING);
    }
  }

  return {
    weights: {
      origin: [-half, -half],
      spacing: COVERAGE_SPACING,
      columns,
      rows,
      values: encodeWeights(weight),
    },
    feature: { kind: "heightGrid", origin: [-half, -half], spacing: HEIGHT_GRID_SPACING, columns: count, rows: count, heights },
    options,
    report: {
      areaHa: Math.round(full * cellHa * 10) / 10,
      touchedHa: Math.round(touched * cellHa * 10) / 10,
      cityRatio: Math.round((builtUp / Math.max(1, playableCells)) * 1000) / 1000,
      peak: Math.round(peak * 10) / 10,
      maxSlopeDegrees: Math.round(degrees(maxTan) * 10) / 10,
    },
  };
}

/** Adds the wilderness hills to a terrain spec, on top of any real-elevation grid it already carries. */
export function withWilderness(spec: TerrainSpec, wilderness: Wilderness | null): TerrainSpec {
  if (!wilderness) return spec;
  return { ...spec, features: [...spec.features, wilderness.feature] };
}

/** Quantizes 0..1 weights to the digit string a generated module stores. */
function encodeWeights(weight: Float64Array): string {
  const codes = new Array<string>(weight.length);
  for (let k = 0; k < weight.length; k++) codes[k] = String(Math.max(0, Math.min(9, Math.round(weight[k]! * 9))));
  return codes.join("");
}

function degrees(tan: number): number {
  return (Math.atan(tan) * 180) / Math.PI;
}

/**
 * Exact Euclidean distance (Felzenszwalb & Huttenlocher) from every cell to the nearest set cell, in meters.
 * Returns `Infinity`-free values: with no set cell at all every distance is the grid diagonal.
 */
function euclideanDistance(mask: Uint8Array, columns: number, rows: number, spacing: number): Float64Array {
  const big = (columns + rows) * (columns + rows);
  const squared = new Float64Array(columns * rows);
  for (let k = 0; k < squared.length; k++) squared[k] = mask[k] ? 0 : big;

  const line = new Float64Array(Math.max(columns, rows));
  const v = new Int32Array(Math.max(columns, rows));
  const zBound = new Float64Array(Math.max(columns, rows) + 1);
  const out = new Float64Array(Math.max(columns, rows));

  // Columns, then rows: the 1D transform of the squared distances along each axis.
  for (let i = 0; i < columns; i++) {
    for (let j = 0; j < rows; j++) line[j] = squared[j * columns + i]!;
    transform1d(line, rows, v, zBound, out);
    for (let j = 0; j < rows; j++) squared[j * columns + i] = out[j]!;
  }
  for (let j = 0; j < rows; j++) {
    const row = j * columns;
    for (let i = 0; i < columns; i++) line[i] = squared[row + i]!;
    transform1d(line, columns, v, zBound, out);
    for (let i = 0; i < columns; i++) squared[row + i] = out[i]!;
  }
  const distance = new Float64Array(columns * rows);
  for (let k = 0; k < distance.length; k++) distance[k] = Math.sqrt(squared[k]!) * spacing;
  return distance;
}

/** Lower envelope of the parabolas f(q) + (p - q)², the 1D step of the distance transform. */
function transform1d(f: Float64Array, n: number, v: Int32Array, z: Float64Array, out: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = 0;
    for (;;) {
      const p = v[k]!;
      s = (f[q]! + q * q - (f[p]! + p * p)) / (2 * q - 2 * p);
      if (s > z[k]!) break;
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    out[q] = (q - p) * (q - p) + f[p]!;
  }
}

/**
 * Pulls neighbouring samples together until no step exceeds `maxSlopeDegrees`, so every wilderness slope stays
 * comfortably inside the character controller's walk limit. Each sample moves in proportion to its own wilderness
 * weight, so a city sample (weight 0) never moves and the mapped ground keeps its elevation.
 */
function limitSlope(heights: Float64Array, count: number, spacing: number, maxSlopeDegrees: number, weightAt: (i: number, j: number) => number): void {
  const maxStep = Math.tan((maxSlopeDegrees * Math.PI) / 180) * spacing;
  const mobility = new Float64Array(count * count);
  for (let j = 0; j < count; j++) for (let i = 0; i < count; i++) mobility[j * count + i] = weightAt(i, j);

  for (let pass = 0; pass < 60; pass++) {
    let worst = 0;
    for (let j = 0; j < count; j++) {
      for (let i = 0; i < count; i++) {
        const a = j * count + i;
        for (const b of [i + 1 < count ? a + 1 : -1, j + 1 < count ? a + count : -1]) {
          if (b < 0) continue;
          const delta = heights[b]! - heights[a]!;
          const excess = Math.abs(delta) - maxStep;
          if (excess <= 1e-6) continue;
          worst = Math.max(worst, excess);
          const ma = mobility[a]!;
          const mb = mobility[b]!;
          const total = ma + mb;
          if (total <= 0) continue;
          const sign = delta > 0 ? 1 : -1;
          heights[a] = heights[a]! + (sign * excess * ma) / total;
          heights[b] = heights[b]! - (sign * excess * mb) / total;
        }
      }
    }
    if (worst <= 1e-6) break;
  }
  for (let k = 0; k < heights.length; k++) if (heights[k]! < 0) heights[k] = 0;
}

function bilinear(values: Float64Array, columns: number, rows: number, gx: number, gz: number): number {
  const cx = Math.min(columns - 1, Math.max(0, gx));
  const cz = Math.min(rows - 1, Math.max(0, gz));
  const ix = Math.min(columns - 2, Math.floor(cx));
  const iz = Math.min(rows - 2, Math.floor(cz));
  const tx = cx - ix;
  const tz = cz - iz;
  const a = values[iz * columns + ix]! + (values[iz * columns + ix + 1]! - values[iz * columns + ix]!) * tx;
  const b = values[(iz + 1) * columns + ix]! + (values[(iz + 1) * columns + ix + 1]! - values[(iz + 1) * columns + ix]!) * tx;
  return a + (b - a) * tz;
}
