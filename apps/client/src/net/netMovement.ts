import type { Mutable, OwnerMoveBlock } from "@twobullets/protocol/messages/snapshot";
import {
  dequantizeOwnerVel,
  dequantizePosXZ,
  dequantizePosY,
  quantizeOwnerVel,
  quantizePosXZ,
  quantizePosY,
  quantizeTicks,
  StanceCode,
} from "@twobullets/protocol/quantize";
import { OPEN_MOVE_GATES, type MoveGates } from "@twobullets/shared/input";
import type { MoveState, Stance, Vec3 } from "@twobullets/shared/movement/types";
import type { WeaponState } from "@twobullets/shared/weapons/types";
import { DEFAULT_LOADOUT } from "@twobullets/shared/weapons/weapons";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";

// M3 movement parity with server-match: the server steps movement with a fresh DEFAULT_LOADOUT weapon state that is
// never stepped (adsBlend 0) and open gates. Owner-block quantization matches the server's snapshot builder.

/** The weapon state the server passes to `stepPlayer` in M3 (the owner block carries no weapon state). */
export const NET_MOVE_WEAPON: WeaponState = createWeaponState(DEFAULT_LOADOUT);
export const NET_MOVE_GATES: MoveGates = OPEN_MOVE_GATES;
export const NET_MOVEMENT = { weapon: NET_MOVE_WEAPON, gates: NET_MOVE_GATES } as const;

/** Owner block timers are 4-bit tick counts. */
const TIMER_BITS = 4;

export function createOwnerBlock(): Mutable<OwnerMoveBlock> {
  return {
    xMm: 0,
    yMm: 0,
    zMm: 0,
    vxMmS: 0,
    vyMmS: 0,
    vzMmS: 0,
    stance: 0,
    grounded: false,
    sprinting: false,
    jumpHeld: false,
    moveMode: 0,
    coyoteTicks: 0,
    jumpBufferTicks: 0,
    groundIgnoreTicks: 0,
  };
}

export function stanceCode(stance: Stance): number {
  return stance === "stand" ? StanceCode.stand : stance === "crouch" ? StanceCode.crouch : StanceCode.prone;
}

export function stanceFromCode(code: number): Stance {
  return code === StanceCode.crouch ? "crouch" : code === StanceCode.prone ? "prone" : "stand";
}

/** Quantizes a predicted tick exactly like the server's owner block. */
export function quantizeOwnerInto(feet: Readonly<Vec3>, move: MoveState, out: Mutable<OwnerMoveBlock>): void {
  out.xMm = quantizePosXZ(feet.x);
  out.yMm = quantizePosY(feet.y);
  out.zMm = quantizePosXZ(feet.z);
  out.vxMmS = quantizeOwnerVel(move.velocity.x);
  out.vyMmS = quantizeOwnerVel(move.velocity.y);
  out.vzMmS = quantizeOwnerVel(move.velocity.z);
  out.stance = stanceCode(move.stance);
  out.grounded = move.grounded;
  out.sprinting = move.sprinting;
  out.jumpHeld = move.jumpHeld;
  out.moveMode = 0;
  out.coyoteTicks = quantizeTicks(move.coyoteTimer, TIMER_BITS);
  out.jumpBufferTicks = quantizeTicks(move.jumpBufferTimer, TIMER_BITS);
  out.groundIgnoreTicks = quantizeTicks(move.groundIgnoreTimer, TIMER_BITS);
}

export function copyOwnerBlock(src: OwnerMoveBlock, dst: Mutable<OwnerMoveBlock>): void {
  dst.xMm = src.xMm;
  dst.yMm = src.yMm;
  dst.zMm = src.zMm;
  dst.vxMmS = src.vxMmS;
  dst.vyMmS = src.vyMmS;
  dst.vzMmS = src.vzMmS;
  dst.stance = src.stance;
  dst.grounded = src.grounded;
  dst.sprinting = src.sprinting;
  dst.jumpHeld = src.jumpHeld;
  dst.moveMode = src.moveMode;
  dst.coyoteTicks = src.coyoteTicks;
  dst.jumpBufferTicks = src.jumpBufferTicks;
  dst.groundIgnoreTicks = src.groundIgnoreTicks;
}

export function ownerFeetInto(block: OwnerMoveBlock, out: { x: number; y: number; z: number }): void {
  out.x = dequantizePosXZ(block.xMm);
  out.y = dequantizePosY(block.yMm);
  out.z = dequantizePosXZ(block.zMm);
}

/**
 * Authoritative movement state from an owner block (allocates; corrections only). When the prediction for the same
 * tick is within ±1 tick on a timer, its float timer is kept, so restoring `ticks / 60` can't flip a `> 0` check.
 */
export function moveStateFromOwner(block: OwnerMoveBlock, predicted: MoveState | null): MoveState {
  const vy = dequantizeOwnerVel(block.vyMmS);
  const timer = (ticks: number, predictedSeconds: number | undefined) =>
    predictedSeconds !== undefined && Math.abs(quantizeTicks(predictedSeconds, TIMER_BITS) - ticks) <= 1 ? predictedSeconds : ticks / 60;
  return {
    velocity: { x: dequantizeOwnerVel(block.vxMmS), y: vy, z: dequantizeOwnerVel(block.vzMmS) },
    stance: stanceFromCode(block.stance),
    grounded: block.grounded,
    sprinting: block.sprinting,
    jumpHeld: block.jumpHeld,
    coyoteTimer: timer(block.coyoteTicks, predicted?.coyoteTimer),
    jumpBufferTimer: timer(block.jumpBufferTicks, predicted?.jumpBufferTimer),
    groundIgnoreTimer: timer(block.groundIgnoreTicks, predicted?.groundIgnoreTimer),
    fallSpeed: block.grounded ? 0 : Math.max(0, -vy),
  };
}
