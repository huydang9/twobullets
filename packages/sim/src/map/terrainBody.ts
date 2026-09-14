// Babylon is imported through deep module paths only (see docs/backend/adr/0302), so a server bundle doesn't pull the
// @babylonjs/core barrel. Callers must enable Havok physics on the scene first.
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeHeightField } from "@babylonjs/core/Physics/v2/physicsShape.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { LEVEL_MATERIAL } from "../level/shapes";
import type { Heightfield } from "@twobullets/shared/map/terrain/heightfield";

export interface TerrainShapeOptions {
  /**
   * Keep every `stride`-th sample (1, 2, 4...). 2 turns a 1025² grid into 513² for a quarter of the Havok memory;
   * the collision surface then departs from the rendered one by up to the terrain's curvature over 2.5 m.
   */
  readonly stride?: number;
  readonly friction?: number;
  /** Shape filter membership bits. Default: Havok's default (all bits), the same as level geometry. */
  readonly membershipMask?: number;
}

/**
 * Heights in the order PhysicsShapeHeightField expects. The Havok plugin reads `data[(nx - 1 - a) * nz + b]` as the
 * sample at world x = -sizeX/2 + b·step, z = -sizeZ/2 + a·step relative to the body (verified with raycasts), which is
 * our row-major layout with the rows reversed.
 */
export function heightfieldToHavokOrder(field: Heightfield, stride = 1): Float32Array {
  if (!Number.isInteger(stride) || stride < 1 || (field.resolution - 1) % stride !== 0) {
    throw new Error(`stride ${stride} does not divide heightfield resolution - 1 (${field.resolution - 1})`);
  }
  const n = field.resolution;
  const m = (n - 1) / stride + 1;
  const data = new Float32Array(m * m);
  for (let a = 0; a < m; a++) {
    const source = a * stride * n;
    const target = (m - 1 - a) * m;
    for (let b = 0; b < m; b++) data[target + b] = field.heights[source + b * stride]!;
  }
  return data;
}

export function createTerrainShape(scene: Scene, field: Heightfield, options: TerrainShapeOptions = {}): PhysicsShapeHeightField {
  const stride = options.stride ?? 1;
  const samples = (field.resolution - 1) / stride + 1;
  const shape = new PhysicsShapeHeightField(field.size, field.size, samples, samples, heightfieldToHavokOrder(field, stride), scene);
  shape.material = { friction: options.friction ?? LEVEL_MATERIAL.friction, restitution: LEVEL_MATERIAL.restitution };
  if (options.membershipMask !== undefined) shape.filterMembershipMask = options.membershipMask;
  return shape;
}

export interface TerrainBody {
  readonly node: TransformNode;
  readonly body: PhysicsBody;
  readonly shape: PhysicsShapeHeightField;
  dispose(): void;
}

/**
 * Static Havok body for the terrain. Pass `shape` to share one heightfield shape between several bodies in the same
 * Havok instance (e.g. packed server worlds); otherwise a new shape is created and owned by the body.
 */
export function createTerrainBody(scene: Scene, field: Heightfield, options: TerrainShapeOptions & { readonly shape?: PhysicsShapeHeightField } = {}): TerrainBody {
  const ownsShape = !options.shape;
  const shape = options.shape ?? createTerrainShape(scene, field, options);
  const node = new TransformNode("terrain_physics", scene);
  // The Havok heightfield is centered on its body.
  node.position.set(field.minX + field.size / 2, 0, field.minZ + field.size / 2);
  const body = new PhysicsBody(node, PhysicsMotionType.STATIC, false, scene);
  body.shape = shape;
  return {
    node,
    body,
    shape,
    dispose() {
      body.dispose();
      node.dispose();
      if (ownsShape) shape.dispose();
    },
  };
}
