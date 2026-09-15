import { planTeamSpawns } from "@twobullets/shared/match/spawns";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { DEFAULT_ZONE_SPEC } from "@twobullets/shared/match/zone";
import type { HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import { ARENA_ZONE_SPEC, knownServerMapIds, resolveServerLevel, type MatchLevel } from "../src/level/serverLevel";
import { createHarness } from "./harness";

// plan.md B2: the match server resolves `MatchConfig.mapId` to a level (arena blockout or Map v1 terrain + buildings).

let havok: HavokModule;
let v1: MatchLevel;

beforeAll(async () => {
  havok = await loadHavok();
  v1 = await resolveServerLevel("v1");
}, 60_000);

describe("resolveServerLevel", () => {
  it("knows arena and v1, rejects unknown ids, and caches map data per process", async () => {
    expect(knownServerMapIds()).toEqual(["arena", "v1"]);
    const arena = await resolveServerLevel("arena");
    expect(arena).toMatchObject({ mapId: "arena", source: "arena", zone: ARENA_ZONE_SPEC });
    await expect(resolveServerLevel("vn-hoian")).rejects.toThrow(/unknown map "vn-hoian"/);
    expect(v1).toMatchObject({ mapId: "v1", killY: MAP_V1.bounds.killY, zone: DEFAULT_ZONE_SPEC });
    expect(["bake", "generated"]).toContain(v1.source);
    expect((await resolveServerLevel("v1")).loadMs).toBe(0);
  });

  it("Map v1 team starts are the offline plan on the terrain; zone centers must be playable", () => {
    const plans = v1.planTeamSpawns(77, 5, 4);
    expect(plans).toHaveLength(5);
    expect(new Set(plans.map((p) => p.poiId)).size).toBe(5);
    const offline = planTeamSpawns(77, 5, 4, MAP_V1.pois, MAP_V1.spawns, () => 0);
    expect(plans.map((p) => p.feet.map((f) => [f.x, f.z]))).toEqual(offline.map((p) => p.feet.map((f) => [f.x, f.z])));
    expect(v1.isValidZoneCenter!(0, 0)).toBe(true);
    expect(v1.isValidZoneCenter!(600, 0)).toBe(false);
  });

  it("a BR match on Map v1: 4 squadmates join at their POI, walk on the terrain, and warmup counts down", async () => {
    const h = await createHarness(havok, { level: v1, maxPlayers: 4, teamMode: "squad", lifecycle: { warmupSeconds: 60, allJoinedSeconds: 30 } });
    for (let i = 0; i < 4; i++) h.connect({ team: 0 });
    h.run(1500);
    expect(h.clients.every((c) => c.welcome !== null && c.disconnect === null)).toBe(true);
    const start = v1.planTeamSpawns(1234, 1, 4)[0]!;
    for (const p of h.match.players) {
      const f = p.feet;
      const home = start.feet[p.slot]!;
      expect(Math.sqrt((f.x - home.x) ** 2 + (f.z - home.z) ** 2)).toBeLessThan(15);
      // On the terrain or on a building/prop, never through the heightfield.
      expect(f.y).toBeGreaterThan(v1.heightAt!(f.x, f.z) - 0.2);
      expect(Math.abs(home.y - v1.heightAt!(home.x, home.z))).toBeLessThan(1e-3);
    }
    expect(h.match.lifecycle!.phase).toBe("Warmup");
    expect(h.clients[0]!.phase!.endTick).toBeGreaterThan(h.match.nextTick);
    await h.dispose();
  }, 60_000);
});
