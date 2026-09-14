// Babylon-dependent building helpers (physics bodies, placement). Headless-safe: no materials, lights or textures.
export { buildBuilding, type BuildingVisualHandle, type BuildingVisualHost, type BuiltBuilding } from "./buildBuilding";
export { createBuildingBody, getBuildingShape, type BuildingBody } from "./buildingPhysics";
