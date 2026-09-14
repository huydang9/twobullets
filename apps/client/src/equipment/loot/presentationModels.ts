import { Matrix, type Mesh, type TransformNode } from "@babylonjs/core";
import { ITEMS, type ConsumableItemId, type ThrowableKind } from "@twobullets/shared";
import type { LootModelFactory } from "./lootModels";

/** The parts of the equipment presentation's ItemMeshLibrary (equipment/presentation/itemMeshes.ts) loot needs. */
export interface ItemMeshSource {
  /** Merged thrown model: +Y along the fuse axis, origin at the grip centre. */
  createWorldTemplate(kind: ThrowableKind): Mesh;
  /** Held model; consumables are a single body mesh under `root`. */
  createHeld(kind: ThrowableKind | ConsumableItemId): { readonly root: TransformNode; readonly meshes: readonly Mesh[] };
  /** A ready ground model from the real (downloaded) model, or null when only the procedural one exists. */
  createLootModel?(itemId: ThrowableKind | ConsumableItemId): Mesh | null;
}

/**
 * Ground models from the presentation's throwable and consumable meshes: the real models' own resting pose when they
 * loaded, else a private copy of the procedural mesh (own geometry, shared materials) laid down on the floor on its
 * flattest side (grenades and bottles on their side, kits flat).
 */
export function presentationLootModels(source: ItemMeshSource): LootModelFactory {
  return {
    createLootModel(itemId) {
      const real = source.createLootModel?.(itemId) ?? null;
      if (real) return real;
      let body: Mesh | null;
      let owner: { dispose(): void } | null;
      if (ITEMS[itemId].category === "throwable") {
        body = source.createWorldTemplate(itemId as ThrowableKind);
        owner = body;
      } else {
        const held = source.createHeld(itemId);
        held.root.computeWorldMatrix(true);
        body = held.meshes[0] ?? null;
        owner = held.root;
      }
      const copy = body?.clone(`loot_${itemId}_model`, null, true) ?? null;
      if (body && copy) {
        copy.parent = null;
        copy.makeGeometryUnique();
        copy.bakeTransformIntoVertices(body.computeWorldMatrix(true));
        copy.position.setAll(0);
        copy.rotationQuaternion = null;
        copy.rotation.setAll(0);
        copy.scaling.setAll(1);
        copy.isVisible = true;
        copy.refreshBoundingInfo();
        layDown(copy);
      }
      // The source copy was made for us; the loot renderer owns the laid-down one.
      owner?.dispose();
      return copy;
    },
  };
}

/** Rests the item on its flattest side (smallest extent becomes up), centred on the origin with its bottom at y = 0. */
function layDown(mesh: Mesh): void {
  const box = mesh.getBoundingInfo().boundingBox;
  const { x, y, z } = box.extendSize;
  const center = box.center;
  const toOrigin = Matrix.Translation(-center.x, -center.y, -center.z);
  const roll = x < y && x <= z ? Matrix.RotationZ(Math.PI / 2) : z < y ? Matrix.RotationX(Math.PI / 2) : Matrix.Identity();
  mesh.bakeTransformIntoVertices(toOrigin.multiply(roll));
  mesh.refreshBoundingInfo();
  mesh.bakeTransformIntoVertices(Matrix.Translation(0, -mesh.getBoundingInfo().boundingBox.minimum.y, 0));
  mesh.refreshBoundingInfo();
}
