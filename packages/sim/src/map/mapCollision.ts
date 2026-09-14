import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeBox, PhysicsShapeCylinder, type PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { Scene } from "@babylonjs/core/scene.js";
import { MOVEMENT } from "@twobullets/shared/constants";
import { COLLIDER_STRIDE, propColliderGroups } from "@twobullets/shared/map/layout/collision";
import type { MapLayout } from "@twobullets/shared/map/layout/mapLayout";
import type { Terrain } from "@twobullets/shared/map/terrain/terrain";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { CharacterBody } from "../CharacterBody";
import { CollisionLayer } from "../collisionLayers";
import type { HavokModule, PlayerBody, SimWorld } from "../index";
import { LEVEL_MATERIAL } from "../level/shapes";
import { WorldRaycaster } from "../WorldRaycaster";
import { createBuildingBody, type BuildingBody } from "./buildingPhysics";
import { createTerrainBody, type TerrainBody } from "./terrainBody";

// Headless Map v1 world (docs/bots/design.md §2.1): terrain heightfield, building compounds and prop colliders as static
// Havok bodies, with no meshes or materials. The same shapes as the client's MapRuntime (terrain stride 1, one compound
// per prefab, one shape per prop group with fences on the blocker layer so bullets and sight pass them).

export interface MapCollisionInput {
  readonly terrain: Terrain;
  readonly layout: MapLayout;
}

export interface MapCollisionStats {
  readonly buildings: number;
  readonly propShapes: number;
  readonly propBodies: number;
  readonly buildMs: number;
}

export interface MapCollision {
  readonly terrain: TerrainBody;
  readonly buildings: readonly BuildingBody[];
  readonly stats: MapCollisionStats;
  dispose(): void;
}

/** Static collision for a built map in a scene with Havok enabled. */
export function buildMapCollision(scene: Scene, input: MapCollisionInput): MapCollision {
  const started = performance.now();
  const terrain = createTerrainBody(scene, input.terrain.field);
  const buildings = input.layout.buildings.map((b) => createBuildingBody(scene, b.prefab, { position: b.position, yaw: b.yaw }, `building_${b.id}`));

  const shapes: PhysicsShape[] = [];
  const bodies: PhysicsBody[] = [];
  const meshes: Mesh[] = [];
  const matrix = new Matrix();
  const rotation = new Quaternion();
  const translation = new Vector3();
  let propBodies = 0;
  for (const group of propColliderGroups(input.layout)) {
    const shape =
      group.shape.kind === "cylinder"
        ? new PhysicsShapeCylinder(Vector3.Zero(), new Vector3(0, group.shape.height, 0), group.shape.radius, scene)
        : new PhysicsShapeBox(new Vector3(0, group.shape.centerY, 0), Quaternion.Identity(), new Vector3(...group.shape.size), scene);
    shape.material = LEVEL_MATERIAL;
    if (!group.bulletproof) shape.filterMembershipMask = CollisionLayer.blocker;
    const count = group.transforms.length / COLLIDER_STRIDE;
    const matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
      const t = i * COLLIDER_STRIDE;
      Quaternion.RotationYawPitchRollToRef(group.transforms[t + 3]!, 0, 0, rotation);
      Matrix.ComposeToRef(Vector3.OneReadOnly, rotation, translation.set(group.transforms[t]!, group.transforms[t + 1]!, group.transforms[t + 2]!), matrix);
      matrix.copyToArray(matrices, i * 16);
    }
    const mesh = new Mesh(`propCollider_${group.prop}_${group.scale}`, scene);
    mesh.isVisible = false;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
    const body = new PhysicsBody(mesh, PhysicsMotionType.STATIC, false, scene);
    body.shape = shape;
    shapes.push(shape);
    bodies.push(body);
    meshes.push(mesh);
    propBodies += count;
  }

  return {
    terrain,
    buildings,
    stats: { buildings: buildings.length, propShapes: shapes.length, propBodies, buildMs: performance.now() - started },
    dispose() {
      for (const body of bodies) body.dispose();
      for (const shape of shapes) shape.dispose();
      for (const mesh of meshes) mesh.dispose();
      for (const b of buildings) {
        b.body.dispose();
        b.node.dispose();
      }
      terrain.dispose();
    },
  };
}

export interface MapSimWorld extends SimWorld {
  readonly collision: MapCollision;
  readonly terrain: Terrain;
  readonly layout: MapLayout;
  /** Feet at the terrain height (buildings and props ignored). */
  groundFeet(x: number, z: number): Vec3;
}

/**
 * Headless world for a built map: NullEngine scene, Havok (never stepped: static bodies and character controller
 * queries only, like ServerMatch), the map collision, a world-only raycast and CharacterBody factory.
 */
export function createMapSimWorld(havok: HavokModule, input: MapCollisionInput): MapSimWorld {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.enablePhysics(new Vector3(0, -MOVEMENT.gravity, 0), new HavokPlugin(false, havok));
  const collision = buildMapCollision(scene, input);
  const raycaster = new WorldRaycaster(scene);
  const bodies = new Set<CharacterBody>();
  return {
    raycastWorld: raycaster.cast,
    scene,
    collision,
    terrain: input.terrain,
    layout: input.layout,
    groundFeet(x, z) {
      return { x, y: input.terrain.sampleHeight(x, z), z };
    },
    createBody(feet: Vec3): PlayerBody {
      const body = new CharacterBody(scene, feet);
      bodies.add(body);
      const dispose = body.dispose.bind(body);
      body.dispose = () => {
        bodies.delete(body);
        dispose();
      };
      return body;
    },
    dispose() {
      for (const body of [...bodies]) body.dispose();
      collision.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
}
