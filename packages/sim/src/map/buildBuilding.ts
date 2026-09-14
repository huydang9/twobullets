import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Vec3Tuple } from "@twobullets/shared/level/types";
import { getPrefabLootSpots, localToWorld, placedBounds } from "@twobullets/shared/map/buildings/placement";
import { getBuildingPrefab, type BuildingPrefabId } from "@twobullets/shared/map/buildings/prefabs/index";
import type { BuildingPlacement, BuildingPrefab, LootSpot } from "@twobullets/shared/map/buildings/types";
import { createBuildingBody } from "./buildingPhysics";

/** Render side of a building. The client implements this with batched meshes; headless servers pass nothing. */
export interface BuildingVisualHost {
  add(prefab: BuildingPrefab, placement: BuildingPlacement): BuildingVisualHandle;
}

export interface BuildingVisualHandle {
  /** Meshes drawing this building. With instancing they are shared with other placements of the same prefab. */
  readonly meshes: readonly AbstractMesh[];
  remove(): void;
}

export interface BuiltBuilding {
  readonly prefab: BuildingPrefab;
  readonly placement: BuildingPlacement;
  readonly node: TransformNode;
  readonly body: PhysicsBody;
  readonly meshes: readonly AbstractMesh[];
  /** Loot spots in world space. Rooms stay prefab-local on `prefab.rooms`; map them with `toWorld`. */
  readonly lootSpots: readonly LootSpot[];
  readonly bounds: { readonly min: Vec3Tuple; readonly max: Vec3Tuple };
  toWorld(local: Vec3Tuple): Vec3Tuple;
  dispose(): void;
}

/**
 * Places a prefab: a static compound Havok body (shape shared per prefab), optional visuals, and world-space metadata.
 * Requires physics to be enabled on the scene.
 */
export function buildBuilding(scene: Scene, prefabId: BuildingPrefabId, placement: BuildingPlacement, visuals?: BuildingVisualHost): BuiltBuilding {
  const prefab = getBuildingPrefab(prefabId);
  const { node, body } = createBuildingBody(scene, prefabId, placement);
  const handle = visuals?.add(prefab, placement);
  const toWorld = (local: Vec3Tuple) => localToWorld(placement, local);
  return {
    prefab,
    placement,
    node,
    body,
    meshes: handle?.meshes ?? [],
    lootSpots: getPrefabLootSpots(prefabId).map((spot) => ({ roomId: spot.roomId, position: toWorld(spot.position) })),
    bounds: placedBounds(prefab, placement),
    toWorld,
    dispose() {
      handle?.remove();
      body.dispose();
      node.dispose();
    },
  };
}
