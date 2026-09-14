import { describe, expect, it } from "vitest";
import { dequantizePitch, dequantizeYaw, quantizePitch, quantizeYaw } from "./aim";
import { CAMERA } from "./constants";
import { createRng } from "./equipment/math";
import { Btn, deriveMoveModifiers, type PlayerInput } from "./input";
import { AccumulatorClock } from "./tickClock";
import { WEAPONS } from "./weapons/weapons";
import { createWeaponState, currentSpreadDegrees, shotDirections, stepWeapon } from "./weapons/weaponStep";

const MAX_PITCH = (CAMERA.maxPitchDegrees * Math.PI) / 180;

describe("aim quantization (R10)", () => {
  it("fits the wire widths and round-trips within one step", () => {
    const random = createRng(7);
    for (let i = 0; i < 10_000; i++) {
      const yaw = (random() * 2 - 1) * 20;
      const pitch = (random() * 2 - 1) * MAX_PITCH;
      const yawQ = quantizeYaw(yaw);
      const pitchQ = quantizePitch(pitch);
      expect(yawQ).toBeGreaterThanOrEqual(0);
      expect(yawQ).toBeLessThan(2 ** 20);
      expect(pitchQ).toBeGreaterThanOrEqual(0);
      expect(pitchQ).toBeLessThan(2 ** 18);
      const dy = Math.abs(Math.atan2(Math.sin(dequantizeYaw(yawQ) - yaw), Math.cos(dequantizeYaw(yawQ) - yaw)));
      expect(dy).toBeLessThanOrEqual(3.1e-6);
      expect(Math.abs(dequantizePitch(pitchQ) - pitch)).toBeLessThanOrEqual(6e-6);
      // Quantizing the dequantized value is stable, so resimulated aim never drifts.
      expect(quantizeYaw(dequantizeYaw(yawQ))).toBe(yawQ);
      expect(quantizePitch(dequantizePitch(pitchQ))).toBe(pitchQ);
    }
    expect(dequantizePitch(quantizePitch(0))).toBe(0);
    expect(dequantizePitch(quantizePitch(9))).toBeCloseTo(MAX_PITCH, 12);
  });

  it("shotDirections regenerates exactly the pellets stepWeapon fired, for random aims", () => {
    const random = createRng(11);
    for (const id of ["shotgun", "rifle", "sniper"] as const) {
      for (let i = 0; i < 200; i++) {
        const yaw = dequantizeYaw(quantizeYaw(random() * 7));
        const pitch = dequantizePitch(quantizePitch((random() * 2 - 1) * 1.5));
        const state = { ...createWeaponState([id]), shotCounter: Math.floor(random() * 1e6) };
        const ctx = { eye: { x: 0, y: 1.6, z: 0 }, yaw, pitch, horizontalSpeed: random() * 9, grounded: random() < 0.8, sprinting: false };
        const { shots } = stepWeapon(state, { fire: true, aim: false, reload: false, selectIndex: null }, ctx, 1 / 60);
        const shot = shots[0]!;
        // Spread as the shooter had it when firing (fresh state: no bloom, hip) is what a Shot event carries.
        const spread = currentSpreadDegrees(state, ctx);
        expect(shotDirections(WEAPONS[id], shot.shotId, yaw, pitch, spread)).toEqual(shot.directions);
      }
    }
  });
});

describe("deriveMoveModifiers (R3)", () => {
  const input = (buttons: number): PlayerInput => ({ tick: 0, forward: 1, right: 0, buttons, select: 0, yawQ: 0, pitchQ: 0, viewOffset8: 0, action: null });

  it("scales speed by the held weapon and its tick ADS blend, and blocks sprint while firing or aiming", () => {
    const rifle = WEAPONS.rifle;
    const hip = createWeaponState(["rifle"]);
    expect(deriveMoveModifiers(hip, input(Btn.sprint))).toEqual({ speedScale: rifle.moveSpeedScale, allowSprint: true });
    const aimed = { ...hip, adsBlend: 1 };
    expect(deriveMoveModifiers(aimed, input(Btn.aim)).speedScale).toBeCloseTo(rifle.moveSpeedScale * rifle.ads.moveSpeedScale, 12);
    expect(deriveMoveModifiers(hip, input(Btn.fire)).allowSprint).toBe(false);
    expect(deriveMoveModifiers(createWeaponState([null]), input(0))).toEqual({ speedScale: 1, allowSprint: true });
  });
});

describe("AccumulatorClock (R4)", () => {
  it("carries a hitch's backlog into later frames instead of dropping it", () => {
    const clock = new AccumulatorClock();
    let ticks = clock.advance(0.1); // 6 ticks due
    expect(ticks).toBe(5);
    ticks += clock.advance(1e-9);
    expect(ticks).toBe(6);
    expect([clock.nextTick(), clock.nextTick()]).toEqual([0, 1]);
  });

  it("drops only what exceeds the backlog cap", () => {
    const clock = new AccumulatorClock({ maxTicksPerFrame: 5, maxBacklogTicks: 10 });
    let ticks = clock.advance(1);
    for (let i = 0; i < 10; i++) ticks += clock.advance(0);
    expect(ticks).toBe(15);
    expect(clock.advance(0)).toBe(0);
  });
});
