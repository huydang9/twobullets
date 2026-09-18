import { Matrix, Mesh, PhysicsBody, PhysicsMotionType, PhysicsShapeBox, PhysicsShapeCylinder, Quaternion, Vector3, type PhysicsShape, type Scene } from "@babylonjs/core";
import { COLLIDER_STRIDE, getMapProp, glassBlocksAt, propColliderGroups, type MapLayout } from "@twobullets/shared";
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
export class PropColliders {
  private readonly bodies: PhysicsBody[] = [];
  private readonly shapes: PhysicsShape[] = [];
  private readonly meshes: Mesh[] = [];
  private readonly phases: PhaseShape[] = [];
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
      const matrices = new Float32Array(count * 16);
      for (let i = 0; i < count; i++) {
        const t = i * COLLIDER_STRIDE;
        Quaternion.RotationYawPitchRollToRef(group.transforms[t + 3]!, 0, 0, rotation);
        Matrix.ComposeToRef(Vector3.OneReadOnly, rotation, new Vector3(group.transforms[t]!, group.transforms[t + 1]!, group.transforms[t + 2]!), matrix);
        matrix.copyToArray(matrices, i * 16);
      }

      const mesh = new Mesh(colliderName(group.prop, group.scale, group.phase), scene);
      mesh.isVisible = false;
      mesh.isPickable = false;
      mesh.doNotSyncBoundingInfo = true;
      mesh.metadata = { surface: getMapProp(group.prop).surface };
      mesh.thinInstanceSetBuffer("matrix", matrices, 16, true);
      const body = new PhysicsBody(mesh, PhysicsMotionType.STATIC, false, scene);
      body.shape = shape;

      this.meshes.push(mesh);
      this.shapes.push(shape);
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

  stats(): PropColliderStats {
    let blockingPanes = 0;
    for (const pane of this.phases) if (pane.blocking) blockingPanes++;
    return { shapes: this.shapes.length, bodies: this.instanceCount, blockingPanes };
  }

  dispose(): void {
    this.bodies.forEach((b) => b.dispose());
    this.shapes.forEach((s) => s.dispose());
    this.meshes.forEach((m) => m.dispose());
  }
}

/** `propCollider_<prop>_<scale>`, with `_p<group>` on the panes that switch mode (one mesh per Havok shape). */
export function colliderName(prop: string, scale: number, phase: number): string {
  return `propCollider_${prop}_${scale}${phase >= 0 ? `_p${phase}` : ""}`;
}
