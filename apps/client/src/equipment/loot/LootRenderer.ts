import { Color3, Matrix, PBRMaterial, Quaternion, Vector3, type Camera, type HemisphericLight, type Mesh, type Scene } from "@babylonjs/core";
import { ITEMS, forEachGroundLoot, type GroundLoot, type ItemId, type LootItem } from "@twobullets/shared";
import type { AssetLibrary } from "../../assets";
import type { EquipmentView } from "../types";
import { createLootTemplate, usesLootMaterial, type LootModelFactory } from "./lootModels";

export interface LootRendererOptions {
  /** Weapon GLBs for gun-body ground models; boxes without it (headless). */
  readonly assets?: AssetLibrary | null;
  /** Throwable and consumable models from the equipment presentation. */
  readonly models?: LootModelFactory | null;
  /** PBR loot is lit by the IBL; it is excluded from this hemispheric fill (environment.skyFill). */
  readonly skyFill?: HemisphericLight | null;
}

export const LOOT_RENDER = {
  /** Items beyond this distance from the camera aren't drawn, m. */
  drawDistance: 70,
  /** Small items (ammo, meds, grenades) disappear sooner, m. */
  smallItemDrawDistance: 40,
  /** Instance buffers are rebuilt when the camera has moved this far since the last rebuild, m. */
  rebuildMoveDistance: 4,
  /** Items in a pile share a yaw with this much jitter each, radians (±). */
  yawJitter: 0.35,
  /** Lift above the floor so flat undersides don't z-fight with it, m. */
  floorLift: 0.004,
  highlight: { color: new Color3(1, 0.93, 0.75), width: 0.006 },
} as const;

const SMALL_CATEGORIES: ReadonlySet<string> = new Set(["ammo", "throwable", "heal", "boost"]);
const ZERO_MATRIX = Matrix.Zero();

/** One item id's template, drawn as thin instances, plus a regular clone for the highlighted item. */
interface Batch {
  readonly mesh: Mesh;
  readonly highlight: Mesh;
  readonly small: boolean;
  matrices: Float32Array;
  /** The array the GPU buffer was created from; rebuilds that keep it update the buffer in place. */
  uploaded: Float32Array | null;
  count: number;
  /** Loot id per instance index, for hiding the highlighted instance. */
  readonly lootIds: number[];
}

/**
 * Ground loot as thin instances: one batch (template mesh) per item id, so Map v1's ~2,300 items (loot table v3, with
 * outdoor piles) cost at most one draw call per item id in view (about 30). Only items near the camera are in the
 * buffers; they are rebuilt without allocating (buffers grow by doubling, then stay) when the ground loot changes
 * (`groundLoot.version`) or the camera has moved a few meters. The item the interaction would pick up
 * (`lootTarget`) is drawn as a separate outlined copy, with its instance hidden.
 */
export class LootRenderer {
  private readonly batches = new Map<ItemId, Batch>();
  private readonly material: PBRMaterial;
  private readonly lastCenter = new Vector3(Infinity, Infinity, Infinity);
  private readonly matrix = new Matrix();
  private readonly rotation = new Quaternion();
  private readonly translation = new Vector3();
  private version = -1;
  private highlighted: { batch: Batch; index: number; item: LootItem } | null = null;
  private highlightedLootId = -1;
  private drawn = 0;
  /** Counts from the last rebuild (DEV stats). */
  readonly stats = { items: 0, drawn: 0, batches: 0, rebuilds: 0 };

  constructor(
    private readonly scene: Scene,
    private readonly equipment: EquipmentView,
    private readonly options: LootRendererOptions = {},
  ) {
    this.material = new PBRMaterial("lootMaterial", scene);
    this.material.albedoColor = Color3.White();
    this.material.metallic = 0;
    this.material.roughness = 0.8;
  }

  /** Per render frame (after equipment.update). */
  update(): void {
    const ground = this.equipment.groundLoot;
    const camera = this.scene.activeCameras?.[0] ?? this.scene.activeCamera;
    if (!ground || !camera) return;
    const center = (camera as Camera).globalPosition;
    const moved = Vector3.DistanceSquared(center, this.lastCenter) > LOOT_RENDER.rebuildMoveDistance ** 2;
    if (moved || ground.version !== this.version) {
      this.version = ground.version;
      this.lastCenter.copyFrom(center);
      this.rebuild(ground, center);
    }
    this.updateHighlight(this.equipment.lootTarget);
  }

  dispose(): void {
    for (const batch of this.batches.values()) {
      const material = batch.mesh.material;
      batch.highlight.dispose();
      batch.mesh.dispose();
      // Merged guns own a MultiMaterial that only references the weapon templates' materials.
      if (material?.getClassName() === "MultiMaterial") material.dispose();
    }
    this.batches.clear();
    this.material.dispose();
  }

  private rebuild(ground: GroundLoot, center: Vector3): void {
    this.restoreHighlighted();
    for (const batch of this.batches.values()) {
      batch.count = 0;
      batch.lootIds.length = 0;
    }
    this.drawn = 0;
    forEachGroundLoot(ground, center, LOOT_RENDER.drawDistance, this.addItem);
    for (const batch of this.batches.values()) {
      batch.mesh.setEnabled(batch.count > 0);
      if (batch.count === 0) continue;
      if (batch.uploaded !== batch.matrices) {
        // New or grown array: a new dynamic GPU buffer. Otherwise the existing one is rewritten in place.
        batch.mesh.thinInstanceSetBuffer("matrix", batch.matrices, 16, false);
        batch.uploaded = batch.matrices;
        batch.mesh.thinInstanceCount = batch.count;
      } else {
        batch.mesh.thinInstanceCount = batch.count;
        batch.mesh.thinInstanceBufferUpdated("matrix");
      }
      batch.mesh.thinInstanceRefreshBoundingInfo(false);
    }
    this.highlightedLootId = -1;
    const stats = this.stats;
    stats.items = ground.items.size;
    stats.drawn = this.drawn;
    stats.batches = this.batches.size;
    stats.rebuilds++;
  }

  /** Adds one item in draw range to its batch (small items only within `smallItemDrawDistance`). */
  private readonly addItem = (item: LootItem): void => {
    const batch = this.batchFor(item.itemId);
    const center = this.lastCenter;
    const [x, y, z] = item.position;
    if (batch.small && (x - center.x) ** 2 + (y - center.y) ** 2 + (z - center.z) ** 2 > LOOT_RENDER.smallItemDrawDistance ** 2) return;
    this.itemMatrix(item, this.matrix);
    if ((batch.count + 1) * 16 > batch.matrices.length) {
      const grown = new Float32Array(batch.matrices.length * 2);
      grown.set(batch.matrices);
      batch.matrices = grown;
    }
    this.matrix.copyToArray(batch.matrices, batch.count * 16);
    batch.lootIds.push(item.lootId);
    batch.count++;
    this.drawn++;
  };

  private updateHighlight(target: LootItem | null): void {
    const lootId = target?.lootId ?? -1;
    if (lootId === this.highlightedLootId) return;
    this.restoreHighlighted();
    this.highlightedLootId = lootId;
    if (!target) return;
    const batch = this.batches.get(target.itemId);
    const index = batch?.lootIds.indexOf(lootId) ?? -1;
    if (!batch || index < 0) return;
    batch.mesh.thinInstanceSetMatrixAt(index, ZERO_MATRIX, true);
    this.itemMatrix(target, this.matrix);
    this.matrix.decompose(undefined, this.rotation, this.translation);
    const highlight = batch.highlight;
    highlight.position.copyFrom(this.translation);
    (highlight.rotationQuaternion ??= new Quaternion()).copyFrom(this.rotation);
    highlight.setEnabled(true);
    this.highlighted = { batch, index, item: target };
  }

  private restoreHighlighted(): void {
    const current = this.highlighted;
    if (!current) return;
    this.highlighted = null;
    current.batch.highlight.setEnabled(false);
    if (current.batch.lootIds[current.index] !== current.item.lootId) return;
    // The hidden instance's slot in the buffer was zeroed; put its matrix back.
    current.batch.mesh.thinInstanceSetMatrixAt(current.index, this.itemMatrix(current.item, this.matrix), true);
  }

  /** Floor position plus a yaw shared by the pile, with a little per-item jitter (deterministic per loot id). */
  private itemMatrix(item: LootItem, out: Matrix): Matrix {
    const pile = item.pileId >= 0 ? unitHash(item.pileId, 0x10075) : unitHash(item.lootId, 0x10076);
    const yaw = pile * Math.PI * 2 + (unitHash(item.lootId, 0x10077) - 0.5) * 2 * LOOT_RENDER.yawJitter;
    Quaternion.RotationYawPitchRollToRef(yaw, 0, 0, this.rotation);
    this.translation.set(item.position[0], item.position[1] + LOOT_RENDER.floorLift, item.position[2]);
    return Matrix.ComposeToRef(Vector3.OneReadOnly, this.rotation, this.translation, out);
  }

  private batchFor(itemId: ItemId): Batch {
    let batch = this.batches.get(itemId);
    if (batch) return batch;
    const mesh = createLootTemplate(itemId, this.scene, this.options);
    if (usesLootMaterial(mesh)) mesh.material = this.material;
    mesh.receiveShadows = true;
    mesh.alwaysSelectAsActiveMesh = false;
    this.options.skyFill?.excludedMeshes.push(mesh);

    // Cloned before thin instances exist, so the copy is a plain single mesh sharing geometry and materials.
    const highlight = mesh.clone(`${mesh.name}_highlight`, null, true)!;
    highlight.renderOutline = true;
    highlight.outlineColor = LOOT_RENDER.highlight.color;
    highlight.outlineWidth = LOOT_RENDER.highlight.width;
    highlight.receiveShadows = true;
    highlight.setEnabled(false);
    this.options.skyFill?.excludedMeshes.push(highlight);

    batch = { mesh, highlight, small: SMALL_CATEGORIES.has(ITEMS[itemId].category), matrices: new Float32Array(16 * 8), uploaded: null, count: 0, lootIds: [] };
    this.batches.set(itemId, batch);
    return batch;
  }
}

/** Deterministic 0..1 from an integer (splitmix32-style finalizer). */
function unitHash(value: number, salt: number): number {
  let h = Math.imul(value ^ salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
