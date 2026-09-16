import { describe, expect, it } from "vitest";
import { DRAFT_MAP_V1, TRAINING_YARD } from "../draftMapV1";
import type { FlattenRegion, TerrainSpec } from "../types";
import { SurfacePaint, flattenHeightfield } from "./flatten";
import { generateHeightfield } from "./generate";
import { Heightfield, checksumBytes } from "./heightfield";
import { sinCos } from "./math";
import { fbm, gradientNoise, hash2 } from "./noise";
import { TERRAIN_V1 } from "./presets";
import { computeSurfaceMask } from "./surface";
import { buildTerrain } from "./terrain";

const DEG = Math.PI / 180;

/** V1 landforms on a coarse grid, for fast tests. */
const SMALL_SPEC: TerrainSpec = { ...TERRAIN_V1, resolution: 129 };

function flatField(height = 10, resolution = 65, size = 64): Heightfield {
  const field = new Heightfield(size, resolution);
  field.heights.fill(height);
  return field;
}

describe("noise", () => {
  it("hashes lattice points to fixed values", () => {
    expect([hash2(0, 0, 0), hash2(1, 0, 0), hash2(-7, 3, 12345), hash2(100000, -100000, 0xffffffff)]).toEqual([4079132893, 3480478903, 4089291524, 947335766]);
  });

  it("gradient noise is zero on lattice points and stays within ±1.05", () => {
    expect(gradientNoise(3, -4, 99)).toBe(0);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 20000; i++) {
      const v = gradientNoise(i * 0.137, i * 0.0713 - 50, 7);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeGreaterThan(-1.05);
    expect(max).toBeLessThan(1.05);
    expect(max - min).toBeGreaterThan(1.2);
  });

  it("fbm depends on the seed", () => {
    expect(fbm(1.3, 2.7, 4, 1)).not.toBe(fbm(1.3, 2.7, 4, 2));
  });
});

describe("sinCos", () => {
  it("matches Math.sin/cos to 1e-14", () => {
    for (let a = -20; a <= 20; a += 0.0137) {
      const { sin, cos } = sinCos(a);
      expect(Math.abs(sin - Math.sin(a))).toBeLessThan(1e-14);
      expect(Math.abs(cos - Math.cos(a))).toBeLessThan(1e-14);
    }
  });
});

describe("Heightfield", () => {
  it("returns stored heights at samples and Havok's triangle split between them", () => {
    const field = new Heightfield(4, 5);
    // Raise the sample at world (0, 0). Havok splits each cell along the (ix+1, iz)-(ix, iz+1) diagonal.
    field.heights[2 * 5 + 2] = 1;
    expect(field.sampleHeight(0, 0)).toBe(1);
    expect(field.sampleHeight(0.25, 0.25)).toBeCloseTo(0.5, 12); // triangle (0,0),(1,0),(0,1)
    expect(field.sampleHeight(-0.25, -0.25)).toBeCloseTo(0.5, 12);
    expect(field.sampleHeight(0.25, -0.25)).toBeCloseTo(0.75, 12); // on the diagonal from (1,-1) to (0,0)
    expect(field.sampleHeight(-0.25, 0.25)).toBeCloseTo(0.75, 12);
    expect(field.sampleHeight(0.5, 0.5)).toBeCloseTo(0, 12);
  });

  it("computes normals and slopes of a plane", () => {
    const field = new Heightfield(64, 65);
    const grade = Math.tan(30 * DEG);
    for (let iz = 0; iz < 65; iz++) for (let ix = 0; ix < 65; ix++) field.heights[iz * 65 + ix] = field.worldX(ix) * grade;
    expect(field.slopeAt(3.3, -7.1)).toBeCloseTo(30, 4);
    const normal = field.sampleNormal(0, 0, { x: 0, y: 0, z: 0 });
    expect(normal.x).toBeCloseTo(-Math.sin(30 * DEG), 5);
    expect(normal.y).toBeCloseTo(Math.cos(30 * DEG), 5);
    expect(normal.z).toBeCloseTo(0, 6);
  });

  it("can view a SharedArrayBuffer", () => {
    const buffer = new SharedArrayBuffer(Heightfield.byteLength(33));
    const a = generateHeightfield({ ...SMALL_SPEC, resolution: 33 }, buffer);
    const b = Heightfield.fromBuffer(a.size, 33, buffer);
    expect(b.sampleHeight(12.5, -40)).toBe(a.sampleHeight(12.5, -40));
  });
});

describe("generation", () => {
  it("is deterministic and matches the recorded checksum", () => {
    const a = generateHeightfield({ ...SMALL_SPEC, resolution: 65 });
    const b = generateHeightfield({ ...SMALL_SPEC, resolution: 65 });
    expect(checksumBytes(a.heights)).toBe(checksumBytes(b.heights));
    // Changes whenever generation changes: bump TerrainSpec.version and update this value deliberately.
    expect(checksumBytes(a.heights)).toBe("1161a79d");
  });

  it("changes with the seed", () => {
    const a = generateHeightfield({ ...SMALL_SPEC, resolution: 33 });
    const b = generateHeightfield({ ...SMALL_SPEC, resolution: 33, seed: 42 });
    expect(checksumBytes(a.heights)).not.toBe(checksumBytes(b.heights));
  });
});

describe("flattenHeightfield", () => {
  it("flattens a circle to its target and eases back over the falloff", () => {
    const field = flatField(10);
    flattenHeightfield(field, [{ shape: "circle", center: [0, 0], radius: 8, falloff: 10, height: 4 }]);
    expect(field.sampleHeight(0, 0)).toBe(4);
    expect(field.sampleHeight(8, 0)).toBe(4);
    expect(field.sampleHeight(13, 0)).toBeCloseTo(7, 5); // halfway through the falloff
    expect(field.sampleHeight(20, 0)).toBe(10);
  });

  it("resolves auto height as the footprint mean and applies the offset", () => {
    const field = new Heightfield(64, 65);
    for (let iz = 0; iz < 65; iz++) for (let ix = 0; ix < 65; ix++) field.heights[iz * 65 + ix] = field.worldX(ix) * 0.2;
    flattenHeightfield(field, [{ shape: "circle", center: [5, 0], radius: 6, falloff: 4, height: "auto", heightOffset: -0.5 }]);
    expect(field.sampleHeight(5, 0)).toBeCloseTo(1 - 0.5, 5);
  });

  it("rotates rects by yaw", () => {
    const field = flatField(10);
    // Long thin rect along world +X (yaw 90° turns local +Z to +X).
    flattenHeightfield(field, [{ shape: "rect", center: [0, 0], halfExtents: [1, 20], yaw: Math.PI / 2, falloff: 0, height: 2 }]);
    expect(field.sampleHeight(18, 0)).toBe(2);
    expect(field.sampleHeight(0, 5)).toBe(10);
  });

  it("only lowers in cut mode and only raises in fill mode", () => {
    const field = flatField(10);
    flattenHeightfield(field, [
      { shape: "circle", center: [-15, 0], radius: 4, falloff: 0, height: 20, mode: "cut" },
      { shape: "circle", center: [15, 0], radius: 4, falloff: 0, height: 20, mode: "fill" },
    ]);
    expect(field.sampleHeight(-15, 0)).toBe(10);
    expect(field.sampleHeight(15, 0)).toBe(20);
  });

  it("builds a linear ramp between pinned polyline points and paints it", () => {
    const field = flatField(0, 129, 128);
    const paint = new SurfacePaint(field.resolution);
    const ramp: FlattenRegion = { shape: "polyline", points: [[-40, 0, 0], [40, 0, 16]], width: 6, falloff: 3, height: "auto", profile: "linear", surface: "road" };
    flattenHeightfield(field, [ramp], paint);
    expect(field.sampleHeight(0, 0)).toBeCloseTo(8, 4);
    expect(field.sampleHeight(20, 2.5)).toBeCloseTo(12, 4);
    expect(field.sampleHeight(0, 20)).toBe(0);
    const mask = computeSurfaceMask(SMALL_SPEC, field, paint);
    expect(mask.surfaceAt(0, 0)).toBe("road");
    expect(mask.surfaceAt(0, 20)).not.toBe("road");
  });

  it("makes a following road smoother than the ground under it", () => {
    const field = new Heightfield(256, 257);
    for (let iz = 0; iz < 257; iz++) for (let ix = 0; ix < 257; ix++) field.heights[iz * 257 + ix] = gradientNoise(field.worldX(ix) / 12, field.worldZ(iz) / 12, 3) * 3;
    const before = new Float32Array(field.heights);
    flattenHeightfield(field, [{ shape: "polyline", points: [[-100, 0], [100, 0]], width: 6, falloff: 4, height: "auto" }]);
    const roughness = (heights: Float32Array) => {
      let sum = 0;
      for (let ix = 30; ix < 226; ix++) sum += Math.abs(heights[128 * 257 + ix + 1]! - heights[128 * 257 + ix]!);
      return sum;
    };
    expect(roughness(field.heights)).toBeLessThan(roughness(before) * 0.3);
  });
});

describe("surface mask", () => {
  it("sums to 255 and puts rock on cliffs", () => {
    const field = new Heightfield(128, 129);
    // West half flat, east half a 60° wall.
    for (let iz = 0; iz < 129; iz++) for (let ix = 0; ix < 129; ix++) field.heights[iz * 129 + ix] = Math.max(0, field.worldX(ix)) * Math.tan(60 * DEG);
    const mask = computeSurfaceMask(SMALL_SPEC, field);
    for (let i = 0; i < mask.weights.length; i += 4) {
      expect(mask.weights[i]! + mask.weights[i + 1]! + mask.weights[i + 2]! + mask.weights[i + 3]!).toBe(255);
    }
    expect(mask.surfaceAt(30, 10)).toBe("rock");
    expect(mask.surfaceAt(-30, 10)).not.toBe("rock");
  });
});

describe("Map v1 terrain", () => {
  const terrain = buildTerrain(DRAFT_MAP_V1.terrain, DRAFT_MAP_V1.flatten);
  const { field } = terrain;

  /** Steepest triangle per cell (the slope Havok's character controller sees). */
  function cellSlopes(filter: (x: number, z: number) => boolean): number[] {
    const n = field.resolution;
    const s = field.spacing;
    const out: number[] = [];
    for (let iz = 0; iz < n - 1; iz += 2) {
      for (let ix = 0; ix < n - 1; ix += 2) {
        if (!filter(field.worldX(ix + 0.5), field.worldZ(iz + 0.5))) continue;
        const h = field.heights;
        const h00 = h[iz * n + ix]!;
        const h10 = h[iz * n + ix + 1]!;
        const h01 = h[(iz + 1) * n + ix]!;
        const h11 = h[(iz + 1) * n + ix + 1]!;
        const a = Math.sqrt((h10 - h00) ** 2 + (h01 - h00) ** 2) / s;
        const b = Math.sqrt((h11 - h01) ** 2 + (h11 - h10) ** 2) / s;
        out.push(Math.atan(Math.max(a, b)) / DEG);
      }
    }
    return out;
  }

  it("keeps the playable area mostly gentle", () => {
    const slopes = cellSlopes((x, z) => terrain.isPlayable(x, z));
    const share = (limit: number) => slopes.filter((d) => d < limit).length / slopes.length;
    expect(share(25)).toBeGreaterThan(0.94);
    // The quarry pit and the radar ridge are a bigger share of the 500 m square than they were of the 1 km one.
    expect(share(50)).toBeGreaterThan(0.975);
  });

  it("rings the playable area with steep, high mountains", () => {
    const half = DRAFT_MAP_V1.terrain.playableHalfExtent;
    const outer = (x: number, z: number) => Math.max(Math.abs(x), Math.abs(z)) > half + 60;
    const slopes = cellSlopes(outer);
    expect(slopes.filter((d) => d > 35).length / slopes.length).toBeGreaterThan(0.3);
    let playableMax = -Infinity;
    for (let x = -half; x <= half; x += 10) for (let z = -half; z <= half; z += 10) playableMax = Math.max(playableMax, terrain.sampleHeight(x, z));
    let edgeSum = 0;
    let edgeCount = 0;
    for (let t = -300; t <= 300; t += 10) {
      for (const [x, z] of [[t, 310], [t, -310], [310, t], [-310, t]] as const) {
        edgeSum += terrain.sampleHeight(x, z);
        edgeCount++;
      }
    }
    expect(edgeSum / edgeCount).toBeGreaterThan(playableMax + 30);
  });

  it("has a radar crest, a quarry pit and flat POI pads", () => {
    const [yx, yz] = TRAINING_YARD.center;
    const radar = terrain.sampleHeight(-60, 185);
    const quarryFloor = terrain.sampleHeight(-130, -110);
    const quarryRim = terrain.sampleHeight(-130 + 100, -110);
    expect(radar - terrain.sampleHeight(60, 100)).toBeGreaterThan(12);
    expect(quarryRim - quarryFloor).toBeGreaterThan(18);
    for (const [dx, dz] of [[0, 0], [40, 40], [-40, 30], [20, -44]] as const) {
      expect(terrain.sampleHeight(yx + dx, yz + dz)).toBeCloseTo(terrain.sampleHeight(yx, yz), 3);
    }
    expect(terrain.slopeAt(-130, -30)).toBeLessThan(25); // quarry ramp
    expect(terrain.surfaceAt(-130, -30)).toBe("dirt");
    expect(terrain.surfaceAt(-40, 0)).toBe("road");
  });
});
