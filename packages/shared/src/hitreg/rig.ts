import type { HitZone } from "../weapons/types";
import { RIG_BOUNDS_CENTER_Y, RIG_BOUNDS_RADIUS, RIG_FIT_POSES, RIG_PITCH_SHARE, type RigFitPose } from "./rigFit";

// Procedural soldier hitbox rig (ADR 0003): a pure function of the replicated pose, tested analytically. Server
// authority, client cosmetic prediction and the debug overlay all use it. Allocation-free by contract.

/**
 * Replicated pose inputs. Feet position in metres; yaw/pitch in radians (MoveInput convention: yaw 0 faces +Z, + turns
 * toward +X; + pitch looks down); `stanceBlend` 0 = stand, 1 = crouch, 2 = prone (knocked crawl), blended in between.
 */
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

/** Zone index → HitZone. */
export const RIG_ZONES: readonly HitZone[] = ["head", "body", "limb"];

export interface RigHit {
  /** 0..1 along the tested segment; the nearest hit wins. */
  readonly t: number;
  /** Shape index, 0..RIG_SHAPE_COUNT-1. */
  readonly shape: number;
  readonly zone: HitZone;
}

/** Writable RigHit for `segmentVsRigInto`. */
export interface MutableRigHit {
  t: number;
  shape: number;
  zone: HitZone;
}

const MAX_PITCH = (80 * Math.PI) / 180;
const EPS = 1e-9;

/** Stance → the stance blend the rig expects. */
export function stanceBlendOf(stance: "stand" | "crouch" | "prone"): number {
  return stance === "prone" ? 2 : stance === "crouch" ? 1 : 0;
}

/** Writes the 13 posed shapes into `out` (length ≥ `RIG_BUFFER_LENGTH`). */
export function poseHitboxes(pose: HitPose, out: Float64Array): void {
  const blend = pose.stanceBlend > 2 ? 2 : pose.stanceBlend > 0 ? pose.stanceBlend : 0;
  let from: RigFitPose;
  let to: RigFitPose;
  let t: number;
  if (blend <= 1) {
    from = RIG_FIT_POSES[0];
    to = RIG_FIT_POSES[1];
    t = blend;
  } else {
    from = RIG_FIT_POSES[1];
    to = RIG_FIT_POSES[2];
    t = blend - 1;
  }
  const u = 1 - t;

  const sinYaw = Math.sin(pose.yaw);
  const cosYaw = Math.cos(pose.yaw);
  const pitch = pose.pitch < -MAX_PITCH ? -MAX_PITCH : pose.pitch > MAX_PITCH ? MAX_PITCH : pose.pitch;
  const pitchScale = from.pitchScale * u + to.pitchScale * t;
  const pivotY = from.pivot[1] * u + to.pivot[1] * t;
  const pivotZ = from.pivot[2] * u + to.pivot[2] * t;
  const px = pose.x;
  const py = pose.y;
  const pz = pose.z;

  for (let i = 0; i < RIG_SHAPE_COUNT; i++) {
    const a = from.shapes[i]!;
    const b = to.shapes[i]!;
    const o = i * RIG_SHAPE_STRIDE;
    const kind = a.kind === "sphere" ? RigShapeKind.sphere : a.kind === "capsule" ? RigShapeKind.capsule : RigShapeKind.box;
    const angle = pitch * pitchScale * RIG_PITCH_SHARE[i]!;
    const sinP = Math.sin(angle);
    const cosP = Math.cos(angle);

    out[o] = kind;
    out[o + 1] = a.zone === "head" ? 0 : a.zone === "body" ? 1 : 2;
    // Local point → pitch around the pivot (local X axis) → yaw → world.
    for (let k = 0; k < 2; k++) {
      const src0 = k === 0 ? a.a : a.b;
      const src1 = k === 0 ? b.a : b.b;
      const lx = src0[0] * u + src1[0] * t;
      const ly0 = src0[1] * u + src1[1] * t - pivotY;
      const lz0 = src0[2] * u + src1[2] * t - pivotZ;
      const ly = ly0 * cosP - lz0 * sinP + pivotY;
      const lz = ly0 * sinP + lz0 * cosP + pivotZ;
      const w = o + 2 + k * 3;
      out[w] = px + lx * cosYaw + lz * sinYaw;
      out[w + 1] = py + ly;
      out[w + 2] = pz - lx * sinYaw + lz * cosYaw;
    }
    out[o + 8] = a.radius * u + b.radius * t;
    out[o + 9] = a.half[0] * u + b.half[0] * t;
    out[o + 10] = a.half[1] * u + b.half[1] * t;
    out[o + 11] = a.half[2] * u + b.half[2] * t;
    // Orientation: yaw about Y, then (lean + pitch share) about local X: q = qYaw · qX.
    const half = 0.5 * (a.lean * u + b.lean * t + angle);
    const sx = Math.sin(half);
    const cx = Math.cos(half);
    const sy = Math.sin(pose.yaw * 0.5);
    const cy = Math.cos(pose.yaw * 0.5);
    out[o + 12] = cy * sx;
    out[o + 13] = sy * cx;
    out[o + 14] = -sy * sx;
    out[o + 15] = cy * cx;
  }
}

/** Cheap broadphase: does segment a→b come within the rig's bounding sphere around the pose's feet? */
export function segmentNearRig(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  return segmentSphereT(ax, ay, az, bx, by, bz, px, py + RIG_BOUNDS_CENTER_Y, pz, RIG_BOUNDS_RADIUS) >= 0;
}

const scratchHit: MutableRigHit = { t: 0, shape: 0, zone: "body" };

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
  if (!segmentVsRigInto(shapes, ax, ay, az, bx, by, bz, scratchHit)) return null;
  return { t: scratchHit.t, shape: scratchHit.shape, zone: scratchHit.zone };
}

/** Allocation-free `segmentVsRig`: writes the nearest hit into `out` and returns true, or returns false. */
export function segmentVsRigInto(shapes: Float64Array, ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: MutableRigHit): boolean {
  let best = 2;
  let bestShape = -1;
  for (let i = 0; i < RIG_SHAPE_COUNT; i++) {
    const o = i * RIG_SHAPE_STRIDE;
    const kind = shapes[o]!;
    let t: number;
    if (kind === RigShapeKind.sphere) {
      t = segmentSphereT(ax, ay, az, bx, by, bz, shapes[o + 2]!, shapes[o + 3]!, shapes[o + 4]!, shapes[o + 8]!);
    } else if (kind === RigShapeKind.capsule) {
      t = segmentCapsuleT(ax, ay, az, bx, by, bz, shapes[o + 2]!, shapes[o + 3]!, shapes[o + 4]!, shapes[o + 5]!, shapes[o + 6]!, shapes[o + 7]!, shapes[o + 8]!);
    } else {
      t = segmentBoxT(shapes, o, ax, ay, az, bx, by, bz);
    }
    if (t >= 0 && t < best) {
      best = t;
      bestShape = i;
    }
  }
  if (bestShape < 0) return false;
  out.t = best;
  out.shape = bestShape;
  out.zone = RIG_ZONES[shapes[bestShape * RIG_SHAPE_STRIDE + 1]!]!;
  return true;
}

/** First t in [0, 1] where the segment is inside the sphere (0 when it starts inside), or -1. */
export function segmentSphereT(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, r: number): number {
  const mx = ax - cx;
  const my = ay - cy;
  const mz = az - cz;
  const c = mx * mx + my * my + mz * mz - r * r;
  if (c <= 0) return 0;
  const nx = bx - ax;
  const ny = by - ay;
  const nz = bz - az;
  const a = nx * nx + ny * ny + nz * nz;
  if (a < EPS) return -1;
  const b = mx * nx + my * ny + mz * nz;
  if (b >= 0) return -1;
  const disc = b * b - a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : -1;
}

/** First t in [0, 1] where the segment is inside the capsule p→q of radius r, or -1. */
export function segmentCapsuleT(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  px: number,
  py: number,
  pz: number,
  qx: number,
  qy: number,
  qz: number,
  r: number,
): number {
  const dx = qx - px;
  const dy = qy - py;
  const dz = qz - pz;
  const mx = ax - px;
  const my = ay - py;
  const mz = az - pz;
  const nx = bx - ax;
  const ny = by - ay;
  const nz = bz - az;
  const dd = dx * dx + dy * dy + dz * dz;
  const md = mx * dx + my * dy + mz * dz;
  const nd = nx * dx + ny * dy + nz * dz;
  const nn = nx * nx + ny * ny + nz * nz;
  const mn = mx * nx + my * ny + mz * nz;
  const mm = mx * mx + my * my + mz * mz;

  // Starts inside: distance from a to the axis segment.
  const s0 = dd > EPS ? clamp01(md / dd) : 0;
  const ex = mx - dx * s0;
  const ey = my - dy * s0;
  const ez = mz - dz * s0;
  if (ex * ex + ey * ey + ez * ez <= r * r) return 0;

  let best = -1;
  // Cylinder side between the end planes.
  if (dd > EPS) {
    const a = dd * nn - nd * nd;
    const k = mm - r * r;
    const c = dd * k - md * md;
    if (a > EPS) {
      const b = dd * mn - nd * md;
      const disc = b * b - a * c;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / a;
        if (t >= 0 && t <= 1) {
          const s = md + t * nd;
          if (s >= 0 && s <= dd) best = t;
        }
      }
    }
  }
  const t0 = segmentSphereT(ax, ay, az, bx, by, bz, px, py, pz, r);
  if (t0 >= 0 && (best < 0 || t0 < best)) best = t0;
  const t1 = segmentSphereT(ax, ay, az, bx, by, bz, qx, qy, qz, r);
  if (t1 >= 0 && (best < 0 || t1 < best)) best = t1;
  return best;
}

/** Slab test in the box's frame (shape at `o` in the rig buffer). */
function segmentBoxT(shapes: Float64Array, o: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const cx = shapes[o + 2]!;
  const cy = shapes[o + 3]!;
  const cz = shapes[o + 4]!;
  const hx = shapes[o + 9]!;
  const hy = shapes[o + 10]!;
  const hz = shapes[o + 11]!;
  // Conjugate rotation (world → local): u = -q.xyz.
  const ux = -shapes[o + 12]!;
  const uy = -shapes[o + 13]!;
  const uz = -shapes[o + 14]!;
  const w = shapes[o + 15]!;

  // Local start point.
  let vx = ax - cx;
  let vy = ay - cy;
  let vz = az - cz;
  let tx = 2 * (uy * vz - uz * vy);
  let ty = 2 * (uz * vx - ux * vz);
  let tz = 2 * (ux * vy - uy * vx);
  const sx = vx + w * tx + (uy * tz - uz * ty);
  const sy = vy + w * ty + (uz * tx - ux * tz);
  const sz = vz + w * tz + (ux * ty - uy * tx);
  // Local direction.
  vx = bx - ax;
  vy = by - ay;
  vz = bz - az;
  tx = 2 * (uy * vz - uz * vy);
  ty = 2 * (uz * vx - ux * vz);
  tz = 2 * (ux * vy - uy * vx);
  const dx = vx + w * tx + (uy * tz - uz * ty);
  const dy = vy + w * ty + (uz * tx - ux * tz);
  const dz = vz + w * tz + (ux * ty - uy * tx);

  let tmin = 0;
  let tmax = 1;
  // X slab
  if (Math.abs(dx) < EPS) {
    if (sx < -hx || sx > hx) return -1;
  } else {
    let t1 = (-hx - sx) / dx;
    let t2 = (hx - sx) / dx;
    if (t1 > t2) {
      const s = t1;
      t1 = t2;
      t2 = s;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dy) < EPS) {
    if (sy < -hy || sy > hy) return -1;
  } else {
    let t1 = (-hy - sy) / dy;
    let t2 = (hy - sy) / dy;
    if (t1 > t2) {
      const s = t1;
      t1 = t2;
      t2 = s;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  if (Math.abs(dz) < EPS) {
    if (sz < -hz || sz > hz) return -1;
  } else {
    let t1 = (-hz - sz) / dz;
    let t2 = (hz - sz) / dz;
    if (t1 > t2) {
      const s = t1;
      t1 = t2;
      t2 = s;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
