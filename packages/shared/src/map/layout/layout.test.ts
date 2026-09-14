import { describe, expect, it } from "vitest";
import { decodeTerrainBake, encodeTerrainBake, readTerrainBakeHeader } from "../terrain/bake";
import { TERRAIN_V1 } from "../terrain/presets";
import { Terrain, buildTerrain } from "../terrain/terrain";
import type { FlattenRegion, MapData, TerrainSpec } from "../types";
import { bandAlong, catmullRom, distanceToRect, pointInPolygon, rectsOverlap } from "./geometry";
import { buildMapLayout } from "./mapLayout";
import { buildMapWorld } from "./mapWorld";
import { segmentLine } from "./placement";
import { ScatterContext, INSTANCE_STRIDE, type ScatterRule } from "./scatter";

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
