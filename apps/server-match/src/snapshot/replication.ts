import {
  quantizeOwnerVel,
  quantizePitch,
  quantizePosXZ,
  quantizePosY,
  quantizeRemoteVel,
  quantizeTicks,
  quantizeYaw,
  REMOTE_PITCH_BITS,
  REMOTE_YAW_BITS,
  RemoteFlags,
  StanceCode,
  EntityPresence,
  type EntityState,
  type Mutable,
  type OwnerMoveBlock,
} from "@twobullets/protocol";
import { dequantizePitch, dequantizeYaw } from "@twobullets/shared/aim";
import type { MoveState, Stance, Vec3 } from "@twobullets/shared/movement/types";

// Sim state → quantized wire state (netcode.md §6.3, §6.5). Adapter: protocol has the quantizers but no MoveState
// mapping; client prediction (T3.5) must quantize its predicted state the same way before comparing owner blocks.

const OWNER_TIMER_BITS = 4;

export function stanceCode(stance: Stance): number {
  return stance === "prone" ? StanceCode.prone : stance === "crouch" ? StanceCode.crouch : StanceCode.stand;
}

/** Owner move block from the body's feet and the move state. */
export function writeOwnerMove(feet: Readonly<Vec3>, move: MoveState, out: Mutable<OwnerMoveBlock>): void {
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
  out.coyoteTicks = quantizeTicks(move.coyoteTimer, OWNER_TIMER_BITS);
  out.jumpBufferTicks = quantizeTicks(move.jumpBufferTimer, OWNER_TIMER_BITS);
  out.groundIgnoreTicks = quantizeTicks(move.groundIgnoreTimer, OWNER_TIMER_BITS);
}

const AIM_BUTTON = 16;

/** Remote (full relevance) entity from feet, move state and the aim/buttons of the input simulated this tick. */
export function writeRemoteEntity(
  slot: number,
  feet: Readonly<Vec3>,
  move: MoveState,
  yawQ20: number,
  pitchQ18: number,
  buttons: number,
  out: Mutable<EntityState>,
): void {
  out.slot = slot;
  out.presence = EntityPresence.full;
  out.xMm = quantizePosXZ(feet.x);
  out.yMm = quantizePosY(feet.y);
  out.zMm = quantizePosXZ(feet.z);
  out.yawQ = quantizeYaw(dequantizeYaw(yawQ20), REMOTE_YAW_BITS);
  out.pitchQ = quantizePitch(dequantizePitch(pitchQ18), REMOTE_PITCH_BITS);
  out.vxQ = quantizeRemoteVel(move.velocity.x);
  out.vyQ = quantizeRemoteVel(move.velocity.y);
  out.vzQ = quantizeRemoteVel(move.velocity.z);
  let flags = stanceCode(move.stance) << RemoteFlags.stanceShift;
  if (move.grounded) flags |= RemoteFlags.grounded;
  if (move.sprinting) flags |= RemoteFlags.sprint;
  if ((buttons & AIM_BUTTON) !== 0) flags |= RemoteFlags.ads;
  out.flags = flags;
  out.noiseClass = 0;
}

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

export function createEntityState(): Mutable<EntityState> {
  return { slot: 0, presence: EntityPresence.full, xMm: 0, yMm: 0, zMm: 0, yawQ: 0, pitchQ: 0, vxQ: 0, vyQ: 0, vzQ: 0, flags: 0, noiseClass: 0 };
}
