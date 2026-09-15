import type { BuildingPrefab } from "../types";
import { barn } from "./farm";
import { smallHouse, twoStoryHouse } from "./houses";
import { closedContainer, openContainer, radarStation, warehouse } from "./industrial";
import { barracks, guardBooth, watchtower } from "./military";
import { TUBE_HOUSES, tubeHouse } from "./tubeHouses";

const PREFABS = [
  smallHouse(false),
  smallHouse(true),
  twoStoryHouse(),
  barn(),
  warehouse(),
  barracks(),
  watchtower(),
  guardBooth(),
  radarStation(),
  openContainer("container_open", "Container (open, red)", "containerRed"),
  openContainer("container_open_blue", "Container (open, blue)", "containerBlue"),
  closedContainer(),
  ...TUBE_HOUSES.map(tubeHouse),
] as const satisfies readonly BuildingPrefab[];

export type BuildingPrefabId =
  | "house_small"
  | "house_small_ruined"
  | "house_two_story"
  | "barn"
  | "warehouse"
  | "barracks"
  | "watchtower"
  | "guard_booth"
  | "radar_station"
  | "container_open"
  | "container_open_blue"
  | "container_closed"
  | "tube_house_2"
  | "tube_house_3"
  | "tube_house_4";

export const BUILDING_PREFABS: ReadonlyMap<BuildingPrefabId, BuildingPrefab> = new Map(PREFABS.map((p) => [p.id as BuildingPrefabId, p]));

export const BUILDING_PREFAB_IDS: readonly BuildingPrefabId[] = [...BUILDING_PREFABS.keys()];

/** Narrows a MapBuilding.prefab string to a known prefab id. */
export function isBuildingPrefabId(id: string): id is BuildingPrefabId {
  return BUILDING_PREFABS.has(id as BuildingPrefabId);
}

export function getBuildingPrefab(id: BuildingPrefabId): BuildingPrefab {
  const prefab = BUILDING_PREFABS.get(id);
  if (!prefab) throw new Error(`Unknown building prefab "${id}"`);
  return prefab;
}
