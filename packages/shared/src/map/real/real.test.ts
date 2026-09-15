import { beforeAll, describe, expect, it } from "vitest";
import { buildNavGrid } from "../../bots/nav/buildNavGrid";
import { mapNavProbes, resolveProbes } from "../../bots/nav/mapProbes";
import { createNavQuery } from "../../bots/nav/navQuery";
import { distance, pointInPolygon, polygonEdgeDistance, polylineDistance } from "../layout/geometry";
import { buildMapLayout, type MapLayout } from "../layout/mapLayout";
import { validateMapLayout } from "../layout/validate";
import { terrainInputsHash } from "../terrain/bake";
import { buildTerrain, type Terrain } from "../terrain/terrain";
import { BAKE as CZ_HOLASOVICE_BAKE } from "./cz-holasovice.bake";
import { BAKE as JP_SHIRAKAWAGO_BAKE } from "./jp-shirakawago.bake";
import { REAL_MAPS, type RealMapModule } from "./index";
import { BAKE as VN_CAMTHANH_BAKE } from "./vn-camthanh.bake";
import { BAKE as VN_HANGXANH_BAKE } from "./vn-hangxanh.bake";
import { BAKE as VN_PHANDANGLUU_BAKE } from "./vn-phandangluu.bake";
import { COLLIDER_STRIDE, propColliderGroups } from "../layout/collision";
import { getPrefabCollision } from "../buildings/placement";
import { getBuildingPrefab, isBuildingPrefabId } from "../buildings/prefabs";
import { isPoliticalName } from "./convert/names";
import { distanceToRect } from "../layout/geometry";
import { mapPaths } from "../layout/roads";
import { planStreetSigns, STREET_SIGN } from "../layout/streetSigns";

/** Recorded by tools/map/build.ts --map <id>; regenerate the map (tools/map/osm/generate.ts) after converter changes. */
const BAKES: Readonly<Record<string, { inputsHash: string; terrainChecksum: string; layoutChecksum: string }>> = {
  "cz-holasovice": CZ_HOLASOVICE_BAKE,
  "vn-camthanh": VN_CAMTHANH_BAKE,
  "jp-shirakawago": JP_SHIRAKAWAGO_BAKE,
  "vn-hangxanh": VN_HANGXANH_BAKE,
  "vn-phandangluu": VN_PHANDANGLUU_BAKE,
};
/** Building caps: villages keep the default 90; the Saigon street maps (urban mode) set their own. */
const BUILDING_CAPS: Readonly<Record<string, number>> = { "vn-hangxanh": 190, "vn-phandangluu": 190 };

describe("real-world map registry", () => {
  it("lists the presets, Holašovice first, then the custom places", () => {
    expect(REAL_MAPS.map((m) => m.info.id)).toEqual(["cz-holasovice", "vn-camthanh", "jp-shirakawago", "vn-hangxanh", "vn-phandangluu"]);
    for (const { info } of REAL_MAPS) {
      expect(info.credits).toContain("osm");
      expect(info.bakeUrl).toBe(`assets/map/${info.id}.terrain.bin`);
    }
  });
});

describe.each(REAL_MAPS.map((entry) => [entry.info.id, entry] as const))("real-world map %s", (id, entry) => {
  let module: RealMapModule;
  let terrain: Terrain;
  let layout: MapLayout;

  beforeAll(async () => {
    module = await entry.load();
    terrain = buildTerrain(module.map.terrain, module.map.flatten);
    layout = buildMapLayout(module.map, terrain);
  }, 60_000);

  it("matches the recorded bake and layout checksums", () => {
    const bake = BAKES[id]!;
    expect(terrainInputsHash(module.map.terrain, module.map.flatten)).toBe(bake.inputsHash);
    expect(terrain.checksum()).toBe(bake.terrainChecksum);
    expect(layout.checksum).toBe(bake.layoutChecksum);
  });

  it("shows no political map or POI names (road labels keep real street names)", () => {
    const names = [entry.info.name, module.map.name, ...module.map.pois.map((p) => p.name), ...(module.map.landmarks ?? []).map((l) => l.name)];
    expect(names.filter(isPoliticalName)).toEqual([]);
    for (const label of module.map.roadLabels ?? []) {
      expect(label.lines.length).toBeGreaterThan(0);
      for (const line of label.lines) for (const [x, z] of line) expect(Math.max(Math.abs(x), Math.abs(z))).toBeLessThanOrEqual(module.map.terrain.playableHalfExtent);
    }
  });

  it("puts street signs off the roadway, outside buildings and apart, for every labeled road", () => {
    const { map } = module;
    const signs = planStreetSigns(map, layout.buildings);
    const labels = map.roadLabels ?? [];
    if (labels.length === 0) expect(signs.filter((s) => s.kind !== "facade")).toEqual([]);
    const paths = mapPaths(map);
    for (const sign of signs) {
      const [x, z] = sign.position;
      expect(Math.max(Math.abs(x), Math.abs(z))).toBeLessThan(map.terrain.playableHalfExtent);
      if (sign.kind === "facade") continue;
      for (const path of paths) expect(polylineDistance(path.points, x, z) - path.halfWidth, `${sign.blades[0]!.name} (${x}, ${z})`).toBeGreaterThanOrEqual(STREET_SIGN.roadClearance - 1e-3);
      for (const b of layout.buildings) expect(distanceToRect(b.bounds, x, z), `${sign.blades[0]!.name} in ${b.id}`).toBeGreaterThanOrEqual(STREET_SIGN.buildingClearance - 1e-3);
      for (const other of signs) if (other !== sign && other.kind !== "facade") expect(distance(x, z, other.position[0], other.position[1])).toBeGreaterThanOrEqual(STREET_SIGN.signGap - 1e-3);
    }
    const street = signs.filter((s) => s.kind === "street");
    for (const a of street) {
      for (const b of signs) if (a !== b && b.blades.some((blade) => blade.name === a.blades[0]!.name) && signs.indexOf(b) < signs.indexOf(a)) expect(distance(a.position[0], a.position[1], b.position[0], b.position[1])).toBeGreaterThanOrEqual(STREET_SIGN.sameNameGap - 1e-3);
    }
    const named = new Set(signs.flatMap((s) => s.blades.map((b) => b.name)));
    for (const label of labels) expect(named.has(label.name), label.name).toBe(true);
    if (id === "vn-hangxanh" || id === "vn-phandangluu") {
      expect(signs.filter((s) => s.kind === "corner").length).toBeGreaterThanOrEqual(5);
      expect(signs.filter((s) => s.kind === "corner").every((s) => s.blades.length === 2)).toBe(true);
    }
    for (const landmark of map.landmarks ?? []) expect(signs.some((s) => s.kind === "facade" && s.building === landmark.building), landmark.name).toBe(true);
  });

  it("places every landmark on a building of its own, labeled and signed", () => {
    for (const landmark of module.map.landmarks ?? []) {
      const building = layout.buildings.find((b) => b.id === landmark.building);
      expect(building, landmark.name).toBeDefined();
      expect(distance(building!.position[0], building!.position[2], landmark.center[0], landmark.center[1])).toBeLessThan(0.01);
    }
    if (id === "vn-phandangluu") {
      const aga = module.map.landmarks?.find((l) => l.name === "Aga Building");
      expect(aga).toBeDefined();
      const building = module.map.buildings.find((b) => b.id === aga!.building)!;
      expect(building.id).toBe("bld_1044664010");
      expect(building.prefab).toBe("tube_house_4");
      // Estimated from the alley layout: within a few meters of the OSM footprint centroid (430.5, 366.4).
      expect(distance(building.position[0], building.position[2], 430.5, 366.4)).toBeLessThan(4);
    }
  });

  it("validates with no issues", () => {
    expect(validateMapLayout(module.map, terrain, layout, module.validation)).toEqual([]);
  });

  it("stays within its building cap, has no Training Yard, 10+ POIs and two spawns per POI", () => {
    const { map, info } = module;
    // Bridges and named landmarks are laid on top of the building cap.
    const landmarkIds = new Set((map.landmarks ?? []).map((l) => l.building));
    expect(map.buildings.filter((b) => !(isBuildingPrefabId(b.prefab) && getBuildingPrefab(b.prefab).spansRoad) && !landmarkIds.has(b.id)).length).toBeLessThanOrEqual(BUILDING_CAPS[id] ?? 90);
    expect(map.buildings.length).toBe(info.stats.buildings);
    expect(map.pois.some((p) => p.kind === "training")).toBe(false);
    expect(map.pois.length).toBeGreaterThanOrEqual(10);
    expect(map.pois.length).toBe(info.stats.pois);
    const counts = new Map<string, number>();
    for (const spawn of map.spawns) {
      const [x, z] = spawn.position;
      const nearest = [...map.pois].sort((a, b) => distance(a.center[0], a.center[1], x, z) - distance(b.center[0], b.center[1], x, z))[0]!;
      counts.set(nearest.id, (counts.get(nearest.id) ?? 0) + 1);
    }
    for (const poi of map.pois) expect(counts.get(poi.id) ?? 0, poi.name).toBeGreaterThanOrEqual(2);
    expect(new Set(map.pois.map((p) => p.name)).size).toBe(map.pois.length);
  });

  it("has finite spawns and feet, and non-degenerate colliders with finite transforms", () => {
    // Guards for the Havok world the client builds from this map (a NaN or zero-size shape corrupts its step).
    for (const { position: [x, z], yaw } of module.map.spawns) {
      expect([x, z, yaw].every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(terrain.sampleHeight(x, z))).toBe(true);
    }
    for (const group of propColliderGroups(layout)) {
      const size = group.shape.kind === "cylinder" ? [group.shape.radius, group.shape.height] : group.shape.size;
      expect(size.every((v) => Number.isFinite(v) && v > 1e-3), group.prop).toBe(true);
      expect(group.transforms.length % COLLIDER_STRIDE).toBe(0);
      expect(group.transforms.every(Number.isFinite), group.prop).toBe(true);
    }
    for (const b of layout.buildings) {
      expect([...b.position, b.yaw].every(Number.isFinite), b.id).toBe(true);
      for (const shape of getPrefabCollision(b.prefab)) expect(shape.size.every((v) => v > 1e-3), b.prefab).toBe(true);
    }
  });

  it("reaches every POI, spawn, entrance and ground-floor room, 97 %+ of loot, and never the fenced water", () => {
    const grid = buildNavGrid({ map: module.map, terrain, layout });
    expect(grid.stats!.overflowColumns).toBe(0);
    const nav = createNavQuery(grid);
    const scratch = { x: 0, y: 0, z: 0 };
    const main = module.map.pois
      .map((p) => nav.nearest({ x: p.center[0], y: terrain.sampleHeight(p.center[0], p.center[1]), z: p.center[1] }, 12, scratch))
      .find((ref) => ref >= 0 && grid.componentOf(ref) === grid.layout.mainComponent)!;
    expect(main).toBeGreaterThanOrEqual(0);
    const results = resolveProbes(nav, mapNavProbes(module.map, terrain, layout), main);
    const missing = results.filter((r) => (r.probe.kind === "spawn" || r.probe.kind === "poi" || r.probe.kind === "entrance" || (r.probe.kind === "room" && !r.probe.upper)) && !r.reachable);
    expect(missing.map((r) => r.probe.name)).toEqual([]);
    const loot = results.filter((r) => r.probe.kind === "loot");
    expect(loot.filter((r) => r.reachable).length / loot.length).toBeGreaterThanOrEqual(0.97);

    let wet = 0;
    const leaks: string[] = [];
    for (let z = -490; z <= 490; z += 8) {
      for (let x = -490; x <= 490; x += 8) {
        if (!module.water.some((w) => pointInPolygon(w, x, z) && polygonEdgeDistance(w, x, z) > 3)) continue;
        if (module.roads.some((r) => polylineDistance(r.points, x, z) < (r.width ?? 5) / 2 + 3)) continue;
        wet++;
        const ref = nav.nearest({ x, y: terrain.sampleHeight(x, z), z }, 0.5, scratch);
        if (ref >= 0 && grid.componentOf(ref) === grid.layout.mainComponent) leaks.push(`(${x}, ${z})`);
      }
    }
    expect(leaks.slice(0, 10)).toEqual([]);
    if (module.info.stats.waterHa > 1) expect(wet).toBeGreaterThan(0);
  }, 60_000);
});
