import { distance, distanceToRect, round3 } from "../../layout/geometry";
import { getMapProp } from "../../layout/props";
import type { Terrain } from "../../terrain/terrain";
import type { MapSpawn, PointOfInterest, PropPlacement, Vec2Tuple } from "../../types";
import type { PlacedBuilding, PlacementSpace } from "./buildings";

/** Spawns per POI. */
export const SPAWNS_PER_POI = 2;
const MAX_SLOPE_TAN = 0.4; // ≈ 22°, validation allows 30°

export function spawnKey(x: number, z: number): string {
  return `${Math.round(x)},${Math.round(z)}`;
}

/**
 * Two spawns on each POI's outskirts (rings just outside its radius), facing its center, like Map v1. A spot must be
 * nearest to its own POI (spawn groups are assigned by nearest POI center), gentle, off roads and water, clear of
 * buildings and placed props, and not in `blocked` (spots a validation or reachability pass rejected).
 */
export function pickSpawns(
  pois: readonly PointOfInterest[],
  terrain: Terrain,
  buildings: readonly PlacedBuilding[],
  props: readonly PropPlacement[],
  space: PlacementSpace,
  blocked: ReadonlySet<string>,
  isolated: (x: number, z: number) => boolean = () => false,
): { spawns: MapSpawn[]; short: string[] } {
  const half = terrain.spec.playableHalfExtent;
  const collidable = props.filter((p) => getMapProp(p.prop).collision.kind !== "none");
  const spawns: MapSpawn[] = [];
  const short: string[] = [];
  pois.forEach((poi, index) => {
    const mine: Vec2Tuple[] = [];
    const start = (index * 47) % 360;
    for (const extra of [14, 24, 36, 50, 66]) {
      for (let step = 0; step < 16 && mine.length < SPAWNS_PER_POI; step++) {
        const degrees = start + step * 22.5;
        const a = (degrees * Math.PI) / 180;
        const r = poi.radius + extra;
        const x = round3(poi.center[0] + Math.cos(a) * r);
        const z = round3(poi.center[1] + Math.sin(a) * r);
        if (Math.abs(x) > half - 30 || Math.abs(z) > half - 30) continue;
        if (blocked.has(spawnKey(x, z)) || isolated(x, z)) continue;
        if (nearestPoi(pois, x, z) !== poi) continue;
        if (terrain.slopeTanAt(x, z) > MAX_SLOPE_TAN) continue;
        if (buildings.some((b) => distanceToRect(b.bounds, x, z) < 5)) continue;
        if (space.nearestPath(x, z, 4) !== null) continue;
        if (space.insideWater(x, z) || !space.clearOfWater({ center: [x, z], halfExtents: [0.5, 0.5], yaw: 0 }, 6)) continue;
        if (collidable.some((p) => distance(x, z, p.position[0], p.position[2]) < 4)) continue;
        if (mine.some(([sx, sz]) => distance(x, z, sx, sz) < 30)) continue;
        if (spawns.some((s) => distance(x, z, s.position[0], s.position[1]) < 20)) continue;
        mine.push([x, z]);
      }
      if (mine.length >= SPAWNS_PER_POI) break;
    }
    if (mine.length < SPAWNS_PER_POI) short.push(poi.id);
    for (const [x, z] of mine) spawns.push({ position: [x, z], yaw: round3(Math.atan2(poi.center[0] - x, poi.center[1] - z)) });
  });
  return { spawns, short };
}

function nearestPoi(pois: readonly PointOfInterest[], x: number, z: number): PointOfInterest | null {
  let best: PointOfInterest | null = null;
  let bestD = Infinity;
  for (const poi of pois) {
    const d = (poi.center[0] - x) * (poi.center[0] - x) + (poi.center[1] - z) * (poi.center[1] - z);
    if (d < bestD) [best, bestD] = [poi, d];
  }
  return best;
}
