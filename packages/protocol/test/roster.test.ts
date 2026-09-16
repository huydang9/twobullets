import { describe, expect, it } from "vitest";
import { createBitReader, createBitWriter } from "../src/bits";
import { MsgId } from "../src/messages/ids";
import { decodeRoster, encodeRoster, ROSTER_NAME_MAX_BYTES, rosterNameBytes, type Roster, type RosterPlayer } from "../src/messages/roster";
import { describeMessage } from "../src/debug/describe";
import { PROTOCOL_VERSION } from "../src/version";
import { createTestRng, randInt } from "./rng";

const human = (slot: number, team: number, name: string, connected = true, host = false): RosterPlayer => ({ slot, team, name, isBot: false, botIndex: -1, connected, host });
const bot = (slot: number, team: number, botIndex: number): RosterPlayer => ({ slot, team, name: "", isBot: true, botIndex, connected: true, host: false });

function roundTrip(m: Roster): { bytes: Uint8Array; decoded: Roster | null } {
  const w = createBitWriter(600);
  encodeRoster(w, m);
  const bytes = w.bytes().slice();
  return { bytes, decoded: decodeRoster(createBitReader(bytes)) };
}

const NAME_CHARS = ["a", "Z", "0", " ", "_", "Đ", "ặ", "ư", "ơ", "ễ", "日", "😀"];

describe("Roster (v5)", () => {
  it("is id 0x4D (since protocol v5)", () => {
    expect(MsgId.Roster).toBe(0x4d);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(5);
  });

  it("round-trips humans (Vietnamese names), bots and connection flags; sizes 2 B + 3 B per player + names", () => {
    const m: Roster = { players: [human(0, 0, "Huy Đặng"), bot(1, 0, 3), human(2, 1, "Nguyễn Thị Ánh", false), bot(3, 1, 0)] };
    const { bytes, decoded } = roundTrip(m);
    expect(decoded).toEqual(m);
    const nameBytes = new TextEncoder().encode("Huy Đặng").length + new TextEncoder().encode("Nguyễn Thị Ánh").length;
    expect(bytes.length).toBe(2 + 4 * 3 + nameBytes);
    expect(describeMessage(bytes)).toMatchObject({ name: "Roster", ok: true });
    expect(roundTrip({ players: [] })).toMatchObject({ decoded: { players: [] } });
    expect(roundTrip({ players: [] }).bytes.length).toBe(2);
  });

  it("20 bots fit in 62 B and 20 humans with 24-byte names in 542 B", () => {
    const bots: Roster = { players: Array.from({ length: 20 }, (_, slot) => bot(slot, Math.floor(slot / 2), slot)) };
    expect(roundTrip(bots).bytes.length).toBe(62);
    expect(roundTrip(bots).decoded).toEqual(bots);
    const humans: Roster = { players: Array.from({ length: 20 }, (_, slot) => human(slot, slot, "x".repeat(24))) };
    const full = roundTrip(humans);
    expect(full.bytes.length).toBe(542);
    expect(full.decoded).toEqual(humans);
  });

  it("cuts long names to 24 bytes on a code point boundary", () => {
    // "Đặng" is 2 + 3 + 1 + 1 bytes; 4 of them are 28 bytes, so the cut lands inside the 4th "ặ".
    const long = "ĐặngĐặngĐặngĐặng";
    const cut = rosterNameBytes(long);
    expect(cut.length).toBeLessThanOrEqual(ROSTER_NAME_MAX_BYTES);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(cut)).toBe("ĐặngĐặngĐặngĐ");
    const { decoded } = roundTrip({ players: [human(5, 2, long)] });
    expect(decoded!.players[0]!.name).toBe("ĐặngĐặngĐặngĐ");
    expect(roundTrip({ players: [bot(0, 0, 999)] }).decoded!.players[0]!.botIndex).toBe(255);
  });

  it("carries the v8 host bit, one per roster, never on a bot", () => {
    const m: Roster = { players: [human(0, 0, "Huy", true, true), human(1, 0, "Lan"), bot(2, 1, 0)] };
    const { bytes, decoded } = roundTrip(m);
    expect(decoded!.players.map((p) => p.host)).toEqual([true, false, false]);
    // Same size as v7: the bit came out of the per-player reserved nibble.
    expect(bytes.length).toBe(2 + 3 * 3 + new TextEncoder().encode("HuyLan").length);
    // A bot with the host bit set is malformed.
    const forged = roundTrip({ players: [bot(0, 0, 1)] }).bytes.slice();
    forged[3]! |= 0b0001_0000;
    expect(decodeRoster(createBitReader(forged))).toBeNull();
  });

  it("random rosters round-trip", () => {
    const rng = createTestRng(0x4d);
    for (let i = 0; i < 500; i++) {
      const slots = Array.from({ length: 20 }, (_, s) => s).filter(() => rng() < 0.6);
      const players = slots.map((slot) => {
        if (rng() < 0.5) return bot(slot, randInt(rng, 0, 19), randInt(rng, 0, 255));
        let name = "";
        for (let k = randInt(rng, 0, 10); k > 0; k--) name += NAME_CHARS[randInt(rng, 0, NAME_CHARS.length - 1)];
        name = new TextDecoder().decode(rosterNameBytes(name));
        return human(slot, randInt(rng, 0, 19), name, rng() < 0.7);
      });
      expect(roundTrip({ players }).decoded).toEqual({ players });
    }
  });

  it("rejects truncation, trailing bytes, duplicate or out-of-range slots, long names and invalid UTF-8", () => {
    const { bytes } = roundTrip({ players: [human(0, 0, "Huy Đặng"), bot(1, 0, 2)] });
    for (let n = 0; n < bytes.length; n++) expect(decodeRoster(createBitReader(bytes.subarray(0, n)))).toBeNull();
    expect(decodeRoster(createBitReader(new Uint8Array([...bytes, 0])))).toBeNull();
    const w = createBitWriter(64);
    encodeRoster(w, { players: [bot(4, 0, 1), bot(4, 1, 2)] });
    expect(decodeRoster(createBitReader(w.bytes()))).toBeNull();
    w.reset();
    encodeRoster(w, { players: [bot(20, 0, 1)] });
    expect(decodeRoster(createBitReader(w.bytes()))).toBeNull();
    // Human with a 25-byte name length, and one with bytes that are not UTF-8.
    const longName = new Uint8Array([MsgId.Roster, 1, 0, 0, 25, ...new Uint8Array(25).fill(0x61)]);
    expect(decodeRoster(createBitReader(longName))).toBeNull();
    const badUtf8 = new Uint8Array([MsgId.Roster, 1, 0, 0, 2, 0xc3, 0x28]);
    expect(decodeRoster(createBitReader(badUtf8))).toBeNull();
    const ok = new Uint8Array([MsgId.Roster, 1, 0, 0, 2, 0xc3, 0xa9]);
    expect(decodeRoster(createBitReader(ok))).toEqual({ players: [human(0, 0, "é", false)] });
  });

  it("fuzz: random and mutated bytes never throw", () => {
    const rng = createTestRng(77);
    const r = createBitReader(new Uint8Array(0));
    const valid = roundTrip({ players: [human(0, 0, "Huy Đặng"), bot(1, 0, 3), human(7, 3, "日本😀")] }).bytes;
    for (let i = 0; i < 20000; i++) {
      let bytes: Uint8Array;
      if (i % 2 === 0) {
        bytes = new Uint8Array(randInt(rng, 0, 120));
        for (let k = 0; k < bytes.length; k++) bytes[k] = randInt(rng, 0, 255);
        if (bytes.length > 0) bytes[0] = MsgId.Roster;
      } else {
        bytes = valid.slice();
        for (let f = randInt(rng, 1, 6); f > 0; f--) {
          const bit = randInt(rng, 8, bytes.length * 8 - 1);
          bytes[bit >>> 3]! ^= 1 << (bit & 7);
        }
        if (rng() < 0.3) bytes = bytes.subarray(0, randInt(rng, 0, bytes.length));
      }
      r.reset(bytes);
      expect(() => decodeRoster(r)).not.toThrow();
      expect(() => describeMessage(bytes)).not.toThrow();
    }
  });
});
