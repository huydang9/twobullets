import type { PlayerInput } from "@twobullets/shared/input";
import type { BitReader, BitWriter } from "../bits";

/** Max redundant inputs per datagram (D5). */
export const MAX_INPUTS_PER_PACKET = 6;

/** 0x01, C→S datagram at 60 Hz (netcode.md §6.5). Ticks are full u32 here; the codec sends u16 and unwraps. */
export interface InputPacket {
  /** Tick of `inputs[0]`. */
  readonly newestTick: number;
  /** Newest snapshot received: drives delta baselines and R-event acks. */
  readonly ackSnapshotTick: number;
  /** `performance.now()` mod 65536, echoed for RTT. */
  readonly clientTimeMs: number;
  /** 0–510 ms (sent /2), for the expected-D check. */
  readonly interpDelayMs: number;
  /** 1..MAX_INPUTS_PER_PACKET, newest first: ticks newestTick, newestTick−1, … */
  readonly inputs: readonly PlayerInput[];
}

export function encodeInputPacket(w: BitWriter, m: InputPacket): void {
  throw new Error("not implemented");
}

/** `referenceTick` is the receiver's current tick, used to unwrap u16 ticks. */
export function decodeInputPacket(r: BitReader, referenceTick: number): InputPacket {
  throw new Error("not implemented");
}
