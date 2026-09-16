import { dequantizePitch, dequantizeYaw } from "./aim";
import type { MoveInput, MoveState } from "./movement/types";
import type { WeaponState } from "./weapons/types";
import { WEAPONS } from "./weapons/weapons";

// One tick of player intent and the predicted per-player state: the unit that the client sends, the server consumes
// and both sides replay (docs/backend/architecture.md §7.1, netcode.md §6.5 `Input`). Pure: no engine imports.

// Same implementation as the equipment helpers; re-exported so both barrel paths resolve to one binding.
export { len2, len3 } from "./equipment/math";
export { dequantizeAim, dequantizePitch, dequantizeYaw, quantizeAim, quantizePitch, quantizeYaw, type QuantizedAim } from "./aim";

/** Button bits of `PlayerInput.buttons`. Wire order matches netcode.md §6.5 (8 bits). */
export const Btn = { jump: 1, sprint: 2, crouch: 4, fire: 8, aim: 16, reload: 32, interact: 64, altThrow: 128 } as const;
export type BtnName = keyof typeof Btn;

/** M5 input actions; they ride input redundancy until `lastProcessedInputTick` covers them (netcode.md §6.2). */
export const PlayerActionType = { pickup: 1, drop: 2, use: 3, cancel: 4, equipAttach: 5, throwItem: 6 } as const;
export type PlayerActionType = (typeof PlayerActionType)[keyof typeof PlayerActionType];

export interface PlayerAction {
  readonly type: PlayerActionType;
  /**
   * 16-bit argument: loot id, inventory slot, or slot + quantity packed by the action (pickup: lootId,
   * use: itemCode(consumableId), throwItem: protocol `encodeThrowArg` — kind, style and the cooked fuse).
   */
  readonly arg: number;
}

export interface PlayerInput {
  /** u32 client tick == the server tick it is meant for. */
  readonly tick: number;
  readonly forward: -1 | 0 | 1;
  readonly right: -1 | 0 | 1;
  /** `Btn` bit set. */
  readonly buttons: number;
  /** 0 none, 1..15 quick slot. */
  readonly select: number;
  /** 20-bit quantized yaw; sims use the dequantized value (refactor R10). */
  readonly yawQ: number;
  /** 18-bit quantized pitch. */
  readonly pitchQ: number;
  /** Shooter view delay D in 1/8 tick; valid when fire or a throw is set. */
  readonly viewOffset8: number;
  /** M5: pickup/drop/use/cancel/equipAttach. */
  readonly action: PlayerAction | null;
}

export interface PlayerState {
  /** Existing movement state; gains `moveMode` in M5. */
  readonly move: MoveState;
  /** Existing weapon state. */
  readonly weapon: WeaponState;
  // M5: throw: ThrowState; item: ItemUseState; vitals: Vitals (server-owned, not predicted)
}

export interface MoveModifiers {
  readonly speedScale: number;
  readonly allowSprint: boolean;
}

/**
 * Movement modifiers from the start-of-tick weapon state and this tick's buttons (refactor R3): replaces the
 * render-frame `speedScale` so prediction, replay and the server agree. Unarmed moves at full speed.
 */
export function deriveMoveModifiers(weapon: WeaponState, input: PlayerInput): MoveModifiers {
  const slot = weapon.slots[weapon.activeIndex];
  const allowSprint = (input.buttons & (Btn.fire | Btn.aim)) === 0;
  if (!slot) return allowSprint ? UNARMED_SPRINT : UNARMED_NO_SPRINT;
  const def = WEAPONS[slot.id];
  const t = weapon.adsBlend;
  return { speedScale: def.moveSpeedScale * (1 + (def.ads.moveSpeedScale - 1) * t), allowSprint };
}

const UNARMED_SPRINT: MoveModifiers = { speedScale: 1, allowSprint: true };
const UNARMED_NO_SPRINT: MoveModifiers = { speedScale: 1, allowSprint: false };

/** Movement gates from simulation state (healing, knocked, boost); the equipment modifiers satisfy it. */
export interface MoveGates {
  readonly speedScale: number;
  readonly allowSprint: boolean;
  readonly allowJump: boolean;
  /** Knocked: prone crawl at MOVEMENT.crawlSpeed. `speedScale` is ignored while crawling (the stance sets the speed). */
  readonly crawl: boolean;
}

export const OPEN_MOVE_GATES: MoveGates = { speedScale: 1, allowSprint: true, allowJump: true, crawl: false };

/** The tick's MoveInput: wire intent + modifiers derived in the tick + state gates, with the dequantized aim. */
export function moveInputFrom(input: PlayerInput, modifiers: MoveModifiers, gates: MoveGates): MoveInput {
  const b = input.buttons;
  const crawl = gates.crawl;
  return {
    forward: input.forward,
    right: input.right,
    jump: (b & Btn.jump) !== 0,
    sprint: (b & Btn.sprint) !== 0 && modifiers.allowSprint && gates.allowSprint,
    crouch: (b & Btn.crouch) !== 0,
    speedScale: modifiers.speedScale * (crawl ? 1 : gates.speedScale),
    allowJump: gates.allowJump,
    crawl,
    yaw: dequantizeYaw(input.yawQ),
    pitch: dequantizePitch(input.pitchQ),
  };
}

/** `PlayerInput.select` → weapon slot index, or null (select is 0 for none, 1-based otherwise). */
export function selectIndexOf(input: PlayerInput): number | null {
  return input.select > 0 ? input.select - 1 : null;
}
