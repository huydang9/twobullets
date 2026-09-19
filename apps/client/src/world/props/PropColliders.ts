import { Matrix, Mesh, PhysicsBody, PhysicsMotionType, PhysicsShapeBox, PhysicsShapeCylinder, Quaternion, Vector3, type PhysicsShape, type Scene } from "@babylonjs/core";
import { COLLIDER_STRIDE, getMapProp, glassBlocksAt, isMirrorWallProp, propColliderGroups, type MapLayout } from "@twobullets/shared";
import { CollisionLayer } from "../../combat/hitboxes";

const MATERIAL = { friction: 0.6, restitution: 0 } as const;

export interface PropColliderStats {
  /** One Havok shape per prop per quantized scale (panes: per phase group too). */
  readonly shapes: number;
  /** One Havok body per instance (sharing its group's shape). */
  readonly bodies: number;
  /** Phase groups whose panes stop bullets right now. */
  readonly blockingPanes: number;
}

/** A phase group's shape and the two masks it switches between. */
interface PhaseShape {
  readonly shape: PhysicsShape;
  readonly phase: number;
  /** Membership the shape was built with: world geometry, which bullets and bot sight rays see. */
  readonly solid: number;
  blocking: boolean;
}

/**
 * Static Havok colliders for map props. Each (prop, scale, phase) group is one shape and one PhysicsBody over an
 * invisible thin-instanced mesh, which Babylon's Havok plugin expands into a static body per instance that all share
 * the shape. Ray hits report the group mesh as `body.transformNode`, tagged with `metadata.surface` for audio.
 *
 * Glazed panes switch between stopping bullets and letting them through (`map/glassPhase.ts`). The switch is one write
 * to the shape's membership mask, so the panes are split into phase groups with a shape each: a group flips together
 * and the groups never flip at the same moment. `setPhaseTime` is what turns the clock, and it must be the match clock,
 * the same number the server derives the same modes from.
 */
/** A live collider batch: its mesh and body, and which layout instance sits in each thin-instance slot. */
interface Destructible {
  readonly prop: string;
  readonly instance: number;
  readonly mesh: Mesh;
  readonly body: PhysicsBody;
  gone: boolean;
}

export class PropColliders {
  private readonly bodies: PhysicsBody[] = [];
  private readonly shapes: PhysicsShape[] = [];
  private readonly meshes: Mesh[] = [];
  private readonly phases: PhaseShape[] = [];
  /** Instances whose collider can leave the world on its own (mirror panes). One body each — see `removeInstance`. */
  private readonly destructible: Destructible[] = [];
  private instanceCount = 0;

  constructor(scene: Scene, layout: Pick<MapLayout, "props">) {
    const matrix = new Matrix();
    const rotation = new Quaternion();
    for (const group of propColliderGroups(layout)) {
      const shape =
        group.shape.kind === "cylinder"
          ? new PhysicsShapeCylinder(Vector3.Zero(), new Vector3(0, group.shape.height, 0), group.shape.radius, scene)
          : new PhysicsShapeBox(new Vector3(0, group.shape.centerY, 0), Quaternion.Identity(), new Vector3(...group.shape.size), scene);
      shape.material = MATERIAL;
      const solid = shape.filterMembershipMask;
      // Shoot-through props (fences, panes letting rounds through) only stop movement, like the target blockers.
      if (!group.bulletproof) shape.filterMembershipMask = CollisionLayer.blocker;
      if (group.phase >= 0) this.phases.push({ shape, phase: group.phase, solid, blocking: group.bulletproof });

      const count = group.transforms.length / COLLIDER_STRIDE;
      const name = colliderName(group.prop, group.scale, group.phase);
      const surface = getMapProp(group.prop).surface;
      this.shapes.push(shape);

      if (isMirrorWallProp(group.prop)) {
        // Destructible panes get a body each, sharing the group's one shape. See `removeInstance`.
        for (let i = 0; i < count; i++) {
          const t = i * COLLIDER_STRIDE;
          const mesh = new Mesh(name, scene);
          mesh.isVisible = false;
          mesh.isPickable = false;
          mesh.doNotSyncBoundingInfo = true;
          mesh.metadata = { surface };
          mesh.position.set(group.transforms[t]!, group.transforms[t + 1]!, group.transforms[t + 2]!);
          mesh.rotation.y = group.transforms[t + 3]!;
          mesh.computeWorldMatrix(true);
          const body = new PhysicsBody(mesh, PhysicsMotionType.STATIC, false, scene);
          body.shape = shape;
          this.meshes.push(mesh);
          this.bodies.push(body);
          this.destructible.push({ prop: group.prop, instance: group.instances[i]!, mesh, body, gone: false });
        }
        this.instanceCount += count;
        continue;
      }

      const matrices = new Float32Array(count * 16);
      for (let i = 0; i < count; i++) {
        const t = i * COLLIDER_STRIDE;
        Quaternion.RotationYawPitchRollToRef(group.transforms[t + 3]!, 0, 0, rotation);
        Matrix.ComposeToRef(Vector3.OneReadOnly, rotation, new Vector3(group.transforms[t]!, group.transforms[t + 1]!, group.transforms[t + 2]!), matrix);
        matrix.copyToArray(matrices, i * 16);
      }

      const mesh = new Mesh(name, scene);
      mesh.isVisible = false;
      mesh.isPickable = false;
      mesh.doNotSyncBoundingInfo = true;
      mesh.metadata = { surface };
      mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
      const body = new PhysicsBody(mesh, PhysicsMotionType.STATIC, false, scene);
      body.shape = shape;

      this.meshes.push(mesh);
      this.bodies.push(body);
      this.instanceCount += count;
    }
  }

  /**
   * Puts every phase group into its mode at `seconds` of match time. Writes only where the mode actually changed, so
   * the ordinary call touches nothing; call it every frame. Nothing else in the world reacts to it.
   */
  setPhaseTime(seconds: number): void {
    for (const pane of this.phases) {
      const blocking = glassBlocksAt(pane.phase, seconds);
      if (blocking === pane.blocking) continue;
      pane.blocking = blocking;
      pane.shape.filterMembershipMask = blocking ? pane.solid : CollisionLayer.blocker;
    }
  }

  /**
   * Takes one instance's collider out of the world for good: the mirror pane a frag destroyed
   * (`shared/equipment/destructible.ts`). Returns false when that instance has no collider or has already gone.
   *
   * Why the panes are not thin-instanced like every other prop: the Havok plugin makes one body per thin instance and
   * only reconciles them when the *count* changes, re-pushing every surviving transform. Swapping the doomed slot
   * with the last one and dropping the count therefore moves a live body — and this world is never stepped (static
   * geometry and character queries only), so Havok's broadphase keeps the moved pane at its old place until something
   * steps. A stale collider in a maze is a wall you cannot see. So a destructible prop gets a body per instance,
   * sharing its group's one shape: the same shape count, no thin-instance bookkeeping, and removal is one
   * `dispose()` that leaves the world immediately.
   */
  removeInstance(prop: string, instance: number): boolean {
    for (const entry of this.destructible) {
      if (entry.gone || entry.prop !== prop || entry.instance !== instance) continue;
      entry.gone = true;
      entry.body.dispose();
      entry.mesh.dispose();
      this.instanceCount--;
      return true;
    }
    return false;
  }

  stats(): PropColliderStats {
    let blockingPanes = 0;
    for (const pane of this.phases) if (pane.blocking) blockingPanes++;
    return { shapes: this.shapes.length, bodies: this.instanceCount, blockingPanes };
  }

  dispose(): void {
    // A destroyed pane already disposed its own body and mesh; disposing twice is a no-op in Babylon.
    this.bodies.forEach((b) => b.dispose());
    this.shapes.forEach((s) => s.dispose());
    this.meshes.forEach((m) => m.dispose());
  }
}

/** `propCollider_<prop>_<scale>`, with `_p<group>` on the panes that switch mode (one mesh per Havok shape). */
export function colliderName(prop: string, scale: number, phase: number): string {
  return `propCollider_${prop}_${scale}${phase >= 0 ? `_p${phase}` : ""}`;
}
