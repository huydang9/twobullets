// Pure building kit: prefab data, collision, geometry and loot spots. No engine imports (see ./babylon for those).
export * from "./types";
export { KIT, PrefabBuilder, subtractRects, type Range, type OpeningSpec, type WallSpec, type ShellSpec, type SlabSpec, type FlightSpec, type GableRoofSpec } from "./kit";
export { BUILDING_PREFABS, BUILDING_PREFAB_IDS, getBuildingPrefab, isBuildingPrefabId, type BuildingPrefabId } from "./prefabs";
export { FACADE_COLORS, facadeColor, type FacadeColor } from "./palette";
export { buildPrefabGeometry, type GeometryOptions, type PrefabGeometry, type PrefabMeshGroup } from "./geometry";
export { PartBvh, boxesOverlap } from "./raycast";
export {
  getPrefabCollision,
  getPrefabLootSpots,
  localToWorld,
  placedBounds,
  prefabLevelBlocks,
  wedgeCorners,
  worldToLocal,
  type LootOptions,
} from "./placement";
