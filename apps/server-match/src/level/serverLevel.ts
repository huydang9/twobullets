import { FakeNavQuery, type FakeNavBox } from "@twobullets/shared/bots/brain/fakeNav";
import { buildNavGrid } from "@twobullets/shared/bots/nav/buildNavGrid";
import { createNavQuery } from "@twobullets/shared/bots/nav/navQuery";
import type { NavGrid, NavQuery } from "@twobullets/shared/bots/types";
import { buildDestructibleWalls } from "@twobullets/shared/equipment/destructible";
import { generateLoot, type LootItem } from "@twobullets/shared/equipment/loot";
import { createTestLoot } from "@twobullets/shared/equipment/presets";
import type { LevelData } from "@twobullets/shared/level/types";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { buildMapLayout, type MapLayout } from "@twobullets/shared/map/layout/mapLayout";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { MAZE_BR } from "@twobullets/shared/map/mazeBr";
import { REAL_MAPS } from "@twobullets/shared/map/real/index";
import { decodeTerrainBake } from "@twobullets/shared/map/terrain/bake";
import { buildTerrain, type Terrain } from "@twobullets/shared/map/terrain/terrain";
import type { MapData } from "@twobullets/shared/map/types";
import { planTeamSpawns } from "@twobullets/shared/match/spawns";
import type { TeamSpawnPlan, ZoneSpec } from "@twobullets/shared/match/types";
import { DEFAULT_ZONE_SPEC, zoneCenterBiasForPois, zoneSpecForHalfExtent, type ZoneCenterCheck } from "@twobullets/shared/match/zone";
import { createMapSimWorld, createSimWorld, type HavokModule, type SimWorld } from "@twobullets/sim";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SpawnPlanner } from "../match/slots";

// What a match needs from its level (plan.md B2): a collision world factory, team starts, the kill plane and the zone
// tuning. `resolveServerLevel(mapId)` handles the dev arena and built maps (Map v1 today); map data (terrain + layout)
// is loaded once per process and shared, while every match builds its own Havok world from it.

export interface MatchLevel {
  readonly mapId: string;
  readonly name: string;
  readonly killY: number;
  readonly zone: ZoneSpec;
  /** Terrain height (buildings and props ignored), or null on a blockout. B3: landing clamps and glide altitude. */
  readonly heightAt: ((x: number, z: number) => number) | null;
  /** Zone center check, or null to accept any center inside the previous circle. */
  readonly isValidZoneCenter: ZoneCenterCheck | null;
  /** Team starts: validated map spawns grouped by POI (the offline `planTeamSpawns`), arena spawn points otherwise. */
  planTeamSpawns(seed: number, teamCount: number, teamSize: number): TeamSpawnPlan[];
  createWorld(havok: HavokModule): Promise<SimWorld>;
  /** Map data load (terrain + layout), ms; 0 for the arena. */
  readonly loadMs: number;
  readonly source: "arena" | "bake" | "generated";
  /**
   * Bot navigation for one match (server bots): a fresh query over the map's nav grid, built on first use and shared by
   * later matches on the same map in this process. Absent: an open fake nav.
   */
  readonly createNav?: () => MatchNav;
  /**
   * Ground loot for a match seed (B5): the offline generator on this level, exactly what practice spawns (map: building
   * piles plus roadside and pad piles; arena: a test pile in front of every spawn). The match filters what it can't
   * simulate (throwables). Absent: no loot.
   */
  readonly createLoot?: (seed: number) => readonly LootItem[];
}

export interface MatchNav {
  readonly nav: NavQuery;
  /** Grid build time for this call, ms (0 when cached or fake). */
  readonly buildMs: number;
  readonly kind: "grid" | "cached" | "fake";
}

/** Arena-sized zone: Map v1's schedule with radii for a 120 m blockout. */
export const ARENA_ZONE_SPEC: ZoneSpec = {
  ...DEFAULT_ZONE_SPEC,
  initial: { cx: 0, cz: 0, r: 60 },
  phases: DEFAULT_ZONE_SPEC.phases.map((p, i) => ({ ...p, radius: [40, 28, 18, 10, 5, 2, 0][i] ?? 0 })),
  edgeMargin: 4,
};

/** Wraps a blockout `LevelData` (the M3/M4 arena) as a match level. */
export function arenaMatchLevel(level: LevelData = ARENA_LEVEL, zone: ZoneSpec = ARENA_ZONE_SPEC): MatchLevel {
  return {
    mapId: "arena",
    name: level.name,
    killY: level.killY,
    zone,
    heightAt: null,
    isValidZoneCenter: null,
    planTeamSpawns(seed, teamCount, teamSize) {
      const planner = new SpawnPlanner(level.spawnPoints, seed, teamSize);
      const plans: TeamSpawnPlan[] = [];
      for (let team = 0; team < teamCount; team++) {
        const feet = [];
        let yaw = 0;
        for (let member = 0; member < teamSize; member++) {
          const s = planner.spawnFor(team * teamSize + member);
          feet.push(s.feet);
          yaw = s.yaw;
        }
        plans.push({ team, poiId: "arena", feet, yaw });
      }
      return plans;
    },
    createWorld: (havok) => createSimWorld(havok, level),
    loadMs: 0,
    source: "arena",
    createNav: () => ({ nav: arenaNav(level, zone), buildMs: 0, kind: "fake" }),
    createLoot: () => createTestLoot(level.spawnPoints),
  };
}

/** Blockout nav: open ground at the spawn height with the tall blocks' footprints as obstacles. */
function arenaNav(level: LevelData, zone: ZoneSpec): NavQuery {
  const boxes: FakeNavBox[] = [];
  const groundY = level.spawnPoints[0]?.position[1] ?? 0;
  for (const b of level.blocks) {
    if (b.kind !== "box" || b.surface === "ground" || b.position[1] - b.size[1] / 2 > groundY + 1.5 || b.position[1] + b.size[1] / 2 < groundY + 0.6) continue;
    const c = Math.abs(Math.cos(b.rotationY ?? 0));
    const sn = Math.abs(Math.sin(b.rotationY ?? 0));
    const hx = (b.size[0] * c + b.size[2] * sn) / 2;
    const hz = (b.size[0] * sn + b.size[2] * c) / 2;
    boxes.push({ minX: b.position[0] - hx, minZ: b.position[2] - hz, maxX: b.position[0] + hx, maxZ: b.position[2] + hz });
  }
  return new FakeNavQuery({ groundY, halfExtent: zone.initial.r, boxes });
}

/** A built map's data source: the `MapData` plus the terrain bake file name in the map assets directory. */
export interface ServerMapSource {
  readonly map: MapData;
  /** e.g. `mapV1.terrain.bin`; a missing or stale bake falls back to generating the terrain (slower boot). */
  readonly bakeFile: string | null;
}

export type ServerMapLoader = () => Promise<ServerMapSource>;

const MAP_LOADERS = new Map<string, ServerMapLoader>([
  ["v1", async () => ({ map: MAP_V1, bakeFile: "mapV1.terrain.bin" })],
  // The maze (shared/map/mazeBr.ts). Both maps are authored in `@twobullets/shared`, which this module already
  // imports, so neither needs the lazy module the real-world maps use. The bake file is the basename of the URL the
  // client loads (apps/client/src/world/mapRuntime/maps.ts), so both sides read the same terrain.
  [MAZE_BR.id, async () => ({ map: MAZE_BR, bakeFile: "mazebr.terrain.bin" })],
]);

/**
 * Adds (or replaces) a map id. Any `MapData` with a terrain spec, flatten list, POIs and spawns works. The real-world
 * registry (packages/shared/src/map/real) is registered below; its modules load on first use.
 */
export function registerServerMap(mapId: string, loader: ServerMapLoader): void {
  MAP_LOADERS.set(mapId, loader);
}

for (const entry of REAL_MAPS) {
  registerServerMap(entry.info.id, async () => ({ map: (await entry.load()).map, bakeFile: basename(entry.info.bakeUrl) }));
}

export function knownServerMapIds(): string[] {
  return ["arena", ...MAP_LOADERS.keys()];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Terrain bakes: `TB_MAP_ASSETS_DIR`, else the client's public assets in a checkout. */
export function mapAssetsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TB_MAP_ASSETS_DIR ? resolve(env.TB_MAP_ASSETS_DIR) : join(REPO_ROOT, "apps/client/public/assets/map");
}

interface LoadedMap {
  readonly map: MapData;
  readonly terrain: Terrain;
  readonly layout: MapLayout;
  readonly source: "bake" | "generated";
  readonly ms: number;
  readonly bakeProblem: string | null;
  /** Built on the first match that needs bots. */
  navGrid: NavGrid | null;
}

const loaded = new Map<string, Promise<LoadedMap>>();

async function loadMap(loader: ServerMapLoader, assetsDir: string): Promise<LoadedMap> {
  const started = performance.now();
  const { map, bakeFile } = await loader();
  let terrain: Terrain | null = null;
  let bakeProblem: string | null = null;
  if (bakeFile !== null) {
    const path = join(assetsDir, bakeFile);
    if (existsSync(path)) {
      const result = await decodeTerrainBake(new Uint8Array(readFileSync(path)), map.terrain, map.flatten);
      if (result.ok) terrain = result.terrain;
      else bakeProblem = `${path}: ${result.reason}`;
    } else {
      bakeProblem = `${path} not found`;
    }
  }
  const source = terrain ? "bake" : "generated";
  terrain ??= buildTerrain(map.terrain, map.flatten);
  const layout = buildMapLayout(map, terrain);
  return { map, terrain, layout, source, ms: performance.now() - started, bakeProblem, navGrid: null };
}

export interface ResolveLevelOptions {
  readonly assetsDir?: string;
  readonly log?: (line: string) => void;
}

/**
 * The level for a `MatchConfig.mapId`: `arena` (dev blockout) or a registered map (`v1`, the real-world ids). Rejects unknown ids. Map data
 * is cached per process, so a second call for the same map is instant.
 */
export async function resolveServerLevel(mapId: string, options: ResolveLevelOptions = {}): Promise<MatchLevel> {
  if (mapId === "arena") return arenaMatchLevel();
  const loader = MAP_LOADERS.get(mapId);
  if (loader === undefined) throw new Error(`unknown map "${mapId}" (server knows: ${knownServerMapIds().join(", ")})`);
  let pending = loaded.get(mapId);
  const first = pending === undefined;
  if (pending === undefined) {
    pending = loadMap(loader, options.assetsDir ?? mapAssetsDir());
    loaded.set(mapId, pending);
    pending.catch(() => loaded.delete(mapId));
  }
  const data = await pending;
  if (first && data.bakeProblem !== null) options.log?.(`[level] ${mapId}: terrain bake unusable (${data.bakeProblem}); generated instead`);
  const { map, terrain, layout } = data;
  const input = { terrain, layout };
  // True when this map has mirror panes or hedges a match can destroy (see createNav below).
  const destructible = buildDestructibleWalls(layout).count > 0;
  return {
    mapId,
    name: map.name,
    killY: map.bounds.killY,
    zone: zoneSpecForHalfExtent(map.terrain.playableHalfExtent, undefined, { centerBias: zoneCenterBiasForPois(map.pois) }),
    heightAt: (x, z) => terrain.sampleHeight(x, z),
    isValidZoneCenter: (x, z) => terrain.isPlayable(x, z) && terrain.slopeTanAt(x, z) < 0.7,
    planTeamSpawns: (seed, teamCount, teamSize) => planTeamSpawns(seed, teamCount, teamSize, map.pois, map.spawns, (x, z) => terrain.sampleHeight(x, z)),
    createWorld: (havok) => Promise.resolve(createMapSimWorld(havok, input)),
    loadMs: first ? data.ms : 0,
    source: data.source,
    createNav: () => {
      // A map whose walls can be destroyed gets a fresh grid per match: the match patches its own grid where a pane
      // was blown out, and a grid shared with later matches would leave them routing bots through walls that are
      // standing again. Costs one build (tens of ms) per match on those maps; every other map still caches.
      if (data.navGrid !== null && !destructible) return { nav: createNavQuery(data.navGrid), buildMs: 0, kind: "cached" };
      const started = performance.now();
      const grid = buildNavGrid({ map, terrain, layout });
      if (!destructible) data.navGrid = grid;
      return { nav: createNavQuery(grid), buildMs: performance.now() - started, kind: "grid" };
    },
    createLoot: (seed) => generateLoot(seed, map.pois, layout.buildings, { flatten: map.flatten, terrain, layout }).items,
  };
}
