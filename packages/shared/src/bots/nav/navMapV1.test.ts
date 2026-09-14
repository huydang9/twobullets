import { describe, expect, it } from "vitest";
import { buildMapLayout } from "../../map/layout/mapLayout";
import { MAP_V1 } from "../../map/mapV1";
import { buildTerrain } from "../../map/terrain/terrain";
import { NavFlag, type NavPath, type PathStatus } from "../types";
import { buildNavGrid } from "./buildNavGrid";
import { isValidZoneCenter } from "./helpers";
import { mapNavProbes, resolveProbes, type NavProbe } from "./mapProbes";
import { createNavQuery } from "./navQuery";
import { deserializeNavGrid, serializeNavGrid } from "./serialize";
import { emptyPath } from "./testWorld";

/**
 * Recorded Map v1 nav checksum (like MAP_V1_BAKE): a layout, prefab or nav build change fails here. Rerun
 * `node tools/bench/bots/nav.ts` and update after intentional changes.
 */
const MAP_V1_NAV_CHECKSUM = "34f6ddee";

/** Known unreachable areas, by probe name prefix (none since the radar station's stair got its bottom step). */
const KNOWN_GAPS: readonly string[] = [];
const isKnownGap = (probe: NavProbe) => KNOWN_GAPS.some((prefix) => probe.name.startsWith(prefix));

describe("Map v1 navigation", () => {
  const terrain = buildTerrain(MAP_V1.terrain, MAP_V1.flatten);
  const layout = buildMapLayout(MAP_V1, terrain);
  const grid = buildNavGrid({ map: MAP_V1, terrain, layout });
  const nav = createNavQuery(grid);
  const probes = mapNavProbes(MAP_V1, terrain, layout);
  const scratch = { x: 0, y: 0, z: 0 };
  const town = nav.nearest({ x: 0, y: terrain.sampleHeight(0, 20), z: 20 }, 5, scratch);
  const results = resolveProbes(nav, probes, town);
  const path: NavPath = emptyPath();

  function run(from: NavProbe, to: NavProbe): PathStatus {
    const handle = nav.requestPath(from, to, null);
    let status = nav.readPath(handle, path);
    for (let i = 0; status === "pending" && i < 2000; i++) {
      nav.update(1500);
      status = nav.readPath(handle, path);
    }
    nav.releasePath(handle);
    return status;
  }

  it("builds within budget", () => {
    expect(grid.stats!.buildMs).toBeLessThan(2000);
    expect(grid.info.byteLength).toBeLessThan(24 * 1024 * 1024);
    expect(grid.info.terrainNodes).toBe(4_000_000);
    expect(grid.stats!.overflowColumns).toBe(0);
    expect(grid.info.components).toBeLessThan(200);
    expect(town).toBeGreaterThanOrEqual(0);
    expect(grid.componentOf(town)).toBe(grid.layout.mainComponent);
    expect(isValidZoneCenter(grid)(0, 20)).toBe(true);
  });

  it("puts every spawn, POI, entrance and ground-floor room on the main component", () => {
    const missing = results.filter((r) => (r.probe.kind === "spawn" || r.probe.kind === "poi" || r.probe.kind === "entrance" || (r.probe.kind === "room" && !r.probe.upper)) && !r.reachable);
    expect(missing.map((r) => r.probe.name)).toEqual([]);
    expect(results.filter((r) => r.probe.kind === "spawn")).toHaveLength(MAP_V1.spawns.length);
  });

  it("reaches building interiors and upper floors, except the known gaps", () => {
    const loot = results.filter((r) => r.probe.kind === "loot");
    const reachable = loot.filter((r) => r.reachable).length;
    expect(reachable / loot.length).toBeGreaterThan(0.975);
    const unexpected = results.filter((r) => !r.reachable && !isKnownGap(r.probe));
    expect(unexpected.map((r) => r.probe.name)).toEqual([]);
    // Upper floors snap to their own floor height, not the ground below.
    for (const r of results.filter((x) => x.probe.kind === "room" && x.probe.upper && !isKnownGap(x.probe))) {
      expect(Math.abs(r.dy), r.probe.name).toBeLessThan(0.35);
    }
  });

  it("paths up the stairs to every upper room and tower platform", () => {
    const pois = new Map(results.filter((r) => r.probe.kind === "poi").map((r) => [r.probe.poi!, r.probe]));
    const upper = results.filter((r) => r.probe.kind === "room" && r.probe.upper && !isKnownGap(r.probe));
    expect(upper.length).toBeGreaterThanOrEqual(31);
    expect(upper.some((r) => r.probe.name.endsWith(":platform"))).toBe(true);
    for (const r of upper) {
      const status = run(pois.get(r.probe.poi!)!, r.probe);
      expect(status, r.probe.name).toBe("found");
      let top = -Infinity;
      let flags = 0;
      for (let i = 0; i < path.count; i++) {
        top = Math.max(top, path.points[i * 3 + 1]!);
        flags |= path.flags[i]!;
      }
      expect(top, r.probe.name).toBeGreaterThan(r.probe.y - 0.35);
      expect(flags & NavFlag.stairs, r.probe.name).toBe(NavFlag.stairs);
    }
  });

  it("finds a path between every pair of POIs", () => {
    const pois = results.filter((r) => r.probe.kind === "poi").map((r) => r.probe);
    for (let i = 0; i < pois.length; i++) {
      for (let j = i + 1; j < pois.length; j++) {
        expect(run(pois[i]!, pois[j]!), `${pois[i]!.name} → ${pois[j]!.name}`).toBe("found");
        expect(path.length).toBeGreaterThan(100);
      }
    }
  });

  it("is deterministic and round-trips through bytes", () => {
    const again = buildNavGrid({ map: MAP_V1, terrain, layout });
    expect(again.info.checksum).toBe(grid.info.checksum);
    expect(grid.info.checksum).toBe(MAP_V1_NAV_CHECKSUM);
    expect(deserializeNavGrid(serializeNavGrid(grid)).info.checksum).toBe(grid.info.checksum);
  });
});
