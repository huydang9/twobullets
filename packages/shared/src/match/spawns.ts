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
/** Members per row at a spawn; larger teams stand in rows behind the first (away from the POI). */
export const TEAM_SPAWN_ROW = 2;
/** When a POI hosts more teams than it has spawns, later teams shift this far back from the reused spawn, m (25 keeps
 * two teams on one spawn more than 20 m apart on the 500 m maps). */
export const TEAM_SPAWN_STACK = 25;

/**
 * Teams spread over the POIs that hold validated spawns, in a seeded shuffle: team t gets POI `order[t % POIs]`, so POIs
 * are shared only when there are more teams than POIs, and teams sharing a POI take its different spawns (seeded start,
 * then the next one). Members stand `TEAM_SPAWN_SPACING` apart along the spawn's right vector, two per row with later
 * rows behind, facing the POI (design.md §12.3: "spawn at a POI with the bot teammate beside you"). With teams ≤ POIs
 * the plan is the same as the original one-POI-per-team plan. Throws when the map has no spawns.
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
  if (groups.length === 0 && teamCount > 0) throw new Error("spawn plan: map has no POIs with spawns");
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
    const round = Math.floor(team / groups.length);
    const lane = team % groups.length;
    const group = groups[order[lane]!]!;
    const count = group.spawns.length;
    const spawn = group.spawns[(hash32(seed, 0x5a4f, lane) + round) % count]!;
    const [sx, sz] = spawn.position;
    const rightX = Math.cos(spawn.yaw);
    const rightZ = -Math.sin(spawn.yaw);
    const forwardX = Math.sin(spawn.yaw);
    const forwardZ = Math.cos(spawn.yaw);
    const back = Math.floor(round / count) * TEAM_SPAWN_STACK;
    const feet = [];
    for (let member = 0; member < teamSize; member++) {
      const row = Math.floor(member / TEAM_SPAWN_ROW);
      const rowWidth = Math.min(TEAM_SPAWN_ROW, teamSize - row * TEAM_SPAWN_ROW);
      const offset = ((member % TEAM_SPAWN_ROW) - (rowWidth - 1) / 2) * TEAM_SPAWN_SPACING;
      const behind = back + row * TEAM_SPAWN_SPACING;
      const x = sx + rightX * offset - forwardX * behind;
      const z = sz + rightZ * offset - forwardZ * behind;
      feet.push({ x, y: heightAt(x, z), z });
    }
    plans.push({ team, poiId: group.poi.id, feet, yaw: spawn.yaw });
  }
  return plans;
}
