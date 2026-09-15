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

/** Recorded by tools/map/build.ts --map <id>; regenerate the map (tools/map/osm/generate.ts) after converter changes. */
const BAKES: Readonly<Record<string, { inputsHash: string; terrainChecksum: string; layoutChecksum: string }>> = {
  "cz-holasovice": CZ_HOLASOVICE_BAKE,
  "vn-camthanh": VN_CAMTHANH_BAKE,
  "jp-shirakawago": JP_SHIRAKAWAGO_BAKE,
};

describe("real-world map registry", () => {
  it("lists the three presets, Holašovice first", () => {
    expect(REAL_MAPS.map((m) => m.info.id)).toEqual(["cz-holasovice", "vn-camthanh", "jp-shirakawago"]);
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

  it("validates with no issues", () => {
    expect(validateMapLayout(module.map, terrain, layout, module.validation)).toEqual([]);
  });

  it("has at most 90 buildings, no Training Yard, 10+ POIs and two spawns per POI", () => {
    const { map, info } = module;
    expect(map.buildings.length).toBeLessThanOrEqual(90);
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
