import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import type { PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { LevelBlock, LevelData } from "@twobullets/shared/level/types";
import { createBlockShape } from "./shapes";

export interface BlockBody {
  readonly body: PhysicsBody;
  readonly shape: PhysicsShape;
  dispose(): void;
}

/**
 * Places `node` at the block's pose and gives it a static body with the block's collision shape. The client passes the
 * block's render mesh; the server passes a bare TransformNode. Requires physics to be enabled on the scene.
 */
export function attachBlockBody(scene: Scene, node: TransformNode, block: LevelBlock): BlockBody {
  node.position.set(block.position[0], block.position[1], block.position[2]);
  node.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), block.rotationY ?? 0);
  node.computeWorldMatrix(true);
  const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);
  const shape = createBlockShape(scene, block);
  body.shape = shape;
  body.setMassProperties({ mass: 0 });
  node.freezeWorldMatrix();
  const dispose = (): void => {
    observer.remove();
    body.dispose();
    shape.dispose();
  };
  // Like PhysicsAggregate: the body goes away with its node.
  const observer = node.onDisposeObservable.add(dispose);
  return { body, shape, dispose };
}

export interface CollisionLevel {
  readonly nodes: readonly TransformNode[];
  dispose(): void;
}

/** Collision-only level (R13): one static Havok body per block on a TransformNode, no meshes or vertex data. */
export function buildCollision(scene: Scene, level: LevelData): CollisionLevel {
  const nodes = level.blocks.map((block, i) => {
    const node = new TransformNode(`level_${block.name ?? `${block.surface}_${block.kind}_${i}`}`, scene);
    attachBlockBody(scene, node, block);
    return node;
  });
  return {
    nodes,
    dispose() {
      for (const node of nodes) node.dispose();
    },
  };
}
