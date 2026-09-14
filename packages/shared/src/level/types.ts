export type Vec3Tuple = readonly [x: number, y: number, z: number];

/** Named palette slots; the client maps these to materials. */
export type SurfaceKind = "ground" | "wall" | "platform" | "ramp" | "cover" | "accent";

export interface LevelBlock {
  /**
   * `box`: axis-aligned cuboid (before rotation).
   * `ramp`: wedge filling the same bounding box. Its sloped face rises along local +Z:
   * the low edge sits at (y = bottom, z = -depth/2), the high edge at (y = top, z = +depth/2),
   * with a vertical back face. Slope angle = atan(height / depth).
   */
  readonly kind: "box" | "ramp";
  /** Optional stable name, used for mesh naming/debugging. Should be unique within a level. */
  readonly name?: string;
  /** Center of the block's bounding box in world space. */
  readonly position: Vec3Tuple;
  /** Full extents (width X, height Y, depth Z) before rotation. */
  readonly size: Vec3Tuple;
  /** Rotation around Y in radians. With rotationY = θ, local +Z points toward world (sin θ, 0, cos θ). */
  readonly rotationY?: number;
  readonly surface: SurfaceKind;
}

export interface SpawnPoint {
  /** Feet position. */
  readonly position: Vec3Tuple;
  /** Facing direction around Y in radians (0 = +Z, π/2 = +X). */
  readonly yaw: number;
}

export interface LevelData {
  readonly name: string;
  readonly blocks: readonly LevelBlock[];
  readonly spawnPoints: readonly SpawnPoint[];
  /** Players below this Y are respawned. */
  readonly killY: number;
}
