import type { AbstractMesh, PhysicsBody, Scene, TransformNode } from "@babylonjs/core";
import type { Vec3Tuple } from "../../../level/types";
import { getPrefabLootSpots, localToWorld, placedBounds } from "../placement";
import { getBuildingPrefab, type BuildingPrefabId } from "../prefabs";
import type { BuildingPlacement, BuildingPrefab, LootSpot } from "../types";
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
