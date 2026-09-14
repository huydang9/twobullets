import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeBox, PhysicsShapeContainer } from "@babylonjs/core/Physics/v2/physicsShape.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { getPrefabCollision, wedgeCorners } from "@twobullets/shared/map/buildings/placement";
import type { BuildingPrefabId } from "@twobullets/shared/map/buildings/prefabs/index";
import type { BuildingPlacement } from "@twobullets/shared/map/buildings/types";
import { LEVEL_MATERIAL, createConvexHullShape } from "../level/shapes";

/** Same surface response as level blocks. */
const MATERIAL = LEVEL_MATERIAL;

const shapesByScene = new WeakMap<Scene, Map<BuildingPrefabId, PhysicsShapeContainer>>();

/**
 * One compound shape per prefab per scene (boxes plus convex hulls for wedges), shared by every placement of that prefab.
 * Disposed with the scene.
 */
export function getBuildingShape(scene: Scene, id: BuildingPrefabId): PhysicsShapeContainer {
  let shapes = shapesByScene.get(scene);
  if (!shapes) {
    const created = new Map<BuildingPrefabId, PhysicsShapeContainer>();
    shapesByScene.set(scene, created);
    scene.onDisposeObservable.addOnce(() => created.forEach((shape) => shape.dispose()));
    shapes = created;
  }
  let container = shapes.get(id);
  if (container) return container;

  container = new PhysicsShapeContainer(scene);
  container.material = MATERIAL;
  const identity = Quaternion.Identity();
  for (const shape of getPrefabCollision(id)) {
    const child =
      shape.kind === "box"
        ? new PhysicsShapeBox(new Vector3(...shape.center), identity, new Vector3(...shape.size), scene)
        : createConvexHullShape(scene, wedgeCorners(shape));
    child.material = MATERIAL;
    container.addChild(child);
  }
  shapes.set(id, container);
  return container;
}

export interface BuildingBody {
  readonly node: TransformNode;
  readonly body: PhysicsBody;
}

/** Static Havok body for a placed prefab. Requires physics to be enabled on the scene. */
export function createBuildingBody(scene: Scene, id: BuildingPrefabId, placement: BuildingPlacement, name = `building_${id}`): BuildingBody {
  const node = new TransformNode(name, scene);
  node.position.set(...placement.position);
  node.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), placement.yaw);
  node.computeWorldMatrix(true);
  const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);
  body.shape = getBuildingShape(scene, id);
  node.freezeWorldMatrix();
  return { node, body };
}
