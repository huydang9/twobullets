import { describe, expect, it } from "vitest";
import { distance, distanceToRect, offsetPoint, pointInPolygon, polylineDistance } from "../../layout/geometry";
import { validateMapLayout } from "../../layout/validate";
import { createReliefFunction } from "../../terrain/generate";
import type { TerrainSpec, Vec2Tuple } from "../../types";
import { fenceProps } from "../fences";
import { convertRealMap } from "./assemble";
import { buildingCandidates, PlacementSpace, placeBuildings, prefabFor, ROAD_GAP } from "./buildings";
import { realTerrainSpec } from "./elevation";
import fixtureJson from "./fixture.osm.json";
import { assembleRings, clipPolylineToSquare, clipRingToSquare, minAreaRect, signedArea, simplifyPolyline } from "./geometry";
import { trimRoadsAtWater, waterEdges } from "./landuse";
import { parseOsm } from "./parse";
import { bboxAround, createProjection } from "./projection";
import { convertRoads, roadClassOf } from "./roads";
import type { ElevationSamples, OsmDocument, PlaceConfig } from "./types";
import { mapPaths, roadFlatten } from "../../layout/roads";

/** A 340 m square of Holašovice (© OpenStreetMap contributors, ODbL), trimmed from the generator's Overpass cache. */
const fixture = fixtureJson as unknown as OsmDocument;

const CONFIG: PlaceConfig = {
  id: "test-holasovice",
  name: "Holašovice",
  country: "Czechia",
  countryCode: "cz",
  lat: 48.9697,
  lon: 14.2736,
  elevation: { mode: "real", scale: 1, maxRelief: 40 },
  buildingCap: 40,
  directionWords: ["sever", "jih", "východ", "západ"],
};

/** A gentle synthetic slope (8 m over the map) in place of a DEM. */
function slope(): ElevationSamples {
  const columns = 129;
  const heights: number[] = [];
  for (let j = 0; j < columns; j++) for (let i = 0; i < columns; i++) heights.push(470 + i * 0.05 + j * 0.02);
  return { spacing: 10, columns, rows: columns, heights };
}

describe("projection", () => {
  it("projects around the center in meters and back", () => {
    const p = createProjection(CONFIG.lat, CONFIG.lon);
    expect(p.project(CONFIG.lat, CONFIG.lon)).toEqual([0, 0]);
    const [, z] = p.project(CONFIG.lat + 0.001, CONFIG.lon);
    expect(z).toBeCloseTo(111.2, 0);
    const [x] = p.project(CONFIG.lat, CONFIG.lon + 0.001);
    expect(x).toBeCloseTo(73.2, 0);
    const back = p.unproject(250, -130);
    const again = p.project(back.lat, back.lon);
    expect(again[0]).toBeCloseTo(250, 2);
    expect(again[1]).toBeCloseTo(-130, 2);
    const [s, w, n, e] = bboxAround(CONFIG.lat, CONFIG.lon, 500);
    expect(s).toBeLessThan(CONFIG.lat);
    expect(n - CONFIG.lat).toBeCloseTo(CONFIG.lat - s, 6);
    expect(e - CONFIG.lon).toBeCloseTo(CONFIG.lon - w, 6);
  });
});

describe("geometry", () => {
  it("clips lines and rings to the map square", () => {
    const pieces = clipPolylineToSquare([[-600, 0], [600, 0], [600, 100], [0, 100]], 500);
    expect(pieces).toEqual([[[-500, 0], [500, 0]], [[500, 100], [0, 100]]]);
    const ring = clipRingToSquare([[-600, -600], [600, -600], [600, 600], [-600, 600]], 500);
    expect(Math.abs(signedArea(ring))).toBeCloseTo(1_000_000, 3);
  });

  it("finds the minimum-area rectangle of a turned footprint", () => {
    const yaw = 0.4;
    const corners = [[-6, -4], [6, -4], [6, 4], [-6, 4]].map(([x, z]) => offsetPoint([30, -20], yaw, x!, z!));
    const rect = minAreaRect(corners);
    expect(rect.halfLength).toBeCloseTo(6, 6);
    expect(rect.halfWidth).toBeCloseTo(4, 6);
    expect(rect.center[0]).toBeCloseTo(30, 6);
    expect(rect.center[1]).toBeCloseTo(-20, 6);
  });

  it("joins multipolygon member ways into rings and simplifies polylines", () => {
    const rings = assembleRings([[[0, 0], [10, 0]], [[10, 10], [10, 0]], [[10, 10], [0, 10], [0, 0]]]);
    expect(rings).toHaveLength(1);
    expect(Math.abs(signedArea(rings[0]!))).toBeCloseTo(100, 6);
    expect(simplifyPolyline([[0, 0], [5, 0.2], [10, 0], [10, 10]], 0.5)).toEqual([[0, 0], [10, 0], [10, 10]]);
  });
});

describe("roads", () => {
  it("classifies OSM highways", () => {
    expect(roadClassOf({ highway: "tertiary" })).toMatchObject({ kind: "asphalt", width: 6.5 });
    expect(roadClassOf({ highway: "track" })).toMatchObject({ kind: "dirt" });
    expect(roadClassOf({ highway: "unclassified", surface: "asphalt" })).toMatchObject({ kind: "asphalt" });
    expect(roadClassOf({ highway: "residential", surface: "gravel" })).toMatchObject({ kind: "dirt" });
    expect(roadClassOf({ highway: "footway" })).toBeNull();
    expect(roadClassOf({ highway: "footway", bridge: "yes" })).toMatchObject({ width: 3 });
    expect(roadClassOf({ highway: "motorway" })).toBeNull();
    expect(roadClassOf({ highway: "service", service: "driveway" })).toBeNull();
    expect(roadClassOf({ highway: "tertiary", tunnel: "yes" })).toBeNull();
    // City mode paves alleys and keeps them narrow.
    expect(roadClassOf({ highway: "service" }, true)).toMatchObject({ kind: "asphalt", width: 3.5 });
    expect(roadClassOf({ highway: "track" }, true)).toMatchObject({ kind: "asphalt" });
  });

  it("joins ways that continue each other into one road and drops stubs", () => {
    const { roads } = convertRoads([
      { id: 1, tags: { highway: "residential" }, points: [[0, 0], [50, 0]] },
      { id: 2, tags: { highway: "residential" }, points: [[100, 0], [50, 0]] },
      { id: 3, tags: { highway: "service" }, points: [[20, 0], [20, 10]] },
    ]);
    expect(roads).toHaveLength(1);
    expect(roads[0]!.points).toEqual([[0, 0], [100, 0]]);
    expect(roads[0]!.width).toBe(5.5);
  });
});

describe("buildings", () => {
  const rect = (length: number, width: number) => minAreaRect([[-length / 2, -width / 2], [length / 2, -width / 2], [length / 2, width / 2], [-length / 2, width / 2]]);

  it("maps footprints to prefabs", () => {
    expect(prefabFor({ building: "house" }, 90, rect(10, 9))).toBe("house_small");
    expect(prefabFor({ building: "yes" }, 180, rect(14, 13))).toBe("house_two_story");
    expect(prefabFor({ building: "barn" }, 220, rect(20, 11))).toBe("barn");
    expect(prefabFor({ building: "chapel" }, 30, rect(6, 5))).toBe("watchtower");
    expect(prefabFor({ building: "industrial" }, 500, rect(28, 18))).toBe("warehouse");
    expect(prefabFor({ building: "garage" }, 24, rect(6, 4))).toMatch(/^container_open/);
    expect(prefabFor({ building: "roof" }, 80, rect(10, 8))).toBeNull();
    expect(prefabFor({ building: "yes" }, 12, rect(4, 3))).toBeNull();
  });

  it("faces the nearest road and keeps clear of it, pushing back when the real footprint is too close", () => {
    const road = { id: "r", kind: "asphalt" as const, straight: true, width: 6, points: [[-100, 0], [100, 0]] as Vec2Tuple[] };
    const space = new PlacementSpace(mapPaths({ flatten: [roadFlatten(road)] }), []);
    // A house footprint 1 m from the road edge (the prefab outline would sit 1.3 m from it).
    const footprint = [[-5, 4], [5, 4], [5, 13], [-5, 13]] as Vec2Tuple[];
    const candidates = buildingCandidates([{ id: 42, tags: { building: "house" }, outer: footprint, holes: [], area: 90 }]);
    const { buildings, report } = placeBuildings(candidates, space, { cap: 10, excluded: new Set() });
    expect(buildings).toHaveLength(1);
    const b = buildings[0]!;
    // Entrance (local +Z) toward the road (−Z world).
    const [ex, ez] = offsetPoint([b.position[0], b.position[2]], b.yaw, 0, 1);
    expect(ez).toBeLessThan(b.position[2]);
    expect(Math.abs(ex - b.position[0])).toBeLessThan(0.01);
    const edge = Math.min(...[-100, -50, 0, 50, 100].map((x) => distanceToRect(b.bounds, x, 0)));
    expect(edge).toBeGreaterThanOrEqual(3 + ROAD_GAP - 1e-6);
    expect(report.pushedBack).toBe(1);
  });
});

describe("water", () => {
  const pond: Vec2Tuple[] = [[-40, -40], [40, -40], [40, 40], [-40, 40]];

  it("fences water with gaps where roads cross, and railings along the crossing", () => {
    const road = { id: "bridge", kind: "asphalt" as const, straight: true, width: 6, points: [[-100, 0], [100, 0]] as Vec2Tuple[] };
    const { fences } = waterEdges([pond], [road]);
    const bank = fences.find((f) => f.gaps !== undefined)!;
    expect(bank.gaps).toHaveLength(2);
    const railings = fences.filter((f) => f !== bank);
    expect(railings).toHaveLength(2);
    // No fence piece stands on the carriageway.
    for (const piece of fenceProps(fences)) expect(Math.abs(piece.position[2])).toBeGreaterThan(3);
  });

  it("cuts roads that dead-end in water back to the bank", () => {
    const pier = { id: "pier", kind: "dirt" as const, straight: true, width: 4, points: [[-100, 0], [0, 0]] as Vec2Tuple[] };
    const [trimmed] = trimRoadsAtWater([pier], [pond]);
    expect(trimmed!.points[trimmed!.points.length - 1]![0]).toBeLessThan(-40);
    expect(trimRoadsAtWater([{ ...pier, points: [[-20, 0], [0, 0]] }], [pond])).toEqual([]);
  });
});

describe("elevation", () => {
  it("stores real relief as a height grid the terrain interpolates exactly at its samples", () => {
    const { spec, report } = realTerrainSpec(7, slope(), { mode: "real", scale: 0.5, maxRelief: 40 });
    const grid = spec.features.find((f) => f.kind === "heightGrid");
    expect(grid && grid.kind === "heightGrid" && grid.columns).toBe(65);
    expect(report.realMin).toBeGreaterThan(470);
    expect(report.gameRelief).toBeLessThan(8);
    const flat: TerrainSpec = { ...spec, relief: { ...spec.relief, hillAmplitude: 0, detailAmplitude: 0, macroAmplitude: 0 } };
    const relief = createReliefFunction(flat);
    if (!grid || grid.kind !== "heightGrid") throw new Error("no grid");
    for (const [i, j] of [[16, 16], [32, 40], [45, 20]] as const) {
      const x = grid.origin[0] + i * grid.spacing;
      const z = grid.origin[1] + j * grid.spacing;
      expect(relief(x, z)).toBeCloseTo(flat.relief.baseHeight + grid.heights[j * grid.columns + i]!, 6);
    }
    expect(realTerrainSpec(7, slope(), { mode: "flat", scale: 1, maxRelief: 4 }).spec.features).toEqual([]);
  });
});

describe("convertRealMap on the fixture", () => {
  const result = convertRealMap({ osm: fixture, elevation: slope(), config: CONFIG });
  const { map, report } = result;

  it("parses the fixture", () => {
    const parsed = parseOsm(fixture, createProjection(CONFIG.lat, CONFIG.lon), 640);
    expect(parsed.buildings.length).toBeGreaterThan(80);
    expect(parsed.points.some((p) => p.tags.place === "village")).toBe(true);
  });

  it("produces a map that validates and is reachable", () => {
    expect(validateMapLayout(map, result.terrain, result.layout, result.validation)).toEqual([]);
    expect(report.issues).toEqual([]);
    expect(report.reachability).not.toBeNull();
    const r = report.reachability!;
    for (const pair of [r.pois, r.spawns, r.entrances]) expect(pair.split("/")[0]).toBe(pair.split("/")[1]);
    expect(r.lootRatio).toBeGreaterThanOrEqual(0.97);
  });

  it("keeps the cap, names POIs from OSM with diacritics, and gives each POI two spawns", () => {
    expect(map.buildings.length).toBeGreaterThan(20);
    expect(map.buildings.length).toBeLessThanOrEqual(40);
    expect(map.pois.length).toBeGreaterThanOrEqual(3);
    expect(map.pois.some((p) => p.name.startsWith("Holašovice"))).toBe(true);
    expect(new Set(map.pois.map((p) => p.name)).size).toBe(map.pois.length);
    for (const poi of map.pois) {
      const mine = map.spawns.filter((s) => {
        const nearest = [...map.pois].sort((a, b) => distance(a.center[0], a.center[1], s.position[0], s.position[1]) - distance(b.center[0], b.center[1], s.position[0], s.position[1]))[0];
        return nearest === poi;
      });
      expect(mine.length, poi.name).toBeGreaterThanOrEqual(2);
    }
  });

  it("faces buildings toward roads, keeps them off roads and out of water", () => {
    const paths = mapPaths(map);
    let facing = 0;
    for (const b of result.layout.buildings) {
      const [ex, ez] = offsetPoint([b.position[0], b.position[2]], b.yaw, 0, 8);
      const here = Math.min(...paths.map((p) => polylineDistance(p.points, b.position[0], b.position[2])));
      const ahead = Math.min(...paths.map((p) => polylineDistance(p.points, ex, ez)));
      if (ahead < here) facing++;
    }
    expect(facing / result.layout.buildings.length).toBeGreaterThan(0.7);
    for (const b of result.layout.buildings) for (const w of result.water) expect(pointInPolygon(w, b.bounds.center[0], b.bounds.center[1])).toBe(false);
  });

  it("is deterministic", () => {
    const again = convertRealMap({ osm: fixture, elevation: slope(), config: CONFIG }, { navCheck: false });
    expect(again.report.layoutChecksum).toBe(report.layoutChecksum);
    expect(again.report.terrainChecksum).toBe(report.terrainChecksum);
  });
});
