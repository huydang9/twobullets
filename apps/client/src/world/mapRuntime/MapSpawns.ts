import type { MapData, SpawnPoint, Terrain } from "@twobullets/shared";

/** Anything that can respawn from a level's spawn list (PlayerController). */
export interface Respawnable {
  respawn(): void;
}

/**
 * The map's fixed spawns, used until the landing phase exists. `spawnPoints` is what the level hands the player: every
 * spawn (PlayerController picks one at random), or just one while `respawnNear` forces the nearest.
 */
export class MapSpawns {
  readonly all: readonly SpawnPoint[];
  private forced: readonly SpawnPoint[] | null = null;

  constructor(map: Pick<MapData, "spawns">, terrain: Terrain) {
    this.all = map.spawns.map(({ position: [x, z], yaw }) => ({ position: [x, terrain.sampleHeight(x, z), z], yaw }));
    if (this.all.length === 0) throw new Error("map has no spawns");
  }

  get spawnPoints(): readonly SpawnPoint[] {
    return this.forced ?? this.all;
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

  /**
   * Respawns at the spawn nearest (x, z). PlayerController only knows random respawns from its level, so the level's
   * spawn list narrows to one point for the call. Replace with a direct `respawnAt` once the player exposes one.
   */
  respawnNear(player: Respawnable, x: number, z: number): SpawnPoint {
    const spawn = this.nearest(x, z);
    this.forced = [spawn];
    try {
      player.respawn();
    } finally {
      this.forced = null;
    }
    return spawn;
  }
}
