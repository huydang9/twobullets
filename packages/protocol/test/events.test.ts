import { describe, expect, it } from "vitest";
import { createBitReader, createBitWriter } from "../src/bits";
import { KILL_CAUSES_BY_CODE, killCauseCode, killCauseOfCode, weaponCode, weaponIdOfCode, WORLD_SLOT_CODE } from "../src/codes";
import { decodeKillFeed, encodeKillFeed, type KillFeed } from "../src/messages/control";
import { reliableSectionBits, type ReliableEvent } from "../src/messages/events";
import { createInputPacketBuffer, decodeInputPacketInto, encodeInputPacket } from "../src/messages/input";
import {
  copySnapshot,
  createSnapshotBuffer,
  createSnapshotCapResult,
  decodeSnapshotInto,
  encodeSnapshot,
  encodeSnapshotCapped,
  EntityPresence,
  type CappableSnapshot,
  type MutableSnapshot,
  type Snapshot,
} from "../src/messages/snapshot";
import { CombatWorld, randomPlayerHit, randomReliable, randomShot, randomVitalsBlock, randomWeaponBlock, SnapshotWorld, weaponWire } from "./fixtures";
import { createTestRng, randInt } from "./rng";

function vitalsWire(v: NonNullable<Snapshot["vitals"]>): unknown {
  return {
    ...v,
    downedHealthQ: v.life === 1 ? v.downedHealthQ : 0,
    reviveTicks: v.life === 1 ? v.reviveTicks : 0,
    helmetDurability: v.helmetLevel ? v.helmetDurability : 0,
    vestDurability: v.vestLevel ? v.vestDurability : 0,
  };
}

describe("snapshot combat groups and events", () => {
  it("roundtrips weapon/vitals groups and U/R events against ack-delayed baselines", () => {
    const rng = createTestRng(31);
    const world = new SnapshotWorld(rng);
    const w = createBitWriter(1500);
    const serverSent = new Map<number, Snapshot>();
    const clientStore = new Map<number, MutableSnapshot>();
    const scratch = createSnapshotBuffer();
    let weapon = randomWeaponBlock(rng);
    let vitals = randomVitalsBlock(rng);
    let seq = 4090;
    for (let t = 0; t < 3000; t++) {
      world.step();
      if (rng() < 0.2) weapon = randomWeaponBlock(rng);
      if (rng() < 0.1) vitals = randomVitalsBlock(rng);
      const reliable: ReliableEvent[] = [];
      for (let k = randInt(rng, 0, 5); k > 0; k--) {
        seq = rng() < 0.3 ? seq + randInt(rng, 2, 40) : seq + 1;
        reliable.push(randomReliable(rng, seq & 0xfff));
      }
      const base = world.snapshot(0, true);
      const snap: Snapshot = {
        ...base,
        weapon: rng() < 0.9 ? weapon : null,
        vitals: rng() < 0.9 ? vitals : null,
        shots: Array.from({ length: rng() < 0.5 ? 0 : randInt(rng, 1, 12) }, () => randomShot(rng)),
        hits: Array.from({ length: rng() < 0.7 ? 0 : randInt(rng, 1, 5) }, () => randomPlayerHit(rng)),
        reliable,
      };
      const baseline = rng() < 0.05 ? null : (serverSent.get(world.tick - randInt(rng, 1, 100)) ?? null);
      w.reset();
      encodeSnapshot(w, snap, baseline);
      serverSent.set(world.tick, snap);
      expect(decodeSnapshotInto(createBitReader(w.bytes()), world.tick, (tick) => clientStore.get(tick) ?? null, scratch)).toBe(true);
      expect(scratch.eventsValid).toBe(true);
      expect(scratch.weapon === null ? null : weaponWire(scratch.weapon)).toEqual(snap.weapon ? weaponWire(snap.weapon) : null);
      expect(scratch.vitals === null ? null : vitalsWire(scratch.vitals)).toEqual(snap.vitals ? vitalsWire(snap.vitals) : null);
      expect(scratch.shots.map((e) => ({ ...e }))).toEqual(snap.shots);
      expect(scratch.hits.map((e) => ({ ...e }))).toEqual(snap.hits);
      expect(scratch.reliable.length).toBe(reliable.length);
      // Only compare the fields each event type carries.
      for (let i = 0; i < reliable.length; i++) expect(scratch.reliable[i]).toMatchObject(reliable[i]!);
      expect(w.bitLength >= 96).toBe(true);
      const stored = createSnapshotBuffer();
      copySnapshot(scratch, stored);
      clientStore.set(world.tick, stored);
    }
  });

  it("events decode even when the baseline is unavailable", () => {
    const rng = createTestRng(3);
    const world = new SnapshotWorld(rng, 4);
    const base = world.snapshot(0);
    world.step();
    const snap: Snapshot = { ...world.snapshot(0), reliable: [randomReliable(rng, 7), randomReliable(rng, 8)], shots: [randomShot(rng)] };
    const w = createBitWriter(1500);
    encodeSnapshot(w, snap, base);
    const out = createSnapshotBuffer();
    expect(decodeSnapshotInto(createBitReader(w.bytes()), world.tick, () => null, out)).toBe(false);
    expect(out.eventsValid).toBe(true);
    expect(out.reliable.map((e) => e.seq)).toEqual([7, 8]);
    expect(out.shots.length).toBe(1);
  });

  it("reliableSectionBits matches the encoder", () => {
    const rng = createTestRng(8);
    for (let i = 0; i < 500; i++) {
      let seq = randInt(rng, 0, 4095);
      const list: ReliableEvent[] = [];
      for (let k = randInt(rng, 1, 20); k > 0; k--) {
        list.push(randomReliable(rng, seq & 0xfff));
        seq += rng() < 0.7 ? 1 : randInt(rng, 2, 9);
      }
      const snap: Snapshot = { header: { serverTick: 5, baselineTick: null, lastProcessedInputTick: -1, clientTimeEcho: 0, serverHoldMs: 0, inputBufferDepthQ: 0, sections: 0 }, owner: null, entities: [], reliable: list };
      const w = createBitWriter(1500);
      encodeSnapshot(w, snap, null);
      expect(w.bitLength - 96).toBe(reliableSectionBits(list));
    }
  });

  it("size cap drops shots, then hits, then audible-only, then the farthest full entities; never R events or owner", () => {
    const rng = createTestRng(12);
    const world = new SnapshotWorld(rng, 16);
    world.step();
    const base = world.snapshot(0);
    const entities = base.entities.map((e) => (e.slot % 4 === 1 ? { ...e, presence: EntityPresence.audibleOnly } : { ...e }));
    const make = (): CappableSnapshot => ({
      ...base,
      entities: entities.map((e) => ({ ...e })),
      weapon: randomWeaponBlock(createTestRng(1)),
      shots: Array.from({ length: 20 }, (_, i) => ({ ...randomShot(rng), shotId: i })),
      hits: Array.from({ length: 10 }, () => randomPlayerHit(rng)),
      reliable: Array.from({ length: 10 }, (_, i) => randomReliable(rng, i)),
    });
    const w = createBitWriter(2000);
    const result = createSnapshotCapResult();
    const full = make();
    encodeSnapshot(w, full, null);
    const uncapped = w.byteLength;

    // Just below the uncapped size: only old shots go.
    const a = make();
    encodeSnapshotCapped(w, a, null, uncapped - 20, result);
    expect(result.fits).toBe(true);
    expect(w.byteLength).toBeLessThanOrEqual(uncapped - 20);
    expect(result.droppedShots).toBeGreaterThan(0);
    expect(result.droppedHits + result.droppedAudible + result.droppedFull).toBe(0);
    expect(a.shots![0]!.shotId).toBe(result.droppedShots);

    // Tighter: shots and hits gone, then audible-only entities, then far entities.
    const b = make();
    const shotsAndHitsBytes = Math.ceil((20 * 99 + 10 * 12) / 8);
    encodeSnapshotCapped(w, b, null, uncapped - shotsAndHitsBytes - 10, result);
    expect(result.fits).toBe(true);
    expect(result.droppedShots).toBe(20);
    expect(result.droppedHits).toBe(10);
    expect(result.droppedAudible).toBeGreaterThan(0);
    expect(result.droppedFull).toBe(0);

    const c = make();
    encodeSnapshotCapped(w, c, null, 90, result);
    expect(result.fits).toBe(true);
    expect(result.droppedAudible).toBe(entities.filter((e) => e.presence === EntityPresence.audibleOnly).length);
    expect(result.droppedFull).toBeGreaterThan(0);
    expect(c.reliable!.length).toBe(10);
    // Remaining full entities are the nearest to the owner.
    const d2 = (e: { xMm: number; yMm: number; zMm: number }) => (e.xMm - base.owner!.xMm) ** 2 + (e.yMm - base.owner!.yMm) ** 2 + (e.zMm - base.owner!.zMm) ** 2;
    const kept = Math.max(...c.entities.map(d2));
    const droppedFull = entities.filter((e) => e.presence === EntityPresence.full && !c.entities.some((k) => k.slot === e.slot));
    for (const e of droppedFull) expect(d2(e)).toBeGreaterThanOrEqual(kept);
    // The trimmed snapshot decodes.
    const out = createSnapshotBuffer();
    expect(decodeSnapshotInto(createBitReader(w.bytes()), base.header.serverTick, () => null, out)).toBe(true);
    expect(out.entities.length).toBe(c.entities.length);

    // Owner + R events alone over the cap: reported, nothing silently lost.
    const d = make();
    encodeSnapshotCapped(w, d, null, 20, result);
    expect(result.fits).toBe(false);
    expect(d.reliable!.length).toBe(10);
  });
});

describe("Input event ack", () => {
  it("roundtrips ackEventSeq and defaults to none", () => {
    const w = createBitWriter(128);
    const input = { tick: 10, forward: 0 as const, right: 0 as const, buttons: 0, select: 0, yawQ: 0, pitchQ: 0, viewOffset8: 0, action: null };
    const out = createInputPacketBuffer();
    for (const ack of [undefined, -1, 0, 1234, 4095]) {
      w.reset();
      encodeInputPacket(w, { newestTick: 10, ackSnapshotTick: 9, clientTimeMs: 0, interpDelayMs: 50, ackEventSeq: ack, inputs: [input] });
      expect(decodeInputPacketInto(createBitReader(w.bytes()), 10, out)).toBe(true);
      expect(out.ackEventSeq).toBe(ack === undefined ? -1 : ack);
    }
  });
});

describe("KillFeed", () => {
  it("roundtrips at 10 bytes", () => {
    const rng = createTestRng(77);
    const w = createBitWriter(64);
    for (let i = 0; i < 2000; i++) {
      const m: KillFeed = {
        serverTick: randInt(rng, 0, 2 ** 32 - 1),
        killer: rng() < 0.1 ? WORLD_SLOT_CODE : randInt(rng, 0, 15),
        victim: randInt(rng, 0, 15),
        cause: randInt(rng, 0, KILL_CAUSES_BY_CODE.length - 1),
        knockedBy: rng() < 0.5 ? WORLD_SLOT_CODE : randInt(rng, 0, 15),
        headshot: rng() < 0.5,
        friendlyFire: rng() < 0.5,
        knock: rng() < 0.5,
        distanceDm: randInt(rng, 0, 65535),
      };
      w.reset();
      encodeKillFeed(w, m);
      expect(w.byteLength).toBe(10);
      expect(decodeKillFeed(createBitReader(w.bytes()))).toEqual(m);
    }
  });
});

describe("wire codes", () => {
  it("weapon and kill cause codes are stable and weapon causes share weapon codes", () => {
    expect([weaponCode("pistol"), weaponCode("rifle"), weaponCode("shotgun"), weaponCode("sniper"), weaponCode(null)]).toEqual([1, 2, 3, 4, 0]);
    for (const id of ["pistol", "rifle", "shotgun", "sniper"] as const) {
      expect(weaponIdOfCode(weaponCode(id))).toBe(id);
      expect(killCauseCode(id)).toBe(weaponCode(id));
    }
    expect(KILL_CAUSES_BY_CODE).toEqual(["unknown", "pistol", "rifle", "shotgun", "sniper", "frag", "molotov", "zone", "fall", "bleedOut", "teamWipe", "outOfBounds"]);
    expect(killCauseOfCode(7)).toBe("zone");
  });
});

describe("combat world", () => {
  it("encodes and decodes the netcode.md §2.4 combat mix", () => {
    const combat = new CombatWorld(createTestRng(41));
    const w = createBitWriter(1500);
    const store = new Map<number, MutableSnapshot>();
    const out = createSnapshotBuffer();
    let prev: Snapshot | null = null;
    for (let t = 0; t < 600; t++) {
      const snap = combat.snapshot(0);
      w.reset();
      encodeSnapshot(w, snap, prev);
      expect(decodeSnapshotInto(createBitReader(w.bytes()), snap.header.serverTick, (tick) => store.get(tick) ?? null, out)).toBe(true);
      const stored = createSnapshotBuffer();
      copySnapshot(out, stored);
      store.set(snap.header.serverTick, stored);
      prev = snap;
    }
  });
});
