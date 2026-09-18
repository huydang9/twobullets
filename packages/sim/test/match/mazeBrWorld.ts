import { buildNavGrid, createNavQuery, isValidZoneCenter } from "@twobullets/shared/bots/nav/index";
import { BOT_PROFILES } from "@twobullets/shared/bots/profiles/profiles";
import type { BotBrainFactory, BotDifficulty, NavGrid, NavQuery } from "@twobullets/shared/bots/types";
import { createGroundLoot, generateLoot, type GroundLoot } from "@twobullets/shared/equipment/loot";
import { buildMapLayout } from "@twobullets/shared/map/layout/mapLayout";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { MAZE_BR } from "@twobullets/shared/map/mazeBr";
import { buildTerrain, type Terrain } from "@twobullets/shared/map/terrain/terrain";
import type { MapData } from "@twobullets/shared/map/types";
import { createBrMatchConfig, type BrMatchConfigOptions } from "@twobullets/shared/match/rules";
import { planTeamSpawns } from "@twobullets/shared/match/spawns";
import type { MatchEvent } from "@twobullets/shared/match/types";
import type { HavokModule } from "../../src/index";
import { createMapSimWorld, type MapSimWorld } from "../../src/map/mapCollision";
import { MatchSim } from "../../src/match/MatchSim";
import { loadoutFor, type HeadlessMatch, type HeadlessMatchOptions } from "./harness";

// Headless match on any MapData (the maze repro and its Map v1 control). `harness.ts` is Map v1 only and loads the
// committed terrain bake; this builds the terrain analytically so a map without a bake works the same way.

const terrains = new Map<string, { readonly terrain: Terrain; readonly layout: ReturnType<typeof buildMapLayout> }>();
const grids = new Map<string, NavGrid>();

export function loadMapWorld(map: MapData): { readonly terrain: Terrain; readonly layout: ReturnType<typeof buildMapLayout> } {
  let cached = terrains.get(map.id);
  if (!cached) {
    const terrain = buildTerrain(map.terrain, map.flatten);
    cached = { terrain, layout: buildMapLayout(map, terrain) };
    terrains.set(map.id, cached);
  }
  return cached;
}

export function loadMapNavGrid(map: MapData): NavGrid {
  let grid = grids.get(map.id);
  if (!grid) {
    const world = loadMapWorld(map);
    grid = buildNavGrid({ map, terrain: world.terrain, layout: world.layout });
    grids.set(map.id, grid);
  }
  return grid;
}

export interface MapMatchOptions extends Omit<HeadlessMatchOptions, "nav"> {
  readonly map?: MapData;
  readonly nav?: NavQuery;
}

/** A bots-only headless match on `map` (default the maze) with the real nav grid and real outdoor loot. */
export function createMapMatch(havok: HavokModule, options: MapMatchOptions): HeadlessMatch {
  const map = options.map ?? MAZE_BR;
  const { terrain, layout } = loadMapWorld(map);
  const world = createMapSimWorld(havok, { terrain, layout });
  const config = createBrMatchConfig({
    seed: options.seed,
    mapId: map.id,
    playableHalfExtent: map.terrain.playableHalfExtent,
    timeScale: options.timeScale ?? 1,
    difficulty: options.difficulty ?? "normal",
    ...(options.config as Partial<BrMatchConfigOptions> | undefined),
  });
  const spawns = planTeamSpawns(config.seed, config.teamCount, config.teamSize, map.pois, map.spawns, (x, z) => terrain.sampleHeight(x, z));
  const ground = createGroundLoot(
    generateLoot(config.seed, map.pois, layout.buildings, { flatten: map.flatten, terrain, layout }).items,
  );
  const grid = loadMapNavGrid(map);
  const nav = options.nav ?? createNavQuery(grid);
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
      profileFor: (difficulty: BotDifficulty) => BOT_PROFILES[difficulty],
      createBody: (feet) => world.createBody(feet),
      isValidZoneCenter: isValidZoneCenter(grid),
    },
  });
  const events: MatchEvent[] = [];
  sim.onEvent((event) => events.push(event));
  return {
    sim,
    world: world as MapSimWorld,
    ground,
    events,
    dispose() {
      sim.dispose();
      world.dispose();
    },
  };
}

export { MAP_V1, MAZE_BR };
export type { BotBrainFactory };
