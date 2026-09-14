import { describe, expect, it } from "vitest";
import { dequantizePitch as sharedDequantizePitch, dequantizeYaw as sharedDequantizeYaw, quantizePitch as sharedQuantizePitch, quantizeYaw as sharedQuantizeYaw } from "@twobullets/shared/aim";
import * as Q from "../src/quantize";
import { createTestRng } from "./rng";

const rng = createTestRng(7);
const N = 20000;

describe("quantizers", () => {
  it("positions: ≤ 0.5 mm error inside the range, clamped outside", () => {
    for (let i = 0; i < N; i++) {
      const x = -520 + rng() * 1040;
      const y = -11 + rng() * 520;
      expect(Math.abs(Q.dequantizePosXZ(Q.quantizePosXZ(x)) - x)).toBeLessThanOrEqual(0.0005 + 1e-9);
      expect(Math.abs(Q.dequantizePosY(Q.quantizePosY(y)) - y)).toBeLessThanOrEqual(0.0005 + 1e-9);
    }
    expect(Q.quantizePosXZ(-1e6)).toBe(0);
    expect(Q.quantizePosXZ(1e6)).toBe(Q.POS_XZ_MAX_Q);
    expect(Q.quantizePosY(1e6)).toBe(Q.POS_Y_MAX_Q);
    // The playable ±500 m square and the 640 m terrain border's inner part fit.
    expect(Q.dequantizePosXZ(Q.POS_XZ_MAX_Q)).toBeGreaterThan(524);
    expect(Q.dequantizePosXZ(0)).toBeLessThan(-524);
  });

  it("aim: the shared/aim layout (yaw ≤ π/2^20, pitch zero-exact), dequantize→quantize is identity", () => {
    const yawBound = Math.PI / 2 ** Q.AIM_YAW_BITS + 1e-12;
    const pitchStep = Q.MAX_PITCH_RAD / (2 ** (Q.AIM_PITCH_BITS - 1) - 1);
    for (let i = 0; i < N; i++) {
      const yaw = (rng() - 0.5) * 40;
      const q = Q.quantizeAimYaw(yaw);
      expect(q).toBe(sharedQuantizeYaw(yaw));
      expect(q).toBeGreaterThanOrEqual(0);
      expect(q).toBeLessThan(2 ** Q.AIM_YAW_BITS);
      const back = Q.dequantizeAimYaw(q);
      let d = Math.abs(back - (((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)));
      d = Math.min(d, 2 * Math.PI - d);
      expect(d).toBeLessThanOrEqual(yawBound);
      expect(Q.quantizeAimYaw(back)).toBe(q);

      const pitch = (rng() * 2 - 1) * Q.MAX_PITCH_RAD;
      const pq = Q.quantizeAimPitch(pitch);
      expect(pq).toBe(sharedQuantizePitch(pitch));
      expect(Math.abs(Q.dequantizeAimPitch(pq) - pitch)).toBeLessThanOrEqual(pitchStep / 2 + 1e-12);
      expect(Q.quantizeAimPitch(Q.dequantizeAimPitch(pq))).toBe(pq);
    }
    for (let q = 0; q < 2 ** Q.AIM_PITCH_BITS - 1; q++) expect(Q.dequantizeAimPitch(q)).toBe(sharedDequantizePitch(q));
    for (let q = 0; q < 2 ** Q.AIM_YAW_BITS; q += 3) expect(Q.dequantizeAimYaw(q)).toBe(sharedDequantizeYaw(q));
    expect(Q.dequantizeAimPitch(0)).toBeCloseTo(-Q.MAX_PITCH_RAD, 12);
    expect(Q.dequantizeAimPitch(2 ** Q.AIM_PITCH_BITS - 2)).toBeCloseTo(Q.MAX_PITCH_RAD, 12);
    expect(Q.dequantizeAimPitch(2 ** (Q.AIM_PITCH_BITS - 1) - 1)).toBe(0);
    // netcode.md §6.3: 6.0 µrad / 11.8 µrad steps.
    expect((2 * Math.PI) / 2 ** 20).toBeLessThan(6.0e-6);
    expect(pitchStep).toBeLessThan(11.9e-6);
  });

  it("remote angles and velocities", () => {
    for (let i = 0; i < N; i++) {
      const yaw = rng() * 2 * Math.PI;
      let d = Math.abs(Q.dequantizeYaw(Q.quantizeYaw(yaw, 12), 12) - yaw);
      d = Math.min(d, 2 * Math.PI - d);
      expect(d).toBeLessThanOrEqual(Math.PI / 4096 + 1e-12);
      const v = (rng() * 2 - 1) * 63.8;
      expect(Math.abs(Q.dequantizeRemoteVel(Q.quantizeRemoteVel(v)) - v)).toBeLessThanOrEqual(0.0625 + 1e-12);
      const ov = (rng() * 2 - 1) * 65;
      expect(Math.abs(Q.dequantizeOwnerVel(Q.quantizeOwnerVel(ov)) - ov)).toBeLessThanOrEqual(0.0005 + 1e-12);
    }
    expect(Q.quantizeRemoteVel(1000)).toBe(Q.REMOTE_VEL_MAX_Q);
    expect(Q.quantizeOwnerVel(-1000)).toBe(-Q.OWNER_VEL_MAX_Q);
  });

  it("audible-only 0.5 m positions", () => {
    for (let i = 0; i < 2000; i++) {
      const xMm = Q.quantizePosXZ(-500 + rng() * 1000);
      const yMm = Q.quantizePosY(rng() * 400);
      expect(Math.abs(Q.audibleXZToMm(Q.audibleXZFromMm(xMm)) - xMm)).toBeLessThanOrEqual(250);
      expect(Math.abs(Q.audibleYToMm(Q.audibleYFromMm(yMm)) - yMm)).toBeLessThanOrEqual(250);
    }
  });

  it("ticks and health", () => {
    expect(Q.quantizeTicks(0.1, 4)).toBe(6);
    expect(Q.quantizeTicks(10, 4)).toBe(15);
    expect(Q.quantizeHealth(73.25, 10)).toBe(733);
    expect(Q.dequantizeHealth(733)).toBeCloseTo(73.3, 10);
  });
});
