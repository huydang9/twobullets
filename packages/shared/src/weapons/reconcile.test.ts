import { describe, expect, it } from "vitest";
import { quantizePitch, quantizeYaw } from "../aim";
import { createRng } from "../equipment/math";
import { Btn, type PlayerInput } from "../input";
import { createMoveState } from "../movement/movement";
import type { MoveState, Stance, Vec3 } from "../movement/types";
import { TICK_SECONDS } from "../tickClock";
import { combatInputInto, createCombatInput, createWeaponContext, stepPlayerWeapon, weaponContextInto } from "./playerWeapon";
import { diffWeaponState, restoreWeapon, ShotEmitter, WEAPON_TOLERANCE, WeaponDiff, weaponWithinTolerance } from "./reconcile";
import type { AimedShot, WeaponState } from "./types";
import { createWeaponState } from "./weaponStep";
import { DEFAULT_LOADOUT } from "./weapons";

const DT = TICK_SECONDS;

interface Tick {
  readonly input: PlayerInput;
  readonly feet: Vec3;
  readonly move: MoveState;
}

/** Seeded player script: held fire bursts, aim, occasional reload and slot switches, a wandering aim and movement. */
function script(seed: number, count: number): Tick[] {
  const random = createRng(seed);
  const stances: Stance[] = ["stand", "stand", "crouch", "prone"];
  const ticks: Tick[] = [];
  let buttons = 0;
  let nextButtons = 0;
  let yaw = 0;
  let pitch = 0;
  let move = createMoveState();
  let nextMove = 0;
  for (let tick = 0; tick < count; tick++) {
    if (tick >= nextButtons) {
      buttons = 0;
      if (random() < 0.55) buttons |= Btn.fire;
      if (random() < 0.35) buttons |= Btn.aim;
      nextButtons = tick + 1 + Math.floor(random() * 40);
    }
    // Taps: semi/bolt need releases, reload and select are one-tick requests.
    const tapFire = random() < 0.05 ? Btn.fire : 0;
    const reload = random() < 0.002 ? Btn.reload : 0;
    const select = random() < 0.004 ? 1 + Math.floor(random() * 4) : 0;
    if (tick >= nextMove) {
      move = {
        ...createMoveState(),
        stance: stances[Math.floor(random() * stances.length)]!,
        velocity: { x: (random() * 2 - 1) * 5, y: 0, z: (random() * 2 - 1) * 5 },
        grounded: random() < 0.85,
        sprinting: random() < 0.2,
      };
      nextMove = tick + 1 + Math.floor(random() * 60);
    }
    yaw += (random() * 2 - 1) * 0.05;
    pitch = Math.max(-1.4, Math.min(1.4, pitch + (random() * 2 - 1) * 0.02));
    ticks.push({
      input: { tick, forward: 0, right: 0, buttons: (buttons ^ tapFire) | reload, select, yawQ: quantizeYaw(yaw), pitchQ: quantizePitch(pitch), viewOffset8: 0, action: null },
      feet: { x: tick * 0.05, y: 1 + Math.sin(tick * 0.01), z: -tick * 0.03 },
      move,
    });
  }
  return ticks;
}

const ctx = createWeaponContext();
const combat = createCombatInput();

function step(state: WeaponState, t: Tick, replay: boolean) {
  return stepPlayerWeapon(state, combatInputInto(combat, t.input), weaponContextInto(ctx, t.feet, t.move, t.input), DT, replay);
}

function hex(values: readonly number[]): string {
  return Array.from(new Uint8Array(new Float64Array(values).buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every number and flag of a weapon state as float64 bits. */
function fingerprint(w: WeaponState): string {
  const values = [w.activeIndex, ["ready", "equipping", "reloading"].indexOf(w.phase), w.phaseTimer, w.cooldown, w.triggerHeld ? 1 : 0, w.bloom, w.adsBlend, w.shotCounter];
  for (const slot of w.slots) values.push(slot ? DEFAULT_LOADOUT.indexOf(slot.id) : -1, slot?.magazine ?? -1, slot?.reserve ?? -1);
  return hex(values);
}

function shotPrint(shots: readonly AimedShot[]): string {
  const values: number[] = [];
  for (const s of shots) {
    values.push(s.shotId, s.origin.x, s.origin.y, s.origin.z, s.yaw, s.pitch, s.spreadDegrees, s.recoilUp, s.recoilRight);
    for (const d of s.directions) values.push(d.x, d.y, d.z);
  }
  return hex(values);
}

/** What a wire round trip does to the floats (T4.4 decides the real layout): timers in 1/64 tick, bloom 0.001°, ADS 1/255. */
function viaWire(w: WeaponState): WeaponState {
  const q = (value: number, stepSize: number) => Math.round(value / stepSize) * stepSize;
  return { ...w, phaseTimer: q(w.phaseTimer, DT / 64), cooldown: q(w.cooldown, DT / 64), bloom: q(w.bloom, 0.001), adsBlend: q(w.adsBlend, 1 / 255) };
}

describe("weapon reconciliation", () => {
  it("flags each field beyond its tolerance and nothing within it", () => {
    const base: WeaponState = { ...createWeaponState(["rifle", null, "pistol"]), phase: "reloading", phaseTimer: 1, cooldown: 0.05, bloom: 1, adsBlend: 0.5 };
    const t = WEAPON_TOLERANCE;
    expect(diffWeaponState(base, { ...base, phaseTimer: 1 + t.timerSeconds * 0.9, cooldown: 0.05 - t.timerSeconds * 0.9, bloom: 1.019, adsBlend: 0.481 })).toBe(0);
    const cases: [Partial<WeaponState>, number][] = [
      [{ phaseTimer: 1 + t.timerSeconds * 1.1 }, WeaponDiff.phaseTimer],
      [{ cooldown: 0.05 + t.timerSeconds * 1.1 }, WeaponDiff.cooldown],
      [{ bloom: 1.03 }, WeaponDiff.bloom],
      [{ adsBlend: 0.53 }, WeaponDiff.adsBlend],
      [{ phase: "ready" }, WeaponDiff.phase],
      [{ activeIndex: 2 }, WeaponDiff.activeIndex],
      [{ shotCounter: 1 }, WeaponDiff.shotCounter],
      [{ triggerHeld: true }, WeaponDiff.triggerHeld],
      [{ slots: [{ ...base.slots[0]!, magazine: 3 }, null, base.slots[2]!] }, WeaponDiff.ammo],
      [{ slots: [base.slots[0]!, null, { ...base.slots[2]!, reserve: 1 }] }, WeaponDiff.ammo],
      [{ slots: [base.slots[0]!, base.slots[2]!, base.slots[2]!] }, WeaponDiff.slots],
      [{ slots: [base.slots[0]!, null] }, WeaponDiff.slots],
    ];
    for (const [change, bit] of cases) expect(diffWeaponState(base, { ...base, ...change }), JSON.stringify(change)).toBe(bit);
    expect(weaponWithinTolerance(base, { ...base, bloom: 1.5 })).toBe(false);
  });

  it("restoreWeapon keeps full-precision predicted floats within tolerance and copies everything else", () => {
    const predicted: WeaponState = { ...createWeaponState(["rifle"]), phase: "reloading", phaseTimer: 0.7000001, cooldown: 0.0123456, bloom: 0.3333, adsBlend: 0.123 };
    const authoritative: WeaponState = { ...viaWire(predicted), slots: [{ id: "rifle", magazine: 7, reserve: 90 }] };
    const restored = restoreWeapon(authoritative, predicted);
    expect(restored).toEqual({ ...authoritative, phaseTimer: predicted.phaseTimer, cooldown: predicted.cooldown, bloom: predicted.bloom, adsBlend: predicted.adsBlend });
    expect(restored.slots[0]).not.toBe(authoritative.slots[0]);
    // Beyond tolerance or another phase: the server's value.
    const far = restoreWeapon({ ...authoritative, bloom: 2, phase: "equipping" }, predicted);
    expect(far.bloom).toBe(2);
    expect(far.phaseTimer).toBe(authoritative.phaseTimer);
    expect(restoreWeapon({ ...authoritative, phase: "ready", phaseTimer: 0.2 }, null).phaseTimer).toBe(0);
  });

  it("a random input stream replayed from any restore point gives identical weapon state, shot ids and pellets", () => {
    const TICKS = 6000;
    const ticks = script(0x3ea9, TICKS);
    const loadout = createWeaponState(DEFAULT_LOADOUT);
    // Deep reserves so the whole run keeps firing and reloading.
    const states: WeaponState[] = [{ ...loadout, slots: loadout.slots.map((slot) => slot && { ...slot, reserve: 5000 }) }];
    const prints = [fingerprint(states[0]!)];
    const shots: string[] = [];
    const counts = { shots: 0, reloads: 0, equips: 0, dry: 0 };
    for (let t = 0; t < TICKS; t++) {
      const r = step(states[t]!, ticks[t]!, false);
      states.push(r.state);
      prints.push(fingerprint(r.state));
      shots.push(shotPrint(r.shots));
      counts.shots += r.shots.length;
      for (const e of r.events) {
        if (e.type === "reloadStarted") counts.reloads++;
        else if (e.type === "equipStarted") counts.equips++;
        else if (e.type === "dryFire") counts.dry++;
      }
    }
    // The script exercises firing on every weapon, reloads, switches and empty magazines.
    expect(counts.shots).toBeGreaterThan(150);
    expect(counts.reloads).toBeGreaterThan(10);
    expect(counts.equips).toBeGreaterThan(10);
    expect(new Set(states.map((s) => s.slots[s.activeIndex]!.id)).size).toBe(4);

    const random = createRng(0xc0ffee);
    let replayedShots = 0;
    for (let r = 0; r < 300; r++) {
      const from = Math.floor(random() * (TICKS - 40));
      const length = 1 + Math.floor(random() * 40);
      // Restore what a snapshot would carry, with the prediction for the same tick available half of the time.
      const exact = states[from]!;
      let live = restoreWeapon(r % 2 === 0 ? viaWire(exact) : exact, r % 2 === 0 ? exact : null);
      let replay = live;
      for (let t = from; t < from + length; t++) {
        const a = step(live, ticks[t]!, false);
        const b = step(replay, ticks[t]!, true);
        live = a.state;
        replay = b.state;
        replayedShots += a.shots.length;
        if (fingerprint(live) !== prints[t + 1] || shotPrint(a.shots) !== shots[t]) expect.fail(`replay from ${from} diverged at tick ${t + 1}`);
        if (fingerprint(replay) !== prints[t + 1] || b.shots.length > 0 || b.events.length > 0) expect.fail(`suppressed replay from ${from} diverged at tick ${t + 1}`);
      }
    }
    expect(replayedShots).toBeGreaterThan(50);
  });

  it("ShotEmitter: a replay over firing ticks never kicks the aim again (R11)", () => {
    const ticks = script(0x77, 600);
    const emitter = new ShotEmitter();
    const aim = { pitch: 0, yaw: 0 };
    const kick = (shot: AimedShot) => {
      if (!emitter.accept(shot)) return;
      aim.pitch -= shot.recoilUp;
      aim.yaw += shot.recoilRight;
    };
    const states: WeaponState[] = [createWeaponState(["rifle"])];
    for (let t = 0; t < 600; t++) {
      const r = step(states[t]!, ticks[t]!, false);
      r.shots.forEach(kick);
      states.push(r.state);
    }
    expect(emitter.lastEmittedShotId).toBeGreaterThan(10);
    const before = { ...aim };
    // Correction at tick 300: `replay: true` produces nothing to kick with.
    let state = restoreWeapon(states[300]!, null);
    for (let t = 300; t < 600; t++) {
      const r = step(state, ticks[t]!, true);
      r.shots.forEach(kick);
      state = r.state;
    }
    // Even a host that re-steps live (e.g. a server re-simulation feeding the same emitter) re-emits nothing.
    state = restoreWeapon(states[300]!, null);
    for (let t = 300; t < 600; t++) {
      const r = step(state, ticks[t]!, false);
      r.shots.forEach(kick);
      state = r.state;
    }
    expect(aim).toEqual(before);
    expect(fingerprint(state)).toBe(fingerprint(states[600]!));
    emitter.reset(0);
    expect(emitter.accept({ weaponId: "rifle", shotId: 0, origin: { x: 0, y: 0, z: 0 }, directions: [], recoilUp: 0, recoilRight: 0 })).toBe(true);
  });
});
