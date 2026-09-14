import type { PlayerInput } from "@twobullets/shared/input";
import { describe, expect, it } from "vitest";
import { createBitReader, createBitWriter } from "../src/bits";
import { MAX_STREAM_FRAME_BYTES, StreamDeframer, writeStreamFrame } from "../src/framing";
import {
  DisconnectReason,
  decodeDisconnect,
  decodeHello,
  decodeResyncRequest,
  decodeResyncResponse,
  decodeWelcome,
  encodeDisconnect,
  encodeHello,
  encodeResyncRequest,
  encodeResyncResponse,
  encodeWelcome,
  type Welcome,
} from "../src/messages/control";
import { createInputPacketBuffer, decodeInputPacket, decodeInputPacketInto, encodeInputPacket, type InputPacket } from "../src/messages/input";
import { decodePing, encodePing, pingRttMs } from "../src/messages/ping";
import {
  EntityPresence,
  copySnapshot,
  createSnapshotBuffer,
  decodeSnapshot,
  decodeSnapshotInto,
  encodeSnapshot,
  type MutableSnapshot,
  type Snapshot,
} from "../src/messages/snapshot";
import { audibleXZFromMm, audibleXZToMm, audibleYFromMm, audibleYToMm } from "../src/quantize";
import { NO_TICK } from "../src/ticks";
import { randomInput, SnapshotWorld } from "./fixtures";
import { createTestRng, randInt } from "./rng";

function wire(input: PlayerInput): PlayerInput {
  return { ...input, viewOffset8: (input.buttons & 8) !== 0 ? input.viewOffset8 : 0 };
}

describe("Input packet", () => {
  it("roundtrips random redundant inputs, including u16 tick wrap", () => {
    const rng = createTestRng(11);
    const w = createBitWriter(256);
    const scratch = createInputPacketBuffer();
    for (let i = 0; i < 5000; i++) {
      const count = randInt(rng, 1, 6);
      const newestTick = randInt(rng, 0, 2 ** 24);
      const oldestFirst: PlayerInput[] = [];
      let prev: PlayerInput | null = null;
      for (let k = count - 1; k >= 0; k--) {
        prev = randomInput(rng, newestTick - k, prev);
        oldestFirst.push(prev);
      }
      const packet: InputPacket = {
        newestTick,
        ackSnapshotTick: rng() < 0.1 ? NO_TICK : newestTick - randInt(rng, 0, 20),
        clientTimeMs: randInt(rng, 0, 65535),
        interpDelayMs: randInt(rng, 0, 255) * 2,
        inputs: oldestFirst.reverse(),
      };
      w.reset();
      encodeInputPacket(w, packet);
      const reference = newestTick + randInt(rng, -2000, 2000);
      const decoded = decodeInputPacket(createBitReader(w.bytes()), reference);
      expect(decoded).not.toBeNull();
      expect(decoded!.newestTick).toBe(newestTick);
      expect(decoded!.ackSnapshotTick).toBe(packet.ackSnapshotTick < 0 || (packet.ackSnapshotTick & 0xffff) === 0xffff ? NO_TICK : packet.ackSnapshotTick);
      expect(decoded!.clientTimeMs).toBe(packet.clientTimeMs);
      expect(decoded!.interpDelayMs).toBe(packet.interpDelayMs);
      expect(decoded!.inputs).toEqual(packet.inputs.map(wire));
      expect(decodeInputPacketInto(createBitReader(w.bytes()), reference, scratch)).toBe(true);
      expect(scratch.count).toBe(count);
    }
  });

  it("identical redundant inputs cost 1 bit each", () => {
    const base: PlayerInput = { tick: 100, forward: 1, right: 0, buttons: 0, select: 0, yawQ: 1234, pitchQ: 5678, viewOffset8: 0, action: null };
    const w = createBitWriter(64);
    encodeInputPacket(w, { newestTick: 100, ackSnapshotTick: 95, clientTimeMs: 0, interpDelayMs: 50, inputs: [base] });
    const one = w.bitLength;
    w.reset();
    const six = [0, 1, 2, 3, 4, 5].map((k) => ({ ...base, tick: 100 - k }));
    encodeInputPacket(w, { newestTick: 100, ackSnapshotTick: 95, clientTimeMs: 0, interpDelayMs: 50, inputs: six });
    expect(w.bitLength - one).toBe(5);
  });
});

function expectSnapshotEqual(decoded: Snapshot, source: Snapshot): void {
  expect(decoded.owner).toEqual(source.owner);
  expect(decoded.entities.length).toBe(source.entities.length);
  for (let i = 0; i < source.entities.length; i++) {
    const s = source.entities[i]!;
    const d = decoded.entities[i]!;
    expect(d.slot).toBe(s.slot);
    expect(d.presence).toBe(s.presence);
    if (s.presence === EntityPresence.full) {
      expect({ ...d, noiseClass: 0 }).toEqual({ ...s, noiseClass: 0 });
    } else if (s.presence === EntityPresence.audibleOnly) {
      expect(d.xMm).toBe(audibleXZToMm(audibleXZFromMm(s.xMm)));
      expect(d.yMm).toBe(audibleYToMm(audibleYFromMm(s.yMm)));
      expect(d.zMm).toBe(audibleXZToMm(audibleXZFromMm(s.zMm)));
      expect(d.noiseClass).toBe(s.noiseClass);
      expect(d.flags).toBe(s.flags & 3);
    }
  }
}

describe("Snapshot", () => {
  it("roundtrips full and delta snapshots against ack-delayed baselines", () => {
    const rng = createTestRng(21);
    const world = new SnapshotWorld(rng);
    const w = createBitWriter(1500);
    const serverSent = new Map<number, Snapshot>();
    const clientStore = new Map<number, MutableSnapshot>();
    const scratch = createSnapshotBuffer();
    let deltas = 0;
    for (let t = 0; t < 3000; t++) {
      world.step();
      const snap = world.snapshot(0, true);
      const ackAge = randInt(rng, 1, 140);
      const baseline = rng() < 0.05 ? null : (serverSent.get(world.tick - ackAge) ?? null);
      w.reset();
      encodeSnapshot(w, snap, baseline);
      serverSent.set(world.tick, snap);
      serverSent.delete(world.tick - 200);
      const ok = decodeSnapshotInto(createBitReader(w.bytes()), world.tick - randInt(rng, 0, 10), (tick) => clientStore.get(tick) ?? null, scratch);
      expect(ok).toBe(true);
      if (baseline !== null) deltas++;
      expect(scratch.header.serverTick).toBe(world.tick);
      expect(scratch.header.baselineTick).toBe(baseline?.header.serverTick ?? null);
      expect(scratch.header.lastProcessedInputTick).toBe(snap.header.lastProcessedInputTick);
      expect(scratch.header.clientTimeEcho).toBe(snap.header.clientTimeEcho);
      expect(scratch.header.serverHoldMs).toBe(snap.header.serverHoldMs);
      expect(scratch.header.inputBufferDepthQ).toBe(snap.header.inputBufferDepthQ);
      expectSnapshotEqual(scratch, snap);
      // The client keeps what it decoded; the server's baseline is the source snapshot. They must stay equal for
      // full entities, so later deltas decode (audible-only entities are never delta baselines).
      const stored = createSnapshotBuffer();
      copySnapshot(scratch, stored);
      clientStore.set(world.tick, stored);
    }
    expect(deltas).toBeGreaterThan(2000);
  });

  it("drops a delta whose baseline the client doesn't have", () => {
    const world = new SnapshotWorld(createTestRng(5));
    const w = createBitWriter(1500);
    const base = world.snapshot(0);
    world.step();
    encodeSnapshot(w, world.snapshot(0), base);
    expect(decodeSnapshot(createBitReader(w.bytes()), world.tick, () => null)).toBeNull();
  });

  it("an entity that re-appears is encoded full even when the baseline had it removed", () => {
    const world = new SnapshotWorld(createTestRng(6), 3);
    const w = createBitWriter(1500);
    const base = world.snapshot(0);
    const removed: Snapshot = { ...base, entities: base.entities.map((e) => (e.slot === 2 ? { ...e, presence: EntityPresence.removed } : e)) };
    world.step();
    const next = world.snapshot(0);
    encodeSnapshot(w, next, removed);
    const decoded = decodeSnapshot(createBitReader(w.bytes()), world.tick, () => removed);
    expect(decoded).not.toBeNull();
    expectSnapshotEqual(decoded!, next);
  });

  it("header-only and owner-only snapshots", () => {
    const w = createBitWriter(64);
    const snap: Snapshot = {
      header: { serverTick: 70000, baselineTick: null, lastProcessedInputTick: NO_TICK, clientTimeEcho: 1, serverHoldMs: 300, inputBufferDepthQ: -500, sections: 0 },
      owner: null,
      entities: [],
    };
    encodeSnapshot(w, snap, null);
    expect(w.byteLength).toBe(12);
    const d = decodeSnapshot(createBitReader(w.bytes()), 69990, () => null)!;
    expect(d.header).toEqual({ ...snap.header, serverHoldMs: 255, inputBufferDepthQ: -128 });
  });
});

describe("control messages", () => {
  const token = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";
  it("Hello", () => {
    const w = createBitWriter(4096);
    const m = { protocolVersion: 1, contentHash: 0xdeadbeef, joinToken: token, maxDatagramSize: 1200, transport: "ws" as const };
    encodeHello(w, m);
    expect(decodeHello(createBitReader(w.bytes()))).toEqual(m);
  });

  it("Welcome is 40 bytes", () => {
    const w = createBitWriter(64);
    const m: Welcome = {
      playerSlot: 9,
      teamId: 4,
      serverTick: 4_000_000_000,
      tickRate: 60,
      snapshotRate: 60,
      matchSeed: 0xfedcba98,
      phase: 3,
      phaseEndTick: 123456,
      maxRewindMs: 200,
      interpFloorMs: 25,
      resumeToken: new Uint8Array(16).map((_, i) => i * 7),
      contentHash: 0x12345678,
      flags: 5,
    };
    encodeWelcome(w, m);
    expect(w.byteLength).toBe(40);
    expect(decodeWelcome(createBitReader(w.bytes()))).toEqual(m);
  });

  it("Disconnect, Resync, Ping", () => {
    const w = createBitWriter(64);
    encodeDisconnect(w, { reason: DisconnectReason.versionMismatch, detail: 2 });
    expect(w.byteLength).toBe(3);
    expect(decodeDisconnect(createBitReader(w.bytes()))).toEqual({ reason: 1, detail: 2 });
    w.reset();
    encodeResyncRequest(w, { scope: 5 });
    expect(w.byteLength).toBe(2);
    expect(decodeResyncRequest(createBitReader(w.bytes()))).toEqual({ scope: 5 });
    w.reset();
    encodeResyncResponse(w, { scope: 1, serverTick: 99999 });
    expect(decodeResyncResponse(createBitReader(w.bytes()))).toEqual({ scope: 1, serverTick: 99999 });
    w.reset();
    encodePing(w, { seq: 200, originTimeMs: 65530, holdMs: 3, reply: true });
    expect(w.byteLength).toBe(7);
    const ping = decodePing(createBitReader(w.bytes()))!;
    expect(ping).toEqual({ seq: 200, originTimeMs: 65530, holdMs: 3, reply: true });
    expect(pingRttMs(ping, 65536 + 40)).toBe(43);
  });
});

describe("stream framing", () => {
  it("reassembles frames split at every byte boundary", () => {
    const rng = createTestRng(9);
    const frames = Array.from({ length: 40 }, (_, i) => new Uint8Array(i % 7 === 0 ? 0 : randInt(rng, 1, 300)).map(() => randInt(rng, 0, 255)));
    const stream = new Uint8Array(frames.reduce((n, f) => n + f.length + 2, 0));
    let at = 0;
    const tmp = new Uint8Array(MAX_STREAM_FRAME_BYTES + 2);
    for (const f of frames) {
      const n = writeStreamFrame(f, tmp);
      stream.set(tmp.subarray(0, n), at);
      at += n;
    }
    const got: number[][] = [];
    const d = new StreamDeframer();
    for (let i = 0; i < stream.length; ) {
      const size = randInt(rng, 1, 50);
      d.push(stream.subarray(i, i + size), (frame) => got.push([...frame]));
      i += size;
    }
    expect(got).toEqual(frames.map((f) => [...f]));
  });

  it("marks oversize frames corrupt", () => {
    const d = new StreamDeframer();
    d.push(new Uint8Array([0xff, 0xff, 1, 2]), () => {
      throw new Error("no frame expected");
    });
    expect(d.corrupt).toBe(true);
  });
});
