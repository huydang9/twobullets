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
  zoneTickDamage,
} from "./zone";

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
    expect(phases.map((p) => p.to.r)).toEqual([400, 250, 150, 90, 45, 20, 0]);
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
