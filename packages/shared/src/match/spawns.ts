import { hash32 } from "../equipment/math";
import type { MapSpawn, PointOfInterest } from "../map/types";
import type { TeamSpawnPlan } from "./types";

// Offline spawn plan (docs/bots/design.md §8.1): until landing select exists, each team starts on the validated map
// spawns of its own seeded POI. Pure; heights come from an injected terrain sampler.

/** A map spawn assigned to the POI it belongs to (the nearest POI center). */
export interface PoiSpawns {
  readonly poi: PointOfInterest;
  readonly spawns: readonly MapSpawn[];
}

/** Groups map spawns by nearest POI; POIs without spawns and `training` are left out. POI order is kept. */
export function spawnsByPoi(pois: readonly PointOfInterest[], spawns: readonly MapSpawn[], excludeKinds: readonly PointOfInterest["kind"][] = ["training"]): PoiSpawns[] {
  const buckets = new Map<string, MapSpawn[]>();
  for (const spawn of spawns) {
    const [x, z] = spawn.position;
    let best: PointOfInterest | null = null;
    let bestD = Infinity;
    for (const poi of pois) {
      const dx = poi.center[0] - x;
      const dz = poi.center[1] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = poi;
      }
    }
    if (!best || excludeKinds.includes(best.kind)) continue;
    let bucket = buckets.get(best.id);
    if (!bucket) buckets.set(best.id, (bucket = []));
    bucket.push(spawn);
  }
  return pois.filter((poi) => buckets.has(poi.id)).map((poi) => ({ poi, spawns: buckets.get(poi.id)! }));
}

/** Side-by-side spacing of a team's members at its spawn, m. */
export const TEAM_SPAWN_SPACING = 2;

/**
 * One distinct POI per team, chosen by a seeded shuffle of the POIs that hold validated spawns. The team starts on one
 * of that POI's spawns (seeded), members side by side `TEAM_SPAWN_SPACING` apart along the spawn's right vector, facing
 * the POI (design.md §12.3: "spawn at a POI with the bot teammate beside you"). Throws when there are fewer eligible POIs
 * than teams.
 */
export function planTeamSpawns(
  seed: number,
  teamCount: number,
  teamSize: number,
  pois: readonly PointOfInterest[],
  spawns: readonly MapSpawn[],
  heightAt: (x: number, z: number) => number,
): TeamSpawnPlan[] {
  const groups = spawnsByPoi(pois, spawns).filter((g) => g.spawns.length > 0);
  if (groups.length < teamCount) throw new Error(`spawn plan: ${teamCount} teams need ${teamCount} POIs with spawns, map has ${groups.length}`);
  // Fisher–Yates with counter-seeded draws.
  const order = groups.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = hash32(seed, 0x5a4e, i) % (i + 1);
    const t = order[i]!;
    order[i] = order[j]!;
    order[j] = t;
  }
  const plans: TeamSpawnPlan[] = [];
  for (let team = 0; team < teamCount; team++) {
    const group = groups[order[team]!]!;
    const spawn = group.spawns[hash32(seed, 0x5a4f, team) % group.spawns.length]!;
    const [sx, sz] = spawn.position;
    const rightX = Math.cos(spawn.yaw);
    const rightZ = -Math.sin(spawn.yaw);
    const feet = [];
    for (let member = 0; member < teamSize; member++) {
      const offset = (member - (teamSize - 1) / 2) * TEAM_SPAWN_SPACING;
      const x = sx + rightX * offset;
      const z = sz + rightZ * offset;
      feet.push({ x, y: heightAt(x, z), z });
    }
    plans.push({ team, poiId: group.poi.id, feet, yaw: spawn.yaw });
  }
  return plans;
}
