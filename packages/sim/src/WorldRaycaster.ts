import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsRaycastResult, type IRaycastQuery } from "@babylonjs/core/Physics/physicsRaycastResult.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { RayHit, RaycastFn } from "@twobullets/shared/weapons/types";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { WORLD_ONLY_MASK } from "./collisionLayers";
import { havokPluginOf } from "./level/shapes";

export interface WorldRaycasterOptions {
  /** Filter bits the ray collides with. Default: static world only (`WORLD_ONLY_MASK`). */
  readonly collideWith?: number;
  /** Hit trigger shapes (hitboxes). Default false. */
  readonly shouldHitTriggers?: boolean;
  /** Maps a hit body to a collider id (hitboxes); world geometry and unknown bodies give null. */
  readonly colliderIdOf?: (body: PhysicsBody | undefined) => string | null;
}

/**
 * Segment queries against the Havok world as a `RaycastFn`. Havok's broadphase only refreshes during the physics step,
 * so moving hitboxes are queried as of the last step (on the client, the last rendered frame, which the player saw).
 * The default configuration is the server's world-only raycast.
 */
export class WorldRaycaster {
  private readonly plugin: HavokPlugin;
  private readonly result = new PhysicsRaycastResult();
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly query: IRaycastQuery;
  private readonly colliderIdOf: ((body: PhysicsBody | undefined) => string | null) | null;

  constructor(scene: Scene, options: WorldRaycasterOptions = {}) {
    this.plugin = havokPluginOf(scene);
    this.query = { shouldHitTriggers: options.shouldHitTriggers ?? false, collideWith: options.collideWith ?? WORLD_ONLY_MASK };
    this.colliderIdOf = options.colliderIdOf ?? null;
  }

  /** Body the rays pass through (the shooter's own capsule). */
  set ignoreBody(body: PhysicsBody | undefined) {
    this.query.ignoreBody = body;
  }

  readonly cast: RaycastFn = (from: Vec3, to: Vec3): RayHit | null => {
    const start = this.from.set(from.x, from.y, from.z);
    const end = this.to.set(to.x, to.y, to.z);
    const result = this.result;
    this.plugin.raycast(start, end, result, this.query);
    if (!result.hasHit) return null;

    const length = Vector3.Distance(start, end);
    const { x: px, y: py, z: pz } = result.hitPointWorld;
    const { x: nx, y: ny, z: nz } = result.hitNormalWorld;
    return {
      point: { x: px, y: py, z: pz },
      normal: { x: nx, y: ny, z: nz },
      fraction: length > 0 ? Math.min(1, result.hitDistance / length) : 0,
      colliderId: this.colliderIdOf ? this.colliderIdOf(result.body) : null,
    };
  };
}
