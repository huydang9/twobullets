import { describe, expect, it } from "vitest";
import { TimeSync } from "../src/timeSync";
import { DilatedTickClock, TimeDilation } from "../src/timeDilation";
import { createSeededRng } from "../src/testing/rng";

const TICK = 1000 / 60;

describe("TimeSync", () => {
  it("recovers clock offset, RTT and jitter from noisy snapshot arrivals", () => {
    const rng = createSeededRng(3);
    const sync = new TimeSync();
    const clientOffset = 123_456.7; // client clock = server clock + offset
    const rtt = 60;
    let clientTimeEchoMs = 0;
    for (let tick = 1; tick <= 600; tick++) {
      const serverSendMs = tick * TICK;
      const down = rtt / 2 + Math.abs(rng.normal()) * 6;
      const arrival = serverSendMs + clientOffset + down;
      // The echoed input was sent by the client one RTT/2 + hold before the server's send.
      const hold = 4;
      clientTimeEchoMs = Math.floor(serverSendMs + clientOffset - hold - rtt / 2) & 0xffff;
      sync.onSnapshot(tick, arrival, clientTimeEchoMs, hold);
    }
    const now = 600 * TICK + clientOffset + 40;
    // True server tick now = (now − offset)/Δ.
    const truth = (now - clientOffset) / TICK;
    expect(Math.abs(sync.serverTickAt(now) - truth)).toBeLessThan(2 / TICK); // < 2 ms clock error
    expect(sync.rttMinMs).toBeGreaterThan(rtt - 2);
    expect(sync.rttMinMs).toBeLessThan(rtt + 2);
    expect(sync.rttMs).toBeGreaterThan(rtt);
    expect(sync.jitterMs).toBeGreaterThan(2);
    expect(sync.jitterMs).toBeLessThan(8);
    expect(sync.clientTargetTickAt(now, 1)).toBeCloseTo(sync.serverTickAt(now) + rtt / 2 / TICK + 1, 0);
    expect(sync.renderTickAt(now, 50)).toBeLessThan(truth);
  });

  it("estimates downstream loss and ignores duplicates and reordering", () => {
    const sync = new TimeSync();
    let t = 0;
    for (let tick = 1; tick <= 100; tick++) {
      t = tick * TICK;
      if (tick % 20 === 0) continue; // 5% loss
      sync.onSnapshot(tick, t);
      if (tick % 7 === 0) sync.onSnapshot(tick, t + 1);
    }
    sync.onSnapshot(60, t + 2); // late reordered copy of a lost tick
    expect(sync.lossRatio()).toBeGreaterThan(0.03);
    expect(sync.lossRatio()).toBeLessThan(0.05);
  });
});

describe("TimeDilation", () => {
  it("slows down when inputs arrive too early and speeds up when late", () => {
    const d = new TimeDilation();
    for (let i = 0; i < 60; i++) d.onBufferDepth(3, i * TICK);
    expect(d.tickScale).toBeGreaterThan(1);
    expect(d.tickScale).toBeLessThanOrEqual(1.05 + 1e-9);
    d.reset();
    for (let i = 0; i < 60; i++) d.onBufferDepth(-2, i * TICK);
    expect(d.tickScale).toBeLessThan(1);
    expect(d.tickScale).toBeGreaterThanOrEqual(0.95 - 1e-9);
    d.reset();
    for (let i = 0; i < 10; i++) d.onBufferDepth(20, i * TICK);
    expect(d.needsResync).toBe(true);
  });

  it("closed loop: a client with a drifting lead converges on the target without oscillating", () => {
    const d = new TimeDilation();
    const clock = new DilatedTickClock();
    // The buffer depth the server sees is the client's lead over the server minus the network delay (in ticks).
    let clientTimeMs = 0;
    let serverTimeMs = 0;
    const networkTicks = 3.6;
    clock.start(10); // starts 10 ticks ahead: depth ≈ 6.4
    let lastDepths: number[] = [];
    for (let frame = 0; frame < 60 * 30; frame++) {
      const dt = 1000 / 144;
      clientTimeMs += dt;
      serverTimeMs += dt;
      clock.tick += clock.advance(dt, d.tickScale);
      const depth = clock.tick - serverTimeMs / TICK - networkTicks;
      if (frame % 2 === 0) d.onBufferDepth(depth, clientTimeMs + 60);
      if (frame > 60 * 25) lastDepths.push(depth);
    }
    const mean = lastDepths.reduce((a, b) => a + b, 0) / lastDepths.length;
    expect(Math.abs(mean - d.targetTicks)).toBeLessThan(0.6);
    expect(Math.max(...lastDepths) - Math.min(...lastDepths)).toBeLessThan(2);
    lastDepths = [];
  });

  it("raises the target with jitter", () => {
    const d = new TimeDilation();
    d.setJitter(4);
    expect(d.targetTicks).toBe(1);
    d.setJitter(10);
    expect(d.targetTicks).toBe(2);
    d.setJitter(30);
    expect(d.targetTicks).toBe(3);
  });
});
