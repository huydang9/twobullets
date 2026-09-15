import type { TerrainFeature, TerrainSpec, Vec2Tuple } from "../types";
import { Heightfield } from "./heightfield";
import { segmentDistanceSq, smoothstep } from "./math";
import { fbm, ridged, subSeed } from "./noise";

/** Height of the unflattened terrain at any world (x, z), including far outside the grid (horizon meshes use that). */
export type ReliefFunction = (x: number, z: number) => number;

const LAYER = { warpX: 1, warpZ: 2, macro: 3, hills: 4, detail: 5, mountains: 6, features: 7 } as const;

/** Builds the procedural height function for a spec. Pure and deterministic; see math.ts for the float rules. */
export function createReliefFunction(spec: TerrainSpec): ReliefFunction {
  const seed = spec.seed >>> 0;
  const { relief, border } = spec;
  const seeds = {
    warpX: subSeed(seed, LAYER.warpX),
    warpZ: subSeed(seed, LAYER.warpZ),
    macro: subSeed(seed, LAYER.macro),
    hills: subSeed(seed, LAYER.hills),
    detail: subSeed(seed, LAYER.detail),
    mountains: subSeed(seed, LAYER.mountains),
    features: subSeed(seed, LAYER.features),
  };
  const warpFrequency = 1 / (relief.hillWavelength * 2.5);
  const inset = spec.playableHalfExtent - border.foothillInset;
  const borderSpan = border.foothillInset + border.rampDistance;

  const natural = (x: number, z: number, out: { wx: number; wz: number }): number => {
    const fx = x * warpFrequency;
    const fz = z * warpFrequency;
    const wx = x + fbm(fx, fz, 3, seeds.warpX) * relief.warp;
    const wz = z + fbm(fx + 5.2, fz + 1.3, 3, seeds.warpZ) * relief.warp;
    out.wx = wx;
    out.wz = wz;
    return (
      relief.baseHeight +
      fbm(wx / relief.macroWavelength, wz / relief.macroWavelength, 3, seeds.macro) * relief.macroAmplitude +
      fbm(wx / relief.hillWavelength, wz / relief.hillWavelength, 4, seeds.hills) * relief.hillAmplitude +
      fbm(x / relief.detailWavelength, z / relief.detailWavelength, 2, seeds.detail) * relief.detailAmplitude
    );
  };

  const warped = { wx: 0, wz: 0 };
  const features = spec.features.map((feature) => compileFeature(feature, seeds.features, natural));

  return (x, z) => {
    let h = natural(x, z, warped);
    const { wx, wz } = warped;
    for (const feature of features) h = feature(x, z, wx, wz, h);

    // Out-of-bounds mountains: distance outside a square slightly inside the playable edge, rounded at the corners.
    const ex = Math.abs(x) - inset;
    const ez = Math.abs(z) - inset;
    if (ex > 0 || ez > 0) {
      const dx = ex > 0 ? ex : 0;
      const dz = ez > 0 ? ez : 0;
      const t = smoothstep(0, borderSpan, Math.sqrt(dx * dx + dz * dz));
      const crest = ridged(wx / border.ridgeWavelength, wz / border.ridgeWavelength, 5, seeds.mountains);
      h += border.height * t * t * (0.3 + 0.7 * crest);
    }
    return h;
  };
}

type CompiledFeature = (x: number, z: number, wx: number, wz: number, h: number) => number;

function compileFeature(feature: TerrainFeature, seed: number, natural: (x: number, z: number, out: { wx: number; wz: number }) => number): CompiledFeature {
  switch (feature.kind) {
    case "hill": {
      const [cx, cz] = feature.center;
      const r2 = feature.radius * feature.radius;
      return (x, z, _wx, _wz, h) => {
        const q = ((x - cx) * (x - cx) + (z - cz) * (z - cz)) / r2;
        return q < 1 ? h + feature.height * (1 - q) * (1 - q) : h;
      };
    }
    case "ridge":
    case "valley": {
      const sign = feature.kind === "ridge" ? feature.height : -feature.depth;
      const half = feature.width / 2;
      const path = feature.path;
      const along = { t: 0 };
      return (x, z, wx, wz, h) => {
        const q = polylineDistanceSq(path, x, z, along) / (half * half);
        if (q >= 1) return h;
        // Vary the crest height a little so the ridge line isn't perfectly even.
        const variation = 0.85 + 0.15 * fbm(wx / 90, wz / 90, 2, seed);
        return h + sign * variation * (1 - q) * (1 - q);
      };
    }
    case "basin": {
      const [cx, cz] = feature.center;
      const { radius, floorRadius, depth, terraces } = feature;
      // The floor settles at the natural height of the basin center so it's level rather than following the hills.
      const floorBase = natural(cx, cz, { wx: 0, wz: 0 });
      const wallFraction = 0.35;
      return (_x, _z, wx, wz, h) => {
        const r = Math.sqrt((wx - cx) * (wx - cx) + (wz - cz) * (wz - cz));
        if (r >= radius) return h;
        // s: 0 at the rim, 1 on the floor.
        const s = r <= floorRadius ? 1 : (radius - r) / (radius - floorRadius);
        const stepped = s * terraces;
        const bench = Math.floor(stepped);
        const wall = smoothstep(0, wallFraction, stepped - bench);
        const cut = bench >= terraces ? 1 : (bench + wall) / terraces;
        const level = smoothstep(0, 0.25, s);
        return h + (floorBase - h) * level - depth * cut;
      };
    }
    case "heightGrid": {
      const { origin, spacing, columns, rows, heights } = feature;
      if (heights.length !== columns * rows) throw new Error(`heightGrid expects ${columns * rows} heights, got ${heights.length}`);
      const wx = [0, 0, 0, 0];
      const wz = [0, 0, 0, 0];
      return (x, z, _wx, _wz, h) => {
        const gx = (x - origin[0]) / spacing;
        const gz = (z - origin[1]) / spacing;
        const ix = Math.floor(gx);
        const iz = Math.floor(gz);
        catmullRomWeights(gx - ix, wx);
        catmullRomWeights(gz - iz, wz);
        let sum = 0;
        for (let j = 0; j < 4; j++) {
          const row = clampIndex(iz + j - 1, rows) * columns;
          let line = 0;
          for (let i = 0; i < 4; i++) line += wx[i]! * heights[row + clampIndex(ix + i - 1, columns)]!;
          sum += wz[j]! * line;
        }
        return h + sum;
      };
    }
  }
}

function clampIndex(i: number, count: number): number {
  return i < 0 ? 0 : i >= count ? count - 1 : i;
}

/** Uniform Catmull-Rom weights of samples i-1..i+2 at fraction t (they sum to 1 and interpolate the samples). */
function catmullRomWeights(t: number, out: number[]): void {
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = (-t3 + 2 * t2 - t) / 2;
  out[1] = (3 * t3 - 5 * t2 + 2) / 2;
  out[2] = (-3 * t3 + 4 * t2 + t) / 2;
  out[3] = (t3 - t2) / 2;
}

/** Squared distance to the nearest point of a polyline. */
export function polylineDistanceSq(path: readonly Vec2Tuple[], x: number, z: number, scratch: { t: number }): number {
  if (path.length === 1) {
    const [px, pz] = path[0]!;
    return (x - px) * (x - px) + (z - pz) * (z - pz);
  }
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, az] = path[i]!;
    const [bx, bz] = path[i + 1]!;
    const d = segmentDistanceSq(x, z, ax, az, bx, bz, scratch);
    if (d < best) best = d;
  }
  return best;
}

/** Rows between progress reports during generation. */
const PROGRESS_ROWS = 32;

/**
 * Samples the relief function onto a new heightfield grid (row-major, see Heightfield). `onProgress` receives 0..1
 * every few rows, for loading screens.
 */
export function generateHeightfield(spec: TerrainSpec, buffer?: ArrayBufferLike, onProgress?: (fraction: number) => void): Heightfield {
  const field = buffer ? Heightfield.fromBuffer(spec.size, spec.resolution, buffer) : new Heightfield(spec.size, spec.resolution);
  const relief = createReliefFunction(spec);
  const n = field.resolution;
  const heights = field.heights;
  for (let iz = 0; iz < n; iz++) {
    const z = field.worldZ(iz);
    const row = iz * n;
    for (let ix = 0; ix < n; ix++) heights[row + ix] = relief(field.worldX(ix), z);
    if (onProgress && iz % PROGRESS_ROWS === PROGRESS_ROWS - 1) onProgress((iz + 1) / n);
  }
  return field;
}
