import { Matrix, Mesh, PhysicsBody, PhysicsMotionType, PhysicsShapeBox, PhysicsShapeCylinder, Quaternion, Vector3, type PhysicsShape, type Scene } from "@babylonjs/core";
import { COLLIDER_STRIDE, getMapProp, propColliderGroups, type MapLayout } from "@twobullets/shared";
import { CollisionLayer } from "../../combat/hitboxes";

const MATERIAL = { friction: 0.6, restitution: 0 } as const;

export interface PropColliderStats {
  /** One Havok shape per prop per quantized scale. */
  readonly shapes: number;
  /** One Havok body per instance (sharing its group's shape). */
  readonly bodies: number;
}

/**
 * Static Havok colliders for map props. Each (prop, scale) group is one shape and one PhysicsBody over an invisible
 * thin-instanced mesh, which Babylon's Havok plugin expands into a static body per instance that all share the shape.
 * Ray hits report the group mesh as `body.transformNode`, tagged with `metadata.surface` for audio.
 */
export class PropColliders {
  private readonly bodies: PhysicsBody[] = [];
  private readonly shapes: PhysicsShape[] = [];
  private readonly meshes: Mesh[] = [];
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
      // Shoot-through props (fences) only stop movement, like the target blockers.
      if (!group.bulletproof) shape.filterMembershipMask = CollisionLayer.blocker;

      const count = group.transforms.length / COLLIDER_STRIDE;
      const matrices = new Float32Array(count * 16);
      for (let i = 0; i < count; i++) {
        const t = i * COLLIDER_STRIDE;
        Quaternion.RotationYawPitchRollToRef(group.transforms[t + 3]!, 0, 0, rotation);
        Matrix.ComposeToRef(Vector3.OneReadOnly, rotation, new Vector3(group.transforms[t]!, group.transforms[t + 1]!, group.transforms[t + 2]!), matrix);
        matrix.copyToArray(matrices, i * 16);
      }

      const mesh = new Mesh(`propCollider_${group.prop}_${group.scale}`, scene);
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

  stats(): PropColliderStats {
    return { shapes: this.shapes.length, bodies: this.instanceCount };
  }

  dispose(): void {
    this.bodies.forEach((b) => b.dispose());
    this.shapes.forEach((s) => s.dispose());
    this.meshes.forEach((m) => m.dispose());
  }
}
