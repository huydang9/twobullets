import type { BuildingPrefab } from "../types";
import { barn } from "./farm";
import { smallHouse, twoStoryHouse } from "./houses";
import { closedContainer, openContainer, radarStation, warehouse } from "./industrial";
import { barracks, guardBooth, watchtower } from "./military";
import { TUBE_HOUSES, TUBE_HOUSE_VARIANTS, tubeHouse } from "./tubeHouses";
import { BRIDGES, bridge } from "./bridges";
import { church, marketHall, pagoda, school } from "./vnCivic";
import { constructionSite, highrise, kiosk, officeTower, petrolStation, workshop } from "./vnCommercial";
import { apartmentBlock, boardingHouse, cafe, frenchShophouse, mezzanineTubeHouse, villa } from "./vnHouses";

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
  // Vietnamese city set (docs/map/buildings.md).
  ...TUBE_HOUSE_VARIANTS.map(tubeHouse),
  mezzanineTubeHouse(),
  frenchShophouse(),
  cafe(),
  villa(),
  boardingHouse(),
  apartmentBlock(),
  pagoda(),
  church(),
  school(),
  marketHall(),
  kiosk(),
  petrolStation(),
  workshop(),
  officeTower(),
  highrise(),
  constructionSite(),
  ...BRIDGES.map(bridge),
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
  | "tube_house_4"
  | "tube_house_narrow"
  | "tube_house_wide"
  | "tube_house_planters"
  | "tube_house_shed"
  | "tube_house_mezzanine"
  | "shophouse_french"
  | "cafe_terrace"
  | "villa"
  | "boarding_house"
  | "apartment_block"
  | "pagoda"
  | "church"
  | "school"
  | "market_hall"
  | "shop_kiosk"
  | "petrol_station"
  | "workshop"
  | "office_tower"
  | "highrise_apartment"
  | "construction_site"
  | "bridge_lane_16"
  | "bridge_lane_80"
  | "bridge_road_24"
  | "bridge_road_40";

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
