import type { PlayerAction, PlayerActionType, PlayerInput } from "@twobullets/shared/input";
import type { BitReader, BitWriter } from "../bits";
import { AIM_PITCH_BITS, AIM_YAW_BITS } from "../quantize";
import { encodeOptionalTick16, decodeOptionalTick16, NO_TICK, unwrapTick16 } from "../ticks";
import { MsgId } from "./ids";

/** Max redundant inputs per datagram (D5). */
export const MAX_INPUTS_PER_PACKET = 6;

/** 0x01, C→S datagram at 60 Hz (netcode.md §6.5). Ticks are full u32 here; the codec sends u16 and unwraps. */
export interface InputPacket {
  /** Tick of `inputs[0]`. */
  readonly newestTick: number;
  /** Newest snapshot received: drives delta baselines and R-event acks. `NO_TICK` (−1) before the first snapshot. */
  readonly ackSnapshotTick: number;
  /** `performance.now()` mod 65536, echoed for RTT. */
  readonly clientTimeMs: number;
  /** 0–510 ms (sent /2), for the expected-D check. */
  readonly interpDelayMs: number;
  /**
   * Cumulative reliable-event ack: 12-bit seq of the newest event delivered in order (netcode ReliableEventReceiver),
   * or −1/omitted before the first one. Complements `ackSnapshotTick`.
   */
  readonly ackEventSeq?: number;
  /** 1..MAX_INPUTS_PER_PACKET, newest first: ticks newestTick, newestTick−1, … */
  readonly inputs: readonly PlayerInput[];
}

// Wire layout. Header: type 8, newestTick 16, ackSnapshotTick 16 (0xFFFF none), clientTimeMs 16, interpDelayMs/2 8,
// count 4, hasEventAck 1 → ackEventSeq 12. Per input, newest first: [sameAsNext 1 → stop] axes 2+2, buttons 8, select 4, [aimChanged 1 →] yaw 20 +
// pitch 18, (fire set →) viewOffset 8, hasAction 1 → type 4 + arg 16. The newest input has no sameAsNext/aimChanged
// bits (there is no newer input to compare with). viewOffset8 is only carried while fire is held; it reads back 0.

const FIRE = 8;
const ACTION_TYPE_MAX = 6;

/** Mutable decode target; assignable to `PlayerInput`. */
export interface MutablePlayerInput {
  tick: number;
  forward: -1 | 0 | 1;
  right: -1 | 0 | 1;
  buttons: number;
  select: number;
  yawQ: number;
  pitchQ: number;
  viewOffset8: number;
  action: { type: PlayerActionType; arg: number } | null;
}

export interface MutableInputPacket {
  newestTick: number;
  ackSnapshotTick: number;
  clientTimeMs: number;
  interpDelayMs: number;
  /** −1 = none. */
  ackEventSeq: number;
  count: number;
  /** Always MAX_INPUTS_PER_PACKET preallocated entries; only the first `count` are valid. */
  readonly inputs: MutablePlayerInput[];
  /** One preallocated action per input slot, reused by the decoder. */
  readonly actionPool: { type: PlayerActionType; arg: number }[];
}

export function createMutablePlayerInput(): MutablePlayerInput {
  return { tick: 0, forward: 0, right: 0, buttons: 0, select: 0, yawQ: 0, pitchQ: 0, viewOffset8: 0, action: null };
}

export function createInputPacketBuffer(): MutableInputPacket {
  const inputs: MutablePlayerInput[] = [];
  const actionPool: { type: PlayerActionType; arg: number }[] = [];
  for (let i = 0; i < MAX_INPUTS_PER_PACKET; i++) {
    inputs.push(createMutablePlayerInput());
    actionPool.push({ type: 1, arg: 0 });
  }
  return { newestTick: 0, ackSnapshotTick: NO_TICK, clientTimeMs: 0, interpDelayMs: 0, ackEventSeq: -1, count: 0, inputs, actionPool };
}

/** Copies an input, reusing `dst.action` storage via `actionStore` when given. */
export function copyPlayerInput(
  src: PlayerInput,
  dst: MutablePlayerInput,
  actionStore?: { type: PlayerActionType; arg: number },
): void {
  dst.tick = src.tick;
  dst.forward = src.forward;
  dst.right = src.right;
  dst.buttons = src.buttons;
  dst.select = src.select;
  dst.yawQ = src.yawQ;
  dst.pitchQ = src.pitchQ;
  dst.viewOffset8 = src.viewOffset8;
  if (src.action === null) dst.action = null;
  else {
    const a = actionStore ?? dst.action ?? { type: src.action.type, arg: 0 };
    a.type = src.action.type;
    a.arg = src.action.arg;
    dst.action = a;
  }
}

function sameAction(a: PlayerAction | null, b: PlayerAction | null): boolean {
  if (a === null || b === null) return a === b;
  return a.type === b.type && a.arg === b.arg;
}

/** Equality of everything the wire carries (viewOffset8 only counts while fire is held). */
export function inputsEqualOnWire(a: PlayerInput, b: PlayerInput): boolean {
  return (
    a.forward === b.forward &&
    a.right === b.right &&
    (a.buttons & 0xff) === (b.buttons & 0xff) &&
    (a.select & 0xf) === (b.select & 0xf) &&
    a.yawQ === b.yawQ &&
    a.pitchQ === b.pitchQ &&
    ((a.buttons & FIRE) === 0 || (a.viewOffset8 & 0xff) === (b.viewOffset8 & 0xff)) &&
    sameAction(a.action, b.action)
  );
}

function writeInputBody(w: BitWriter, input: PlayerInput, newer: PlayerInput | null): void {
  w.write(input.forward + 1, 2);
  w.write(input.right + 1, 2);
  w.write(input.buttons, 8);
  w.write(input.select, 4);
  if (newer === null) {
    w.write(input.yawQ, AIM_YAW_BITS);
    w.write(input.pitchQ, AIM_PITCH_BITS);
  } else if (input.yawQ === newer.yawQ && input.pitchQ === newer.pitchQ) {
    w.writeBool(false);
  } else {
    w.writeBool(true);
    w.write(input.yawQ, AIM_YAW_BITS);
    w.write(input.pitchQ, AIM_PITCH_BITS);
  }
  if ((input.buttons & FIRE) !== 0) w.write(input.viewOffset8, 8);
  if (input.action === null) w.writeBool(false);
  else {
    w.writeBool(true);
    w.write(input.action.type, 4);
    w.write(input.action.arg, 16);
  }
}

export function encodeInputPacket(w: BitWriter, m: InputPacket): void {
  const count = m.inputs.length;
  if (count < 1 || count > MAX_INPUTS_PER_PACKET) throw new RangeError(`InputPacket needs 1..${MAX_INPUTS_PER_PACKET} inputs`);
  w.write(MsgId.Input, 8);
  w.write(m.newestTick, 16);
  w.write(encodeOptionalTick16(m.ackSnapshotTick), 16);
  w.write(m.clientTimeMs, 16);
  w.write(Math.min(255, Math.max(0, Math.round(m.interpDelayMs / 2))), 8);
  w.write(count, 4);
  const ackEventSeq = m.ackEventSeq ?? -1;
  w.writeBool(ackEventSeq >= 0);
  if (ackEventSeq >= 0) w.write(ackEventSeq, 12);
  writeInputBody(w, m.inputs[0]!, null);
  for (let i = 1; i < count; i++) {
    const input = m.inputs[i]!;
    const newer = m.inputs[i - 1]!;
    if (inputsEqualOnWire(input, newer)) {
      w.writeBool(true);
      continue;
    }
    w.writeBool(false);
    writeInputBody(w, input, newer);
  }
}

function readAxis(r: BitReader): -1 | 0 | 1 | 2 {
  return (r.read(2) - 1) as -1 | 0 | 1 | 2;
}

/**
 * Allocation-free decode into `out`. `referenceTick` is the receiver's current tick, used to unwrap u16 ticks.
 * Returns false for malformed or truncated packets (never throws on untrusted bytes).
 */
export function decodeInputPacketInto(r: BitReader, referenceTick: number, out: MutableInputPacket): boolean {
  if (r.read(8) !== MsgId.Input) return false;
  out.newestTick = unwrapTick16(r.read(16), referenceTick);
  out.ackSnapshotTick = decodeOptionalTick16(r.read(16), referenceTick);
  out.clientTimeMs = r.read(16);
  out.interpDelayMs = r.read(8) * 2;
  const count = r.read(4);
  out.ackEventSeq = r.readBool() ? r.read(12) : -1;
  if (r.overflowed || count < 1 || count > MAX_INPUTS_PER_PACKET) return false;
  out.count = count;
  for (let i = 0; i < count; i++) {
    const input = out.inputs[i]!;
    const newer = i === 0 ? null : out.inputs[i - 1]!;
    if (newer !== null && r.readBool()) {
      copyPlayerInput(newer, input, out.actionPool[i]);
      input.tick = newer.tick - 1;
      continue;
    }
    input.tick = newer === null ? out.newestTick : newer.tick - 1;
    const forward = readAxis(r);
    const right = readAxis(r);
    if (forward === 2 || right === 2) return false;
    input.forward = forward;
    input.right = right;
    input.buttons = r.read(8);
    input.select = r.read(4);
    if (newer === null || r.readBool()) {
      input.yawQ = r.read(AIM_YAW_BITS);
      input.pitchQ = r.read(AIM_PITCH_BITS);
    } else {
      input.yawQ = newer.yawQ;
      input.pitchQ = newer.pitchQ;
    }
    input.viewOffset8 = (input.buttons & FIRE) !== 0 ? r.read(8) : 0;
    if (r.readBool()) {
      const type = r.read(4);
      const arg = r.read(16);
      if (type < 1 || type > ACTION_TYPE_MAX) return false;
      const action = out.actionPool[i]!;
      action.type = type as PlayerActionType;
      action.arg = arg;
      input.action = action;
    } else {
      input.action = null;
    }
    if (r.overflowed) return false;
  }
  // A few zero padding bits may remain in the last byte; anything more is a malformed packet.
  return !r.overflowed && r.bitsLeft < 8;
}

/** Convenience decode that allocates (tests, tooling). Returns null for malformed packets. */
export function decodeInputPacket(r: BitReader, referenceTick: number): InputPacket | null {
  const buf = createInputPacketBuffer();
  if (!decodeInputPacketInto(r, referenceTick, buf)) return null;
  const inputs: PlayerInput[] = [];
  for (let i = 0; i < buf.count; i++) {
    const copy = createMutablePlayerInput();
    copyPlayerInput(buf.inputs[i]!, copy, buf.inputs[i]!.action ? { type: 1, arg: 0 } : undefined);
    inputs.push(copy);
  }
  return {
    newestTick: buf.newestTick,
    ackSnapshotTick: buf.ackSnapshotTick,
    clientTimeMs: buf.clientTimeMs,
    interpDelayMs: buf.interpDelayMs,
    ackEventSeq: buf.ackEventSeq,
    inputs,
  };
}
