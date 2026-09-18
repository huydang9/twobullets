import { describe, expect, it } from "vitest";
import { PerfWatchdog } from "../../src/perf/perfWatchdog";

const OPTIONS = { slowFps: 30, graceMs: 6000, sustainMs: 4000 } as const;

/** Feeds frames at 60 Hz of wall clock from `startMs`, returns the time of the frame that fired (or -1). */
const feed = (watchdog: PerfWatchdog, startMs: number, durationMs: number, fps: number): number => {
  for (let t = startMs; t < startMs + durationMs; t += 16.67) {
    if (watchdog.update(t, fps)) return t;
  }
  return -1;
};

describe("PerfWatchdog", () => {
  it("fires once, only after the grace period plus the sustain window", () => {
    const watchdog = new PerfWatchdog(OPTIONS);
    expect(feed(watchdog, 0, 6000, 12)).toBe(-1);
    expect(watchdog.triggered).toBe(false);

    const firedAt = feed(watchdog, 6000, 6000, 12);
    expect(firedAt).toBeGreaterThanOrEqual(10000);
    expect(firedAt).toBeLessThan(10100);
    expect(watchdog.triggered).toBe(true);
    expect(watchdog.averageFps).toBeCloseTo(12, 1);
  });

  it("does not fire twice", () => {
    const watchdog = new PerfWatchdog(OPTIONS);
    expect(feed(watchdog, 0, 12000, 11)).toBeGreaterThan(0);
    expect(feed(watchdog, 12000, 20000, 11)).toBe(-1);
    expect(watchdog.triggered).toBe(true);
  });

  it("stays quiet at a healthy frame rate", () => {
    const watchdog = new PerfWatchdog(OPTIONS);
    expect(feed(watchdog, 0, 60000, 144)).toBe(-1);
    expect(watchdog.triggered).toBe(false);
    expect(watchdog.averageFps).toBeCloseTo(144, 1);
  });

  it("ignores a short stall and re-arms the sustain window when FPS recovers", () => {
    const watchdog = new PerfWatchdog(OPTIONS);
    feed(watchdog, 0, 7000, 120);
    // Two seconds of slowness, then a full recovery: never reaches the 4 s sustain window.
    expect(feed(watchdog, 7000, 2000, 8)).toBe(-1);
    expect(feed(watchdog, 9000, 6000, 120)).toBe(-1);
    expect(watchdog.triggered).toBe(false);
    // The slow timer restarted, so slowness must last a fresh 4 s (the average needs time to fall first).
    expect(feed(watchdog, 15000, 3000, 8)).toBe(-1);
    expect(feed(watchdog, 18000, 4000, 8)).toBeGreaterThan(0);
  });

  it("does not flap inside the hysteresis band", () => {
    const watchdog = new PerfWatchdog({ ...OPTIONS, graceMs: 0 });
    // 31 FPS is above the slow threshold but below the 34.5 recovery point: the slow timer must not reset.
    expect(feed(watchdog, 0, 3000, 29)).toBe(-1);
    expect(feed(watchdog, 3000, 1500, 32)).toBe(-1);
    expect(feed(watchdog, 4500, 2000, 29)).toBeGreaterThan(0);
  });

  it("ignores NaN, Infinity and zero samples", () => {
    const watchdog = new PerfWatchdog(OPTIONS);
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect(watchdog.update(20000, bad)).toBe(false);
    }
    expect(watchdog.averageFps).toBe(0);
    expect(watchdog.update(20000, Number.NaN)).toBe(false);

    // Bad samples never advanced the average, so a healthy run after them still stays quiet.
    expect(feed(watchdog, 20000, 10000, 120)).toBe(-1);
    expect(watchdog.averageFps).toBeCloseTo(120, 1);
  });

  it("starts the grace period at the first update, not at construction", () => {
    const watchdog = new PerfWatchdog(OPTIONS);
    // The clock starts at 50 s (a long asset load): grace is still measured from here.
    expect(feed(watchdog, 50000, 5900, 10)).toBe(-1);
    expect(feed(watchdog, 55900, 4000, 10)).toBe(-1);
    expect(feed(watchdog, 59900, 1000, 10)).toBeGreaterThanOrEqual(60000);
  });

  it("re-arms after reset(), including the grace period", () => {
    const watchdog = new PerfWatchdog(OPTIONS);
    expect(feed(watchdog, 0, 12000, 10)).toBeGreaterThan(0);

    watchdog.reset();
    expect(watchdog.triggered).toBe(false);
    expect(watchdog.averageFps).toBe(0);

    // Grace restarts from the next update, so the next 6 s of slow frames are ignored again.
    expect(feed(watchdog, 12000, 6000, 10)).toBe(-1);
    expect(feed(watchdog, 18000, 5000, 10)).toBeGreaterThan(0);
    expect(watchdog.triggered).toBe(true);
  });

  it("uses the documented defaults", () => {
    const watchdog = new PerfWatchdog();
    expect(feed(watchdog, 0, 6000, 20)).toBe(-1);
    expect(feed(watchdog, 6000, 3900, 20)).toBe(-1);
    expect(feed(watchdog, 9900, 500, 20)).toBeGreaterThan(0);
  });
});
