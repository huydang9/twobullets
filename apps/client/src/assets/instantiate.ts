import type { AbstractMesh, AnimationGroup, AssetContainer, Skeleton, TransformNode } from "@babylonjs/core";

export interface Instantiated {
  readonly root: TransformNode;
  readonly meshes: AbstractMesh[];
  readonly skeletons: Skeleton[];
  readonly animationGroups: AnimationGroup[];
  /** Finds a descendant (or the root) by its glTF node name; throws when missing. */
  node(name: string): TransformNode;
  dispose(): void;
}

/**
 * Clones a loaded container into the scene with its own nodes, skeleton and animation groups.
 * Names are kept identical to the glTF so lookups work per instance.
 */
export function instantiate(container: AssetContainer): Instantiated {
  const entries = container.instantiateModelsToScene((name) => name, false, { doNotInstantiate: true });
  const [root] = entries.rootNodes as TransformNode[];
  if (!root || entries.rootNodes.length !== 1) throw new Error(`Expected one root node, got ${entries.rootNodes.length}`);

  // Babylon keeps a TransformNode for a skinned glTF node and re-parents the skinned Mesh (same name) to the
  // root; prefer the mesh so `node("arms")` returns something renderable.
  const byName = new Map<string, TransformNode>([[root.name, root]]);
  for (const node of root.getDescendants(false) as TransformNode[]) {
    const existing = byName.get(node.name);
    if (!existing || (node.getClassName() === "Mesh" && existing.getClassName() !== "Mesh")) byName.set(node.name, node);
  }
  return {
    root,
    meshes: root.getChildMeshes(false),
    skeletons: entries.skeletons,
    animationGroups: entries.animationGroups,
    node(name) {
      const node = byName.get(name);
      if (!node) throw new Error(`Node "${name}" not found in instance of ${root.name}`);
      return node;
    },
    dispose: () => entries.dispose(),
  };
}
