import { createBitReader, createBitWriter } from "@twobullets/protocol/bits";
import { EntityPresence, encodeSnapshot, type Snapshot } from "@twobullets/protocol/messages/snapshot";
import { describe, expect, it } from "vitest";
import { ClientSnapshotStore, ServerSnapshotBaselines } from "../src/baselines";
import { createSeededRng } from "../src/testing/rng";

function snap(tick: number, x: number): Snapshot {
  return {
    header: { serverTick: tick, baselineTick: null, lastProcessedInputTick: tick, clientTimeEcho: 0, serverHoldMs: 0, inputBufferDepthQ: 4, sections: 0 },
    owner: { xMm: 500000 + x, yMm: 20000, zMm: 500000, vxMmS: 1000, vyMmS: 0, vzMmS: 0, stance: 0, grounded: true, sprinting: false, jumpHeld: false, moveMode: 0, coyoteTicks: 0, jumpBufferTicks: 0, groundIgnoreTicks: 0 },
    entities: [
      { slot: 1, presence: EntityPresence.full, xMm: 400000 + 2 * x, yMm: 20000, zMm: 400000, yawQ: tick & 4095, pitchQ: 500, vxQ: 16, vyQ: 0, vzQ: 0, flags: 16, noiseClass: 0 },
    ],
  };
}

describe("baselines", () => {
  it("server encodes against the newest acked snapshot; client decodes over loss and reordering", () => {
    const rng = createSeededRng(5);
    const server = new ServerSnapshotBaselines();
    const client = new ClientSnapshotStore();
    const w = createBitWriter(1500);
    const r = createBitReader(new Uint8Array(0));
    let decoded = 0;
    let deltas = 0;
    const inFlight: { arrive: number; bytes: Uint8Array; ackAt: number }[] = [];
    for (let tick = 0; tick < 3000; tick++) {
      const s = snap(tick, tick * 17);
      const base = server.baselineFor(tick);
      if (base) deltas++;
      w.reset();
      encodeSnapshot(w, s, base);
      server.record(s);
      if (rng.next() > 0.05) inFlight.push({ arrive: tick + 2 + Math.floor(rng.next() * 3), bytes: w.bytes().slice(), ackAt: 0 });
      for (let i = inFlight.length - 1; i >= 0; i--) {
        if (inFlight[i]!.arrive > tick) continue;
        r.reset(inFlight[i]!.bytes);
        const got = client.decode(r, tick);
        inFlight.splice(i, 1);
        if (got) {
          decoded++;
          expect(got.owner).toEqual(snap(got.header.serverTick, got.header.serverTick * 17).owner);
        }
      }
      // The ack reaches the server a few ticks later (input datagrams, some lost).
      if (rng.next() > 0.05) server.ack(client.newestTick);
    }
    expect(deltas).toBeGreaterThan(2800);
    expect(decoded).toBeGreaterThan(2700);
  });

  it("ignores acks for ticks never sent or moving backwards; resets to full", () => {
    const server = new ServerSnapshotBaselines();
    server.record(snap(10, 0));
    server.record(snap(11, 0));
    server.ack(50);
    expect(server.ackedTick).toBe(-1);
    server.ack(11);
    server.ack(10);
    expect(server.ackedTick).toBe(11);
    expect(server.baselineFor(12)?.header.serverTick).toBe(11);
    expect(server.baselineFor(11 + 128)).toBeNull();
    server.reset();
    expect(server.baselineFor(12)).toBeNull();
  });
});
