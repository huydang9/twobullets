import { describe, expect, it } from "vitest";
import { GLASS_PHASE, PHASE_GLASS_PROP, PHASE_GLASS_PROPS, glassBlocksAt, glassPhaseBucket, glassPhaseRemaining, isPhaseGlass } from "./glassPhase";
import { getMapProp } from "./layout/props";

// The glazed pane's mode is server-bound gameplay: the headless match server and every client must land on the same
// answer for the same pane at the same tick, from nothing but the pane's position and the clock.

describe("glass phase", () => {
  const { holdSeconds: hold, buckets } = GLASS_PHASE;
  const cycle = hold * 2;

  /** A wall running along world X stands on a constant-Z line; one running along Z stands on a constant-X line. */
  const ALONG_X = 0;
  const ALONG_Z = Math.PI / 2;

  it("names the pane props, and they exist", () => {
    // One glazed wall in two lengths: the 4 m piece and the 2 m piece the maze's narrow lanes are built from.
    expect(PHASE_GLASS_PROPS).toEqual(["wall_glass", "wall_glass_2"]);
    for (const prop of PHASE_GLASS_PROPS) {
      expect(isPhaseGlass(prop), prop).toBe(true);
      // Resting mode: shoot-through, which is what the pure layout, the nav grid and any world with no clock see.
      expect(getMapProp(prop).collision, prop).toMatchObject({ kind: "box", bulletproof: false });
    }
    expect(isPhaseGlass(PHASE_GLASS_PROP)).toBe(true);
    for (const other of ["wall_concrete", "wall_concrete_2", "wall_mirror", "wall_mirror_2"]) {
      expect(isPhaseGlass(other), other).toBe(false);
    }
  });

  it("gives a pane the same group wherever it is asked, and the same one for every piece of a wall", () => {
    for (let i = 0; i < 200; i++) {
      const x = -72 + i * 0.73;
      const z = 71 - i * 1.31;
      const yaw = i % 2 === 0 ? ALONG_X : ALONG_Z;
      expect(glassPhaseBucket(x, z, yaw)).toBe(glassPhaseBucket(x, z, yaw));
      expect(glassPhaseBucket(x, z, yaw)).toBeGreaterThanOrEqual(0);
      expect(glassPhaseBucket(x, z, yaw)).toBeLessThan(buckets);
    }
    // A wall is pieces laid end to end on a lattice line — one 2 m piece on the maze's common squeeze, or one to three
    // 4 m pieces on a wider lane. The group is read off the line the wall stands on, which `yaw` names, so every piece
    // of the wall agrees whatever length they are. Mixed lengths is exactly what broke the old positional derivation.
    const grid = GLASS_PHASE.grid;
    for (let k = -40; k <= 40; k++) {
      const line = k * grid;
      for (const length of [2, 4]) {
        for (let span = 1; span * length <= 12; span++) {
          for (let start = -40; start <= 40; start += 3) {
            const from = start * grid;
            const pieces = Array.from({ length: span }, (_, p) => from + (p + 0.5) * length);
            expect(new Set(pieces.map((along) => glassPhaseBucket(line, along, ALONG_Z))).size, `V wall at x=${line}`).toBe(1);
            expect(new Set(pieces.map((along) => glassPhaseBucket(along, line, ALONG_X))).size, `H wall at z=${line}`).toBe(1);
          }
        }
      }
    }
  });

  it("spreads panes over every group", () => {
    const seen = new Set<number>();
    const grid = GLASS_PHASE.grid;
    for (let k = -24; k <= 24; k++) {
      seen.add(glassPhaseBucket(k * grid, 2, ALONG_Z));
      seen.add(glassPhaseBucket(2, k * grid, ALONG_X));
    }
    expect(seen.size).toBe(buckets);
    // Neighbouring wall lines rarely agree: the hash spreads the groups rather than banding the map.
    let same = 0;
    for (let k = -24; k < 24; k++) if (glassPhaseBucket(k * grid, 2, ALONG_Z) === glassPhaseBucket((k + 1) * grid, 2, ALONG_Z)) same++;
    expect(same).toBeLessThan(24);
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
    for (let tick = 0; tick < 600; tick++) forward.push(glassBlocksAt(glassPhaseBucket(12, -36, ALONG_Z), tick / 60));
    const backward: boolean[] = new Array(600);
    for (let tick = 599; tick >= 0; tick--) backward[tick] = glassBlocksAt(glassPhaseBucket(12, -36, ALONG_Z), tick / 60);
    expect(backward).toEqual(forward);
  });
});
