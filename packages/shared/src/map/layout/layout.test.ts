import { describe, expect, it } from "vitest";
import { decodeTerrainBake, encodeTerrainBake, readTerrainBakeHeader } from "../terrain/bake";
import { TERRAIN_V1 } from "../terrain/presets";
import { Terrain, buildTerrain } from "../terrain/terrain";
import type { FlattenRegion, MapData, TerrainSpec } from "../types";
import { bandAlong, catmullRom, distanceToRect, pointInPolygon, rectsOverlap } from "./geometry";
import { buildMapLayout } from "./mapLayout";
import { buildMapWorld } from "./mapWorld";
import { lineOpenings, segmentLine } from "./placement";
import { getMapProp } from "./props";
import { ScatterContext, INSTANCE_STRIDE, isHardCover, type ScatterRule } from "./scatter";

const SMALL: TerrainSpec = { ...TERRAIN_V1, resolution: 129 };
const REGIONS: readonly FlattenRegion[] = [
  { shape: "circle", center: [0, 20], radius: 60, falloff: 30, height: "auto", surface: "dirt" },
  { shape: "polyline", points: [[-300, 0], [300, 10]], width: 6, falloff: 4, height: "auto", surface: "road" },
];

describe("geometry", () => {
  it("tests oriented rectangles", () => {
    const a = { center: [0, 0] as const, halfExtents: [2, 1] as const, yaw: 0 };
    expect(rectsOverlap(a, { center: [3.9, 0], halfExtents: [2, 1], yaw: 0 })).toBe(true);
    expect(rectsOverlap(a, { center: [4.1, 0], halfExtents: [2, 1], yaw: 0 })).toBe(false);
    expect(rectsOverlap(a, { center: [4.1, 0], halfExtents: [2, 1], yaw: 0 }, 0.5)).toBe(true);
    // A rect turned 90° is 1 m wide along X.
    expect(rectsOverlap(a, { center: [3.1, 0], halfExtents: [2, 1], yaw: Math.PI / 2 })).toBe(false);
    expect(distanceToRect({ center: [0, 0], halfExtents: [2, 1], yaw: Math.PI / 2 }, 0, 3)).toBeCloseTo(1, 9);
  });

  it("keeps spline control points and builds bands on the requested side", () => {
    const curve = catmullRom([[0, 0], [50, 20], [100, 0]], 8);
    expect(curve[0]).toEqual([0, 0]);
    expect(curve).toContainEqual([50, 20]);
    expect(curve.at(-1)).toEqual([100, 0]);
    // Travelling north, the right-hand band lies east.
    const band = bandAlong([[0, 0], [0, 100]], 5, 10, 1);
    expect(pointInPolygon(band, 7, 50)).toBe(true);
    expect(pointInPolygon(band, -7, 50)).toBe(false);
  });

  it("lays fence segments along a line with gaps", () => {
    const fence = segmentLine("fence_wood", [[0, 0], [20, 0]], { gaps: [[8, 12]] });
    expect(fence.map((p) => p.position[0])).toEqual([2, 6, 14, 18]);
    // Segments run along +X: yaw 0.
    expect(fence.every((p) => Math.abs(p.yaw) < 1e-12)).toBe(true);
    const north = segmentLine("fence_wood", [[0, 0], [0, 8]]);
    expect(north[0]!.yaw).toBeCloseTo(-Math.PI / 2, 12);
  });

  // Covered [start, end] spans along an X-axis line of `segment` pieces.
  const spans = (line: ReturnType<typeof segmentLine>, segment = 4) => line.map((p): [number, number] => [p.position[0] - segment / 2, p.position[0] + segment / 2]);

  it("keeps gap edges where they are authored instead of dropping every piece that touches them", () => {
    // Military Compound breach: 6 m, not the 8 m left by snapping to leg-wide 4 m pieces.
    const wall = spans(segmentLine("wall_concrete", [[0, 0], [100, 0]], { gaps: [[64, 70]] }));
    expect(Math.max(...wall.filter(([, b]) => b <= 67).map(([, b]) => b))).toBeCloseTo(64, 9);
    expect(Math.min(...wall.filter(([a]) => a >= 67).map(([a]) => a))).toBeCloseTo(70, 9);
    expect(wall.some(([a, b]) => a < 70 - 1e-9 && b > 64 + 1e-9)).toBe(false);
    // Both ends stay closed.
    expect(wall[0]![0]).toBeCloseTo(0, 9);
    expect(wall.at(-1)![1]).toBeCloseTo(100, 9);
    // A 3 m garden gate between stretches of 13 and 14 m.
    const yard = spans(segmentLine("fence_wood", [[0, 0], [30, 0]], { gaps: [[13, 16]] }));
    expect(yard.filter(([a, b]) => a < 16 - 1e-9 && b > 13 + 1e-9)).toEqual([]);
    expect(yard.some(([, b]) => Math.abs(b - 13) < 1e-9) && yard.some(([a]) => Math.abs(a - 16) < 1e-9)).toBe(true);
  });

  it("handles short stretches with whole pieces, widening a gap slightly rather than closing a gate", () => {
    // 5 m before the gap: one piece against the leg start, the gap widens by 1 m; 11 m after it: three flush pieces.
    expect(segmentLine("fence_wood", [[0, 0], [20, 0]], { gaps: [[5, 9]] }).map((p) => p.position[0])).toEqual([2, 11, 14.5, 18]);
    // A 3 m sliver would overhang a 2 m gate by 1 m (> 25 %): dropped.
    expect(segmentLine("fence_wood", [[0, 0], [21, 0]], { gaps: [[3, 5]] }).map((p) => p.position[0])).toEqual([7, 11, 15, 19]);
    // The same sliver next to a 12 m gate keeps its piece.
    expect(segmentLine("fence_wood", [[0, 0], [31, 0]], { gaps: [[3, 15]] }).map((p) => p.position[0])).toEqual([2, 17, 21, 25, 29]);
    // A gap across a corner opens both legs; legs without gaps are laid as before.
    const corner = segmentLine("fence_wood", [[0, 0], [20, 0], [20, 20]], { gaps: [[16, 24]] });
    expect(corner.filter((p) => Math.abs(p.yaw) < 1e-12).map((p) => p.position[0])).toEqual([2, 6, 10, 14]);
    expect(corner.filter((p) => Math.abs(p.yaw) > 1e-12).map((p) => p.position[2])).toEqual([6, 10, 14, 18]);
    expect(segmentLine("fence_wood", [[0, 0], [30, 0]], { gaps: [[40, 50]] })).toEqual(segmentLine("fence_wood", [[0, 0], [30, 0]]));
  });

  it("reports gap midpoints along a polyline, across corners too", () => {
    expect(lineOpenings([[0, 0], [20, 0], [20, 20]], [[16, 24], [30, 34]])).toEqual([
      { center: [20, 0], width: 8 },
      { center: [20, 12], width: 4 },
    ]);
  });
});

describe("terrain bake", () => {
  const terrain = buildTerrain(SMALL, REGIONS);

  it("round-trips heights, mask and paint bit for bit", async () => {
    const bytes = await encodeTerrainBake(terrain, REGIONS);
    expect(readTerrainBakeHeader(bytes)?.checksum).toBe(terrain.checksum());
    const result = await decodeTerrainBake(bytes, SMALL, REGIONS);
    if (!result.ok) throw new Error(result.reason);
    expect(result.terrain.checksum()).toBe(terrain.checksum());
    expect(result.terrain.snapshot().paint).toEqual(terrain.snapshot().paint);
    // A decoded terrain keeps flattening like the original.
    const more: FlattenRegion[] = [{ shape: "circle", center: [100, 100], radius: 20, falloff: 10, height: 12, surface: "road" }];
    const reference = buildTerrain(SMALL, REGIONS);
    reference.flatten(more);
    result.terrain.flatten(more);
    expect(result.terrain.checksum()).toBe(reference.checksum());
  });

  it("rejects stale inputs and corrupt payloads", async () => {
    const bytes = await encodeTerrainBake(terrain, REGIONS);
    const stale = await decodeTerrainBake(bytes, SMALL, REGIONS.slice(1));
    expect(stale.ok).toBe(false);
    expect(stale.ok ? "" : stale.reason).toMatch(/stale/);
    const corrupt = bytes.slice();
    corrupt[corrupt.length - 20]! ^= 0xff;
    expect((await decodeTerrainBake(corrupt, SMALL, REGIONS)).ok).toBe(false);
  });

  it("rebuilds from a snapshot without generating", () => {
    const copy = Terrain.fromSnapshot(SMALL, {
      heights: terrain.field.heights.slice(),
      weights: terrain.surface.weights.slice(),
      paint: terrain.snapshot().paint.slice(),
    });
    expect(copy.checksum()).toBe(terrain.checksum());
    expect(copy.sampleHeight(12.3, -40.1)).toBe(terrain.sampleHeight(12.3, -40.1));
  });
});

describe("scatter", () => {
  const square: [number, number][] = [[-200, -200], [200, -200], [200, 200], [-200, 200]];
  const rules: ScatterRule[] = [
    { id: "trees", props: [{ prop: "tree_fir_a", weight: 1 }, { prop: "tree_broadleaf_a", weight: 1 }], area: square, density: 1, scaleRange: [0.8, 1.2] },
    { id: "grass", props: [{ prop: "grass_clump_short", weight: 1 }], area: square, density: 20, detail: true },
  ];
  const map: MapData = {
    id: "test",
    name: "test",
    terrain: SMALL,
    flatten: REGIONS,
    bounds: { outOfBoundsGraceSeconds: 5, killY: -40, landingAltitude: 300 },
    pois: [],
    buildings: [{ id: "house", prefab: "house_small", position: [100, 0, -100], yaw: 0.3, snapToTerrain: true }],
    props: [{ prop: "wall_concrete", position: [-100, 0, -100], yaw: 0, snapToTerrain: true }],
    scatters: rules,
    spawns: [{ position: [0, -150], yaw: 0 }],
  };
  const terrain = buildTerrain(map.terrain, map.flatten);

  it("is deterministic and keeps off roads, pads, buildings, props and spawns", () => {
    const a = buildMapLayout(map, terrain);
    const b = buildMapLayout(map, terrain);
    expect(a.checksum).toBe(b.checksum);
    expect(a.ruleCounts.trees).toBeGreaterThan(500);
    expect(a.ruleCounts.grass).toBeUndefined();
    const house = a.buildings[0]!;
    for (const set of a.props.filter((s) => s.prop.startsWith("tree"))) {
      for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
        const x = set.data[i]!;
        const z = set.data[i + 2]!;
        expect(Math.hypot(x, z - 20)).toBeGreaterThan(61); // pad
        expect(Math.abs(z - (x * 10) / 600 - 5)).toBeGreaterThan(3); // road centerline (half width 3)
        expect(distanceToRect(house.bounds, x, z)).toBeGreaterThan(2);
        expect(Math.hypot(x + 100, z + 100)).toBeGreaterThan(2);
        expect(Math.hypot(x, z + 150)).toBeGreaterThan(2.5);
        expect(set.data[i + 1]!).toBeLessThan(terrain.sampleHeight(x, z));
      }
    }
  });

  it("spaces, fills gaps, and turns rock faces downhill (cover options)", () => {
    const context = new ScatterContext(map, terrain, buildMapLayout(map, terrain).buildings);
    const out = new Map<string, number[]>();
    const spaced = context.expand({ id: "spaced", props: [{ prop: "rock_boulder_large", weight: 1 }], area: square, density: 0.5, minDistance: 30 }, out);
    const boulders = out.get("rock_boulder_large")!;
    expect(spaced).toBeGreaterThan(20);
    for (let i = 0; i < boulders.length; i += INSTANCE_STRIDE) {
      for (let j = i + INSTANCE_STRIDE; j < boulders.length; j += INSTANCE_STRIDE) {
        expect(Math.hypot(boulders[i]! - boulders[j]!, boulders[i + 2]! - boulders[j + 2]!)).toBeGreaterThanOrEqual(30);
      }
    }
    // The spaced boulders are hard cover: a filler with a 20 m bare radius stays clear of them.
    expect(isHardCover(getMapProp("rock_boulder_large"))).toBe(true);
    context.expand({ id: "fill", props: [{ prop: "log_fallen", weight: 1 }], area: square, density: 0.5, bareRadius: 20 }, out);
    const logs = out.get("log_fallen") ?? [];
    for (let i = 0; i < logs.length; i += INSTANCE_STRIDE) {
      for (let j = 0; j < boulders.length; j += INSTANCE_STRIDE) expect(Math.hypot(logs[i]! - boulders[j]!, logs[i + 2]! - boulders[j + 2]!)).toBeGreaterThanOrEqual(20);
    }
    // Explicit spots on slopes: front (local +Z) points down the fall line, seated below the downhill ground.
    const spots: [number, number][] = [];
    for (let x = -180; x <= 180 && spots.length < 8; x += 12) for (let z = -180; z <= 180 && spots.length < 8; z += 12) if (terrain.slopeTanAt(x, z) > 0.1) spots.push([x, z]);
    expect(spots.length).toBeGreaterThan(0);
    const faces = new Map<string, number[]>();
    context.expand({ id: "faces", props: [{ prop: "rock_face_large", weight: 1 }], area: square, density: 1, spots, faceDownhill: true, avoidPads: false }, faces);
    const placed = faces.get("rock_face_large")!;
    expect(placed.length).toBeGreaterThan(0);
    for (let i = 0; i < placed.length; i += INSTANCE_STRIDE) {
      const [x, y, z, yaw] = [placed[i]!, placed[i + 1]!, placed[i + 2]!, placed[i + 3]!];
      expect(terrain.sampleHeight(x + Math.sin(yaw) * 2, z + Math.cos(yaw) * 2)).toBeLessThan(terrain.sampleHeight(x - Math.sin(yaw) * 2, z - Math.cos(yaw) * 2));
      expect(y).toBeLessThan(terrain.sampleHeight(x, z));
    }
  });

  it("expands detail rules identically per region and for the whole area", () => {
    const context = new ScatterContext(map, terrain, buildMapLayout(map, terrain).buildings);
    const rule = rules[1]!;
    const whole = new Map<string, number[]>();
    context.expandRegion(rule, -40, -40, 40, 40, whole);
    const tiled = new Map<string, number[]>();
    for (const [x0, z0] of [[-40, -40], [0, -40], [-40, 0], [0, 0]] as const) context.expandRegion(rule, x0, z0, x0 + 40, z0 + 40, tiled);
    const sort = (list: number[]) => Array.from({ length: list.length / INSTANCE_STRIDE }, (_, i) => list.slice(i * INSTANCE_STRIDE, (i + 1) * INSTANCE_STRIDE).join(",")).sort();
    expect(sort(tiled.get("grass_clump_short")!)).toEqual(sort(whole.get("grass_clump_short")!));
    expect(whole.get("grass_clump_short")!.length / INSTANCE_STRIDE).toBeGreaterThan(500);
  });
});

describe("buildMapWorld", () => {
  it("generates when there is no bake and reports progress", async () => {
    const stages = new Set<string>();
    const world = await buildMapWorld(
      { id: "t", name: "t", terrain: SMALL, flatten: REGIONS, bounds: { outOfBoundsGraceSeconds: 5, killY: -40, landingAltitude: 300 }, pois: [], buildings: [], props: [], scatters: [], spawns: [] },
      { onProgress: (stage) => stages.add(stage) },
    );
    expect(world.terrainSource).toBe("generated");
    expect(world.terrain.checksum()).toBe(buildTerrain(SMALL, REGIONS).checksum());
    expect([...stages]).toEqual(["generate", "layout"]);
  });
});
