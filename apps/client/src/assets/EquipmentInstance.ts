import { Mesh, VertexBuffer, VertexData, type AbstractMesh, type AnimationGroup, type AssetContainer, type Scene, type Skeleton, type TransformNode } from "@babylonjs/core";
import type { EquipmentAsset, EquipmentModelId, EquipmentPartRole, ThrowArmsAsset, ThrowArmsClipName, ThrowArmsNodeRole } from "./equipmentManifest";
import { instantiate, type Instantiated } from "./instantiate";

/**
 * One equipment model (throwable, consumable or gear) with its parts as separate nodes. `root` is the loader root (it
 * carries the glTF → left-handed conversion); parent it or a node above it, never the part nodes to other rigs.
 */
export class EquipmentModelInstance {
  readonly id: EquipmentModelId;
  readonly asset: EquipmentAsset;
  readonly root: TransformNode;
  /** The item-space node (origin at the body centre, +Y up). */
  readonly item: TransformNode;
  readonly parts: Readonly<Partial<Record<EquipmentPartRole, TransformNode>>> & { readonly body: TransformNode };
  readonly meshes: readonly AbstractMesh[];
  private readonly entries: Instantiated;

  constructor(id: EquipmentModelId, asset: EquipmentAsset, container: AssetContainer) {
    this.id = id;
    this.asset = asset;
    this.entries = instantiate(container);
    this.root = this.entries.root;
    this.meshes = this.entries.meshes;
    this.item = this.entries.node(asset.nodes.root);
    const parts: Partial<Record<EquipmentPartRole, TransformNode>> = {};
    for (const role of ["body", "spoon", "ring"] as const) {
      const name = asset.nodes[role];
      if (name) parts[role] = this.entries.node(name);
    }
    this.parts = parts as EquipmentModelInstance["parts"];
  }

  /** Meshes under one part (a glTF node with several primitives becomes a TransformNode with child meshes). */
  partMeshes(role: EquipmentPartRole): AbstractMesh[] {
    const part = this.parts[role];
    if (!part) return [];
    const own = part.getClassName() === "Mesh" ? [part as unknown as AbstractMesh] : [];
    return [...own, ...part.getChildMeshes(false)].filter((m) => m.getTotalVertices() > 0);
  }

  setEnabled(enabled: boolean): void {
    this.root.setEnabled(enabled);
  }

  dispose(): void {
    this.entries.dispose();
  }
}

/**
 * First-person throwing arms. The single baked clip is posed by source frame (fractional frames interpolate), so the
 * caller maps its own throw timeline onto the clip ranges; nothing plays on its own.
 */
export class ThrowArmsInstance {
  readonly asset: ThrowArmsAsset;
  readonly root: TransformNode;
  readonly meshes: readonly AbstractMesh[];
  readonly skeleton: Skeleton | null;
  readonly animation: AnimationGroup;
  readonly nodes: Readonly<Record<ThrowArmsNodeRole, TransformNode>>;
  private readonly entries: Instantiated;
  private readonly frameScale: number;
  private started = false;

  constructor(asset: ThrowArmsAsset, container: AssetContainer) {
    this.asset = asset;
    this.entries = instantiate(container);
    this.root = this.entries.root;
    this.meshes = this.entries.meshes;
    this.skeleton = this.entries.skeletons[0] ?? null;
    const animation = this.entries.animationGroups.find((g) => g.name === asset.animation);
    if (!animation) throw new Error(`Throw arms: animation "${asset.animation}" missing`);
    this.animation = animation;
    const nodes: Partial<Record<ThrowArmsNodeRole, TransformNode>> = {};
    for (const [role, name] of Object.entries(asset.nodes) as [ThrowArmsNodeRole, string][]) nodes[role] = this.entries.node(name);
    this.nodes = nodes as Record<ThrowArmsNodeRole, TransformNode>;
    // Babylon's glTF loader keys animations at its own frame rate (60), not the source fps.
    this.frameScale = (animation.targetedAnimations[0]?.animation.framePerSecond ?? asset.fps) / asset.fps;
  }

  /** Source frame at `t` (0..1) through a clip. */
  clipFrame(clip: ThrowArmsClipName, t: number): number {
    const [start, end] = this.asset.clips[clip];
    return start + (end - start) * Math.min(1, Math.max(0, t));
  }

  /** Poses the arms on a (fractional) source frame. The group is started once and stays paused. */
  pose(frame: number): void {
    const f = Math.min(this.asset.lastFrame, Math.max(0, frame)) * this.frameScale;
    if (!this.started) {
      this.animation.start(false, 1, 0, this.asset.lastFrame * this.frameScale);
      this.animation.pause();
      this.started = true;
    }
    this.animation.goToFrame(f);
  }

  setEnabled(enabled: boolean): void {
    this.root.setEnabled(enabled);
  }

  dispose(): void {
    if (this.started) this.animation.stop(true);
    this.entries.dispose();
  }
}

const STATIC_ATTRIBUTES = [VertexBuffer.PositionKind, VertexBuffer.NormalKind, VertexBuffer.UVKind, VertexBuffer.TangentKind] as const;

/**
 * Bakes meshes into one static mesh (a sub-mesh per material): each part's current world matrix goes into the vertices,
 * including the loader's handedness flip (faces are re-wound), so keep the instance root at the origin and call
 * `computeWorldMatrices` first. Copies the vertex data: the result owns its geometry and shares the materials.
 */
export function bakeStaticMesh(parts: readonly AbstractMesh[], name: string, scene: Scene): Mesh | null {
  const meshes = parts.filter((part): part is Mesh => part instanceof Mesh && part.getTotalVertices() > 0);
  if (meshes.length === 0) return null;
  const kinds = STATIC_ATTRIBUTES.filter((kind) => meshes.every((mesh) => mesh.isVerticesDataPresent(kind)));
  const copies = meshes.map((part) => {
    const data = new VertexData();
    for (const kind of kinds) data.set(part.getVerticesData(kind, true, true)!, kind);
    data.indices = part.getIndices(true, true);
    data.transform(part.computeWorldMatrix(true));
    const copy = new Mesh(`${name}_part`, scene);
    data.applyToMesh(copy);
    copy.material = part.material;
    return copy;
  });
  const materials = new Set(meshes.map((mesh) => mesh.material));
  const merged = copies.length === 1 ? copies[0]! : Mesh.MergeMeshes(copies, true, true, undefined, false, materials.size > 1);
  if (!merged) return null;
  merged.name = name;
  merged.isPickable = false;
  return merged;
}

/** Recomputes world matrices down from `root` (after re-parenting or posing, before baking). */
export function computeWorldMatrices(root: TransformNode): void {
  root.computeWorldMatrix(true);
  for (const node of root.getDescendants(false) as TransformNode[]) node.computeWorldMatrix(true);
}
