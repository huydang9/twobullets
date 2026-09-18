import { describe, expect, it } from "vitest";
import { GLASS_PHASE, PHASE_GLASS_PROP, glassBlocksAt, glassPhaseBucket, glassPhaseRemaining, isPhaseGlass } from "./glassPhase";
import { getMapProp } from "./layout/props";

// The glazed pane's mode is server-bound gameplay: the headless match server and every client must land on the same
// answer for the same pane at the same tick, from nothing but the pane's position and the clock.

describe("glass phase", () => {
  const { holdSeconds: hold, buckets } = GLASS_PHASE;
  const cycle = hold * 2;

  it("names one pane prop, and it exists", () => {
    expect(isPhaseGlass(PHASE_GLASS_PROP)).toBe(true);
    expect(isPhaseGlass("wall_concrete")).toBe(false);
    expect(isPhaseGlass("wall_mirror")).toBe(false);
    // Resting mode: shoot-through, which is what the pure layout, the nav grid and any world with no clock see.
    expect(getMapProp(PHASE_GLASS_PROP).collision).toMatchObject({ kind: "box", bulletproof: false });
  });

  it("gives a pane the same group wherever it is asked, and the same one for both pieces of an 8 m edge", () => {
    for (let i = 0; i < 200; i++) {
      const x = -72 + i * 0.73;
      const z = 71 - i * 1.31;
      expect(glassPhaseBucket(x, z)).toBe(glassPhaseBucket(x, z));
      expect(glassPhaseBucket(x, z)).toBeGreaterThanOrEqual(0);
      expect(glassPhaseBucket(x, z)).toBeLessThan(buckets);
    }
    // A maze edge is two 4 m pieces 4 m apart, both inside the same 8 m lattice cell.
    for (let k = 0; k <= 18; k++) {
      for (let j = 0; j < 18; j++) {
        const line = -72 + k * 8;
        const centre = -68 + j * 8;
        expect(glassPhaseBucket(line, centre - 2)).toBe(glassPhaseBucket(line, centre + 2));
        expect(glassPhaseBucket(centre - 2, line)).toBe(glassPhaseBucket(centre + 2, line));
      }
    }
  });

  it("spreads panes over every group", () => {
    const seen = new Set<number>();
    for (let x = -72; x <= 72; x += 8) for (let z = -72; z <= 72; z += 8) seen.add(glassPhaseBucket(x, z));
    expect(seen.size).toBe(buckets);
  });

  it("holds each mode for exactly holdSeconds and repeats", () => {
    for (let bucket = 0; bucket < buckets; bucket++) {
      let flips = 0;
      let last = glassBlocksAt(bucket, 0);
      for (let step = 1; step <= cycle * 100; step++) {
        const mode = glassBlocksAt(bucket, step / 100);
        if (mode !== last) flips++;
        last = mode;
      }
      // Two flips per cycle: into blocking and back out.
      expect(flips, `phase group ${bucket}`).toBe(2);
      // And the cycle repeats forever, including deep into a long match.
      for (const t of [0, 3.5, 7, 12.25, 19.75]) expect(glassBlocksAt(bucket, t)).toBe(glassBlocksAt(bucket, t + cycle * 30));
    }
  });

  it("never flips two groups at the same moment, and never leaves the map in one mode", () => {
    const groups = Array.from({ length: buckets }, (_, b) => b);
    let previous = groups.map((b) => glassBlocksAt(b, 0));
    for (let step = 1; step <= cycle * 40; step++) {
      const seconds = step / 4;
      const modes = groups.map((b) => glassBlocksAt(b, seconds));
      // Some panes stop bullets and some don't, always: there is no global safe window and no global wall.
      expect(modes.filter((m) => m).length, `t = ${seconds}`).toBeGreaterThan(0);
      expect(modes.filter((m) => !m).length, `t = ${seconds}`).toBeGreaterThan(0);
      // At most one group turns over in any quarter second: a flip is a local event, never a map-wide one.
      expect(modes.filter((m, i) => m !== previous[i]).length, `t = ${seconds}`).toBeLessThanOrEqual(1);
      previous = modes;
    }
  });

  it("counts down to the next flip", () => {
    for (let bucket = 0; bucket < buckets; bucket++) {
      for (let step = 0; step < cycle * 10; step++) {
        const seconds = step / 10;
        const left = glassPhaseRemaining(bucket, seconds);
        expect(left).toBeGreaterThan(0);
        expect(left).toBeLessThanOrEqual(hold);
        // It is the time to the flip: the mode is the same just before it and different just after.
        expect(glassBlocksAt(bucket, seconds + left - 0.05)).toBe(glassBlocksAt(bucket, seconds));
        expect(glassBlocksAt(bucket, seconds + left + 0.05)).not.toBe(glassBlocksAt(bucket, seconds));
      }
    }
  });

  it("is a pure function of position and clock: no state, no wall clock, no drift", () => {
    // Two independent walks over the same times in different orders (a client predicting ahead, a server stepping
    // ticks) see the same modes. Nothing is memoised, so nothing can diverge.
    const forward: boolean[] = [];
    for (let tick = 0; tick < 600; tick++) forward.push(glassBlocksAt(glassPhaseBucket(12, -36), tick / 60));
    const backward: boolean[] = new Array(600);
    for (let tick = 599; tick >= 0; tick--) backward[tick] = glassBlocksAt(glassPhaseBucket(12, -36), tick / 60);
    expect(backward).toEqual(forward);
  });
});
