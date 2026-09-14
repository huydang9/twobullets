import { describe, expect, it } from "vitest";
import { buildMapLayout } from "../../map/layout/mapLayout";
import { MAP_V1 } from "../../map/mapV1";
import { buildTerrain } from "../../map/terrain/terrain";
import { NavFlag, type NavPath, type PathStatus } from "../types";
import { buildNavGrid } from "./buildNavGrid";
import { isValidZoneCenter } from "./helpers";
import { auditBuildingLinks } from "./linkAudit";
import { mapNavProbes, resolveProbes, type NavProbe } from "./mapProbes";
import { createNavQuery } from "./navQuery";
import { deserializeNavGrid, serializeNavGrid } from "./serialize";
import { emptyPath } from "./testWorld";

/**
 * Recorded Map v1 nav checksum (like MAP_V1_BAKE): a layout, prefab or nav build change fails here. Rerun
 * `node tools/bench/bots/nav.ts` and update after intentional changes.
 */
const MAP_V1_NAV_CHECKSUM = "21e550b3";

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

  it("never links a building interior to the terrain through a wall (controller capsule sweep)", () => {
    expect(auditBuildingLinks(grid)).toEqual([]);
    // Every building with a walkable interior keeps at least one link (closed containers have none).
    const linked = new Set<number>();
    for (let i = 0; i < grid.arrays.linkFrom.length; i++) {
      const from = grid.arrays.linkFrom[i]!;
      if (from >= grid.terrainNodes) linked.add(grid.spanPlacement[from - grid.terrainNodes]!);
    }
    const unlinked = grid.placements.filter((p, i) => !linked.has(i)).map((p) => layout.buildings.find((b) => b.id === p.id)!.prefab);
    expect(new Set(unlinked)).toEqual(new Set(["container_closed"]));
  });

  it("climbs the town-house stairs straight to the right floor, without back-and-forth", () => {
    for (const id of ["town_house_ne2", "town_house_s_east"]) {
      const p = grid.placements.find((b) => b.id === id)!;
      const at = (lx: number, ly: number, lz: number) => ({ x: p.x + lx * p.cos + lz * p.sin, y: p.y + ly, z: p.z - lx * p.sin + lz * p.cos });
      const outside = at(0, -0.1, 9);
      const cases = [
        { from: outside, to: at(-3.2, 3, 0), floor: 3 },
        { from: at(3.2, 3, 0), to: outside, floor: -0.1 },
        { from: at(1, 1.5, -0.1), to: at(-3.2, 3, 0), floor: 3 },
        { from: at(1, 1.5, -0.1), to: at(3.2, 0, 2), floor: 0 },
        { from: at(1, 2.7, -1.3), to: at(3.2, 3, 0), floor: 3 },
      ];
      for (const c of cases) {
        const probe = (v: { x: number; y: number; z: number }): NavProbe => ({ name: id, kind: "room", ...v, maxDistance: 1, upper: false });
        expect(run(probe(c.from), probe(c.to)), `${id} ${JSON.stringify(c)}`).toBe("found");
        const up = c.to.y > c.from.y;
        let stairLegs = 0;
        for (let i = 1; i < path.count; i++) {
          const dy = path.points[i * 3 + 1]! - path.points[(i - 1) * 3 + 1]!;
          expect(up ? dy : -dy, `${id} waypoint ${i}`).toBeGreaterThan(-0.2);
          if ((path.flags[i]! & path.flags[i - 1]! & NavFlag.stairs) !== 0) stairLegs++;
        }
        expect(stairLegs, id).toBeLessThanOrEqual(1);
        expect(Math.abs(path.points[(path.count - 1) * 3 + 1]! - p.y - c.floor), id).toBeLessThan(0.15);
      }
      // A straight walk never joins the floor above or below.
      expect(nav.lineWalkable(at(-0.4, 0, -2), at(-0.4, 3, -2))).toBe(false);
      expect(nav.lineWalkable(at(-0.4, 3, -2), at(-0.4, 0, -2))).toBe(false);
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
