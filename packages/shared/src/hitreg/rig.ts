import type { HitZone } from "../weapons/types";

// Procedural soldier hitbox rig (ADR 0003): a pure function of the replicated pose, tested analytically. Server
// authority, client cosmetic prediction and the debug overlay all use it. Allocation-free by contract.

/** Replicated pose inputs. Feet position in metres; yaw/pitch in radians (MoveInput convention); 0 = stand, 1 = crouch. */
export interface HitPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  stanceBlend: number;
}

/** Shapes in `SOLDIER_HITBOXES` order: head sphere, neck capsule, chest/abdomen/pelvis boxes, 8 limb capsules. */
export const RIG_SHAPE_COUNT = 13;

export const RigShapeKind = { sphere: 0, capsule: 1, box: 2 } as const;
export type RigShapeKind = (typeof RigShapeKind)[keyof typeof RigShapeKind];

/**
 * Doubles per posed shape in the `poseHitboxes` output buffer:
 * [0] kind (`RigShapeKind`), [1] zone index (0 head, 1 body, 2 limb),
 * [2..4] centre (sphere, box) or segment start (capsule), [5..7] segment end (capsule),
 * [8] radius (sphere, capsule), [9..11] box half extents, [12..15] box orientation quaternion (x, y, z, w).
 * The layout may be refined by T4.3 before the first consumer lands (M4); size the buffer with `RIG_BUFFER_LENGTH`.
 */
export const RIG_SHAPE_STRIDE = 16;
export const RIG_BUFFER_LENGTH = RIG_SHAPE_COUNT * RIG_SHAPE_STRIDE;

export interface RigHit {
  /** 0..1 along the tested segment; the nearest hit wins. */
  readonly t: number;
  /** Shape index, 0..RIG_SHAPE_COUNT-1. */
  readonly shape: number;
  readonly zone: HitZone;
}

/** Writes the 13 posed shapes into `out` (length ≥ `RIG_BUFFER_LENGTH`). */
export function poseHitboxes(pose: HitPose, out: Float64Array): void {
  throw new Error("not implemented");
}

/** Nearest intersection of segment a→b with the posed shapes, or null. */
export function segmentVsRig(
  shapes: Float64Array,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): RigHit | null {
  throw new Error("not implemented");
}
