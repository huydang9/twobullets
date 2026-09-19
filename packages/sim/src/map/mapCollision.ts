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
import { MOVEMENT, SIMULATION } from "@twobullets/shared/constants";
import { COLLIDER_STRIDE, propColliderGroups } from "@twobullets/shared/map/layout/collision";
import { isMirrorWallProp } from "@twobullets/shared/equipment/destructible";
import { glassBlocksAt } from "@twobullets/shared/map/glassPhase";
import type { MapLayout } from "@twobullets/shared/map/layout/mapLayout";
import type { Terrain } from "@twobullets/shared/map/terrain/terrain";
import type { Vec3 } from "@twobullets/shared/movement/types";
import type { RaycastFn } from "@twobullets/shared/weapons/types";
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
  /**
   * Puts the glazed panes into their mode at `seconds` of match time (`shared/map/glassPhase.ts`): in one mode a pane
   * stops bullets and blocks a bot's sight ray, in the other rounds pass straight through it. Each phase group has its
   * own shape, so they never switch together. Call it once per tick with the tick's own time — every client derives the
   * same modes from the same number, with nothing sent over the wire, and a world that never calls it holds the resting
   * mode (shoot-through) forever.
   */
  setPhaseTime(seconds: number): void;
  /**
   * `setPhaseTime` for a match tick, and the only conversion the server side makes: match seconds are the absolute
   * match tick over the tick rate, on every host. The client's half of it is `PropColliders.setPhaseTick`
   * (apps/client/src/world/props/PropColliders.ts); the two are pinned against each other by
   * apps/client/test/world/glassPhaseAgreement.test.ts, because if they ever drift apart a player shoots through a
   * pane the server says is solid.
   */
  setPhaseTick(tick: number): void;
  /**
   * Takes one prop instance out of the world for good: a mirror pane a frag destroyed
   * (`shared/equipment/destructible.ts`). Returns false when that instance has no collider or is already gone.
   *
   * Destructible props are the one kind that is not thin-instanced (see `removeColliderInstance`), so this is one
   * `dispose()` on that pane's own static body, and the pane leaves Havok's broadphase the same instant.
   */
  removeInstance(prop: string, instance: number): boolean;
  dispose(): void;
}

/** One prop instance whose collider can leave the world on its own: its own static body, sharing a group shape. */
export interface DestructibleCollider {
  readonly prop: string;
  readonly instance: number;
  readonly mesh: Mesh;
  readonly body: PhysicsBody;
  gone: boolean;
}

/**
 * Removes one destructible instance's collider. Shared by the headless world and the client's `PropColliders`, so
 * offline and headless agree on what is still standing.
 *
 * **Why these props are not thin-instanced like every other one.** The Havok plugin makes a body per thin instance
 * and only reconciles them when the *count* changes: shrinking the count releases the last body and re-pushes every
 * survivor's transform. Taking out instance k therefore means swapping the last instance into slot k — which *moves*
 * a live static body. These worlds are never stepped (static geometry plus character-controller queries), and Havok
 * only picks a moved static body up in its broadphase on a step, so the swapped pane would go on blocking its old
 * corridor and stop blocking its new one. In a maze that is a wall you cannot see.
 *
 * So a destructible prop gets one body per instance, all sharing the group's single `PhysicsShape`: the same shape
 * count as before, no per-frame cost, and removal is one `dispose()` — `HP_World_RemoveBody`, effective at once.
 */
export function removeColliderInstance(colliders: readonly DestructibleCollider[], prop: string, instance: number): boolean {
  for (const entry of colliders) {
    if (entry.gone || entry.prop !== prop || entry.instance !== instance) continue;
    entry.gone = true;
    entry.body.dispose();
    entry.mesh.dispose();
    return true;
  }
  return false;
}

/** Static collision for a built map in a scene with Havok enabled. */
export function buildMapCollision(scene: Scene, input: MapCollisionInput): MapCollision {
  const started = performance.now();
  const terrain = createTerrainBody(scene, input.terrain.field);
  const buildings = input.layout.buildings.map((b) => createBuildingBody(scene, b.prefab, { position: b.position, yaw: b.yaw }, `building_${b.id}`));

  const shapes: PhysicsShape[] = [];
  const bodies: PhysicsBody[] = [];
  const meshes: Mesh[] = [];
  const destructible: DestructibleCollider[] = [];
  /** Panes that switch mode: one entry per phase group, each with its own shape (see `setPhaseTime`). */
  const phases: { shape: PhysicsShape; phase: number; solid: number; blocking: boolean }[] = [];
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
    const solid = shape.filterMembershipMask;
    if (!group.bulletproof) shape.filterMembershipMask = CollisionLayer.blocker;
    if (group.phase >= 0) phases.push({ shape, phase: group.phase, solid, blocking: group.bulletproof });
    const count = group.transforms.length / COLLIDER_STRIDE;
    const name = `propCollider_${group.prop}_${group.scale}${group.phase >= 0 ? `_p${group.phase}` : ""}`;
    shapes.push(shape);
    propBodies += count;

    // Panes a grenade can destroy get a body each (see `removeColliderInstance`); everything else thin-instances.
    if (isMirrorWallProp(group.prop)) {
      for (let i = 0; i < count; i++) {
        const t = i * COLLIDER_STRIDE;
        const mesh = new Mesh(name, scene);
        mesh.isVisible = false;
        mesh.isPickable = false;
        mesh.doNotSyncBoundingInfo = true;
        mesh.position.set(group.transforms[t]!, group.transforms[t + 1]!, group.transforms[t + 2]!);
        mesh.rotation.y = group.transforms[t + 3]!;
        mesh.computeWorldMatrix(true);
        const body = new PhysicsBody(mesh, PhysicsMotionType.STATIC, false, scene);
        body.shape = shape;
        bodies.push(body);
        meshes.push(mesh);
        destructible.push({ prop: group.prop, instance: group.instances[i]!, mesh, body, gone: false });
      }
      continue;
    }

    const matrices = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
      const t = i * COLLIDER_STRIDE;
      Quaternion.RotationYawPitchRollToRef(group.transforms[t + 3]!, 0, 0, rotation);
      Matrix.ComposeToRef(Vector3.OneReadOnly, rotation, translation.set(group.transforms[t]!, group.transforms[t + 1]!, group.transforms[t + 2]!), matrix);
      matrix.copyToArray(matrices, i * 16);
    }
    const mesh = new Mesh(name, scene);
    mesh.isVisible = false;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
    const body = new PhysicsBody(mesh, PhysicsMotionType.STATIC, false, scene);
    body.shape = shape;
    bodies.push(body);
    meshes.push(mesh);
  }

  const setPhaseTime = (seconds: number): void => {
    for (const pane of phases) {
      const blocking = glassBlocksAt(pane.phase, seconds);
      if (blocking === pane.blocking) continue;
      pane.blocking = blocking;
      pane.shape.filterMembershipMask = blocking ? pane.solid : CollisionLayer.blocker;
    }
  };

  return {
    terrain,
    buildings,
    stats: { buildings: buildings.length, propShapes: shapes.length, propBodies, buildMs: performance.now() - started },
    setPhaseTime,
    setPhaseTick(tick: number) {
      setPhaseTime(tick / SIMULATION.tickRate);
    },
    removeInstance(prop: string, instance: number) {
      return removeColliderInstance(destructible, prop, instance);
    },
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

/** Map collision by the world ray it belongs to; see `worldPhaseClock`. */
const PHASED_WORLDS = new WeakMap<RaycastFn, MapCollision>();

/**
 * The map collision behind a world raycast, for a caller holding nothing but the ray function.
 *
 * The server's hit registration (apps/server-match/src/hitreg) is that caller: `ServerCombat` hands it
 * `SimWorld.raycastWorld` and nothing else, yet it is the one place that knows which tick a bullet is being resolved
 * at — so it is the one place that can turn the glazed panes' clock (`MapCollision.setPhaseTick`) before the ray goes
 * out. A WeakMap rather than a property hung on the function, so the ray stays a plain `RaycastFn` everywhere else and
 * a disposed world's collision stays collectable.
 *
 * Null for a world with no map collision (the arena blockout), which has no panes to turn.
 */
export function worldPhaseClock(raycastWorld: RaycastFn): MapCollision | null {
  return PHASED_WORLDS.get(raycastWorld) ?? null;
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
  PHASED_WORLDS.set(raycaster.cast, collision);
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
