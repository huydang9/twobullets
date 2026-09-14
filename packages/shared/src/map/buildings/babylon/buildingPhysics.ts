import {
  Mesh,
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  PhysicsShapeContainer,
  PhysicsShapeConvexHull,
  Quaternion,
  TransformNode,
  Vector3,
  VertexData,
  type Scene,
} from "@babylonjs/core";
import { getPrefabCollision, wedgeCorners } from "../placement";
import type { BuildingPrefabId } from "../prefabs";
import type { BuildingPlacement } from "../types";

/** Same surface response as level blocks (buildLevel's PhysicsAggregate options). */
const MATERIAL = { friction: 0.6, restitution: 0 } as const;

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
        : convexHull(scene, wedgeCorners(shape));
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

function convexHull(scene: Scene, corners: readonly (readonly [number, number, number])[]): PhysicsShapeConvexHull {
  // The hull is built from a throwaway mesh's vertices (in its local space), so the mesh never needs to render.
  const mesh = new Mesh("buildingHullSource", scene);
  const data = new VertexData();
  data.positions = corners.flat();
  data.indices = [0, 1, 2, 3, 4, 5];
  data.applyToMesh(mesh);
  const hull = new PhysicsShapeConvexHull(mesh, scene);
  mesh.dispose();
  return hull;
}
