import type { PlayerInput } from "@twobullets/shared/input";
import { describe, expect, it } from "vitest";
import { InsertResult, ServerInputBuffer } from "../src/inputBuffer";
import { createSeededRng } from "../src/testing/rng";

function input(tick: number, extra: Partial<PlayerInput> = {}): PlayerInput {
  return { tick, forward: 1, right: 0, buttons: 2, select: 0, yawQ: 100, pitchQ: 200, viewOffset8: 0, action: null, ...extra };
}

describe("ServerInputBuffer", () => {
  it("consumes inputs by tick and reports lastProcessedInputTick", () => {
    const b = new ServerInputBuffer();
    expect(b.insert(input(10), 10)).toBe(InsertResult.accepted);
    expect(b.insert(input(11, { right: -1 }), 10)).toBe(InsertResult.accepted);
    expect(b.take(10).forward).toBe(1);
    expect(b.lastWasSynthetic).toBe(false);
    expect(b.take(11).right).toBe(-1);
    expect(b.lastProcessedInputTick).toBe(11);
    expect(b.stats.consumed).toBe(2);
  });

  it("drops duplicates, late and too-early inputs", () => {
    const b = new ServerInputBuffer({ maxLeadTicks: 8 });
    b.insert(input(5), 5);
    expect(b.insert(input(5), 5)).toBe(InsertResult.duplicate);
    b.take(5);
    expect(b.insert(input(5), 6)).toBe(InsertResult.duplicate);
    b.take(6);
    expect(b.insert(input(6), 7)).toBe(InsertResult.late);
    expect(b.insert(input(40), 7)).toBe(InsertResult.tooEarly);
    expect(b.stats).toMatchObject({ duplicate: 2, late: 1, tooEarly: 1 });
  });

  it("repeats the last input on a gap with edge-triggered buttons and actions cleared", () => {
    const b = new ServerInputBuffer();
    b.insert(input(1, { buttons: 1 | 2 | 8 | 32 | 64, select: 3, viewOffset8: 9, action: { type: 1, arg: 7 } }), 1);
    b.take(1);
    const s = b.take(2);
    expect(b.lastWasSynthetic).toBe(true);
    expect(s.tick).toBe(2);
    expect(s.buttons).toBe(2 | 8);
    expect(s.select).toBe(0);
    expect(s.action).toBeNull();
    expect(s.forward).toBe(1);
    expect(s.yawQ).toBe(100);
    expect(b.lastProcessedInputTick).toBe(1);
    expect(b.syntheticStreak).toBe(1);
    // Before any input: neutral.
    const fresh = new ServerInputBuffer();
    expect(fresh.take(0)).toMatchObject({ forward: 0, buttons: 0, yawQ: 0 });
  });

  it("token bucket caps accepted inputs at tickRate + 6/s (speedhack clients gain nothing)", () => {
    const b = new ServerInputBuffer({ maxLeadTicks: 63, capacity: 128 });
    let next = 0;
    // A client producing inputs 20% fast for 10 s, always within the lead window.
    for (let tick = 0; tick < 600; tick++) {
      for (let k = 0; k < 1.2 * (tick + 1) - next && next <= tick + 60; ) {
        b.insert(input(next), tick);
        next++;
      }
      b.take(tick);
    }
    const perSecond = b.stats.accepted / 10;
    expect(perSecond).toBeLessThanOrEqual(66 + 1.3);
    expect(b.stats.consumed).toBeLessThanOrEqual(600);
  });

  it("depth tracks how far ahead inputs arrive", () => {
    const b = new ServerInputBuffer({ depthAlpha: 1 });
    for (let t = 0; t < 100; t++) {
      b.insert(input(t + 3), t);
      b.take(t);
    }
    expect(b.depthTicks).toBe(3);
    expect(b.depthQ).toBe(12);
  });

  it("property: random arrival order, duplication and loss never double-consume or consume out of order", () => {
    const rng = createSeededRng(77);
    const b = new ServerInputBuffer();
    const consumed = new Set<number>();
    const pending: number[] = [];
    for (let tick = 0; tick < 5000; tick++) {
      for (let k = 0; k < 3; k++) if (rng.next() < 0.9) pending.push(tick + 2 + Math.floor(rng.next() * 6));
      for (let i = pending.length - 1; i >= 0; i--) {
        if (rng.next() < 0.5) {
          b.insert(input(pending[i]!), tick);
          if (rng.next() < 0.8) pending.splice(i, 1);
        }
      }
      const got = b.take(tick);
      expect(got.tick).toBe(tick);
      if (!b.lastWasSynthetic) {
        expect(consumed.has(tick)).toBe(false);
        consumed.add(tick);
      }
    }
    const s = b.stats;
    expect(s.consumed + s.synthetic).toBe(5000);
  });
});
