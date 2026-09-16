import { describe, expect, it } from "vitest";
import { createBitReader, createBitWriter } from "../src/bits";
import {
  decodeMatchCommand,
  decodeMatchCommandResult,
  encodeMatchCommand,
  encodeMatchCommandResult,
  MatchCommandCode,
  MatchCommandStatus,
  type MatchCommand,
  type MatchCommandResult,
} from "../src/messages/control";
import { MsgId } from "../src/messages/ids";
import { decodeMatchEnd, encodeMatchEnd, MatchEndReason } from "../src/messages/match";
import { describeMessage } from "../src/debug/describe";
import { PROTOCOL_VERSION } from "../src/version";
import { createTestRng, randInt } from "./rng";

// Quitting a match (protocol v8): MatchCommand / MatchCommandResult round-trips, bounds and fuzz.

describe("MatchCommand (v8)", () => {
  it("uses ids 0x50 / 0x51 from protocol v8", () => {
    expect(MsgId.MatchCommand).toBe(0x50);
    expect(MsgId.MatchCommandResult).toBe(0x51);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(8);
  });

  it("round-trips the command in 3 bytes and the result in 4", () => {
    const w = createBitWriter(16);
    for (const command of [MatchCommandCode.leave, MatchCommandCode.endForAll]) {
      const m: MatchCommand = { command, detail: 0 };
      w.reset();
      encodeMatchCommand(w, m);
      expect(w.byteLength).toBe(3);
      expect(decodeMatchCommand(createBitReader(w.bytes()))).toEqual(m);
      expect(describeMessage(w.bytes())).toMatchObject({ name: "MatchCommand", ok: true });
    }
    for (const status of [MatchCommandStatus.ok, MatchCommandStatus.denied, MatchCommandStatus.unavailable, MatchCommandStatus.unknown]) {
      const m: MatchCommandResult = { command: MatchCommandCode.endForAll, status, detail: 0 };
      w.reset();
      encodeMatchCommandResult(w, m);
      expect(w.byteLength).toBe(4);
      expect(decodeMatchCommandResult(createBitReader(w.bytes()))).toEqual(m);
      expect(describeMessage(w.bytes())).toMatchObject({ name: "MatchCommandResult", ok: true });
    }
  });

  it("keeps unknown command codes decodable (the server answers `unknown`) but rejects unknown statuses", () => {
    const w = createBitWriter(16);
    encodeMatchCommand(w, { command: 250, detail: 7 });
    expect(decodeMatchCommand(createBitReader(w.bytes()))).toEqual({ command: 250, detail: 7 });
    w.reset();
    encodeMatchCommandResult(w, { command: MatchCommandCode.leave, status: 9, detail: 0 });
    expect(decodeMatchCommandResult(createBitReader(w.bytes()))).toBeNull();
  });

  it("rejects truncation, trailing bytes and the wrong id", () => {
    const w = createBitWriter(16);
    encodeMatchCommand(w, { command: MatchCommandCode.leave, detail: 0 });
    const command = w.bytes().slice();
    for (let n = 0; n < command.length; n++) expect(decodeMatchCommand(createBitReader(command.subarray(0, n)))).toBeNull();
    expect(decodeMatchCommand(createBitReader(new Uint8Array([...command, 0])))).toBeNull();
    expect(decodeMatchCommandResult(createBitReader(command))).toBeNull();
    w.reset();
    encodeMatchCommandResult(w, { command: MatchCommandCode.leave, status: MatchCommandStatus.ok, detail: 0 });
    const result = w.bytes().slice();
    for (let n = 0; n < result.length; n++) expect(decodeMatchCommandResult(createBitReader(result.subarray(0, n)))).toBeNull();
    expect(decodeMatchCommandResult(createBitReader(new Uint8Array([...result, 0])))).toBeNull();
    expect(decodeMatchCommand(createBitReader(result))).toBeNull();
  });

  it("MatchEnd accepts the new `hostEnded` reason and still rejects unknown ones", () => {
    const w = createBitWriter(64);
    encodeMatchEnd(w, { serverTick: 42, reason: MatchEndReason.hostEnded, winningTeam: 2, players: [] });
    expect(decodeMatchEnd(createBitReader(w.bytes()))).toMatchObject({ reason: MatchEndReason.hostEnded, winningTeam: 2 });
    w.reset();
    encodeMatchEnd(w, { serverTick: 42, reason: 9 as MatchEndReason, winningTeam: -1, players: [] });
    expect(decodeMatchEnd(createBitReader(w.bytes()))).toBeNull();
  });

  it("fuzz: random and mutated bytes never throw", () => {
    const rng = createTestRng(0x50);
    const r = createBitReader(new Uint8Array(0));
    const w = createBitWriter(16);
    encodeMatchCommandResult(w, { command: MatchCommandCode.endForAll, status: MatchCommandStatus.denied, detail: 0 });
    const valid = w.bytes().slice();
    for (let i = 0; i < 20000; i++) {
      let bytes: Uint8Array;
      if (i % 2 === 0) {
        bytes = new Uint8Array(randInt(rng, 0, 10));
        for (let k = 0; k < bytes.length; k++) bytes[k] = randInt(rng, 0, 255);
        if (bytes.length > 0) bytes[0] = rng() < 0.5 ? MsgId.MatchCommand : MsgId.MatchCommandResult;
      } else {
        bytes = valid.slice();
        const bit = randInt(rng, 0, bytes.length * 8 - 1);
        bytes[bit >>> 3]! ^= 1 << (bit & 7);
        if (rng() < 0.3) bytes = bytes.subarray(0, randInt(rng, 0, bytes.length));
      }
      r.reset(bytes);
      expect(() => decodeMatchCommand(r)).not.toThrow();
      r.reset(bytes);
      expect(() => decodeMatchCommandResult(r)).not.toThrow();
      expect(() => describeMessage(bytes)).not.toThrow();
    }
  });
});
