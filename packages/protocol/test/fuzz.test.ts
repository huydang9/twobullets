import { describe, expect, it } from "vitest";
import { createBitReader, createBitWriter } from "../src/bits";
import { decodeDisconnect, decodeHello, decodeKillFeed, decodeResyncRequest, decodeResyncResponse, decodeWelcome } from "../src/messages/control";
import { MsgId } from "../src/messages/ids";
import { createInputPacketBuffer, decodeInputPacketInto, encodeInputPacket } from "../src/messages/input";
import { decodePing } from "../src/messages/ping";
import { decodeRoster } from "../src/messages/roster";
import { MAX_ENTITY_SLOTS, MAX_TEAMMATES, createSnapshotBuffer, decodeSnapshotInto, encodeSnapshot, type Snapshot } from "../src/messages/snapshot";
import { describeMessage } from "../src/debug/describe";
import { StreamDeframer } from "../src/framing";
import { CombatWorld, randomInput, randomItemsBlock, randomPlayerHit, randomReliable, randomShot, randomTeammates, randomVitalsBlock, randomWeaponBlock, SnapshotWorld } from "./fixtures";
import { createTestRng, randInt } from "./rng";

// netcode.md §11.4 gate: random bytes never throw uncaught. The BitReader bounds every read, so decoders see zeros
// past the end and report `overflowed` instead of indexing out of range.

const IDS = [MsgId.Input, MsgId.Ping, MsgId.Snapshot, MsgId.Hello, MsgId.Welcome, MsgId.Resync, MsgId.Disconnect, MsgId.KillFeed, MsgId.Roster];

function decodeAll(bytes: Uint8Array, baseline: Snapshot | null): void {
  const r = createBitReader(bytes);
  const input = createInputPacketBuffer();
  if (decodeInputPacketInto(r, 5000, input)) {
    expect(input.count).toBeGreaterThanOrEqual(1);
    expect(input.count).toBeLessThanOrEqual(6);
  }
  r.reset(bytes);
  const snap = createSnapshotBuffer();
  if (decodeSnapshotInto(r, 5000, () => baseline, snap)) {
    expect(snap.entities.length).toBeLessThanOrEqual(MAX_ENTITY_SLOTS);
    expect(snap.teammates.length).toBeLessThanOrEqual(MAX_TEAMMATES);
  }
  for (const decode of [decodeHello, decodeWelcome, decodeDisconnect, decodeResyncRequest, decodeResyncResponse, decodePing, decodeKillFeed, decodeRoster]) {
    r.reset(bytes);
    decode(r);
  }
  describeMessage(bytes);
  new StreamDeframer().push(bytes, () => {});
}

describe("decoder fuzz", () => {
  it("random bytes with valid and random ids", () => {
    const rng = createTestRng(1234);
    const world = new SnapshotWorld(rng);
    const baseline = world.snapshot(0, true);
    for (let i = 0; i < 20000; i++) {
      const bytes = new Uint8Array(randInt(rng, 0, i % 10 === 0 ? 1200 : 80));
      for (let k = 0; k < bytes.length; k++) bytes[k] = randInt(rng, 0, 255);
      if (bytes.length > 0 && rng() < 0.8) bytes[0] = IDS[randInt(rng, 0, IDS.length - 1)]!;
      if (bytes.length > 0 && bytes[0] === MsgId.Snapshot && bytes.length > 4 && rng() < 0.5) {
        bytes[3] = baseline.header.serverTick & 0xff;
        bytes[4] = (baseline.header.serverTick >>> 8) & 0xff;
      }
      expect(() => decodeAll(bytes, baseline)).not.toThrow();
    }
  });

  it("mutated and truncated valid messages", () => {
    const rng = createTestRng(99);
    const world = new SnapshotWorld(rng);
    const combat = new CombatWorld(rng);
    const w = createBitWriter(1500);
    let prevSnap: Snapshot | null = null;
    for (let i = 0; i < 6000; i++) {
      world.step();
      w.reset();
      if (i % 3 === 2) {
        const snap: Snapshot = {
          ...(i % 2 === 0 ? combat.snapshot(0) : world.snapshot(0, true)),
          weapon: randomWeaponBlock(rng),
          vitals: randomVitalsBlock(rng),
          items: randomItemsBlock(rng),
          shots: [randomShot(rng), randomShot(rng)],
          hits: [randomPlayerHit(rng)],
          reliable: [randomReliable(rng, 1), randomReliable(rng, 2), randomReliable(rng, 9)],
          teammates: randomTeammates(rng),
        };
        encodeSnapshot(w, snap, prevSnap?.weapon ? prevSnap : null);
        prevSnap = snap;
      } else if (i % 2 === 0) {
        const inputs = [];
        let prev = null;
        for (let k = 0; k < randInt(rng, 1, 6); k++) inputs.push((prev = randomInput(rng, world.tick - k, prev)));
        encodeInputPacket(w, { newestTick: world.tick, ackSnapshotTick: world.tick - 3, clientTimeMs: 1, interpDelayMs: 40, inputs });
      } else {
        const snap = world.snapshot(0, true);
        encodeSnapshot(w, snap, prevSnap);
        prevSnap = snap;
      }
      const bytes = w.bytes().slice();
      const mode = randInt(rng, 0, 2);
      let mutated = bytes;
      if (mode === 0) mutated = bytes.subarray(0, randInt(rng, 0, bytes.length));
      else {
        for (let f = 0; f < randInt(rng, 1, 8); f++) {
          const bit = randInt(rng, 0, bytes.length * 8 - 1);
          bytes[bit >>> 3]! ^= 1 << (bit & 7);
        }
        if (mode === 2) mutated = new Uint8Array([...bytes, ...new Uint8Array(randInt(rng, 1, 20))]);
      }
      expect(() => decodeAll(mutated, prevSnap)).not.toThrow();
    }
  });
});
