import { createRng } from "@twobullets/shared/equipment/math";
import { Btn, OPEN_MOVE_GATES, type MoveGates, type PlayerInput, type PlayerState } from "@twobullets/shared/input";
import type { CharacterBody } from "../src/CharacterBody";

/** Seeded input script: each control is held for a random number of ticks, like a player would. */
export function randomInputs(seed: number, count: number): { inputs: PlayerInput[]; gates: MoveGates[] } {
  const random = createRng(seed);
  const hold = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const inputs: PlayerInput[] = [];
  const gates: MoveGates[] = [];
  const KNOCKED: MoveGates = { speedScale: 1, allowSprint: false, allowJump: false, crawl: true };
  let forward: -1 | 0 | 1 = 1;
  let right: -1 | 0 | 1 = 0;
  let buttons = 0;
  let yawQ = 0;
  let yawRate = 0;
  let knocked = false;
  let nextMove = 0;
  let nextButtons = 0;
  let nextTurn = 0;
  let nextKnock = 0;
  for (let tick = 0; tick < count; tick++) {
    if (tick >= nextMove) {
      forward = ([-1, 0, 1, 1, 1] as const)[Math.floor(random() * 5)]!;
      right = ([-1, 0, 0, 1] as const)[Math.floor(random() * 4)]!;
      nextMove = tick + hold(10, 90);
    }
    if (tick >= nextButtons) {
      buttons = 0;
      if (random() < 0.5) buttons |= Btn.sprint;
      if (random() < 0.15) buttons |= Btn.jump;
      if (random() < 0.2) buttons |= Btn.crouch;
      if (random() < 0.2) buttons |= Btn.aim;
      if (random() < 0.1) buttons |= Btn.fire;
      nextButtons = tick + hold(3, 60);
    }
    if (tick >= nextTurn) {
      yawRate = Math.floor((random() * 2 - 1) * 12000);
      nextTurn = tick + hold(5, 80);
    }
    if (tick >= nextKnock) {
      knocked = random() < 0.08;
      nextKnock = tick + hold(60, 240);
    }
    yawQ = (((yawQ + yawRate) % (1 << 20)) + (1 << 20)) % (1 << 20);
    inputs.push({ tick, forward, right, buttons, select: 0, yawQ, pitchQ: 131071, viewOffset8: 0, action: null });
    gates.push(knocked ? KNOCKED : OPEN_MOVE_GATES);
  }
  return { inputs, gates };
}

/** Every simulated number and flag of a tick, as float64 bits, so comparisons are bitwise. */
export function fingerprint(body: CharacterBody, state: PlayerState): string {
  const m = state.move;
  const values = new Float64Array([
    body.feet.x,
    body.feet.y,
    body.feet.z,
    m.velocity.x,
    m.velocity.y,
    m.velocity.z,
    m.grounded ? 1 : 0,
    m.stance === "stand" ? 0 : m.stance === "crouch" ? 1 : 2,
    m.sprinting ? 1 : 0,
    m.jumpHeld ? 1 : 0,
    m.coyoteTimer,
    m.jumpBufferTimer,
    m.groundIgnoreTimer,
    m.fallSpeed,
    state.weapon.adsBlend,
  ]);
  return Buffer.from(values.buffer).toString("hex");
}
