import { describe, expect, it } from "vitest";
import type { MapData, RoadLabel, TerrainSpec, Vec2Tuple } from "../types";
import { distance, distanceToRect, polylineDistance, type OrientedRect } from "./geometry";
import { mapPaths, roadFlatten } from "./roads";
import { planStreetSigns, STREET_SIGN, type SignBuilding, type StreetSign } from "./streetSigns";

type SignMap = Pick<MapData, "flatten" | "roadLabels" | "landmarks" | "terrain">;

function testMap(roads: { name: string; width: number; points: Vec2Tuple[]; rank?: RoadLabel["rank"] }[], landmarks: MapData["landmarks"] = undefined): SignMap {
  return {
    terrain: { playableHalfExtent: 500 } as TerrainSpec,
    flatten: roads.map((r, i) => roadFlatten({ id: `road_${i}`, kind: "asphalt", straight: true, width: r.width, points: r.points })),
    roadLabels: roads.map((r) => ({ name: r.name, rank: r.rank ?? 0, length: Math.round(distance(r.points[0]![0], r.points[0]![1], r.points[1]![0], r.points[1]![1])), lines: [r.points] })),
    ...(landmarks ? { landmarks } : {}),
  };
}

function building(id: string, center: Vec2Tuple, halfExtents: Vec2Tuple, yaw = 0): SignBuilding {
  const rect: OrientedRect = { center, halfExtents, yaw };
  return { id, bounds: rect, base: rect };
}

/** Pole (and blade ends) off every road's paved width and outside every building outline. */
function expectClear(map: SignMap, buildings: readonly SignBuilding[], signs: readonly StreetSign[]): void {
  const paths = mapPaths(map);
  for (const sign of signs.filter((s) => s.kind !== "facade")) {
    const [x, z] = sign.position;
    for (const path of paths) expect(polylineDistance(path.points, x, z), `${sign.blades[0]!.name} at ${x}, ${z}`).toBeGreaterThanOrEqual(path.halfWidth + STREET_SIGN.roadClearance - 1e-3);
    for (const b of buildings) expect(distanceToRect(b.bounds, x, z)).toBeGreaterThanOrEqual(STREET_SIGN.buildingClearance - 1e-3);
  }
}

describe("street signs", () => {
  const crossing = testMap([
    { name: "Phan Đăng Lưu", width: 7.5, points: [[-400, 0], [400, 0]] },
    { name: "Hoàng Văn Thụ", width: 7.5, points: [[0, -400], [0, 400]] },
  ]);

  it("puts one pole with both names at a crossing, on a corner past both road edges", () => {
    const signs = planStreetSigns(crossing, []);
    const corners = signs.filter((s) => s.kind === "corner");
    expect(corners).toHaveLength(1);
    const [corner] = corners;
    expect(corner!.blades.map((b) => b.name).sort()).toEqual(["Hoàng Văn Thụ", "Phan Đăng Lưu"]);
    const [x, z] = corner!.position;
    expect(Math.abs(x)).toBeGreaterThanOrEqual(3.75 + STREET_SIGN.roadClearance);
    expect(Math.abs(z)).toBeGreaterThanOrEqual(3.75 + STREET_SIGN.roadClearance);
    expect(distance(0, 0, x, z)).toBeLessThan(10);
    // Each blade runs along its own road.
    for (const blade of corner!.blades) expect(Math.abs(blade.name === "Phan Đăng Lưu" ? blade.dir[0] : blade.dir[1])).toBeCloseTo(1, 3);
    expectClear(crossing, [], signs);
  });

  it("moves to a free corner when buildings stand on the others, never inside one", () => {
    const buildings = [building("bld_1", [8, 8], [3, 3]), building("bld_2", [-8, 8], [3, 3]), building("bld_3", [-8, -8], [3, 3])];
    const signs = planStreetSigns(crossing, buildings);
    const corner = signs.find((s) => s.kind === "corner")!;
    expect(corner.position[0]).toBeGreaterThan(0);
    expect(corner.position[1]).toBeLessThan(0);
    expectClear(crossing, buildings, signs);
  });

  it("spaces street signs along long roads and keeps one road's signs apart", () => {
    const map = testMap([{ name: "Nguyễn Kiệm", width: 7.5, points: [[-450, 30], [450, 30]] }]);
    const signs = planStreetSigns(map, []);
    expect(signs.every((s) => s.kind === "street")).toBe(true);
    expect(signs.length).toBe(Math.floor(900 / STREET_SIGN.spacing));
    const xs = signs.map((s) => s.position[0]).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(STREET_SIGN.sameNameGap);
    // Alternating sides of the street.
    expect(new Set(signs.map((s) => Math.sign(s.position[1] - 30))).size).toBe(2);
    expectClear(map, [], signs);
  });

  it("skips street signs next to a corner sign of the same road", () => {
    const signs = planStreetSigns(crossing, []);
    const corner = signs.find((s) => s.kind === "corner")!;
    for (const s of signs.filter((s) => s.kind === "street")) {
      for (const blade of s.blades) {
        if (corner.blades.some((b) => b.name === blade.name)) expect(distance(s.position[0], s.position[1], corner.position[0], corner.position[1])).toBeGreaterThanOrEqual(STREET_SIGN.sameNameGap);
      }
    }
  });

  it("slides a blocked street sign along the road instead of dropping it", () => {
    const map = testMap([{ name: "Đồng Khởi", width: 6, points: [[0, -100], [0, 100]] }]);
    // Buildings hug both sides at the middle, where the only sign would go.
    const buildings = [building("bld_a", [5.5, 0], [1.5, 8]), building("bld_b", [-5.5, 0], [1.5, 8])];
    const signs = planStreetSigns(map, buildings);
    expect(signs).toHaveLength(1);
    expect(Math.abs(signs[0]!.position[1])).toBeGreaterThan(8);
    expectClear(map, buildings, signs);
  });

  it("puts a landmark's name on its entrance facade", () => {
    const map = testMap([], [{ name: "Aga Building", building: "bld_9", center: [40, 60] }]);
    const b = building("bld_9", [40, 60], [5, 8], Math.PI / 2);
    const signs = planStreetSigns(map, [b]);
    expect(signs).toHaveLength(1);
    const [sign] = signs;
    expect(sign!.kind).toBe("facade");
    expect(sign!.building).toBe("bld_9");
    // Yaw π/2 turns the entrance (+Z) toward +X: the board is 8.08 m east of the center and runs north-south.
    expect(sign!.position[0]).toBeCloseTo(48.08, 2);
    expect(sign!.position[1]).toBeCloseTo(60, 2);
    expect(Math.abs(sign!.blades[0]!.dir[1])).toBeCloseTo(1, 3);
  });

  it("plans nothing without road labels or landmarks", () => {
    expect(planStreetSigns(testMap([]), [])).toEqual([]);
  });
});
