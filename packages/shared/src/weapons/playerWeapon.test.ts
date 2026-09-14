import { describe, expect, it } from "vitest";
import { dequantizePitch, dequantizeYaw, quantizePitch, quantizeYaw } from "../aim";
import { createRng } from "../equipment/math";
import { Btn, type PlayerInput } from "../input";
import { createMoveState, eyeHeightFor } from "../movement/movement";
import type { MoveState, Stance } from "../movement/types";
import { combatInputInto, createCombatInput, createWeaponContext, stepPlayerWeapon, weaponContextInto } from "./playerWeapon";
import type { WeaponId, WeaponState } from "./types";
import { createWeaponState, shotDirections, stepWeapon } from "./weaponStep";
import { WEAPONS } from "./weapons";

const DT = 1 / 60;

function input(partial: Partial<PlayerInput>): PlayerInput {
  return { tick: 0, forward: 0, right: 0, buttons: 0, select: 0, yawQ: 0, pitchQ: quantizePitch(0), viewOffset8: 0, action: null, ...partial };
}

/** Float64 bits as hex, so comparisons are bitwise. */
function hex(values: readonly number[]): string {
  return Array.from(new Uint8Array(new Float64Array(values).buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("player weapon inputs", () => {
  it("maps wire buttons and select to the combat input", () => {
    const out = createCombatInput();
    expect(combatInputInto(out, input({ buttons: Btn.fire | Btn.reload | Btn.sprint, select: 2 }))).toEqual({ fire: true, aim: false, reload: true, selectIndex: 1 });
    expect(combatInputInto(out, input({ buttons: Btn.aim, select: 0 }))).toEqual({ fire: false, aim: true, reload: false, selectIndex: null });
  });

  it("builds the context from tick feet, stance eye height, moved state and the dequantized aim", () => {
    const move: MoveState = { ...createMoveState(), stance: "crouch", velocity: { x: 3, y: -1, z: 4 }, grounded: false, sprinting: true };
    const i = input({ yawQ: quantizeYaw(1.2), pitchQ: quantizePitch(-0.4) });
    const ctx = weaponContextInto(createWeaponContext(), { x: 1, y: 2, z: 3 }, move, i);
    expect(ctx).toEqual({
      eye: { x: 1, y: 2 + eyeHeightFor("crouch"), z: 3 },
      yaw: dequantizeYaw(i.yawQ),
      pitch: dequantizePitch(i.pitchQ),
      horizontalSpeed: 5,
      grounded: false,
      sprinting: true,
    });
  });
});

describe("stepPlayerWeapon", () => {
  it("replay advances the state identically but emits no shots or events (R11)", () => {
    const ctx = createWeaponContext();
    let live: WeaponState = createWeaponState(["rifle", "shotgun"]);
    let replayed = live;
    let shots = 0;
    for (let t = 0; t < 400; t++) {
      const combat = { fire: t % 40 < 30, aim: t % 100 > 50, reload: t === 210, selectIndex: t === 300 ? 1 : null };
      ctx.yaw = t * 0.01;
      const a = stepPlayerWeapon(live, combat, ctx, DT, false);
      const b = stepPlayerWeapon(replayed, combat, ctx, DT, true);
      expect(b.shots).toHaveLength(0);
      expect(b.events).toHaveLength(0);
      expect(b.state).toEqual(a.state);
      shots += a.shots.length;
      live = a.state;
      replayed = b.state;
    }
    expect(shots).toBeGreaterThan(20);
  });

  it("returns the same state object and shared empty lists on an idle tick", () => {
    const state = createWeaponState(["pistol"]);
    const step = stepWeapon(state, { fire: false, aim: false, reload: false, selectIndex: null }, createWeaponContext(), DT);
    expect(step.state).toBe(state);
    expect(Object.isFrozen(step.shots) && Object.isFrozen(step.events)).toBe(true);
  });
});

describe("remote shot reconstruction (R10)", () => {
  it("shotDirections rebuilds the fired pellets bit for bit for random aims, weapons and spread", () => {
    const random = createRng(0x51107);
    const ids: WeaponId[] = ["pistol", "rifle", "shotgun", "sniper"];
    const stances: Stance[] = ["stand", "crouch", "prone"];
    const ctx = createWeaponContext();
    const combat = createCombatInput();
    let checked = 0;
    for (let n = 0; n < 2000; n++) {
      const id = ids[Math.floor(random() * ids.length)]!;
      // Client side: raw camera aim → the quantized wire input it simulates.
      const rawYaw = (random() * 2 - 1) * 20;
      const rawPitch = (random() * 2 - 1) * 1.6;
      const wire = input({ buttons: Btn.fire | (random() < 0.5 ? Btn.aim : 0), yawQ: quantizeYaw(rawYaw), pitchQ: quantizePitch(rawPitch) });
      const move: MoveState = {
        ...createMoveState(),
        stance: stances[Math.floor(random() * 3)]!,
        velocity: { x: (random() * 2 - 1) * 6, y: 0, z: (random() * 2 - 1) * 6 },
        grounded: random() < 0.8,
      };
      const base = createWeaponState([id]);
      const state: WeaponState = { ...base, shotCounter: Math.floor(random() * 100_000), bloom: random() * WEAPONS[id].spread.maxBloom, adsBlend: random() };
      const fired = stepPlayerWeapon(state, combatInputInto(combat, wire), weaponContextInto(ctx, { x: random() * 1000, y: random() * 50, z: random() * 1000 }, move, wire), DT, false);
      expect(fired.shots).toHaveLength(1);
      const shot = fired.shots[0]!;
      expect(shot.yaw).toBe(dequantizeYaw(wire.yawQ));
      expect(shot.pitch).toBe(dequantizePitch(wire.pitchQ));
      // Server side: the same quantized aim (and re-quantizing the dequantized aim is lossless on the wire).
      expect(quantizeYaw(shot.yaw)).toBe(wire.yawQ);
      expect(quantizePitch(shot.pitch)).toBe(wire.pitchQ);
      const rebuilt = shotDirections(WEAPONS[shot.weaponId], shot.shotId, dequantizeYaw(wire.yawQ), dequantizePitch(wire.pitchQ), shot.spreadDegrees);
      expect(rebuilt).toHaveLength(WEAPONS[id].pellets);
      expect(hex(rebuilt.flatMap((d) => [d.x, d.y, d.z]))).toBe(hex(shot.directions.flatMap((d) => [d.x, d.y, d.z])));
      checked++;
    }
    expect(checked).toBe(2000);
  });
});
