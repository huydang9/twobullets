import type { TerrainFeature, TerrainSpec } from "../../types";
import type { ElevationOptions, ElevationSamples } from "./types";

/** Terrain square and grid shared by every real-world map (same as Map v1: 500 m playable, 70 m border). */
export const REAL_TERRAIN = { size: 640, resolution: 513, playableHalfExtent: 250 } as const;
/** Height of the lowest playable ground, m (keeps `killY` −40 well below everything). */
export const REAL_BASE_HEIGHT = 20;
/** Spacing of the stored height grid, m (65 × 65 over the 640 m square). */
export const HEIGHT_GRID_SPACING = 10;

export interface ElevationReport {
  readonly mode: ElevationOptions["mode"];
  readonly scale: number;
  /** Real elevation range inside the playable square, m above sea level (null when flat or no DEM). */
  readonly realMin: number | null;
  readonly realMax: number | null;
  /** Game relief range inside the playable square, m above the lowest point. */
  readonly gameRelief: number;
  /** Steepest grid slope inside the playable square, degrees-free ratio (rise over run). */
  readonly maxGridSlope: number;
}

/** Box blur of a row-major grid, `passes` times with a 3×3 kernel (edges clamp). */
function blur(values: Float64Array, columns: number, rows: number, passes: number): Float64Array {
  let src = values;
  for (let p = 0; p < passes; p++) {
    const dst = new Float64Array(src.length);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < columns; i++) {
        let sum = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const row = Math.min(rows - 1, Math.max(0, j + dj)) * columns;
          for (let di = -1; di <= 1; di++) sum += src[row + Math.min(columns - 1, Math.max(0, i + di))]!;
        }
        dst[j * columns + i] = sum / 9;
      }
    }
    src = dst;
  }
  return src;
}

/** Linear up to `knee` × max, then a smooth rational roll-off that approaches `max` and never exceeds it. */
function compress(relief: number, max: number): number {
  const knee = 0.7 * max;
  if (relief <= knee) return relief;
  const t = (relief - knee) / (max - knee);
  return knee + ((max - knee) * t) / (1 + t);
}

/**
 * Terrain spec for a real-world place. `real`: the DEM is smoothed (SRTM carries canopy and roof bumps), measured from
 * the lowest playable point, scaled, compressed toward `maxRelief` and stored as a 20 m `heightGrid` feature on a gentle
 * procedural relief. `flat`: that gentle relief only. The procedural mountain border stays either way.
 */
export function realTerrainSpec(seed: number, samples: ElevationSamples | null, options: ElevationOptions): { spec: TerrainSpec; report: ElevationReport } {
  const { size, resolution, playableHalfExtent } = REAL_TERRAIN;
  const half = size / 2;
  const features: TerrainFeature[] = [];
  let report: ElevationReport = { mode: "flat", scale: 0, realMin: null, realMax: null, gameRelief: 0, maxGridSlope: 0 };

  if (options.mode === "real" && samples) {
    const { spacing, columns, rows } = samples;
    const smoothed = blur(Float64Array.from(samples.heights), columns, rows, 2);
    const at = (grid: Float64Array, x: number, z: number) => {
      // Bilinear on the sample grid (sample (0, 0) at (-half, -half)).
      const gx = Math.min(columns - 1.000001, Math.max(0, (x + half) / spacing));
      const gz = Math.min(rows - 1.000001, Math.max(0, (z + half) / spacing));
      const ix = Math.floor(gx);
      const iz = Math.floor(gz);
      const tx = gx - ix;
      const tz = gz - iz;
      const a = grid[iz * columns + ix]! + (grid[iz * columns + ix + 1]! - grid[iz * columns + ix]!) * tx;
      const b = grid[(iz + 1) * columns + ix]! + (grid[(iz + 1) * columns + ix + 1]! - grid[(iz + 1) * columns + ix]!) * tx;
      return a + (b - a) * tz;
    };

    const count = Math.round(size / HEIGHT_GRID_SPACING) + 1;
    const raw = new Float64Array(count * count);
    let realMin = Infinity;
    let realMax = -Infinity;
    for (let j = 0; j < count; j++) {
      for (let i = 0; i < count; i++) {
        const x = -half + i * HEIGHT_GRID_SPACING;
        const z = -half + j * HEIGHT_GRID_SPACING;
        const h = at(smoothed, x, z);
        raw[j * count + i] = h;
        if (Math.abs(x) <= playableHalfExtent && Math.abs(z) <= playableHalfExtent) {
          if (h < realMin) realMin = h;
          if (h > realMax) realMax = h;
        }
      }
    }
    const heights: number[] = [];
    let maxRelief = 0;
    for (let k = 0; k < raw.length; k++) {
      const relief = compress(Math.max(-5, (raw[k]! - realMin) * options.scale), options.maxRelief);
      const rounded = Math.round(relief * 100) / 100;
      heights.push(rounded);
    }
    let maxSlope = 0;
    for (let j = 0; j < count; j++) {
      for (let i = 0; i < count; i++) {
        const x = -half + i * HEIGHT_GRID_SPACING;
        const z = -half + j * HEIGHT_GRID_SPACING;
        if (Math.abs(x) > playableHalfExtent || Math.abs(z) > playableHalfExtent) continue;
        const h = heights[j * count + i]!;
        maxRelief = Math.max(maxRelief, h);
        if (i + 1 < count) maxSlope = Math.max(maxSlope, Math.abs(heights[j * count + i + 1]! - h) / HEIGHT_GRID_SPACING);
        if (j + 1 < count) maxSlope = Math.max(maxSlope, Math.abs(heights[(j + 1) * count + i]! - h) / HEIGHT_GRID_SPACING);
      }
    }
    features.push({ kind: "heightGrid", origin: [-half, -half], spacing: HEIGHT_GRID_SPACING, columns: count, rows: count, heights });
    report = {
      mode: "real",
      scale: options.scale,
      realMin: Math.round(realMin * 10) / 10,
      realMax: Math.round(realMax * 10) / 10,
      gameRelief: Math.round(maxRelief * 10) / 10,
      maxGridSlope: Math.round(maxSlope * 1000) / 1000,
    };
  }

  const spec: TerrainSpec = {
    version: 1,
    seed: seed >>> 0,
    size,
    resolution,
    playableHalfExtent,
    relief: {
      baseHeight: REAL_BASE_HEIGHT,
      // Real relief carries the landforms; noise only breaks up the 20 m spline (and gives flat maps some roll).
      macroAmplitude: options.mode === "flat" ? 1.5 : 0,
      macroWavelength: 600,
      hillAmplitude: options.mode === "flat" ? 1.2 : 0.8,
      hillWavelength: 140,
      detailAmplitude: 0.35,
      detailWavelength: 24,
      warp: 30,
    },
    border: { foothillInset: 40, rampDistance: 110, height: 110, ridgeWavelength: 320 },
    features,
  };
  return { spec, report };
}
