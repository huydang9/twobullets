import type { BitReader, BitWriter } from "../bits";
import { MAX_PLAYER_SLOTS, SLOT_BITS, TEAM_BITS } from "../codes";
import { MsgId } from "./ids";

// Roster (protocol v5): who holds each slot. Sent on the control stream after Welcome and again whenever a join, leave
// or bot fill changes it. Bots carry their seat index (`bot:<n>`), not a name, so clients localize "Bot n".

/** Human names are cut to this many UTF-8 bytes (on a code point boundary). */
export const ROSTER_NAME_MAX_BYTES = 24;

export interface RosterPlayer {
  readonly slot: number;
  readonly team: number;
  /** Nickname (≤ ROSTER_NAME_MAX_BYTES UTF-8 bytes); "" for bots. */
  readonly name: string;
  readonly isBot: boolean;
  /** `n` of the `bot:<n>` seat (u8, saturating); −1 for humans. */
  readonly botIndex: number;
  /** Humans: a session is attached. Bots: always true. */
  readonly connected: boolean;
  /** v8: this account may end the match for everyone (the lobby host, or whoever inherited it). Never a bot. */
  readonly host: boolean;
}

/** 0x4D, S→C (2 B + 3 B per player + name bytes; ≤ 542 B). Players sorted by slot. */
export interface Roster {
  readonly players: readonly RosterPlayer[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 bytes of `name`, cut to `max` bytes without splitting a code point. */
export function rosterNameBytes(name: string, max = ROSTER_NAME_MAX_BYTES): Uint8Array {
  const bytes = textEncoder.encode(name);
  if (bytes.length <= max) return bytes;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

// Roster: type 8, count 5, reserved 3; per player: slot 5, team 5, bot 1, connected 1, host 1 (v8), reserved 3, then
// u8 = bot index (bots) or name length (humans), then the name bytes.
export function encodeRoster(w: BitWriter, m: Roster): void {
  const count = Math.min(MAX_PLAYER_SLOTS, m.players.length);
  w.write(MsgId.Roster, 8);
  w.write(count, 5);
  w.write(0, 3);
  for (let i = 0; i < count; i++) {
    const p = m.players[i]!;
    w.write(p.slot, SLOT_BITS);
    w.write(p.team, TEAM_BITS);
    w.write(p.isBot ? 1 : 0, 1);
    w.write(p.connected ? 1 : 0, 1);
    w.write(p.host && !p.isBot ? 1 : 0, 1);
    w.write(0, 3);
    if (p.isBot) {
      w.write(Math.min(255, Math.max(0, Math.floor(p.botIndex))), 8);
    } else {
      const name = rosterNameBytes(p.name);
      w.write(name.length, 8);
      w.writeBytes(name);
    }
  }
}

export function decodeRoster(r: BitReader): Roster | null {
  if (r.read(8) !== MsgId.Roster) return null;
  const count = r.read(5);
  r.read(3);
  if (r.overflowed || count > MAX_PLAYER_SLOTS) return null;
  const players: RosterPlayer[] = [];
  let seen = 0;
  for (let i = 0; i < count; i++) {
    const slot = r.read(SLOT_BITS);
    const team = r.read(TEAM_BITS);
    const isBot = r.read(1) === 1;
    const connected = r.read(1) === 1;
    const host = r.read(1) === 1;
    r.read(3);
    const byte = r.read(8);
    if (r.overflowed || slot >= MAX_PLAYER_SLOTS || (seen & (1 << slot)) !== 0) return null;
    seen |= 1 << slot;
    if (isBot) {
      if (host) return null;
      players.push({ slot, team, name: "", isBot, botIndex: byte, connected, host: false });
      continue;
    }
    if (byte > ROSTER_NAME_MAX_BYTES) return null;
    const bytes = r.readBytes(byte);
    if (r.overflowed) return null;
    let name: string;
    try {
      name = textDecoder.decode(bytes);
    } catch {
      return null;
    }
    players.push({ slot, team, name, isBot, botIndex: -1, connected, host });
  }
  if (r.overflowed || r.bitsLeft !== 0) return null;
  return { players };
}
