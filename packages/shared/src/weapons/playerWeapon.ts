import { dequantizePitch, dequantizeYaw } from "../aim";
import { len2 } from "../equipment/math";
import { Btn, type PlayerInput } from "../input";
import { eyeHeightFor } from "../movement/movement";
import type { MoveState, Vec3 } from "../movement/types";
import type { CombatInput, WeaponContext, WeaponState, WeaponStepResult } from "./types";
import { stepWeapon, type WeaponStepOptions } from "./weaponStep";

// The weapon half of a player tick (docs/backend/architecture.md §7.2 R3/R10/R11): the wire `PlayerInput` and the
// post-movement state become the weapon step's input and context. `stepPlayer` (packages/sim) runs it after movement;
// hosts that interleave other steps between movement and weapons (offline CombatSystem, MatchSim bots) call it directly,
// so every path fires the same shots from the same tick facts.

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type MutableCombatInput = Mutable<CombatInput>;
export type MutableWeaponContext = Omit<Mutable<WeaponContext>, "eye"> & { readonly eye: Mutable<Vec3> };

export function createCombatInput(): MutableCombatInput {
  return { fire: false, aim: false, reload: false, selectIndex: null };
}

export function createWeaponContext(): MutableWeaponContext {
  return { eye: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, horizontalSpeed: 0, grounded: true, sprinting: false };
}

/** The tick's combat intent from its wire input: fire/aim/reload bits and `select` (0 none, else slot index + 1). */
export function combatInputInto(out: MutableCombatInput, input: PlayerInput): CombatInput {
  const b = input.buttons;
  out.fire = (b & Btn.fire) !== 0;
  out.aim = (b & Btn.aim) !== 0;
  out.reload = (b & Btn.reload) !== 0;
  out.selectIndex = input.select > 0 ? input.select - 1 : null;
  return out;
}

/**
 * Weapon context after this tick's movement: eye at the tick feet + stance eye height, the input's dequantized aim (R10:
 * the server stepping the same input fires identical pellets), and the moved state's speed, ground and sprint.
 */
export function weaponContextInto(out: MutableWeaponContext, feet: Readonly<Vec3>, move: MoveState, input: PlayerInput): WeaponContext {
  out.eye.x = feet.x;
  out.eye.y = feet.y + eyeHeightFor(move.stance);
  out.eye.z = feet.z;
  out.yaw = dequantizeYaw(input.yawQ);
  out.pitch = dequantizePitch(input.pitchQ);
  out.horizontalSpeed = len2(move.velocity.x, move.velocity.z);
  out.grounded = move.grounded;
  out.sprinting = move.sprinting;
  return out;
}

const LIVE: WeaponStepOptions = { emit: true };
const REPLAY: WeaponStepOptions = { emit: false };

/**
 * One player weapon tick. `replay` (R11) advances the state identically but builds no shots or events, so a replay after
 * a correction never re-kicks recoil, re-spawns tracers or replays sounds. Callers gate `combat` beforehand when
 * something outside the sim blocks weapons (equipment `gateCombatInput`).
 */
export function stepPlayerWeapon(weapon: WeaponState, combat: CombatInput, ctx: WeaponContext, dt: number, replay: boolean): WeaponStepResult {
  return stepWeapon(weapon, combat, ctx, dt, replay ? REPLAY : LIVE);
}
