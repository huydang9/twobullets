import type { MapData, SpawnPoint, Terrain } from "@twobullets/shared";

/** Anything that can respawn at a given spawn point (PlayerController). */
export interface Respawnable {
  respawnAt(spawn: SpawnPoint): void;
}

/** The map's fixed spawns, used until the landing phase exists. `spawnPoints` is what the level hands the player. */
export class MapSpawns {
  readonly all: readonly SpawnPoint[];

  constructor(map: Pick<MapData, "spawns">, terrain: Terrain) {
    this.all = map.spawns.map(({ position: [x, z], yaw }) => ({ position: [x, terrain.sampleHeight(x, z), z], yaw }));
    if (this.all.length === 0) throw new Error("map has no spawns");
  }

  get spawnPoints(): readonly SpawnPoint[] {
    return this.all;
  }

  nearest(x: number, z: number): SpawnPoint {
    let best = this.all[0]!;
    let bestDistance = Infinity;
    for (const spawn of this.all) {
      const d = (spawn.position[0] - x) ** 2 + (spawn.position[2] - z) ** 2;
      if (d < bestDistance) [best, bestDistance] = [spawn, d];
    }
    return best;
  }

  /** Respawns at the spawn nearest (x, z). */
  respawnNear(player: Respawnable, x: number, z: number): SpawnPoint {
    const spawn = this.nearest(x, z);
    player.respawnAt(spawn);
    return spawn;
  }
}
