import type { MoveState } from "./movement/types";
import type { WeaponState } from "./weapons/types";

// One tick of player intent and the predicted per-player state: the unit that the client sends, the server consumes
// and both sides replay (docs/backend/architecture.md §7.1, netcode.md §6.5 `Input`). Pure: no engine imports.

// Same implementation as the equipment helpers; re-exported so both barrel paths resolve to one binding.
export { len2, len3 } from "./equipment/math";

/** Button bits of `PlayerInput.buttons`. Wire order matches netcode.md §6.5 (8 bits). */
export const Btn = { jump: 1, sprint: 2, crouch: 4, fire: 8, aim: 16, reload: 32, interact: 64, altThrow: 128 } as const;
export type BtnName = keyof typeof Btn;

/** M5 input actions; they ride input redundancy until `lastProcessedInputTick` covers them (netcode.md §6.2). */
export const PlayerActionType = { pickup: 1, drop: 2, use: 3, cancel: 4, equipAttach: 5 } as const;
export type PlayerActionType = (typeof PlayerActionType)[keyof typeof PlayerActionType];

export interface PlayerAction {
  readonly type: PlayerActionType;
  /** 16-bit argument: loot id, inventory slot, or slot + quantity packed by the action. */
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
 * render-frame `speedScale` so prediction, replay and the server agree.
 */
export function deriveMoveModifiers(weapon: WeaponState, input: PlayerInput): MoveModifiers {
  throw new Error("not implemented");
}
