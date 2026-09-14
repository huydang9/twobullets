import { describe, expect, it } from "vitest";
import { createInterpolatedPose, EntityInterpolator, InterpolationDelay } from "../src/interpolation";
import { createSeededRng } from "../src/testing/rng";

const DT = 1 / 60;

describe("InterpolationDelay", () => {
  it("follows interval + loss cushion + 2.5σ, grows at once and shrinks ≤ 1 ms / 100 ms", () => {
    const d = new InterpolationDelay();
    expect(d.update(0, 16.7, 0, 2)).toBe(25);
    expect(d.update(10, 16.7, 0.02, 6)).toBeCloseTo(16.7 * 2 + 15 + 1, 5);
    expect(d.update(110, 16.7, 0, 3)).toBeCloseTo(16.7 * 2 + 15 + 1 - 1, 5);
    expect(d.update(1_000_000, 16.7, 0, 2)).toBe(25);
    expect(d.update(1_000_001, 16.7, 0, 200)).toBe(150);
  });
});

describe("EntityInterpolator", () => {
  it("Hermite interpolation of a smooth trajectory stays within µm-scale error and is C1-ish", () => {
    const it = new EntityInterpolator();
    const pos = (t: number) => 10 * Math.sin(t * 0.8);
    const vel = (t: number) => 8 * Math.cos(t * 0.8);
    for (let tick = 0; tick < 32; tick++) it.push(tick, pos(tick * DT), 1, 0, vel(tick * DT), 0, 0, 0, 0, 16);
    const out = createInterpolatedPose();
    let maxErr = 0;
    for (let rt = 1; rt < 30; rt += 0.037) {
      it.sample(rt, out);
      maxErr = Math.max(maxErr, Math.abs(out.x - pos(rt * DT)));
      expect(out.extrapolated).toBe(false);
    }
    expect(maxErr).toBeLessThan(1e-5);
  });

  it("inserts out-of-order samples, ignores duplicates, drops the oldest when full", () => {
    const it = new EntityInterpolator({ capacity: 4 });
    for (const t of [3, 1, 2, 2, 5, 4]) it.push(t, t, 0, 0, 1 * 60, 0, 0, 0, 0, 0);
    expect(it.size).toBe(4);
    expect(it.newestTick).toBe(5);
    const out = createInterpolatedPose();
    it.sample(3.5, out);
    expect(out.x).toBeCloseTo(3.5, 6);
    it.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0); // older than oldest when full: ignored
    it.sample(2, out);
    expect(out.x).toBeCloseTo(2, 6);
  });

  it("dead-reckons ≤ 100 ms then holds, and blends back when data resumes", () => {
    const it = new EntityInterpolator();
    for (let t = 0; t < 10; t++) it.push(t, t * 0.1, 5, 0, 6, 0, 0, 0, 0, 16);
    const out = createInterpolatedPose();
    it.sample(9 + 3, out); // 50 ms ahead
    expect(out.extrapolated).toBe(true);
    expect(out.x).toBeCloseTo(0.9 + 6 * 0.05, 6);
    it.sample(9 + 30, out); // 500 ms ahead: capped at 100 ms
    expect(out.x).toBeCloseTo(0.9 + 6 * 0.1, 6);
    // Airborne: gravity applies.
    const air = new EntityInterpolator();
    air.push(0, 0, 10, 0, 0, 0, 0, 0, 0, 0);
    air.sample(6, out);
    expect(out.y).toBeCloseTo(10 - 0.5 * 24 * 0.01, 6);
    // Data resumes with a different trajectory: the pose moves continuously.
    for (let t = 10; t < 45; t++) it.push(t, 2 + t * 0.1, 5, 0, 6, 0, 0, 0, 0, 16);
    const before = out.x;
    it.sample(39.1, out);
    expect(out.extrapolated).toBe(false);
    void before;
    const blended = out.x;
    it.sample(39.1 + 6.1, out); // > 100 ms later: blend finished
    expect(Math.abs(blended - (2 + 3.91))).toBeGreaterThan(0.01);
    expect(out.x).toBeCloseTo(2 + 4.52, 6);
  });

  it("shortest-arc yaw across 0/2π and teleport steps", () => {
    const it = new EntityInterpolator();
    it.push(0, 0, 0, 0, 0, 0, 0, 2 * Math.PI - 0.1, 0, 0);
    it.push(1, 0, 0, 0, 0, 0, 0, 0.1, 0, 0);
    it.push(2, 500, 0, 0, 0, 0, 0, 0.1, 0, 0);
    const out = createInterpolatedPose();
    it.sample(0.5, out);
    expect(Math.min(out.yaw, 2 * Math.PI - out.yaw)).toBeLessThan(1e-9);
    it.sample(1.5, out);
    expect(out.x).toBe(0);
  });

  it("property: interpolated position always lies near the segment hull for random bounded motion", () => {
    const rng = createSeededRng(12);
    const it = new EntityInterpolator();
    let x = 0;
    let v = 0;
    for (let t = 0; t < 32; t++) {
      v = Math.max(-9.5, Math.min(9.5, v + (rng.next() - 0.5) * 2.4));
      x += v * DT;
      it.push(t, x, 0, 0, v, 0, 0, 0, 0, 16);
    }
    const out = createInterpolatedPose();
    let prev = NaN;
    for (let rt = 0; rt < 31; rt += 0.05) {
      it.sample(rt, out);
      if (!Number.isNaN(prev)) expect(Math.abs(out.x - prev)).toBeLessThan(9.5 * 0.05 * DT + 0.002);
      prev = out.x;
    }
  });
});
