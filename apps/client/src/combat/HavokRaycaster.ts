import { PhysicsRaycastResult, Vector3, type HavokPlugin, type IRaycastQuery, type PhysicsBody, type Scene } from "@babylonjs/core";
import type { RayHit, RaycastFn, Vec3 } from "@twobullets/shared";
import { BULLET_COLLIDE_MASK, type HitboxRegistry } from "./hitboxes";

/**
 * Bullet segment queries against the Havok world. Havok's broadphase only refreshes during the physics step, so
 * moving hitboxes are queried as of the last rendered frame, which is also what the player saw.
 */
export class HavokRaycaster {
  private readonly plugin: HavokPlugin;
  private readonly result = new PhysicsRaycastResult();
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly query: IRaycastQuery = { shouldHitTriggers: true, collideWith: BULLET_COLLIDE_MASK };

  constructor(
    scene: Scene,
    private readonly registry: HitboxRegistry,
  ) {
    const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
    if (!plugin || !("raycast" in plugin) || plugin.getPluginVersion() !== 2) throw new Error("HavokRaycaster requires the Havok physics plugin (v2)");
    this.plugin = plugin as HavokPlugin;
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
      colliderId: this.registry.colliderIdOf(result.body),
    };
  };
}
