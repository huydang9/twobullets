import type { PlayerInput } from "@twobullets/shared/input";
import { describe, expect, it } from "vitest";
import { createBitWriter } from "../src/bits";
import { encodeInputPacket } from "../src/messages/input";
import { encodeKillFeed } from "../src/messages/control";
import { SHOT_EVENT_BITS, PLAYER_HIT_EVENT_BITS, ReliableEventType, reliableSectionBits } from "../src/messages/events";
import { encodeSnapshot, MAX_ENTITY_SLOTS, SNAPSHOT_MAX_BYTES, type Snapshot } from "../src/messages/snapshot";
import { CombatWorld, randomReliable, SnapshotWorld } from "./fixtures";
import { createTestRng, randInt } from "./rng";

// Wire sizes for the report and as a regression guard against netcode.md §2.2/§2.4 and the §6.5 event table.

const log = (...args: unknown[]) => {
  if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.PROTOCOL_SIZES) console.log(...args);
};

describe("wire sizes", () => {
  it("Input datagram with aim changing every tick", () => {
    const rng = createTestRng(4);
    const w = createBitWriter(256);
    const sizes: number[] = [];
    for (const count of [1, 3, 5, 6]) {
      const inputs: PlayerInput[] = [];
      for (let k = 0; k < count; k++) {
        const fire = rng() < 0.3;
        inputs.push({
          tick: 1000 - k,
          forward: 1,
          right: k % 2 === 0 ? 0 : 1,
          buttons: fire ? 8 | 16 : 16,
          select: 0,
          yawQ: randInt(rng, 0, 2 ** 20 - 1),
          pitchQ: randInt(rng, 0, 2 ** 18 - 1),
          viewOffset8: fire ? 40 : 0,
          action: null,
        });
      }
      w.reset();
      encodeInputPacket(w, { newestTick: 1000, ackSnapshotTick: 995, clientTimeMs: 1234, interpDelayMs: 50, inputs });
      sizes.push(w.byteLength);
    }
    log("input bytes for 1/3/5/6 inputs:", sizes.join("/"));
    // netcode.md: 15 / 29 / 43 B for 1 / 3 / 5 inputs.
    // This layout also carries the hasAction bit and a viewOffset byte on firing ticks, which the bench left out.
    expect(sizes[0]).toBeLessThanOrEqual(18);
    expect(sizes[1]).toBeLessThanOrEqual(33);
    expect(sizes[2]).toBeLessThanOrEqual(47);
    expect(sizes[3]).toBeLessThanOrEqual(55);
  });

  it("10-player snapshot: full and delta against a 4-tick-old ack", () => {
    const world = new SnapshotWorld(createTestRng(8));
    const w = createBitWriter(1500);
    const history: Snapshot[] = [];
    const full: number[] = [];
    const delta: number[] = [];
    for (let t = 0; t < 3600; t++) {
      world.step();
      const snap = world.snapshot(0);
      history.push(snap);
      w.reset();
      encodeSnapshot(w, snap, null);
      full.push(w.byteLength);
      if (history.length > 4) {
        w.reset();
        encodeSnapshot(w, snap, history[history.length - 5]!);
        delta.push(w.byteLength);
      }
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)]!;
    log(`snapshot full mean ${mean(full).toFixed(1)} B; delta mean ${mean(delta).toFixed(1)} B, p95 ${p95(delta)} B, max ${Math.max(...delta)} B`);
    expect(mean(full)).toBeLessThanOrEqual(200);
    expect(mean(delta)).toBeLessThanOrEqual(110);
  });

  it("events against netcode.md §6.5 (Shot 8 B, PlayerHit 2 B, HitConfirm/DamageTaken/Kill 6 B, KillFeed 12 B)", () => {
    const rng = createTestRng(2);
    // Shot carries the full 20/18-bit input aim, 1/64° spread and a 1 cm origin offset (exact pellet seed + aim for
    // remote tracers) where the doc's tracer-only layout had 16/16-bit aim and no origin. v3 slots are 5 bits: 100 bits.
    expect(SHOT_EVENT_BITS).toBe(100);
    expect(Math.ceil(SHOT_EVENT_BITS / 8)).toBeLessThanOrEqual(13);
    expect(PLAYER_HIT_EVENT_BITS).toBe(13);
    const single: Record<number, number> = {};
    for (const type of [ReliableEventType.HitConfirm, ReliableEventType.DamageTaken, ReliableEventType.Kill]) {
      let e = randomReliable(rng, 5);
      while (e.type !== type) e = randomReliable(rng, 5);
      // One event in a section: 12-bit seq + 5-bit type + payload (the 6-bit count is per section).
      single[type] = reliableSectionBits([e]) - 6;
      expect(single[type]).toBeLessThanOrEqual(48);
    }
    // A resent contiguous backlog costs 1 bit of seq per event after the first.
    const backlog = Array.from({ length: 4 }, (_, i) => randomReliable(rng, 100 + i));
    const perEvent = (reliableSectionBits(backlog) - 6) / 4;
    const w = createBitWriter(64);
    encodeKillFeed(w, { serverTick: 1, killer: 1, victim: 2, cause: 2, knockedBy: 31, headshot: true, friendlyFire: false, knock: false, distanceDm: 1234 });
    log(`event bits: Shot ${SHOT_EVENT_BITS}, PlayerHit ${PLAYER_HIT_EVENT_BITS}, HitConfirm ${single[1]}, DamageTaken ${single[2]}, Kill ${single[3]}, backlog mean ${perEvent.toFixed(1)}; KillFeed ${w.byteLength} B`);
    expect(w.byteLength).toBeLessThanOrEqual(12);
  });

  it("10-player combat snapshot (weapon/vitals groups, shots, reliable events) against netcode.md §2.4", () => {
    const { full, delta, owner, events } = combatSizes(10);
    const p95 = (a: number[]) => pct(a, 0.95);
    log(`combat full mean ${mean(full).toFixed(1)} B; delta mean ${mean(delta).toFixed(1)} B, p95 ${p95(delta)} B, max ${Math.max(...delta)} B; owner ${mean(owner).toFixed(1)} B, events ${mean(events).toFixed(1)} B`);
    // netcode.md: full 226 B, delta mean 108 B / p95 135 B, owner block 11.6 B, events 6.5 B.
    expect(mean(full)).toBeLessThanOrEqual(250);
    expect(mean(delta)).toBeLessThanOrEqual(125);
    expect(p95(delta)).toBeLessThanOrEqual(160);
    expect(mean(owner)).toBeLessThanOrEqual(16);
  });

  it("20-player combat snapshot: under the datagram cap and the 160 kbps p99 downstream budget", () => {
    const { full, delta, owner, events } = combatSizes(20);
    const p99 = pct(delta, 0.99);
    // netcode.md §2.4: WebTransport datagram over IPv4 ≈ 58 B overhead, WSS ≈ 77 B, 60 Hz.
    const kbps = (bytes: number, overhead: number) => ((bytes + overhead) * 8 * 60) / 1000;
    log(
      `20p combat full mean ${mean(full).toFixed(1)} B (max ${Math.max(...full)}); delta mean ${mean(delta).toFixed(1)} B, p95 ${pct(delta, 0.95)} B, p99 ${p99} B, max ${Math.max(...delta)} B; ` +
        `owner ${mean(owner).toFixed(1)} B, events ${mean(events).toFixed(1)} B; down ${kbps(mean(delta), 58).toFixed(0)} kbps WT (p99 ${kbps(p99, 58).toFixed(0)}), ${kbps(mean(delta), 77).toFixed(0)} kbps WSS`,
    );
    expect(Math.max(...full)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    expect(mean(delta)).toBeLessThanOrEqual(230);
    expect(kbps(p99, 58)).toBeLessThanOrEqual(160);
  });

  it("20-player movement snapshot with the last slot 19 present", () => {
    const world = new SnapshotWorld(createTestRng(21), 20);
    const w = createBitWriter(1500);
    const history: Snapshot[] = [];
    const delta: number[] = [];
    for (let t = 0; t < 1200; t++) {
      world.step();
      const snap = world.snapshot(0);
      expect(snap.entities.at(-1)!.slot).toBe(19);
      history.push(snap);
      if (history.length > 4) {
        w.reset();
        encodeSnapshot(w, snap, history[history.length - 5]!);
        delta.push(w.byteLength);
      }
    }
    log(`20p movement delta mean ${mean(delta).toFixed(1)} B, p95 ${pct(delta, 0.95)} B`);
    expect(mean(delta)).toBeLessThanOrEqual(220);
  });
});

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)]!;

/** Per-recipient combat snapshots for `players` over 60 s: full, delta vs a 4-tick-old ack, owner and event bytes. */
function combatSizes(players: number): { full: number[]; delta: number[]; owner: number[]; events: number[] } {
  const combat = new CombatWorld(createTestRng(19), players);
  const w = createBitWriter(1500);
  const history: Snapshot[] = [];
  const full: number[] = [];
  const delta: number[] = [];
  const owner: number[] = [];
  const events: number[] = [];
  for (let t = 0; t < 3600; t++) {
    const snap = combat.snapshot(0);
    history.push(snap);
    w.reset();
    encodeSnapshot(w, snap, null);
    full.push(w.byteLength);
    if (history.length > 4) {
      w.reset();
      const stats = { shotsBits: 0, hitsBits: 0, reliableBits: 0, ownerBits: 0, entityBits: new Int32Array(MAX_ENTITY_SLOTS) };
      encodeSnapshot(w, snap, history[history.length - 5]!, stats);
      delta.push(w.byteLength);
      owner.push(stats.ownerBits / 8);
      events.push((stats.shotsBits + stats.reliableBits + stats.hitsBits) / 8);
    }
  }
  return { full, delta, owner, events };
}
