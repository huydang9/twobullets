import { ManualClock } from "@twobullets/netcode";
import { describe, expect, it } from "vitest";
import { TickScheduler, type TimerApi } from "../src/sched/TickScheduler";

/** Virtual timers: timeouts fire `lateMs` after their due time (like libuv + timer slack), immediates cost 0.05 ms. */
class FakeTimers implements TimerApi {
  private readonly clock: ManualClock;
  private readonly queue: { at: number; seq: number; cb: () => void; id: number }[] = [];
  private seq = 0;
  private nextId = 1;
  lateMs: () => number = () => 0;

  constructor(clock: ManualClock) {
    this.clock = clock;
  }

  setTimeout(cb: () => void, ms: number): unknown {
    return this.push(this.clock.now() + ms + this.lateMs(), cb);
  }
  clearTimeout(handle: unknown): void {
    this.remove(handle as number);
  }
  setImmediate(cb: () => void): unknown {
    return this.push(this.clock.now() + 0.05, cb);
  }
  clearImmediate(handle: unknown): void {
    this.remove(handle as number);
  }

  runUntil(ms: number): void {
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.queue[0];
      if (next === undefined || next.at > ms) break;
      this.queue.shift();
      if (next.at > this.clock.now()) this.clock.set(next.at);
      next.cb();
    }
    if (this.clock.now() < ms) this.clock.set(ms);
  }

  get pending(): number {
    return this.queue.length;
  }

  private push(at: number, cb: () => void): number {
    const id = this.nextId++;
    this.queue.push({ at, seq: this.seq++, cb, id });
    return id;
  }

  private remove(id: number): void {
    const i = this.queue.findIndex((e) => e.id === id);
    if (i >= 0) this.queue.splice(i, 1);
  }
}

describe("TickScheduler (ADR 0304)", () => {
  it("keeps absolute deadlines: no drift over 60 s even when every timer fires late", () => {
    const clock = new ManualClock(1000);
    const timers = new FakeTimers(clock);
    let jitter = 0;
    timers.lateMs = () => (jitter = (jitter * 7 + 3) % 5); // 0..4 ms late, deterministic
    const ticks: number[] = [];
    const starts: number[] = [];
    const scheduler = new TickScheduler({
      clock,
      timers,
      spinMs: 1,
      onTick: (tick) => {
        ticks.push(tick);
        starts.push(clock.now());
        clock.advance(0.5); // work
      },
    });
    scheduler.start(0);
    timers.runUntil(1000 + 60_000);
    scheduler.stop();

    const period = 1000 / 60;
    // Ticks 0..3600 are due within the window (t0 + 3600 · period = the end).
    expect(ticks.length).toBeGreaterThanOrEqual(3600);
    expect(ticks.length).toBeLessThanOrEqual(3601);
    ticks.forEach((t, i) => expect(t).toBe(i));
    // Each tick starts at or after its deadline and never drifts: the last tick is as punctual as the first.
    let maxLate = 0;
    for (let i = 0; i < starts.length; i++) {
      const late = starts[i]! - (1000 + i * period);
      expect(late).toBeGreaterThanOrEqual(-1e-9);
      if (late > maxLate) maxLate = late;
    }
    // Timeouts wake ≤ 4 ms late but aim 1 ms early; the spin absorbs the rest, so lateness stays ≤ ~3 ms.
    expect(maxLate).toBeLessThan(3.5);
    expect(scheduler.hitches).toBe(0);
    expect(scheduler.overruns).toBe(0);
    expect(timers.pending).toBe(0);
  });

  it("catches up back-to-back after a stall without skipping tick numbers and reports one hitch", () => {
    const clock = new ManualClock(0);
    const timers = new FakeTimers(clock);
    const ticks: number[] = [];
    const hitches: number[] = [];
    const scheduler = new TickScheduler({
      clock,
      timers,
      onTick: (tick) => {
        ticks.push(tick);
        clock.advance(tick === 100 ? 400 : 0.2); // one 400 ms stall (GC / VM steal)
      },
      onHitch: (behind, tick) => hitches.push(behind, tick),
    });
    scheduler.start(0);
    timers.runUntil(5000);
    scheduler.stop();

    ticks.forEach((t, i) => expect(t).toBe(i));
    expect(ticks.length).toBeGreaterThanOrEqual(300);
    expect(scheduler.hitches).toBe(1);
    expect(hitches[0]).toBeGreaterThan(250);
    expect(scheduler.overruns).toBeGreaterThanOrEqual(1);
    // Caught up: the final tick ran within a period of its deadline.
    const last = ticks[ticks.length - 1]!;
    expect(5000 - scheduler.deadlineOf(last)).toBeLessThan(1000 / 60 + 1);
    const lateness = scheduler.lateness.flush({ count: 0, p50: 0, p99: 0, max: 0, mean: 0 });
    expect(lateness.max).toBeGreaterThan(250);
    expect(lateness.p50).toBeLessThan(2);
  });

  it("pump() drives ticks from a virtual clock, and stop() halts everything", () => {
    const clock = new ManualClock(0);
    let count = 0;
    const scheduler = new TickScheduler({ clock, onTick: () => count++, maxTicksPerTurn: 1000 });
    scheduler.start(500, false);
    expect(scheduler.pump()).toBe(1); // tick 500 due immediately
    clock.advance(1000);
    expect(scheduler.pump()).toBe(60);
    expect(scheduler.nextTick).toBe(561);
    scheduler.stop();
    clock.advance(1000);
    expect(scheduler.pump()).toBe(0);
    expect(count).toBe(61);
  });
});
