import type { Vec3Tuple } from "../../level/types";
import { getBuildingPrefab, isBuildingPrefabId, type BuildingPrefabId } from "../buildings/prefabs";
import type { BuildingPrefab } from "../buildings/types";
import type { Terrain } from "../terrain/terrain";
import type { MapBuilding, MapData, Vec2Tuple } from "../types";
import { offsetPoint, type OrientedRect } from "./geometry";

/** Snapped floors sit this far above the highest terrain sample under a foundation, m. */
export const FLOOR_CLEARANCE = 0.1;
/** Prefabs without a foundation (containers) sit this close to the ground; their floor plate covers the rest. */
const PLATE_CLEARANCE = 0.02;
/** Base footprint sampling step for snapping and validation, m. */
const BASE_SAMPLE_STEP = 1;

/** Map building with layout extras. */
export interface LayoutBuilding extends MapBuilding {
  /** Id of an earlier building to stand on (stacked containers); Y becomes the top of that building. */
  readonly stackOn?: string;
}

export interface ResolvedBuilding {
  readonly id: string;
  readonly prefab: BuildingPrefabId;
  readonly poi?: string;
  /** Floor origin with Y resolved. */
  readonly position: Vec3Tuple;
  readonly yaw: number;
  /** Whole prefab (roofs and eaves included), for spacing tests. */
  readonly bounds: OrientedRect;
  /** The part that meets the ground (foundation, or the whole plan when the prefab has none). */
  readonly base: OrientedRect;
  /** How far below the floor the base reaches, m: terrain must stay between the floor and this depth. */
  readonly baseDepth: number;
  /** Building this one stands on, if stacked. */
  readonly stackOn?: string;
}

interface PrefabBase {
  readonly min: Vec2Tuple;
  readonly max: Vec2Tuple;
  /** How far below the floor the base hides terrain, m. */
  readonly depth: number;
  /** Floor height above the highest terrain under the base when snapped, m. */
  readonly clearance: number;
}

const baseCache = new Map<string, PrefabBase>();

/** Prefab-local XZ extent and depth of the parts below the floor (foundations); containers sit on their floor plate. */
export function prefabBase(prefab: BuildingPrefab): PrefabBase {
  let base = baseCache.get(prefab.id);
  if (base) return base;
  const below = prefab.parts.filter((part) => part.min[1] < 0);
  const parts = below.length > 0 ? below : prefab.parts.filter((part) => part.min[1] <= 0.01);
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  let depth = 0;
  for (const part of parts) {
    min[0] = Math.min(min[0], part.min[0]);
    min[1] = Math.min(min[1], part.min[2]);
    max[0] = Math.max(max[0], part.max[0]);
    max[1] = Math.max(max[1], part.max[2]);
    depth = Math.max(depth, -part.min[1]);
  }
  // Floor plates (containers) hide only a few centimeters of terrain.
  base = below.length > 0 ? { min, max, depth, clearance: FLOOR_CLEARANCE } : { min, max, depth: 0.1, clearance: PLATE_CLEARANCE };
  baseCache.set(prefab.id, base);
  return base;
}

function localRect(position: Vec2Tuple, yaw: number, min: Vec2Tuple, max: Vec2Tuple): OrientedRect {
  const center = offsetPoint(position, yaw, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2);
  return { center, halfExtents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2], yaw };
}

/** Calls `visit` for world XZ sample points covering a rect (edges included) about every `step` meters. */
export function forEachRectSample(rect: OrientedRect, step: number, visit: (x: number, z: number) => void): void {
  const [hx, hz] = rect.halfExtents;
  const nx = Math.max(1, Math.ceil((2 * hx) / step));
  const nz = Math.max(1, Math.ceil((2 * hz) / step));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const [x, z] = offsetPoint(rect.center, rect.yaw, -hx + (2 * hx * i) / nx, -hz + (2 * hz * j) / nz);
      visit(x, z);
    }
  }
}

/** Highest and lowest terrain under a building's base. */
export function terrainRangeUnder(terrain: Terrain, base: OrientedRect): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  forEachRectSample(base, BASE_SAMPLE_STEP, (x, z) => {
    const h = terrain.sampleHeight(x, z);
    if (h < min) min = h;
    if (h > max) max = h;
  });
  return { min, max };
}

/** Resolves one building; `resolved` holds earlier buildings by id (for `stackOn`). */
export function resolveBuilding(building: LayoutBuilding, terrain: Terrain, resolved: ReadonlyMap<string, ResolvedBuilding> = new Map()): ResolvedBuilding {
  if (!isBuildingPrefabId(building.prefab)) throw new Error(`Building "${building.id}" uses unknown prefab "${building.prefab}"`);
  const prefab = getBuildingPrefab(building.prefab);
  const xz: Vec2Tuple = [building.position[0], building.position[2]];
  const base = prefabBase(prefab);
  const baseRect = localRect(xz, building.yaw, base.min, base.max);
  let y = building.position[1];
  if (building.stackOn) {
    const below = resolved.get(building.stackOn);
    if (!below) throw new Error(`Building "${building.id}" stacks on "${building.stackOn}", which isn't placed before it`);
    y = below.position[1] + getBuildingPrefab(below.prefab).bounds.max[1];
  } else if (building.snapToTerrain) {
    y = terrainRangeUnder(terrain, baseRect).max + base.clearance;
  }
  return {
    id: building.id,
    prefab: building.prefab,
    ...(building.poi ? { poi: building.poi } : {}),
    position: [building.position[0], Math.round(y * 1000) / 1000, building.position[2]],
    yaw: building.yaw,
    bounds: localRect(xz, building.yaw, [prefab.bounds.min[0], prefab.bounds.min[2]], [prefab.bounds.max[0], prefab.bounds.max[2]]),
    base: baseRect,
    baseDepth: base.depth,
    ...(building.stackOn ? { stackOn: building.stackOn } : {}),
  };
}

export function resolveBuildings(map: Pick<MapData, "buildings">, terrain: Terrain): ResolvedBuilding[] {
  const byId = new Map<string, ResolvedBuilding>();
  return map.buildings.map((building) => {
    const resolved = resolveBuilding(building, terrain, byId);
    byId.set(resolved.id, resolved);
    return resolved;
  });
}
