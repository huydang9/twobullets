import { describe, expect, it } from "vitest";
import { RIG_BOUNDS_CENTER_Y, RIG_BOUNDS_RADIUS } from "./rigFit";
import {
  poseHitboxes,
  RIG_BUFFER_LENGTH,
  RIG_SHAPE_COUNT,
  RIG_SHAPE_STRIDE,
  RigShapeKind,
  segmentCapsuleT,
  segmentNearRig,
  segmentSphereT,
  segmentVsRig,
  type HitPose,
} from "./rig";

const buffer = new Float64Array(RIG_BUFFER_LENGTH);

function pose(p: Partial<HitPose> = {}): Float64Array {
  poseHitboxes({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, stanceBlend: 0, ...p }, buffer);
  return buffer;
}

/** Horizontal shot from 20 m in front (+Z) toward the soldier at height y, lateral offset x. */
function shootFromFront(shapes: Float64Array, y: number, x = 0) {
  return segmentVsRig(shapes, x, y, 20, x, y, -20);
}

describe("segment intersectors", () => {
  it("sphere: entry t, start inside, miss, behind", () => {
    expect(segmentSphereT(-2, 0, 0, 2, 0, 0, 0, 0, 0, 1)).toBeCloseTo(0.25, 9);
    expect(segmentSphereT(0.1, 0, 0, 2, 0, 0, 0, 0, 0, 1)).toBe(0);
    expect(segmentSphereT(-2, 1.01, 0, 2, 1.01, 0, 0, 0, 0, 1)).toBe(-1);
    expect(segmentSphereT(2, 0, 0, 5, 0, 0, 0, 0, 0, 1)).toBe(-1);
  });

  it("capsule: side, cap, parallel along the axis", () => {
    // Vertical capsule y 0..1, r 0.5; horizontal ray at y 0.5 enters the side at x = -0.5.
    expect(segmentCapsuleT(-2, 0.5, 0, 2, 0.5, 0, 0, 0, 0, 0, 1, 0, 0.5)).toBeCloseTo(1.5 / 4, 9);
    // Ray at y 1.3 touches only the top cap (sphere at y 1, r 0.5): x = -0.4.
    expect(segmentCapsuleT(-2, 1.3, 0, 2, 1.3, 0, 0, 0, 0, 0, 1, 0, 0.5)).toBeCloseTo(1.6 / 4, 9);
    // Straight down the axis from above: hits the top cap at y 1.5.
    expect(segmentCapsuleT(0, 3, 0, 0, -3, 0, 0, 0, 0, 0, 1, 0, 0.5)).toBeCloseTo(1.5 / 6, 9);
    expect(segmentCapsuleT(-2, 2, 0, 2, 2, 0, 0, 0, 0, 0, 1, 0, 0.5)).toBe(-1);
  });
});

describe("poseHitboxes / segmentVsRig", () => {
  it("writes 13 shapes with the SOLDIER_HITBOXES kinds and zones", () => {
    const shapes = pose();
    const kinds = Array.from({ length: RIG_SHAPE_COUNT }, (_, i) => shapes[i * RIG_SHAPE_STRIDE]);
    const zones = Array.from({ length: RIG_SHAPE_COUNT }, (_, i) => shapes[i * RIG_SHAPE_STRIDE + 1]);
    expect(kinds).toEqual([0, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(zones).toEqual([0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it("standing: head at eye height, chest, abdomen, legs; misses above and beside", () => {
    const shapes = pose();
    expect(shootFromFront(shapes, 1.66)?.zone).toBe("head");
    // Torso from behind (the aiming arms cover the front).
    expect(segmentVsRig(shapes, -0.1, 1.3, -20, -0.1, 1.3, 20)?.zone).toBe("body");
    expect(segmentVsRig(shapes, 0, 1.05, -20, 0, 1.05, 20)?.zone).toBe("body");
    expect(shootFromFront(shapes, 0.95)?.zone).toBe("body");
    expect(shootFromFront(shapes, 0.3, 0.12)?.zone).toBe("limb");
    expect(shootFromFront(shapes, 0.7, -0.11)?.zone).toBe("limb");
    expect(shootFromFront(shapes, 1.85)).toBeNull();
    expect(shootFromFront(shapes, 1.0, 0.6)).toBeNull();
    // Between the legs below the pelvis.
    expect(shootFromFront(shapes, 0.4, 0)).toBeNull();
  });

  it("nearest shape wins: a shot at the rifle arm hits the forearm before the chest", () => {
    const shapes = pose();
    const hit = shootFromFront(shapes, 1.29, 0.1);
    expect(hit?.zone).toBe("limb");
    const behind = segmentVsRig(shapes, 0.1, 1.29, -20, 0.1, 1.29, 20);
    expect(behind?.zone).toBe("body");
  });

  it("the hit t is the entry point along the segment", () => {
    const shapes = pose();
    const hit = segmentVsRig(shapes, 0, 1.665, 10, 0, 1.665, -10)!;
    // Head sphere centre z 0.035, r ≈ 0.1264: entry at z ≈ 0.1614.
    expect(10 - hit.t * 20).toBeCloseTo(0.035 + 0.125 * (1.8 / 1.78), 6);
  });

  it("crouched: a standing head-height shot misses, crouched head height hits", () => {
    const shapes = pose({ stanceBlend: 1 });
    expect(shootFromFront(shapes, 1.66)).toBeNull();
    expect(shootFromFront(shapes, 0.97)?.zone).toBe("head");
    expect(segmentVsRig(shapes, 0, 0.62, -20, 0, 0.62, 20)?.zone).toBe("body");
  });

  it("prone: only low shots hit; the head is forward along the facing direction", () => {
    const shapes = pose({ stanceBlend: 2 });
    expect(shootFromFront(shapes, 0.9)).toBeNull();
    expect(segmentVsRig(shapes, 0, 5, 0.8, 0, -1, 0.8)?.zone).toBe("head");
    expect(segmentVsRig(shapes, 0, 5, 0.3, 0, -1, 0.3)?.zone).toBe("body");
    expect(segmentVsRig(shapes, -0.15, 5, -0.8, -0.15, -1, -0.8)?.zone).toBe("limb");
    expect(segmentVsRig(shapes, 0, 5, -1.3, 0, -1, -1.3)).toBeNull();
  });

  it("stance blend 0.5 sits between stand and crouch", () => {
    const head = (blend: number) => pose({ stanceBlend: blend })[3]!;
    expect(head(0.5)).toBeCloseTo((head(0) + head(1)) / 2, 9);
    expect(head(1.5)).toBeCloseTo((head(1) + head(2)) / 2, 9);
  });

  it("yaw turns the rig: facing +X, the head is offset along +X and the rifle arm toward -Z", () => {
    const shapes = pose({ yaw: Math.PI / 2 });
    expect(shapes[2]).toBeCloseTo(0.035, 9);
    expect(shapes[4]).toBeCloseTo(0, 9);
    // Right upper arm start at local x +0.2 → world z -0.2.
    const arm = 6 * RIG_SHAPE_STRIDE;
    expect(shapes[arm + 4]).toBeCloseTo(-0.2, 9);
    // A shot from behind (-X) at chest height hits the chest box.
    expect(segmentVsRig(shapes, -20, 1.3, 0, 20, 1.3, 0)?.shape).toBe(2);
  });

  it("box quaternions rotate local axes into the posed frame", () => {
    const shapes = pose({ yaw: Math.PI / 2, stanceBlend: 2 });
    const chest = 2 * RIG_SHAPE_STRIDE;
    const [x, y, z, w] = [shapes[chest + 12]!, shapes[chest + 13]!, shapes[chest + 14]!, shapes[chest + 15]!];
    expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 12);
    const rotate = (vx: number, vy: number, vz: number) => {
      const tx = 2 * (y * vz - z * vy);
      const ty = 2 * (z * vx - x * vz);
      const tz = 2 * (x * vy - y * vx);
      return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)].map((v) => Math.round(v * 1e9) / 1e9 + 0);
    };
    // Prone (lean 90°) facing +X: the box's long axis (local Y) points along +X, its depth (local Z) points down.
    expect(rotate(0, 1, 0)).toEqual([1, 0, 0]);
    expect(rotate(0, 0, 1)).toEqual([0, -1, 0]);
    expect(rotate(1, 0, 0)).toEqual([0, 0, -1]);
    // A shot straight down through the posed chest centre hits it; 
    expect(segmentVsRig(shapes, shapes[chest + 2]!, 3, shapes[chest + 4]!, shapes[chest + 2]!, 0.3, shapes[chest + 4]!)?.shape).toBe(2);
  });

  it("aim pitch moves the head and arms but not the legs", () => {
    const level = Float64Array.from(pose());
    const down = pose({ pitch: 0.6 });
    expect(down[3]).toBeLessThan(level[3]!);
    const armEnd = 7 * RIG_SHAPE_STRIDE + 6;
    expect(down[armEnd]).toBeLessThan(level[armEnd]! - 0.1);
    const shin = 11 * RIG_SHAPE_STRIDE;
    expect(Array.from(down.subarray(shin, shin + RIG_SHAPE_STRIDE))).toEqual(Array.from(level.subarray(shin, shin + RIG_SHAPE_STRIDE)));
  });

  it("every shape stays inside the broadphase sphere for any stance, yaw and pitch", () => {
    for (const blend of [0, 0.5, 1, 1.5, 2]) {
      for (const pitch of [-1.4, 0, 1.4]) {
        const shapes = pose({ x: 3, y: 2, z: -4, yaw: 1.1, pitch, stanceBlend: blend });
        for (let i = 0; i < RIG_SHAPE_COUNT; i++) {
          const o = i * RIG_SHAPE_STRIDE;
          const kind = shapes[o]!;
          const extent = kind === RigShapeKind.box ? Math.hypot(shapes[o + 9]!, shapes[o + 10]!, shapes[o + 11]!) : shapes[o + 8]!;
          for (const p of kind === RigShapeKind.capsule ? [2, 5] : [2]) {
            const d = Math.hypot(shapes[o + p]! - 3, shapes[o + p + 1]! - (2 + RIG_BOUNDS_CENTER_Y), shapes[o + p + 2]! + 4);
            expect(d + extent, `shape ${i} blend ${blend} pitch ${pitch}`).toBeLessThanOrEqual(RIG_BOUNDS_RADIUS);
          }
        }
      }
    }
    expect(segmentNearRig(0, 0, 0, 5, 1, 5, -5, 1, 5)).toBe(false);
    expect(segmentNearRig(0, 0, 0, 5, 1, 0.5, -5, 1, 0.5)).toBe(true);
  });

  it("is deterministic and allocation-free in shape", () => {
    const a = Float64Array.from(pose({ x: 1.25, y: 3, z: 7, yaw: 2.5, pitch: -0.3, stanceBlend: 0.7 }));
    const b = pose({ x: 1.25, y: 3, z: 7, yaw: 2.5, pitch: -0.3, stanceBlend: 0.7 });
    expect(Array.from(b)).toEqual(Array.from(a));
  });
});
