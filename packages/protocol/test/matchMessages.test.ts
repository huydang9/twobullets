import { describe, expect, it } from "vitest";
import { createBitReader, createBitWriter } from "../src/bits";
import { PhaseCode } from "../src/messages/control";
import {
  decodeMatchEnd,
  decodePhaseChange,
  decodeZonePhase,
  encodeMatchEnd,
  encodePhaseChange,
  encodeZonePhase,
  MatchEndReason,
  quantizeZonePhase,
  type MatchEnd,
  type PhaseChange,
  type ZonePhaseMessage,
} from "../src/messages/match";
import { describeMessage } from "../src/debug/describe";
import { createTestRng, randInt } from "./rng";

describe("battle royale lifecycle messages (v4)", () => {
  it("PhaseChange round-trips in 12 bytes and rejects unknown phases", () => {
    const w = createBitWriter(64);
    const m: PhaseChange = { phase: PhaseCode.Combat, startTick: 0xfffffff0, endTick: 0, teamsAlive: 5, playersAlive: 20 };
    encodePhaseChange(w, m);
    expect(w.byteLength).toBe(12);
    expect(decodePhaseChange(createBitReader(w.bytes()))).toEqual(m);
    w.reset();
    encodePhaseChange(w, { ...m, phase: 9 });
    expect(decodePhaseChange(createBitReader(w.bytes()))).toBeNull();
    expect(describeMessage(w.bytes()).name).toBe("PhaseChange");
  });

  it("ZonePhase is 27 bytes and decodes to exactly the quantized phase", () => {
    const rng = createTestRng(46);
    const w = createBitWriter(64);
    for (let i = 0; i < 200; i++) {
      const phase: ZonePhaseMessage = {
        index: randInt(rng, 1, 8),
        waitStartTick: randInt(rng, 0, 100_000),
        shrinkStartTick: 100_001 + randInt(rng, 0, 5000),
        shrinkEndTick: 105_002 + randInt(rng, 0, 5000),
        from: { cx: rng() * 1000 - 500, cz: rng() * 1000 - 500, r: rng() * 710 },
        to: { cx: rng() * 1000 - 500, cz: rng() * 1000 - 500, r: rng() * 400 },
        dps: randInt(rng, 0, 200) / 10,
      };
      w.reset();
      encodeZonePhase(w, phase);
      expect(w.byteLength).toBe(27);
      const decoded = decodeZonePhase(createBitReader(w.bytes()))!;
      const q = quantizeZonePhase(phase);
      expect(decoded).toEqual(q);
      // Quantizing is idempotent, so a server simulating `q` and a client decoding it agree bit for bit.
      w.reset();
      encodeZonePhase(w, q);
      expect(decodeZonePhase(createBitReader(w.bytes()))).toEqual(q);
      expect(Math.abs(q.from.cx - phase.from.cx)).toBeLessThanOrEqual(1 / 128 + 1e-9);
      expect(Math.abs(q.to.r - phase.to.r)).toBeLessThanOrEqual(1 / 128 + 1e-9);
    }
  });

  it("MatchEnd round-trips 20 players in 188 bytes, no winner as -1", () => {
    const rng = createTestRng(74);
    const players = Array.from({ length: 20 }, (_, slot) => ({
      slot,
      teamId: Math.floor(slot / 4),
      placement: randInt(rng, 1, 5),
      bot: rng() < 0.5,
      kills: randInt(rng, 0, 30),
      knocks: randInt(rng, 0, 30),
      revives: randInt(rng, 0, 5),
      damageDealt: randInt(rng, 0, 4000),
      survivedSec: randInt(rng, 0, 900),
    }));
    const m: MatchEnd = { serverTick: 123_456, reason: MatchEndReason.lastTeam, winningTeam: 3, players };
    const w = createBitWriter(256);
    encodeMatchEnd(w, m);
    expect(w.byteLength).toBe(188);
    expect(decodeMatchEnd(createBitReader(w.bytes()))).toEqual(m);
    w.reset();
    const none: MatchEnd = { serverTick: 1, reason: MatchEndReason.cancelled, winningTeam: -1, players: [] };
    encodeMatchEnd(w, none);
    expect(w.byteLength).toBe(8);
    expect(decodeMatchEnd(createBitReader(w.bytes()))).toEqual(none);
    expect(decodeMatchEnd(createBitReader(w.bytes().subarray(0, 7)))).toBeNull();
  });
});
