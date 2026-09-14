import { TERRAIN_SURFACES, type TerrainSpec, type TerrainSurface } from "../types";
import type { SurfacePaint } from "./flatten";
import type { Heightfield } from "./heightfield";
import { clamp, smoothstep } from "./math";
import { fbm, subSeed } from "./noise";

// Slope thresholds as tan(angle), so no trigonometry runs at generation time.
const TAN_22 = 0.4040262258351568;
const TAN_32 = 0.6248693519093275;
const TAN_36 = 0.7265425280053609;
const TAN_44 = 0.9656887748070739;

const MASK_LAYER = 11;

/**
 * Per-sample surface weights: RGBA = grass, dirt, rock, road (TERRAIN_SURFACES order), summing to 255. The same bytes
 * feed the terrain material's splat texture and gameplay queries such as footstep sounds.
 */
export class SurfaceMask {
  readonly resolution: number;
  readonly weights: Uint8Array;
  private readonly field: Heightfield;

  constructor(field: Heightfield, weights?: Uint8Array) {
    const count = field.resolution * field.resolution * 4;
    if (weights && weights.length !== count) throw new Error(`SurfaceMask expects ${count} bytes, got ${weights.length}`);
    this.field = field;
    this.resolution = field.resolution;
    this.weights = weights ?? new Uint8Array(count);
  }

  /** Bilinear weights at (x, z), each 0..1, written into `out` in TERRAIN_SURFACES order. */
  sampleWeights(x: number, z: number, out: number[] | Float32Array): number[] | Float32Array {
    const { field } = this;
    const n = this.resolution;
    const gx = clamp((x - field.minX) / field.spacing, 0, n - 1);
    const gz = clamp((z - field.minZ) / field.spacing, 0, n - 1);
    const ix = Math.min(Math.floor(gx), n - 2);
    const iz = Math.min(Math.floor(gz), n - 2);
    const fx = gx - ix;
    const fz = gz - iz;
    const i00 = (iz * n + ix) * 4;
    const i10 = i00 + 4;
    const i01 = i00 + n * 4;
    const i11 = i01 + 4;
    const w = this.weights;
    for (let k = 0; k < 4; k++) {
      const top = w[i00 + k]! + (w[i10 + k]! - w[i00 + k]!) * fx;
      const bottom = w[i01 + k]! + (w[i11 + k]! - w[i01 + k]!) * fx;
      out[k] = (top + (bottom - top) * fz) / 255;
    }
    return out;
  }

  /** Dominant surface at (x, z), e.g. for footsteps and bullet impacts. */
  surfaceAt(x: number, z: number): TerrainSurface {
    const weights = this.sampleWeights(x, z, scratchWeights);
    let best = 0;
    for (let k = 1; k < 4; k++) if (weights[k]! > weights[best]!) best = k;
    return TERRAIN_SURFACES[best]!;
  }
}

const scratchWeights = [0, 0, 0, 0];

/**
 * Derives natural surfaces from the final heights (rock on steep slopes and high peaks, dirt on eroded slopes, noisy
 * patches and quarry floors, grass elsewhere), then composites flatten paint on top.
 */
export function computeSurfaceMask(spec: TerrainSpec, field: Heightfield, paint?: SurfacePaint): SurfaceMask {
  const mask = new SurfaceMask(field);
  const n = field.resolution;
  const seed = subSeed(spec.seed >>> 0, MASK_LAYER);
  const peakStart = spec.relief.baseHeight + spec.border.height * 0.55;
  const basins = spec.features.filter((f) => f.kind === "basin");
  const out = mask.weights;
  const painted = paint?.channels;

  for (let iz = 0; iz < n; iz++) {
    const z = field.worldZ(iz);
    for (let ix = 0; ix < n; ix++) {
      const x = field.worldX(ix);
      const i = iz * n + ix;
      const gx = field.gradX(ix, iz);
      const gz = field.gradZ(ix, iz);
      const slope = Math.sqrt(gx * gx + gz * gz);
      const h = field.heights[i]!;

      // Jitter the thresholds so layer borders wander instead of tracing contour lines.
      const jitter = fbm(x / 9, z / 9, 2, seed);
      let rock = smoothstep(TAN_36, TAN_44, slope + jitter * 0.12);
      rock = Math.max(rock, smoothstep(peakStart, peakStart + 25, h + jitter * 12) * 0.85);

      let dirt = smoothstep(TAN_22, TAN_32, slope + jitter * 0.08) * 0.7;
      dirt = Math.max(dirt, smoothstep(0.38, 0.62, fbm(x / 70, z / 70, 3, seed + 1)) * 0.8);
      for (const basin of basins) {
        const dx = x - basin.center[0];
        const dz = z - basin.center[1];
        dirt = Math.max(dirt, 1 - smoothstep(basin.radius * 0.8, basin.radius * 1.05, Math.sqrt(dx * dx + dz * dz)));
      }

      let rockW = rock;
      let dirtW = dirt * (1 - rock);
      let roadW = 0;
      if (painted) {
        // Paint is already composited "over"; natural layers keep whatever coverage the paint left.
        const p = i * 4;
        const keep = 1 - (painted[p]! + painted[p + 1]! + painted[p + 2]! + painted[p + 3]!) / 255;
        dirtW = dirtW * keep + painted[p + 1]! / 255;
        rockW = rockW * keep + painted[p + 2]! / 255;
        roadW = painted[p + 3]! / 255;
      }

      // Round in priority order so every sample sums to exactly 255; grass takes the remainder.
      const o = i * 4;
      const roadByte = Math.round(roadW * 255);
      const rockByte = Math.min(Math.round(rockW * 255), 255 - roadByte);
      const dirtByte = Math.min(Math.round(dirtW * 255), 255 - roadByte - rockByte);
      out[o] = 255 - roadByte - rockByte - dirtByte;
      out[o + 1] = dirtByte;
      out[o + 2] = rockByte;
      out[o + 3] = roadByte;
    }
  }
  return mask;
}
