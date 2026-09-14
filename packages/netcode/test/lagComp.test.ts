import { poseHitboxes, RIG_BUFFER_LENGTH, segmentVsRig, type HitPose, type MutableRigHit } from "@twobullets/shared/hitreg/rig";
import { describe, expect, it } from "vitest";
import { clampViewDelayTicks, LagCompHistory, MAX_REWIND_TICKS } from "../src/hitreg/LagCompHistory";

const createMutableRigHit = (): MutableRigHit => ({ t: 0, shape: 0, zone: "body" });

const pose = (x: number, z: number, yaw = 0, pitch = 0, stanceBlend = 0, y = 0): HitPose => ({ x, y, z, yaw, pitch, stanceBlend });
const blank = (): HitPose => pose(0, 0);

describe("LagCompHistory", () => {
  it("returns the exact recorded pose at integer ticks", () => {
    const h = new LagCompHistory();
    const out = blank();
    for (let t = 1000; t < 1040; t++) {
      for (let slot = 0; slot < 16; slot++) h.record(t, slot, pose(slot * 1.1 + t * 0.0137, -t * 0.071, (t * 0.3) % 6, 0.01 * slot, (t % 3) * 0.5, 12.345 + slot));
    }
    for (let t = 1040 - 32; t < 1040; t++) {
      for (let slot = 0; slot < 16; slot++) {
        expect(h.sample(slot, t, out)).toBe(true);
        expect(out).toEqual(pose(slot * 1.1 + t * 0.0137, -t * 0.071, (t * 0.3) % 6, 0.01 * slot, (t % 3) * 0.5, 12.345 + slot));
      }
    }
    // Overwritten by the 32-tick ring, and never recorded.
    expect(h.sample(3, 1040 - 33, out)).toBe(false);
    expect(h.sample(3, 1040, out)).toBe(false);
    expect(h.has(3, 1039)).toBe(true);
    expect(h.has(3, 1007)).toBe(false);
  });

  it("interpolates between ticks with shortest-arc yaw, and snaps across a teleport", () => {
    const h = new LagCompHistory();
    const out = blank();
    h.record(10, 2, pose(0, 0, 3.0, -0.2, 0, 1));
    h.record(11, 2, pose(1, -2, -3.0, 0.2, 1, 2));
    expect(h.sample(2, 10.25, out)).toBe(true);
    expect(out.x).toBeCloseTo(0.25, 12);
    expect(out.z).toBeCloseTo(-0.5, 12);
    expect(out.y).toBeCloseTo(1.25, 12);
    expect(out.pitch).toBeCloseTo(-0.1, 12);
    expect(out.stanceBlend).toBeCloseTo(0.25, 12);
    // 3.0 → −3.0 wraps through π: a quarter of the 0.283 rad arc.
    expect(out.yaw).toBeCloseTo(3.0 + (2 * Math.PI - 6) * 0.25, 12);
    expect(h.sample(2, 11.5, out)).toBe(false);

    h.record(12, 2, pose(50, 50), false);
    expect(h.sample(2, 11.4, out)).toBe(true);
    expect(out.x).toBe(1);
    expect(h.sample(2, 11.6, out)).toBe(true);
    expect(out.x).toBe(50);
    h.clear(2);
    expect(h.sample(2, 12, out)).toBe(false);
  });

  it("MAX_REWIND: a hit at exactly MAX_REWIND passes and one tick beyond fails", () => {
    const h = new LagCompHistory();
    const hit = createMutableRigHit();
    const present = 5000;
    // A segment across z at chest height through x = 0 (a bullet's per-tick segment).
    const seg = [0, 1.3, -3, 0, 1.3, 3] as const;
    const run = (standsInLineAt: number, viewDelay: number): boolean => {
      for (let t = present - 31; t <= present; t++) h.record(t, 7, t === standsInLineAt ? pose(0, 0) : pose(4, 0));
      return h.segmentVsRig(7, h.rewindTick(present, viewDelay), seg[0], seg[1], seg[2], seg[3], seg[4], seg[5], hit);
    };
    expect(run(present - MAX_REWIND_TICKS, MAX_REWIND_TICKS)).toBe(true);
    expect(hit.zone).toBe("body");
    expect(h.stats.rewindClamps).toBe(0);

    expect(run(present - MAX_REWIND_TICKS - 1, MAX_REWIND_TICKS + 1)).toBe(false);
    expect(h.stats.rewindClamps).toBe(1);
    // The pose one tick beyond is still in history: the clamp, not a missing sample, rejects it.
    expect(h.has(7, present - MAX_REWIND_TICKS - 1)).toBe(true);
    expect(h.segmentVsRig(7, present - MAX_REWIND_TICKS - 1, seg[0], seg[1], seg[2], seg[3], seg[4], seg[5], hit)).toBe(true);

    // Fractional D samples between ticks: half-way from the in-line pose (x 0) to the next (x 4).
    expect(run(present - MAX_REWIND_TICKS, 0)).toBe(false);
    const between = blank();
    expect(h.sample(7, h.rewindTick(present, MAX_REWIND_TICKS - 0.5), between)).toBe(true);
    expect(between.x).toBe(2);
  });

  it("caches posed rigs per (slot, sample tick) until the slot records again", () => {
    const h = new LagCompHistory();
    for (let t = 0; t < 20; t++) for (let s = 0; s < 3; s++) h.record(t, s, pose(s * 3 + t * 0.1, t * 0.05, t * 0.2, 0.1, t % 2));
    const a = h.posedRig(1, 15.5)!;
    const expected = new Float64Array(RIG_BUFFER_LENGTH);
    const sampled = blank();
    h.sample(1, 15.5, sampled);
    poseHitboxes(sampled, expected);
    expect(Array.from(a)).toEqual(Array.from(expected));
    expect(h.stats.poseEvals).toBe(1);
    for (let i = 0; i < 100; i++) expect(h.posedRig(1, 15.5)).toBe(a);
    expect(h.stats.cacheHits).toBe(100);
    expect(h.stats.poseEvals).toBe(1);
    h.posedRig(2, 15.5);
    h.posedRig(1, 14);
    expect(h.stats.poseEvals).toBe(3);
    h.record(20, 1, pose(0, 0));
    h.posedRig(1, 15.5);
    expect(h.stats.poseEvals).toBe(4);
    // Segment results match the shared intersector on the same posed rig.
    const hit = createMutableRigHit();
    const direct = segmentVsRig(h.posedRig(2, 12)!, 6.6, 1.2, -2, 6.6, 1.2, 3);
    expect(h.segmentVsRig(2, 12, 6.6, 1.2, -2, 6.6, 1.2, 3, hit)).toBe(direct !== null);
    if (direct) expect(hit.t).toBe(direct.t);
  });

  it("clampViewDelayTicks: claim within expected ± 2, then [0, MAX_REWIND]", () => {
    expect(clampViewDelayTicks(6, 5)).toBe(6);
    expect(clampViewDelayTicks(9, 5)).toBe(7);
    expect(clampViewDelayTicks(0, 5)).toBe(3);
    expect(clampViewDelayTicks(30, 14)).toBe(MAX_REWIND_TICKS);
    expect(clampViewDelayTicks(0, 1)).toBe(0);
    expect(clampViewDelayTicks(Number.NaN, 4)).toBe(4);
    expect(clampViewDelayTicks(3, -5)).toBe(0);
  });
});
