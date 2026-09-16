import { distanceToRect, type MapData, type MapLayout, type ResolvedBuilding, type Terrain, type Vec2Tuple } from "@twobullets/shared";

/** Standing eye height used by every ground viewpoint, m. */
export const BENCH_EYE_HEIGHT = 1.7;
/** Watchtower platform height above the building floor (prefabs/military.ts: three 3 m flights). */
const WATCHTOWER_PLATFORM = 9;
/** Look targets sit at chest height above the terrain, m. */
const TARGET_HEIGHT = 1.5;

export interface BenchViewpoint {
  readonly id: string;
  readonly label: string;
  /** Eye position, m. */
  readonly position: readonly [x: number, y: number, z: number];
  /** Camera yaw about +Y, radians; 0 looks along +Z (north). */
  readonly yaw: number;
  /** Camera pitch, radians; positive looks down. */
  readonly pitch: number;
  /** Surface the eye stands on: terrain, or a building floor. */
  readonly floorY: number;
  /** Building the viewpoint stands on, if any. */
  readonly building?: string;
}

interface Placement {
  readonly id: string;
  readonly label: string;
  /** Ground position, or a building to stand on with the floor height above its origin. */
  readonly at: Vec2Tuple | { readonly building: string; readonly floor: number };
  readonly lookAt: Vec2Tuple;
}

/**
 * The six fixed Map v1 benchmark viewpoints, resolved against the terrain and layout so they follow edits to the map:
 * a spawn field facing the Training Yard soldiers, a town street, the forest clearing, the radar watchtower looking
 * over the map, the military compound and the quarry rim.
 */
export function resolveBenchViewpoints(map: MapData, terrain: Terrain, layout: MapLayout): BenchViewpoint[] {
  const poi = (id: string): Vec2Tuple => {
    const found = map.pois.find((p) => p.id === id);
    if (!found) throw new Error(`Bench viewpoints: map ${map.id} has no POI "${id}"`);
    return found.center;
  };
  const offset = ([x, z]: Vec2Tuple, dx: number, dz: number): Vec2Tuple => [x + dx, z + dz];
  const town = poi("town");
  const training = poi("training");
  const spawn = [...map.spawns].sort((a, b) => distance2(a.position, training) - distance2(b.position, training))[0];
  if (!spawn) throw new Error(`Bench viewpoints: map ${map.id} has no spawns`);

  const placements: readonly Placement[] = [
    { id: "spawn", label: "Spawn field", at: spawn.position, lookAt: training },
    { id: "town", label: "Town street", at: offset(town, -45, 0), lookAt: offset(town, 80, 0) },
    { id: "forest", label: "Forest clearing", at: poi("forest"), lookAt: town },
    { id: "radar", label: "Radar tower top", at: { building: "radar_tower", floor: WATCHTOWER_PLATFORM }, lookAt: town },
    { id: "military", label: "Military compound", at: offset(poi("military"), -30, 6), lookAt: offset(poi("military"), 40, -12) },
    // The pit is terraced; its rim is ~22 m up, about 85 m from the center.
    { id: "quarry", label: "Quarry rim", at: offset(poi("quarry"), -62, 62), lookAt: poi("quarry") },
  ];

  const stand = (at: Placement["at"]) => {
    if (!("building" in at)) return { x: at[0], z: at[1], floorY: terrain.sampleHeight(at[0], at[1]), building: null };
    const building = findBuilding(layout, at.building);
    return { x: building.position[0], z: building.position[2], floorY: building.position[1] + at.floor, building };
  };

  return placements.map(({ id, label, at, lookAt }) => {
    const { x, z, floorY, building } = stand(at);
    const y = floorY + BENCH_EYE_HEIGHT;
    const [tx, tz] = lookAt;
    const ty = terrain.sampleHeight(tx, tz) + TARGET_HEIGHT;
    const horizontal = Math.hypot(tx - x, tz - z);
    return {
      id,
      label,
      position: [x, y, z],
      yaw: Math.atan2(tx - x, tz - z),
      pitch: Math.atan2(y - ty, horizontal),
      floorY,
      ...(building ? { building: building.id } : {}),
    };
  });
}

/** Problems with a viewpoint set: eyes below their floor or the terrain, or inside a building they don't stand on. */
export function validateBenchViewpoints(viewpoints: readonly BenchViewpoint[], terrain: Terrain, layout: MapLayout): string[] {
  const issues: string[] = [];
  for (const v of viewpoints) {
    const [x, y, z] = v.position;
    const ground = terrain.sampleHeight(x, z);
    if (!Number.isFinite(y)) issues.push(`${v.id}: eye height is not finite`);
    if (y < ground + BENCH_EYE_HEIGHT - 1e-3) issues.push(`${v.id}: eye ${y.toFixed(2)} is below terrain ${ground.toFixed(2)} + eye height`);
    if (y < v.floorY + BENCH_EYE_HEIGHT - 1e-3) issues.push(`${v.id}: eye ${y.toFixed(2)} is below its floor ${v.floorY.toFixed(2)}`);
    if (Math.abs(x) > terrain.field.size / 2 || Math.abs(z) > terrain.field.size / 2) issues.push(`${v.id}: outside the heightfield`);
    for (const building of layout.buildings) {
      if (building.id === v.building) continue;
      if (distanceToRect(building.bounds, x, z) <= 0.5) issues.push(`${v.id}: inside or against building ${building.id}`);
    }
  }
  return issues;
}

function findBuilding(layout: MapLayout, id: string): ResolvedBuilding {
  const building = layout.buildings.find((b) => b.id === id);
  if (!building) throw new Error(`Bench viewpoints: layout has no building "${id}"`);
  return building;
}

function distance2([ax, az]: Vec2Tuple, [bx, bz]: Vec2Tuple): number {
  return (ax - bx) ** 2 + (az - bz) ** 2;
}
