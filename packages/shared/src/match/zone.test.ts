import { describe, expect, it } from "vitest";
import {
  computeZonePhase,
  createZoneState,
  DEFAULT_ZONE_SPEC,
  distanceOutsideZone,
  isOutsideZone,
  scheduleZonePhases,
  secondsToTicks,
  ZONE_PLAYABLE_HALF_EXTENT,
  zoneAt,
  zoneAtInto,
  zoneCloseSeconds,
  zonePlayableHalfExtent,
  zoneSpecForHalfExtent,
  zoneTickDamage,
  type ZoneCenterCheck,
} from "./zone";
import { MAP_V1 } from "../map/mapV1";
import { REAL_TERRAIN } from "../map/real/convert/elevation";
import type { ZoneSpec } from "./types";

const spec = DEFAULT_ZONE_SPEC;
const START = 300;

describe("zone schedule", () => {
  it("closes at 6:55 of combat", () => {
    expect(zoneCloseSeconds(spec)).toBe(415);
    const phases = scheduleZonePhases(spec, 1, START);
    expect(phases).toHaveLength(7);
    expect(phases[6]!.shrinkEndTick - START).toBe(415 * 60);
    // Table: phase 1 announced 0:30, shrink 1:40–2:20; phase 3 shrink 3:55–4:20.
    expect([phases[0]!.waitStartTick, phases[0]!.shrinkStartTick, phases[0]!.shrinkEndTick].map((t) => (t - START) / 60)).toEqual([30, 100, 140]);
    expect([phases[2]!.shrinkStartTick, phases[2]!.shrinkEndTick].map((t) => (t - START) / 60)).toEqual([235, 260]);
    expect(phases.map((p) => p.to.r)).toEqual([200, 125, 75, 45, 25, 12, 0]);
    expect(phases.map((p) => p.dps)).toEqual([1, 2, 3, 5, 8, 12, 20]);
  });

  it("each phase is announced when the previous shrink ends and starts from its circle", () => {
    const phases = scheduleZonePhases(spec, 77, START);
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]!.waitStartTick).toBe(phases[i - 1]!.shrinkEndTick);
      expect(phases[i]!.from).toEqual(phases[i - 1]!.to);
    }
    expect(phases[0]!.from).toEqual(spec.initial);
  });

  it("every next circle is contained in the previous one and inside the edge margin, for many seeds", () => {
    for (let seed = 0; seed < 300; seed++) {
      for (const p of scheduleZonePhases(spec, seed, 0)) {
        const d = Math.sqrt((p.to.cx - p.from.cx) ** 2 + (p.to.cz - p.from.cz) ** 2);
        expect(d + p.to.r, `seed ${seed} phase ${p.index}`).toBeLessThanOrEqual(p.from.r + 1e-9);
        const bound = ZONE_PLAYABLE_HALF_EXTENT - spec.edgeMargin - 0.5 * p.to.r;
        expect(Math.abs(p.to.cx)).toBeLessThanOrEqual(bound + 1e-9);
        expect(Math.abs(p.to.cz)).toBeLessThanOrEqual(bound + 1e-9);
      }
    }
  });

  it("is deterministic per seed and differs across seeds", () => {
    expect(scheduleZonePhases(spec, 42, 0)).toEqual(scheduleZonePhases(spec, 42, 0));
    const centers = new Set(Array.from({ length: 20 }, (_, seed) => JSON.stringify(scheduleZonePhases(spec, seed, 0)[6]!.to)));
    expect(centers.size).toBeGreaterThan(15);
  });

  it("re-rolls centers the check rejects and falls back to the previous center", () => {
    const east = scheduleZonePhases(spec, 5, 0, 1, (x) => x > 0);
    for (const p of east) expect(p.to.cx === p.from.cx || p.to.cx > 0).toBe(true);
    const never = scheduleZonePhases(spec, 5, 0, 1, () => false);
    for (const p of never) expect([p.to.cx, p.to.cz]).toEqual([0, 0]);
  });

  it("timeScale scales every duration", () => {
    const quarter = scheduleZonePhases(spec, 3, 0, 0.25);
    expect(quarter[6]!.shrinkEndTick).toBe(secondsToTicks(415, 0.25));
    expect(quarter[0]!.shrinkStartTick).toBe(secondsToTicks(100, 0.25));
    // Centers don't depend on timing.
    expect(quarter.map((p) => p.to)).toEqual(scheduleZonePhases(spec, 3, 0).map((p) => p.to));
  });

  it("rejects phases outside the spec", () => {
    expect(() => computeZonePhase(spec, 1, 8, null, 0)).toThrow();
  });
});

describe("zoneAt", () => {
  const phases = scheduleZonePhases(spec, 9, START);

  it("idle before the first announcement: initial circle, no damage", () => {
    const z = zoneAt(spec, phases, START + 10);
    expect(z.stage).toBe("idle");
    expect(z.current).toEqual(spec.initial);
    expect(z.dps).toBe(0);
    expect(z.next).toBeNull();
    expect(z.ticksToChange).toBe(30 * 60 - 10);
  });

  it("waiting → shrinking → next waiting → closed, with the phase's damage from the announcement on", () => {
    const p1 = phases[0]!;
    const waiting = zoneAt(spec, phases, p1.waitStartTick);
    expect(waiting).toMatchObject({ stage: "waiting", phaseIndex: 1, dps: 1, next: p1.to, ticksToChange: p1.shrinkStartTick - p1.waitStartTick });
    expect(waiting.current).toEqual(p1.from);

    const mid = zoneAt(spec, phases, (p1.shrinkStartTick + p1.shrinkEndTick) / 2);
    expect(mid.stage).toBe("shrinking");
    expect(mid.current.r).toBeCloseTo((p1.from.r + p1.to.r) / 2, 9);
    expect(mid.current.cx).toBeCloseTo((p1.from.cx + p1.to.cx) / 2, 9);

    const last = phases[6]!;
    const closed = zoneAt(spec, phases, last.shrinkEndTick + 100);
    expect(closed).toMatchObject({ stage: "closed", phaseIndex: 7, dps: 20, next: null, ticksToChange: 0 });
    expect(closed.current).toEqual(last.to);
  });

  it("is continuous at every phase boundary (radius changes by at most one tick of shrink)", () => {
    let previous = zoneAt(spec, phases, START).current;
    for (let tick = START + 1; tick <= phases[6]!.shrinkEndTick + 5; tick++) {
      const now = zoneAt(spec, phases, tick).current;
      const dr = Math.abs(now.r - previous.r);
      const dc = Math.sqrt((now.cx - previous.cx) ** 2 + (now.cz - previous.cz) ** 2);
      expect(dr, `tick ${tick}`).toBeLessThan(0.2);
      expect(dc, `tick ${tick}`).toBeLessThan(0.2);
      previous = now;
    }
  });

  it("with only the announced phases, a finished shrink waits for the next announcement instead of closing", () => {
    const announced = phases.slice(0, 2);
    const z = zoneAt(spec, announced, phases[1]!.shrinkEndTick);
    expect(z.stage).toBe("waiting");
    expect(z.next).toBeNull();
  });

  it("zoneAtInto reuses the output object", () => {
    const out = createZoneState(spec);
    const current = out.current;
    zoneAtInto(spec, phases, phases[2]!.shrinkStartTick + 30, out);
    expect(out.current).toBe(current);
    expect(out.stage).toBe("shrinking");
  });

  it("outside tests and tick damage", () => {
    const circle = { cx: 10, cz: 0, r: 5 };
    expect(isOutsideZone(circle, 16, 0)).toBe(true);
    expect(isOutsideZone(circle, 14, 0)).toBe(false);
    expect(distanceOutsideZone(circle, 20, 0)).toBeCloseTo(5, 9);
    expect(zoneTickDamage(spec, 1)).toBeCloseTo(0.1, 9);
    expect(zoneTickDamage(spec, 20)).toBeCloseTo(2, 9);
  });
});

describe("scaling to the map", () => {
  const SEEDS = [1, 7, 42, 1234, 99999];
  /** Captured from the ±250 m schedule before the zone read the map's half extent: [cx, cz, r] per phase, per seed. */
  const V1_GOLDEN: number[][][] = [[[23.12,2.38,200],[-37.22,-9.62,125],[-26.5,-24.73,75],[-53.49,-25.85,45],[-64.93,-25.64,25],[-69.52,-14.62,12],[-77.91,-21.38,0]],[[58.84,115.31,200],[39.83,87.3,125],[48.22,49.32,75],[52.84,64.9,45],[35.03,67.53,25],[35.22,62.02,12],[38.14,66.04,0]],[[-42.29,-106.05,200],[19.48,-95.65,125],[-14.27,-85.69,75],[-5.18,-59.06,45],[-6.35,-49.83,25],[-12.88,-43.9,12],[-23.39,-43.27,0]],[[17.69,-50.84,200],[35.2,-80.15,125],[50.78,-33.13,75],[54.98,-60.37,45],[54.36,-42.81,25],[42.14,-42.97,12],[41.08,-48.4,0]],[[52.61,10.15,200],[-10.74,7.4,125],[-25.83,52.69,75],[-49.06,36.77,45],[-33.63,32.89,25],[-40.73,40.57,12],[-41.4,50.75,0]]];
  /** Same seeds through the re-roll path (a check that rejects half the map). */
  const V1_GOLDEN_CHECKED: number[][][] = [[[23.12,2.38,200],[26.7,52.02,125],[37.42,36.91,75],[10.43,35.79,45],[-1.01,36,25],[-5.6,47.02,12],[-13.99,40.26,0]],[[58.84,115.31,200],[39.83,87.3,125],[48.22,49.32,75],[52.84,64.9,45],[35.03,67.53,25],[35.22,62.02,12],[38.14,66.04,0]],[[-42.6,47.24,200],[19.17,51.22,125],[-14.58,61.18,75],[-5.49,87.81,45],[-6.66,97.04,25],[-13.19,102.97,12],[-23.7,103.6,0]],[[52.57,49.36,200],[70.08,20.05,125],[85.66,67.07,75],[89.86,39.83,45],[89.24,57.39,25],[77.02,57.23,12],[75.96,51.8,0]],[[52.61,10.15,200],[37.28,25.54,125],[22.19,70.83,75],[-1.04,54.91,45],[14.39,51.03,25],[7.29,58.71,12],[6.62,68.89,0]]];

  const circles = (zone: ZoneSpec, seed: number, check: ZoneCenterCheck | null = null): number[][] =>
    scheduleZonePhases(zone, seed, 0, 1, check).map((p) => [p.to.cx, p.to.cz, p.to.r]);

  it("Map v1 and the real maps keep exactly the schedule they had before the zone scaled", () => {
    expect(MAP_V1.terrain.playableHalfExtent).toBe(ZONE_PLAYABLE_HALF_EXTENT);
    expect(REAL_TERRAIN.playableHalfExtent).toBe(ZONE_PLAYABLE_HALF_EXTENT);
    // Same object, so nothing downstream (the server level, the net view) can see a different spec.
    expect(zoneSpecForHalfExtent(MAP_V1.terrain.playableHalfExtent)).toBe(DEFAULT_ZONE_SPEC);
    SEEDS.forEach((seed, i) => {
      expect(circles(spec, seed), `seed ${seed}`).toEqual(V1_GOLDEN[i]);
      expect(circles(spec, seed, (x, z) => x + z > 0), `seed ${seed}, rejecting checker`).toEqual(V1_GOLDEN_CHECKED[i]);
    });
  });

  it("a smaller map gets the same schedule with every radius scaled", () => {
    const half = 72; // the maze
    const small = zoneSpecForHalfExtent(half);
    const k = half / ZONE_PLAYABLE_HALF_EXTENT;
    expect(zonePlayableHalfExtent(small)).toBe(half);
    expect(small.initial).toEqual({ cx: 0, cz: 0, r: 102.24 });
    // The first circle still covers the playable square, as 355 does at ±250 m.
    expect(small.initial.r).toBeGreaterThan(half * Math.SQRT2);
    expect(small.phases.map((p) => p.radius)).toEqual(spec.phases.map((p) => Math.round(p.radius * k * 100) / 100));
    // Phase 1 squeezes the map instead of containing it (the bug: 200 m on a 144 m map).
    expect(small.phases[0]!.radius).toBeLessThan(half);
    // Timings, damage and the phase count are untouched: this is a scaling fix, not a re-design.
    expect(small.phases.map((p) => [p.waitSeconds, p.shrinkSeconds, p.dps])).toEqual(spec.phases.map((p) => [p.waitSeconds, p.shrinkSeconds, p.dps]));
    expect(zoneCloseSeconds(small)).toBe(zoneCloseSeconds(spec));
    expect(small.firstAnnounceSeconds).toBe(spec.firstAnnounceSeconds);
    expect(small.damageIntervalTicks).toBe(spec.damageIntervalTicks);
  });

  it("keeps a small map's circles inside its playable square", () => {
    const half = 72;
    const small = zoneSpecForHalfExtent(half);
    for (let seed = 0; seed < 200; seed++) {
      for (const p of scheduleZonePhases(small, seed, 0)) {
        const bound = half - small.edgeMargin - 0.5 * p.to.r;
        expect(Math.abs(p.to.cx), `seed ${seed} phase ${p.index}`).toBeLessThanOrEqual(bound + 1e-9);
        expect(Math.abs(p.to.cz), `seed ${seed} phase ${p.index}`).toBeLessThanOrEqual(bound + 1e-9);
        // And the circle itself stays on the map.
        expect(Math.max(Math.abs(p.to.cx), Math.abs(p.to.cz)) + p.to.r).toBeLessThanOrEqual(half * Math.SQRT2);
      }
    }
  });

  it("scaling is proportional: the same seed draws the same picture on both maps", () => {
    const k = 0.288; // 72 / 250
    const small = zoneSpecForHalfExtent(72);
    for (const seed of SEEDS) {
      const big = scheduleZonePhases(spec, seed, 0);
      scheduleZonePhases(small, seed, 0).forEach((p, i) => {
        expect(p.to.cx).toBeCloseTo(big[i]!.to.cx * k, 1);
        expect(p.to.cz).toBeCloseTo(big[i]!.to.cz * k, 1);
      });
    }
  });

  it("rejects a half extent that isn't a positive number", () => {
    expect(() => zoneSpecForHalfExtent(0)).toThrow();
    expect(() => zoneSpecForHalfExtent(Number.NaN)).toThrow();
  });
});
