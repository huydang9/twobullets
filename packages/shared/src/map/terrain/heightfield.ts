import { clamp } from "./math";

export interface NormalLike {
  x: number;
  y: number;
  z: number;
}

/**
 * Square grid of heights centered on the world origin.
 *
 * Layout: `heights[iz * resolution + ix]` is the sample at world (minX + ix·spacing, minZ + iz·spacing), so rows run
 * along +X and row index grows with +Z. The array can view a SharedArrayBuffer so workers share one copy.
 *
 * Between samples the surface is the same pair of triangles Havok builds for PhysicsShapeHeightField: each cell is
 * split along the diagonal from (ix+1, iz) to (ix, iz+1). `sampleHeight` therefore returns exactly the height a
 * physics ray would hit, and render meshes use the same split.
 */
export class Heightfield {
  readonly resolution: number;
  readonly size: number;
  readonly spacing: number;
  readonly minX: number;
  readonly minZ: number;
  readonly heights: Float32Array;

  constructor(size: number, resolution: number, heights?: Float32Array) {
    if (!Number.isInteger(resolution) || resolution < 2) throw new Error(`Heightfield resolution must be an integer ≥ 2, got ${resolution}`);
    const count = resolution * resolution;
    if (heights && heights.length !== count) throw new Error(`Heightfield expects ${count} heights, got ${heights.length}`);
    this.resolution = resolution;
    this.size = size;
    this.spacing = size / (resolution - 1);
    this.minX = -size / 2;
    this.minZ = -size / 2;
    this.heights = heights ?? new Float32Array(count);
  }

  /** Allocates heights in a buffer of your choice (e.g. `new SharedArrayBuffer(Heightfield.byteLength(n))`). */
  static fromBuffer(size: number, resolution: number, buffer: ArrayBufferLike): Heightfield {
    return new Heightfield(size, resolution, new Float32Array(buffer, 0, resolution * resolution));
  }

  static byteLength(resolution: number): number {
    return resolution * resolution * Float32Array.BYTES_PER_ELEMENT;
  }

  get maxX(): number {
    return this.minX + this.size;
  }

  get maxZ(): number {
    return this.minZ + this.size;
  }

  /** Sample height with indices clamped to the grid. */
  at(ix: number, iz: number): number {
    const n = this.resolution;
    const cx = ix < 0 ? 0 : ix >= n ? n - 1 : ix;
    const cz = iz < 0 ? 0 : iz >= n ? n - 1 : iz;
    return this.heights[cz * n + cx]!;
  }

  worldX(ix: number): number {
    return this.minX + ix * this.spacing;
  }

  worldZ(iz: number): number {
    return this.minZ + iz * this.spacing;
  }

  contains(x: number, z: number): boolean {
    return x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ;
  }

  /** Height of the physics surface at (x, z); positions outside the grid are clamped to its edge. */
  sampleHeight(x: number, z: number): number {
    const n = this.resolution;
    const gx = clamp((x - this.minX) / this.spacing, 0, n - 1);
    const gz = clamp((z - this.minZ) / this.spacing, 0, n - 1);
    let ix = Math.floor(gx);
    let iz = Math.floor(gz);
    if (ix > n - 2) ix = n - 2;
    if (iz > n - 2) iz = n - 2;
    const fx = gx - ix;
    const fz = gz - iz;
    const h = this.heights;
    const row = iz * n;
    const h10 = h[row + ix + 1]!;
    const h01 = h[row + n + ix]!;
    if (fx + fz <= 1) {
      const h00 = h[row + ix]!;
      return h00 + fx * (h10 - h00) + fz * (h01 - h00);
    }
    const h11 = h[row + n + ix + 1]!;
    return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
  }

  /**
   * Smooth surface gradient (dh/dx, dh/dz): central differences at the samples, blended bilinearly. Smoother than the
   * faceted triangle slope, which suits prop alignment, surface masks and shading.
   */
  sampleGradient(x: number, z: number, out: { x: number; z: number }): { x: number; z: number } {
    const n = this.resolution;
    const gx = clamp((x - this.minX) / this.spacing, 0, n - 1);
    const gz = clamp((z - this.minZ) / this.spacing, 0, n - 1);
    let ix = Math.floor(gx);
    let iz = Math.floor(gz);
    if (ix > n - 2) ix = n - 2;
    if (iz > n - 2) iz = n - 2;
    const fx = gx - ix;
    const fz = gz - iz;
    const w00 = (1 - fx) * (1 - fz);
    const w10 = fx * (1 - fz);
    const w01 = (1 - fx) * fz;
    const w11 = fx * fz;
    out.x = this.gradX(ix, iz) * w00 + this.gradX(ix + 1, iz) * w10 + this.gradX(ix, iz + 1) * w01 + this.gradX(ix + 1, iz + 1) * w11;
    out.z = this.gradZ(ix, iz) * w00 + this.gradZ(ix + 1, iz) * w10 + this.gradZ(ix, iz + 1) * w01 + this.gradZ(ix + 1, iz + 1) * w11;
    return out;
  }

  /** Smooth unit normal at (x, z). */
  sampleNormal<T extends NormalLike>(x: number, z: number, out: T): T {
    const g = this.sampleGradient(x, z, scratchGradient);
    const inv = 1 / Math.sqrt(g.x * g.x + g.z * g.z + 1);
    out.x = -g.x * inv;
    out.y = inv;
    out.z = -g.z * inv;
    return out;
  }

  /** tan(slope) of the smooth surface: rise over run. Compare against tan of a threshold angle in simulation code. */
  slopeTanAt(x: number, z: number): number {
    const g = this.sampleGradient(x, z, scratchGradient);
    return Math.sqrt(g.x * g.x + g.z * g.z);
  }

  /** Slope in degrees. Uses Math.atan, so treat it as tooling/UI output; simulation thresholds should use slopeTanAt. */
  slopeAt(x: number, z: number): number {
    return (Math.atan(this.slopeTanAt(x, z)) * 180) / Math.PI;
  }

  /** Central-difference dh/dx at a sample (one-sided at the edges). */
  gradX(ix: number, iz: number): number {
    const n = this.resolution;
    const a = ix > 0 ? ix - 1 : 0;
    const b = ix < n - 1 ? ix + 1 : n - 1;
    return (this.at(b, iz) - this.at(a, iz)) / ((b - a) * this.spacing);
  }

  gradZ(ix: number, iz: number): number {
    const n = this.resolution;
    const a = iz > 0 ? iz - 1 : 0;
    const b = iz < n - 1 ? iz + 1 : n - 1;
    return (this.at(ix, b) - this.at(ix, a)) / ((b - a) * this.spacing);
  }

  /** Min and max height over the whole grid. */
  range(): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (const h of this.heights) {
      if (h < min) min = h;
      if (h > max) max = h;
    }
    return { min, max };
  }

  /** Min and max height over an index rectangle (inclusive). */
  rangeIn(ix0: number, iz0: number, ix1: number, iz1: number): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const h = this.at(ix, iz);
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    return { min, max };
  }
}

const scratchGradient = { x: 0, z: 0 };

/** FNV-1a over the raw bytes, as 8 hex digits. Client and server compare it to confirm they built the same ground. */
export function checksumBytes(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
