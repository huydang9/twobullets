import { createBitReader, createBitWriter } from "@twobullets/protocol/bits";
import { createReliableEventStore, ReliableEventType, type ReliableEvent, type ReliableEventStore } from "@twobullets/protocol/messages/events";
import { MsgId } from "@twobullets/protocol/messages/ids";
import { createInputPacketBuffer, decodeInputPacketInto, encodeInputPacket } from "@twobullets/protocol/messages/input";
import { createSnapshotBuffer, decodeSnapshotInto, encodeSnapshot, type Snapshot } from "@twobullets/protocol/messages/snapshot";
import type { PlayerInput } from "@twobullets/shared/input";
import { describe, expect, it } from "vitest";
import { ReliableEventReceiver, ReliableEventSender } from "../src/reliableEvents";
import { ManualClock } from "../src/testing/clock";
import { LinkConditioner } from "../src/testing/LinkConditioner";
import { createMemorySessionPair } from "../src/testing/memorySession";
import { NETWORK_PROFILES, type NetworkProfile } from "../src/testing/profiles";
import { createSeededRng } from "../src/testing/rng";

/** Deterministic event number `i` (the payload identifies it, so delivery order and content are checkable). */
function eventFor(i: number, out: ReliableEventStore): ReliableEvent {
  const h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  out.seq = 0;
  switch (i % 3) {
    case 0:
      out.type = ReliableEventType.HitConfirm;
      out.victim = h & 15;
      out.pellets = (h >>> 4) & 15;
      out.zones = (h >>> 8) & 7;
      out.damageQ = (h >>> 11) & 2047;
      out.killed = ((h >>> 22) & 1) === 1;
      out.downed = ((h >>> 23) & 1) === 1;
      out.armorHit = ((h >>> 24) & 1) === 1;
      out.armorBroken = ((h >>> 25) & 1) === 1;
      break;
    case 1:
      out.type = ReliableEventType.DamageTaken;
      out.attacker = h & 15;
      out.dirYawQ = (h >>> 4) & 255;
      out.amountQ = (h >>> 12) & 2047;
      out.zone = (h >>> 23) & 3;
      out.kind = ((h >>> 25) & 7) % 6;
      break;
    default:
      out.type = ReliableEventType.Kill;
      out.killer = h & 15;
      out.victim = (h >>> 4) & 15;
      out.cause = ((h >>> 8) & 31) % 12;
      out.headshot = ((h >>> 13) & 1) === 1;
      out.friendlyFire = ((h >>> 14) & 1) === 1;
      out.knock = ((h >>> 15) & 1) === 1;
      out.distanceM = (h >>> 16) & 1023;
  }
  return out as ReliableEvent;
}

function samePayload(a: ReliableEvent, b: ReliableEvent): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case ReliableEventType.HitConfirm: {
      const c = b as typeof a;
      return a.victim === c.victim && a.pellets === c.pellets && a.zones === c.zones && a.damageQ === c.damageQ && a.killed === c.killed && a.downed === c.downed && a.armorHit === c.armorHit && a.armorBroken === c.armorBroken;
    }
    case ReliableEventType.DamageTaken: {
      const c = b as typeof a;
      return a.attacker === c.attacker && a.dirYawQ === c.dirYawQ && a.amountQ === c.amountQ && a.zone === c.zone && a.kind === c.kind;
    }
    case ReliableEventType.Kill: {
      const c = b as typeof a;
      return a.killer === c.killer && a.victim === c.victim && a.cause === c.cause && a.headshot === c.headshot && a.friendlyFire === c.friendlyFire && a.knock === c.knock && a.distanceM === c.distanceM;
    }
  }
}

describe("ReliableEventSender", () => {
  it("sends the first two snapshots back to back, then every 2nd, until acked", () => {
    const sender = new ReliableEventSender();
    const store = createReliableEventStore();
    expect(sender.push(eventFor(0, store))).toBe(0);
    const carried: number[] = [];
    for (let tick = 0; tick < 8; tick++) {
      if (sender.select(1000).length > 0) carried.push(tick);
      sender.markSent(tick);
    }
    expect(carried).toEqual([0, 1, 3, 5, 7]);
    sender.onAck(5, -1);
    expect(sender.pending).toBe(0);
    expect(sender.select(1000).length).toBe(0);
  });

  it("selects ascending seqs within the bit budget and acks by snapshot tick or cumulative seq", () => {
    const sender = new ReliableEventSender({ capacity: 8 });
    const store = createReliableEventStore();
    for (let i = 0; i < 8; i++) expect(sender.push(eventFor(i, store))).toBe(i);
    expect(sender.push(eventFor(8, store))).toBe(-1);
    expect(sender.stats.overflows).toBe(1);
    // 6-bit count + first event (12 + 5 + 27, v3 5-bit victim) + second (1 + 5 + 29) = 85 bits.
    expect(sender.select(85).map((e) => e.seq)).toEqual([0, 1]);
    expect(sender.select(84).map((e) => e.seq)).toEqual([0]);
    const all = sender.select(10_000).map((e) => e.seq);
    expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    sender.markSent(40);
    // Unknown tick and wrong-window seqs are ignored.
    sender.onAck(41, 4000);
    expect(sender.pending).toBe(8);
    sender.onAck(-1, 2);
    expect(sender.pending).toBe(5);
    sender.onAck(40, -1);
    expect(sender.pending).toBe(0);
    expect(sender.stats.acked).toBe(8);
    // Stale ack after the queue moved on.
    expect(sender.push(eventFor(9, store))).toBe(8);
    sender.onAck(40, 7);
    expect(sender.pending).toBe(1);
  });

  it("seqs wrap at 4096 without loss or duplication", () => {
    const sender = new ReliableEventSender({ capacity: 64 });
    const receiver = new ReliableEventReceiver(64);
    const store = createReliableEventStore();
    const expected = createReliableEventStore();
    let delivered = 0;
    let mismatches = 0;
    let pushed = 0;
    let newestReceived = -1;
    for (let tick = 0; tick < 3000; tick++) {
      for (let k = 0; k < 3; k++) expect(sender.push(eventFor(pushed++, store))).toBeGreaterThanOrEqual(0);
      const selected = sender.select(4000);
      sender.markSent(tick);
      // Every third snapshot is lost; delivery reverses the order to exercise buffering.
      if (tick % 3 !== 2) {
        const reversed = [...selected].reverse();
        receiver.receive(reversed, (e) => {
          if (!samePayload(e, eventFor(delivered, expected)) || e.seq !== (delivered & 0xfff)) mismatches++;
          delivered++;
        });
        newestReceived = tick;
      }
      // Alternate the two ack paths: snapshot tick only, cumulative seq only.
      if (tick % 2 === 0) sender.onAck(newestReceived, -1);
      else sender.onAck(-1, receiver.ackSeq);
    }
    expect(pushed).toBe(9000);
    expect(mismatches).toBe(0);
    expect(delivered).toBeGreaterThan(8990);
    expect(sender.stats.overflows).toBe(0);
    expect(receiver.stats.outOfOrder).toBeGreaterThan(0);
  });
});

describe("ReliableEventReceiver", () => {
  it("dedupes, reorders and reports the cumulative ack", () => {
    const r = new ReliableEventReceiver(16);
    const mk = (seq: number): ReliableEvent => {
      const e = { ...eventFor(seq, createReliableEventStore()) };
      e.seq = seq;
      return e;
    };
    const got: number[] = [];
    expect(r.ackSeq).toBe(-1);
    r.receive([mk(1), mk(2)], (e) => got.push(e.seq));
    expect(got).toEqual([]);
    expect(r.ackSeq).toBe(-1);
    r.receive([mk(0), mk(1)], (e) => got.push(e.seq));
    expect(got).toEqual([0, 1, 2]);
    expect(r.ackSeq).toBe(2);
    r.receive([mk(2), mk(0), mk(3)], (e) => got.push(e.seq));
    expect(got).toEqual([0, 1, 2, 3]);
    expect(r.stats.duplicates).toBe(3);
    r.receive([mk(40)], () => got.push(-1));
    expect(r.stats.dropped).toBe(1);
  });
});

interface ReliableRun {
  pushed: number;
  delivered: number;
  mismatches: number;
  p50: number;
  p99: number;
  max: number;
  maxOutsideOutage: number;
  meanTransmissions: number;
  maxPending: number;
  overflows: number;
  duplicatesSeen: number;
  budgetViolations: number;
}

const TICK_MS = 1000 / 60;
/** Reliable section budget per snapshot (60 B): small, so backlogs after outages spill over several snapshots. */
const BUDGET_BITS = 480;

function runReliable(profile: Pick<NetworkProfile, "up" | "down">, seconds: number, seed: number): ReliableRun {
  const clock = new ManualClock(0);
  const rng = createSeededRng(seed ^ 0x5bd1e995);
  const [clientEnd, serverEnd] = createMemorySessionPair({ clock });
  const link = new LinkConditioner(clientEnd, profile, clock, seed);

  // ---- Server: events, snapshots carrying the reliable section, acks from inputs ----
  const sender = new ReliableEventSender();
  const pushTimes: number[] = [];
  const store = createReliableEventStore();
  const sw = createBitWriter(1000);
  const sr = createBitReader(new Uint8Array(0));
  const packet = createInputPacketBuffer();
  let serverTick = 0;
  let nextServerMs = 0;
  let budgetViolations = 0;
  serverEnd.onDatagram((bytes) => {
    sr.reset(bytes);
    if (bytes[0] !== MsgId.Input || !decodeInputPacketInto(sr, serverTick, packet)) return;
    sender.onAck(packet.ackSnapshotTick, packet.ackEventSeq);
  });
  const header = { serverTick: 0, baselineTick: null, lastProcessedInputTick: -1, clientTimeEcho: 0, serverHoldMs: 0, inputBufferDepthQ: 0, sections: 0 };
  function serverStep(generate: boolean): void {
    if (generate) {
      let n = rng.next() < 0.1 ? 1 : 0;
      if (rng.next() < 0.004) n += 1 + Math.floor(rng.next() * 6); // shotgun kill: confirm + damage + kill bursts
      if (serverTick === 1200) n += 40; // one big burst: 40 events over a 60 B budget
      for (let k = 0; k < n; k++) {
        const seq = sender.push(eventFor(pushTimes.length, store));
        if (seq < 0) break;
        pushTimes.push(clock.now());
      }
    }
    header.serverTick = serverTick;
    const reliable = sender.select(BUDGET_BITS);
    const snap: Snapshot = { header, owner: null, entities: [], reliable };
    sw.reset();
    encodeSnapshot(sw, snap, null);
    if (reliable.length > 0 && sw.bitLength - 96 > BUDGET_BITS) budgetViolations++;
    serverEnd.sendDatagram(sw.bytes());
    sender.markSent(serverTick);
    serverTick++;
  }

  // ---- Client: decode, deliver in order, ack in every input ----
  const receiver = new ReliableEventReceiver();
  const scratch = createSnapshotBuffer();
  const cr = createBitReader(new Uint8Array(0));
  const cw = createBitWriter(128);
  const expected = createReliableEventStore();
  const latencies: number[] = [];
  let delivered = 0;
  let mismatches = 0;
  let newestSnapshot = -1;
  let maxOutsideOutage = 0;
  const outageStart = profile.down.outagePeriodMs ? profile.down.outagePeriodMs / 2 : Infinity;
  const outageEnd = outageStart + (profile.down.outageDurationMs ?? 0);
  const deliver = (e: ReliableEvent): void => {
    if (!samePayload(e, eventFor(delivered, expected)) || e.seq !== (delivered & 0xfff)) mismatches++;
    const pushedAt = pushTimes[delivered]!;
    const latency = clock.now() - pushedAt;
    latencies.push(latency);
    // Events pushed within an RTT of the outage (either way) are expected to wait it out.
    if (pushedAt + latency < outageStart || pushedAt > outageEnd + 500) maxOutsideOutage = Math.max(maxOutsideOutage, latency);
    delivered++;
  };
  link.onDatagram((bytes) => {
    cr.reset(bytes);
    if (bytes[0] !== MsgId.Snapshot) return;
    const ok = decodeSnapshotInto(cr, Math.max(0, newestSnapshot), () => null, scratch);
    if (!scratch.eventsValid) return;
    receiver.receive(scratch.reliable, deliver);
    if (ok && scratch.header.serverTick > newestSnapshot) newestSnapshot = scratch.header.serverTick;
  });
  const input: PlayerInput = { tick: 0, forward: 0, right: 0, buttons: 0, select: 0, yawQ: 0, pitchQ: 0, viewOffset8: 0, action: null };
  let clientTick = 0;
  let nextInputMs = 3;
  function sendInput(): void {
    cw.reset();
    encodeInputPacket(cw, {
      newestTick: clientTick,
      ackSnapshotTick: newestSnapshot,
      clientTimeMs: Math.floor(clock.now()) & 0xffff,
      interpDelayMs: 50,
      ackEventSeq: receiver.ackSeq,
      inputs: [{ ...input, tick: clientTick }],
    });
    link.sendDatagram(cw.bytes());
    clientTick++;
  }

  const genEndMs = seconds * 1000;
  const endMs = genEndMs + 6000;
  while (clock.now() < endMs) {
    clock.advance(1);
    link.pump();
    while (clock.now() >= nextServerMs) {
      serverStep(clock.now() < genEndMs);
      nextServerMs += TICK_MS;
    }
    link.pump();
    if (clock.now() >= nextInputMs) {
      sendInput();
      nextInputMs += TICK_MS;
    }
  }

  latencies.sort((a, b) => a - b);
  return {
    pushed: pushTimes.length,
    delivered,
    mismatches,
    p50: latencies[Math.floor(latencies.length * 0.5)]!,
    p99: latencies[Math.floor(latencies.length * 0.99)]!,
    max: latencies[latencies.length - 1]!,
    maxOutsideOutage,
    meanTransmissions: sender.stats.transmissions / Math.max(1, sender.stats.pushed),
    maxPending: sender.stats.maxPending,
    overflows: sender.stats.overflows,
    duplicatesSeen: receiver.stats.duplicates,
    budgetViolations,
  };
}

const log = (label: string, r: ReliableRun) => {
  const proc = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
  if (proc?.env.NETCODE_VERBOSE) proc.stderr.write(`${label} ${JSON.stringify(r)}\n`);
};

function expectExactlyOnceInOrder(r: ReliableRun): void {
  expect(r.pushed).toBeGreaterThan(400);
  expect(r.overflows).toBe(0);
  expect(r.budgetViolations).toBe(0);
  expect(r.delivered).toBe(r.pushed);
  expect(r.mismatches).toBe(0);
}

describe("reliable events over LinkConditioner", () => {
  it("typical: every event exactly once, in order, p99 < 150 ms", () => {
    const r = runReliable(NETWORK_PROFILES.typical, 120, 101);
    log("typical", r);
    expectExactlyOnceInOrder(r);
    expect(r.p50).toBeLessThan(60);
    expect(r.p99).toBeLessThan(150);
    expect(r.max).toBeLessThan(400);
  });

  it("bad: every event exactly once, in order, p99 < 300 ms", () => {
    const r = runReliable(NETWORK_PROFILES.bad, 120, 202);
    log("bad", r);
    expectExactlyOnceInOrder(r);
    expect(r.p99).toBeLessThan(300);
    expect(r.max).toBeLessThan(800);
  });

  it("awful (8% bursty loss, 250 ms RTT, 2 s outage at 150 s): exactly once, in order, bounded", () => {
    const r = runReliable(NETWORK_PROFILES.awful, 160, 303);
    log("awful", r);
    expectExactlyOnceInOrder(r);
    expect(r.p99).toBeLessThan(700);
    expect(r.maxOutsideOutage).toBeLessThan(1200);
    // The outage itself: 2 s of silence, then the backlog drains within a few RTTs.
    expect(r.max).toBeLessThan(3500);
  });

  it("duplication and reordering: no duplicate or out-of-order delivery", () => {
    const link = { latencyMs: 40, jitterMs: 15, lossRate: 0.05, burstLength: 2, duplicateRate: 0.05, reorderRate: 0.1 };
    const r = runReliable({ up: link, down: link }, 60, 404);
    log("dup+reorder", r);
    expectExactlyOnceInOrder(r);
    expect(r.duplicatesSeen).toBeGreaterThan(100);
    expect(r.p99).toBeLessThan(250);
  });
});
