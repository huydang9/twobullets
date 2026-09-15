/** Map v1 or a generated real-world map with its terrain and layout, without Havok (nav benches). */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapLayout } from "@twobullets/shared/map/layout/mapLayout";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { loadRealMap } from "@twobullets/shared/map/real/index";
import { decodeTerrainBake } from "@twobullets/shared/map/terrain/bake";
import { buildTerrain, type Terrain } from "@twobullets/shared/map/terrain/terrain";
import type { MapData } from "@twobullets/shared/map/types";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

export interface LoadedMap {
  readonly map: MapData;
  readonly terrain: Terrain;
  readonly layout: ReturnType<typeof buildMapLayout>;
  readonly source: "bake" | "generated";
}

const loaded = new Map<string, Promise<LoadedMap>>();

/** Map v1 or a generated real-world map, with terrain from its bake (or generated when the bake is stale). */
export function loadMap(id: string): Promise<LoadedMap> {
  let promise = loaded.get(id);
  if (!promise) {
    promise = (async () => {
      const map = id === "v1" ? MAP_V1 : (await loadRealMap(id)).map;
      const bakePath = join(REPO_ROOT, `apps/client/public/assets/map/${id === "v1" ? "mapV1" : id}.terrain.bin`);
      let terrain: Terrain | null = null;
      if (existsSync(bakePath)) {
        const result = await decodeTerrainBake(new Uint8Array(readFileSync(bakePath)), map.terrain, map.flatten);
        if (result.ok) terrain = result.terrain;
      }
      const source = terrain ? "bake" : "generated";
      terrain ??= buildTerrain(map.terrain, map.flatten);
      return { map, terrain, layout: buildMapLayout(map, terrain), source };
    })();
    loaded.set(id, promise);
  }
  return promise;
}

