/**
 * Headless match on any map id (`tools/bench/bots/match.ts --map <id>`): the same setup as the sim test harness's
 * `createHeadlessMatch` (Map v1 only), with the map's terrain (its committed bake when current), layout, nav grid, POI
 * spawn plan and loot. The returned object is a `HeadlessMatch`, so `runHeadlessMatch` measures it unchanged.
 */
import { BOT_PROFILES } from "@twobullets/shared/bots/profiles/profiles";
import { buildNavGrid } from "@twobullets/shared/bots/nav/buildNavGrid";
import { isValidZoneCenter } from "@twobullets/shared/bots/nav/helpers";
import { createNavQuery } from "@twobullets/shared/bots/nav/navQuery";
import type { NavQuery } from "@twobullets/shared/bots/types";
import { createGroundLoot, generateLoot } from "@twobullets/shared/equipment/loot";
import { createBrMatchConfig } from "@twobullets/shared/match/rules";
import { planTeamSpawns } from "@twobullets/shared/match/spawns";
import type { MatchEvent } from "@twobullets/shared/match/types";
import type { HavokModule } from "../../../../packages/sim/src/index.ts";
import { createMapSimWorld } from "../../../../packages/sim/src/map/mapCollision.ts";
import { MatchSim } from "../../../../packages/sim/src/match/MatchSim.ts";
import { loadoutFor, type HeadlessMatch, type HeadlessMatchOptions } from "../../../../packages/sim/test/match/harness.ts";
import { StraightNav } from "../../../../packages/sim/test/match/straightNav.ts";

export { loadMap, type LoadedMap } from "./loadMap.ts";
import { loadMap } from "./loadMap.ts";

export async function createMapHeadlessMatch(havok: HavokModule, mapId: string, options: HeadlessMatchOptions): Promise<HeadlessMatch & { readonly navMs: number }> {
  const { map, terrain, layout } = await loadMap(mapId);
  const world = createMapSimWorld(havok, { terrain, layout });
  const config = createBrMatchConfig({ seed: options.seed, mapId, playableHalfExtent: map.terrain.playableHalfExtent, timeScale: options.timeScale ?? 1, difficulty: options.difficulty ?? "normal", ...options.config });
  const spawns = options.spawns?.(world, config) ?? planTeamSpawns(config.seed, config.teamCount, config.teamSize, map.pois, map.spawns, (x, z) => terrain.sampleHeight(x, z));
  const ground = createGroundLoot(generateLoot(config.seed, map.pois, layout.buildings).items);
  let nav: NavQuery;
  let zoneCenter = (x: number, z: number) => terrain.isPlayable(x, z) && terrain.slopeTanAt(x, z) < 0.7;
  let navMs = 0;
  if (options.nav === undefined || options.nav === "grid") {
    const started = performance.now();
    const grid = buildNavGrid({ map, terrain, layout });
    navMs = performance.now() - started;
    nav = createNavQuery(grid);
    zoneCenter = isValidZoneCenter(grid);
  } else {
    nav = options.nav === "straight" ? new StraightNav(terrain) : options.nav;
  }
  const sim = new MatchSim({
    config,
    spawns,
    killY: map.bounds.killY,
    profile: options.profile ?? false,
    ...loadoutFor(options.loadout),
    ports: {
      raycastWorld: world.raycastWorld,
      nav,
      groundLoot: ground,
      brainFactory: options.brains,
      profileFor: (difficulty) => BOT_PROFILES[difficulty],
      createBody: (feet) => world.createBody(feet),
      ...(options.external ? { external: options.external(world) } : {}),
      isValidZoneCenter: zoneCenter,
    },
  });
  const events: MatchEvent[] = [];
  sim.onEvent((event) => events.push(event));
  return {
    sim,
    world,
    ground,
    events,
    navMs,
    dispose() {
      sim.dispose();
      world.dispose();
    },
  };
}
