import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { buildMapLayout } from "@twobullets/shared/map/layout/mapLayout";
import { decodeTerrainBake } from "@twobullets/shared/map/terrain/bake";
import { buildTerrain, type Terrain } from "@twobullets/shared/map/terrain/terrain";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNavGrid, createNavQuery, isValidZoneCenter } from "@twobullets/shared/bots/nav/index";
import type { NavGrid, NavQuery } from "@twobullets/shared/bots/types";
import type { MapCollisionInput } from "../../src/map/mapCollision";

// Node loader for Map v1 (tests and tools/bench/bots): the committed terrain bake when it's current, else generated.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const BAKE = join(REPO_ROOT, "apps/client/public/assets/map/mapV1.terrain.bin");

let cached: Promise<MapCollisionInput & { readonly source: "bake" | "generated"; readonly ms: number }> | null = null;

export function loadMapV1(): Promise<MapCollisionInput & { readonly source: "bake" | "generated"; readonly ms: number }> {
  cached ??= (async () => {
    const started = performance.now();
    let terrain: Terrain | null = null;
    if (existsSync(BAKE)) {
      const result = await decodeTerrainBake(new Uint8Array(readFileSync(BAKE)), MAP_V1.terrain, MAP_V1.flatten);
      if (result.ok) terrain = result.terrain;
    }
    const source = terrain ? "bake" : "generated";
    terrain ??= buildTerrain(MAP_V1.terrain, MAP_V1.flatten);
    const layout = buildMapLayout(MAP_V1, terrain);
    return { terrain, layout, source, ms: performance.now() - started };
  })();
  return cached;
}

let navGrid: Promise<{ readonly grid: NavGrid; readonly ms: number }> | null = null;

/** Map v1 nav grid, built once per process (~0.6 s, 17 MB). */
export function loadMapV1NavGrid(): Promise<{ readonly grid: NavGrid; readonly ms: number }> {
  navGrid ??= loadMapV1().then((map) => {
    const started = performance.now();
    const grid = buildNavGrid({ map: MAP_V1, terrain: map.terrain, layout: map.layout });
    return { grid, ms: performance.now() - started };
  });
  return navGrid;
}

/** A fresh NavQuery on the shared grid (each holds ~5 MB of search scratch and its own 64 path handles). */
export async function createMapV1Nav(): Promise<{ readonly nav: NavQuery; readonly isValidZoneCenter: (x: number, z: number) => boolean }> {
  const { grid } = await loadMapV1NavGrid();
  return { nav: createNavQuery(grid), isValidZoneCenter: isValidZoneCenter(grid) };
}
