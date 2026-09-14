import type { PlayerInput } from "@twobullets/shared/input";
import { describe, expect, it } from "vitest";
import { createBitWriter } from "../src/bits";
import { encodeInputPacket } from "../src/messages/input";
import { encodeSnapshot, type Snapshot } from "../src/messages/snapshot";
import { SnapshotWorld } from "./fixtures";
import { createTestRng, randInt } from "./rng";

// Wire sizes for the report and as a regression guard against netcode.md §2.2/§2.4 (movement-only M3 layout: no
// weapon/vitals groups or events, so snapshots are smaller than the doc's combat numbers).

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
});
