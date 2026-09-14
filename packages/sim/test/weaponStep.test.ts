import { dequantizeAim } from "@twobullets/shared/aim";
import { createRng } from "@twobullets/shared/equipment/math";
import { Btn, selectIndexOf, type PlayerInput, type PlayerState } from "@twobullets/shared/input";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { createMoveState, eyeHeightFor } from "@twobullets/shared/movement/movement";
import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import { ProjectileBuffer, projectileId } from "@twobullets/shared/weapons/projectileBuffer";
import { restoreWeapon } from "@twobullets/shared/weapons/reconcile";
import type { AimedShot, WeaponState } from "@twobullets/shared/weapons/types";
import { createWeaponState, stepWeapon } from "@twobullets/shared/weapons/weaponStep";
import { DEFAULT_LOADOUT } from "@twobullets/shared/weapons/weapons";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CharacterBody } from "../src/CharacterBody";
import { createSimWorld, stepPlayer, type SimWorld, type StepResult } from "../src/index";
import { loadHavok } from "../src/node/loadHavok";
import { fingerprint, randomInputs } from "./simHarness";

// T4.1: stepPlayer's weapon step (movement → weapons in one authoritative tick). Offline parity with the pre-T4.1
// composition, replay consistency with shots, and R11 suppression.

const TICKS = 3000;
const RESTORES = 120;
const MAX_REPLAY = 30;

let world: SimWorld;

beforeAll(async () => {
  world = await createSimWorld(await loadHavok(), ARENA_LEVEL);
});

afterAll(() => world?.dispose());

/** randomInputs plus fire bursts and taps, reload taps and slot switches (a separate stream, so the movement script is unchanged). */
function combatInputs(seed: number) {
  const { inputs, gates } = randomInputs(seed, TICKS);
  const random = createRng(seed ^ 0x9e37);
  let burstUntil = -1;
  const withCombat: PlayerInput[] = inputs.map((input, tick) => {
    let buttons = input.buttons;
    // Fire bursts (auto) and taps (semi/bolt need releases).
    if (tick > burstUntil + 1 && random() < 0.03) burstUntil = tick + 5 + Math.floor(random() * 40);
    if (tick <= burstUntil || random() < 0.03) buttons |= Btn.fire;
    if (random() < 0.004) buttons |= Btn.reload;
    const select = random() < 0.004 ? 1 + Math.floor(random() * 4) : 0;
    return { ...input, buttons, select };
  });
  return { inputs: withCombat, gates };
}

function startState(): PlayerState {
  const weapon = createWeaponState(DEFAULT_LOADOUT);
  return { move: createMoveState(), weapon: { ...weapon, slots: weapon.slots.map((slot) => slot && { ...slot, reserve: 5000 }) } };
}

function weaponPrint(w: WeaponState): string {
  const values = [w.activeIndex, ["ready", "equipping", "reloading"].indexOf(w.phase), w.phaseTimer, w.cooldown, w.triggerHeld ? 1 : 0, w.bloom, w.adsBlend, w.shotCounter];
  for (const slot of w.slots) values.push(slot?.magazine ?? -1, slot?.reserve ?? -1);
  return Buffer.from(new Float64Array(values).buffer).toString("hex");
}

function shotPrint(shots: readonly AimedShot[]): string {
  const values: number[] = [];
  for (const s of shots) {
    values.push(s.shotId, s.origin.x, s.origin.y, s.origin.z, s.yaw, s.pitch, s.spreadDegrees, s.recoilUp, s.recoilRight);
    for (const d of s.directions) values.push(d.x, d.y, d.z);
  }
  return Buffer.from(new Float64Array(values).buffer).toString("hex");
}

function spawnBody(): CharacterBody {
  const [x, y, z] = ARENA_LEVEL.spawnPoints[0]!.position;
  return world.createBody({ x, y, z }) as CharacterBody;
}

describe("stepPlayer weapon step", () => {
  const { inputs, gates } = combatInputs(0x7a41);

  it("matches the pre-T4.1 composition (movement-only stepPlayer, then stepWeapon as CombatSystem built it)", () => {
    const integrated: string[] = [];
    const integratedShots: string[] = [];
    let body = spawnBody();
    let state = startState();
    let shots = 0;
    for (let t = 0; t < TICKS; t++) {
      const r = stepPlayer(body, state, inputs[t]!, TICK_SECONDS, { replay: false, gates: gates[t], weapons: true });
      state = r.state;
      integrated.push(fingerprint(body, state) + weaponPrint(state.weapon));
      integratedShots.push(shotPrint(r.shots));
      shots += r.shots.length;
    }
    body.dispose();
    expect(shots).toBeGreaterThan(50);

    body = spawnBody();
    state = startState();
    for (let t = 0; t < TICKS; t++) {
      const input = inputs[t]!;
      const moved = stepPlayer(body, state, input, TICK_SECONDS, { replay: false, gates: gates[t] });
      expect(moved.state.weapon).toBe(state.weapon); // weapons off: passes through
      const move = moved.state.move;
      const aim = dequantizeAim(input.yawQ, input.pitchQ);
      const b = input.buttons;
      const fired = stepWeapon(
        state.weapon,
        { fire: (b & Btn.fire) !== 0, aim: (b & Btn.aim) !== 0, reload: (b & Btn.reload) !== 0, selectIndex: selectIndexOf(input) },
        {
          eye: { x: body.feet.x, y: body.feet.y + eyeHeightFor(move.stance), z: body.feet.z },
          yaw: aim.yaw,
          pitch: aim.pitch,
          horizontalSpeed: Math.sqrt(move.velocity.x * move.velocity.x + move.velocity.z * move.velocity.z),
          grounded: move.grounded,
          sprinting: move.sprinting,
        },
        TICK_SECONDS,
      );
      state = { move, weapon: fired.state };
      if (fingerprint(body, state) + weaponPrint(state.weapon) !== integrated[t] || shotPrint(fired.shots) !== integratedShots[t]) {
        expect.fail(`composition diverged at tick ${t}`);
      }
    }
    body.dispose();
  }, 120_000);

  it("replays from restore points to identical movement, weapon state, shot ids and pellets; replay: true emits nothing", () => {
    const body = spawnBody();
    const states: PlayerState[] = [startState()];
    const feet = [{ ...body.feet }];
    const prints = [fingerprint(body, states[0]!) + weaponPrint(states[0]!.weapon)];
    const shots: string[] = [];
    const buffer = new ProjectileBuffer();
    let events = 0;
    for (let t = 0; t < TICKS; t++) {
      const r: StepResult = stepPlayer(body, states[t]!, inputs[t]!, TICK_SECONDS, { replay: false, gates: gates[t], weapons: true });
      states.push(r.state);
      feet.push({ ...body.feet });
      prints.push(fingerprint(body, r.state) + weaponPrint(r.state.weapon));
      shots.push(shotPrint(r.shots));
      events += r.events.length;
      for (const shot of r.shots) {
        const first = buffer.count;
        buffer.spawnShot(shot, 3);
        for (let p = 0; p < shot.directions.length; p++) expect(buffer.id[first + p]).toBe(projectileId(3, shot.shotId, p));
      }
    }
    expect(buffer.count).toBeGreaterThan(100);
    expect(events).toBeGreaterThan(0);

    const random = createRng(0xfeed);
    let replayedShots = 0;
    for (let r = 0; r < RESTORES; r++) {
      const from = Math.floor(random() * (TICKS - MAX_REPLAY));
      const length = 1 + Math.floor(random() * MAX_REPLAY);
      const replay = r % 2 === 1;
      const restored = states[from]!;
      body.restore(feet[from]!, restored.move.velocity, restored.move.stance);
      let state: PlayerState = { move: restored.move, weapon: restoreWeapon(restored.weapon, restored.weapon) };
      for (let t = from; t < from + length; t++) {
        const step = stepPlayer(body, state, inputs[t]!, TICK_SECONDS, { replay, gates: gates[t], weapons: true });
        state = step.state;
        if (fingerprint(body, state) + weaponPrint(state.weapon) !== prints[t + 1]) expect.fail(`replay (${replay}) from ${from} diverged at tick ${t + 1}`);
        if (replay) {
          if (step.shots.length > 0 || step.events.length > 0) expect.fail(`replay: true emitted at tick ${t}`);
        } else {
          replayedShots += step.shots.length;
          if (shotPrint(step.shots) !== shots[t]) expect.fail(`shots differ on replay from ${from} at tick ${t}`);
        }
      }
    }
    expect(replayedShots).toBeGreaterThan(5);
    body.dispose();
  }, 120_000);
});
