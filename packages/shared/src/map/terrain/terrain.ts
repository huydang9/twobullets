import type { FlattenRegion, TerrainSpec, TerrainSurface } from "../types";
import { SurfacePaint, flattenHeightfield } from "./flatten";
import { createReliefFunction, generateHeightfield, type ReliefFunction } from "./generate";
import { Heightfield, checksumBytes, type NormalLike } from "./heightfield";
import { SurfaceMask, computeSurfaceMask } from "./surface";

export interface TerrainBuildOptions {
  /** Storage for the heights, e.g. a SharedArrayBuffer of Heightfield.byteLength(resolution) bytes. */
  readonly heightBuffer?: ArrayBufferLike;
  /** Generation progress 0..1 (heights are ~75% of the build time), for loading screens. */
  readonly onProgress?: (fraction: number) => void;
}

/**
 * The raw arrays behind a built terrain: enough to rebuild it without generating (worker transfer, baked binary).
 * `paint` is the flatten paint, kept so `Terrain.flatten` can composite more regions later.
 */
export interface TerrainSnapshot {
  readonly heights: Float32Array;
  /** Surface mask, RGBA per sample. */
  readonly weights: Uint8Array;
  readonly paint: Uint8Array;
}

/**
 * Built terrain: final heights (after flattening), the surface mask and the queries gameplay needs. Everything is
 * plain data and pure functions, so the server and the client build identical ground from the same MapData.
 */
export class Terrain {
  readonly spec: TerrainSpec;
  readonly field: Heightfield;
  readonly surface: SurfaceMask;
  /** Unflattened height function; valid beyond the grid, used by the horizon mesh. */
  readonly relief: ReliefFunction;
  /** Paint from every flatten region so far, kept so later flattens composite over it. */
  private readonly paint: SurfacePaint;

  /** `surface` may be passed when it was already computed for these heights and paint (see fromSnapshot). */
  constructor(spec: TerrainSpec, field: Heightfield, paint: SurfacePaint, surface?: SurfaceMask) {
    this.spec = spec;
    this.field = field;
    this.paint = paint;
    this.surface = surface ?? computeSurfaceMask(spec, field, paint);
    this.relief = createReliefFunction(spec);
  }

  /** Rebuilds a terrain from its arrays without generating anything. The arrays are used in place, not copied. */
  static fromSnapshot(spec: TerrainSpec, snapshot: TerrainSnapshot): Terrain {
    const field = new Heightfield(spec.size, spec.resolution, snapshot.heights);
    const paint = new SurfacePaint(spec.resolution, snapshot.paint);
    return new Terrain(spec, field, paint, new SurfaceMask(field, snapshot.weights));
  }

  /** Views of the terrain's arrays (not copies). Transferring them to a worker detaches this terrain. */
  snapshot(): TerrainSnapshot {
    return { heights: this.field.heights, weights: this.surface.weights, paint: this.paint.channels };
  }

  /** Physics surface height at (x, z) (identical to a Havok ray against the heightfield). */
  sampleHeight(x: number, z: number): number {
    return this.field.sampleHeight(x, z);
  }

  sampleNormal<T extends NormalLike>(x: number, z: number, out: T): T {
    return this.field.sampleNormal(x, z, out);
  }

  /** Slope in degrees (tooling and UI; use `slopeTanAt` for simulation thresholds). */
  slopeAt(x: number, z: number): number {
    return this.field.slopeAt(x, z);
  }

  slopeTanAt(x: number, z: number): number {
    return this.field.slopeTanAt(x, z);
  }

  surfaceAt(x: number, z: number): TerrainSurface {
    return this.surface.surfaceAt(x, z);
  }

  surfaceWeightsAt(x: number, z: number, out: number[] | Float32Array): number[] | Float32Array {
    return this.surface.sampleWeights(x, z, out);
  }

  isPlayable(x: number, z: number): boolean {
    const half = this.spec.playableHalfExtent;
    return x >= -half && x <= half && z >= -half && z <= half;
  }

  /**
   * Applies more flatten regions on top of the built terrain and rebuilds the surface mask (a full-grid pass, so
   * batch regions into one call). Meshes and physics bodies built earlier must be rebuilt by the caller.
   */
  flatten(regions: readonly FlattenRegion[]): void {
    flattenHeightfield(this.field, regions, this.paint);
    this.surface.weights.set(computeSurfaceMask(this.spec, this.field, this.paint).weights);
  }

  /** Hash of heights and surface weights, to confirm client and server built the same terrain. */
  checksum(): string {
    return `${checksumBytes(this.field.heights)}-${checksumBytes(this.surface.weights)}`;
  }
}

/** Generates heights, applies flatten regions in order, then derives the surface mask. */
export function buildTerrain(spec: TerrainSpec, regions: readonly FlattenRegion[] = [], options: TerrainBuildOptions = {}): Terrain {
  const field = generateHeightfield(spec, options.heightBuffer, options.onProgress);
  const paint = new SurfacePaint(field.resolution);
  flattenHeightfield(field, regions, paint);
  return new Terrain(spec, field, paint);
}
