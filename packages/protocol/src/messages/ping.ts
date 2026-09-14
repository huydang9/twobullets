import type { BitReader, BitWriter } from "../bits";
import { MsgId } from "./ids";

// 0x02, both directions, datagram (7 B): RTT probe when idle, region beacons, and the WebTransport datagram check
// after the handshake (netcode.md §7.3). The responder echoes seq and originTimeMs and fills holdMs.

export interface Ping {
  /** u8, echoed. */
  readonly seq: number;
  /** Sender's `performance.now()` mod 65536, echoed. */
  readonly originTimeMs: number;
  /** Responder: receipt → reply, ms (0 in a request). */
  readonly holdMs: number;
  readonly reply: boolean;
}

// type 8, seq 8, originTimeMs 16, holdMs 16, flags 8 (bit 0 = reply).
export function encodePing(w: BitWriter, m: Ping): void {
  w.write(MsgId.Ping, 8);
  w.write(m.seq, 8);
  w.write(m.originTimeMs, 16);
  w.write(Math.min(0xffff, Math.max(0, Math.round(m.holdMs))), 16);
  w.write(m.reply ? 1 : 0, 8);
}

export function decodePing(r: BitReader): Ping | null {
  if (r.read(8) !== MsgId.Ping) return null;
  const seq = r.read(8);
  const originTimeMs = r.read(16);
  const holdMs = r.read(16);
  const flags = r.read(8);
  if (r.overflowed || r.bitsLeft !== 0 || flags > 1) return null;
  return { seq, originTimeMs, holdMs, reply: flags === 1 };
}

/** RTT from a ping reply received at `nowMs` (same clock as `originTimeMs`, wraps at 65536). */
export function pingRttMs(reply: Ping, nowMs: number): number {
  return ((Math.floor(nowMs) - reply.originTimeMs) & 0xffff) - reply.holdMs;
}
