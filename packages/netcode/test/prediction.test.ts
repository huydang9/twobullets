import { describe, expect, it } from "vitest";
import { CorrectionSmoother, createReconcileResult, ownerMoveWithinTolerance, PredictionHistory, reconcile, ReconcileKind, type ReplayHooks } from "../src/prediction";
import { createSeededRng } from "../src/testing/rng";

interface S {
  x: number;
  v: number;
}

const hooks = (restored: S[]): ReplayHooks<S, number> => ({
  step: (s, input) => ({ x: s.x + s.v + input, v: s.v }),
  restore: (s) => restored.push(s),
  withinTolerance: (p, a) => Math.abs(p.x - a.x) < 0.01 && p.v === a.v,
});

function run(history: PredictionHistory<S, number>, from: S, inputs: number[], start: number): S {
  let s = from;
  const h = hooks([]);
  inputs.forEach((input, i) => {
    s = h.step(s, input, start + i);
    history.record(start + i, input, s);
  });
  return s;
}

describe("PredictionHistory + reconcile", () => {
  it("match drops old history and keeps the prediction", () => {
    const history = new PredictionHistory<S, number>();
    run(history, { x: 0, v: 1 }, [0, 0, 0, 0, 0], 100);
    const out = reconcile(history, 102, { x: 3, v: 1 }, hooks([]), createReconcileResult());
    expect(out.kind).toBe(ReconcileKind.match);
    expect(out.state).toEqual({ x: 5, v: 1 });
    expect(history.has(101)).toBe(false);
    expect(history.has(102)).toBe(true);
  });

  it("mismatch restores and replays recorded inputs to the newest tick", () => {
    const history = new PredictionHistory<S, number>();
    run(history, { x: 0, v: 1 }, [0, 1, 0, 2, 0], 100);
    const restored: S[] = [];
    const out = reconcile(history, 101, { x: 10, v: 1 }, hooks(restored), createReconcileResult());
    expect(out.kind).toBe(ReconcileKind.replayed);
    expect(out.replayed).toBe(3);
    // 101 → 10; 102: +1+0 = 11; 103: +1+2 = 14; 104: +1+0 = 15
    expect(out.state).toEqual({ x: 15, v: 1 });
    expect(restored).toEqual([{ x: 10, v: 1 }]);
    expect(history.stateAt(104)).toEqual({ x: 15, v: 1 });
    // The same authoritative tick again now matches.
    expect(reconcile(history, 103, { x: 14, v: 1 }, hooks([]), createReconcileResult()).kind).toBe(ReconcileKind.match);
  });

  it("snaps beyond maxReplayTicks, resets without history, ignores stale and future ticks", () => {
    const history = new PredictionHistory<S, number>();
    run(history, { x: 0, v: 0 }, new Array(40).fill(0), 0);
    expect(reconcile(history, 5, { x: 9, v: 0 }, hooks([]), createReconcileResult()).kind).toBe(ReconcileKind.snapped);
    expect(history.newestTick).toBe(-1);
    expect(reconcile(history, 5, { x: 9, v: 0 }, hooks([]), createReconcileResult()).kind).toBe(ReconcileKind.reset);
    run(history, { x: 0, v: 0 }, new Array(10).fill(0), 100);
    expect(reconcile(history, 105, { x: 0, v: 0 }, hooks([]), createReconcileResult()).kind).toBe(ReconcileKind.match);
    expect(reconcile(history, 101, { x: 7, v: 0 }, hooks([]), createReconcileResult()).kind).toBe(ReconcileKind.stale);
    expect(reconcile(history, 500, { x: 7, v: 0 }, hooks([]), createReconcileResult()).kind).toBe(ReconcileKind.ahead);
  });

  it("property: replay after a random correction reproduces a from-scratch simulation", () => {
    const rng = createSeededRng(9);
    for (let round = 0; round < 200; round++) {
      const history = new PredictionHistory<S, number>();
      const inputs = Array.from({ length: 30 }, () => Math.floor(rng.next() * 3) - 1);
      run(history, { x: 0, v: 0.5 }, inputs, 1000);
      const k = 1000 + Math.floor(rng.next() * 29);
      const auth = { x: 1000 + rng.next() * 100, v: 0.5 };
      const out = reconcile(history, k, auth, hooks([]), createReconcileResult(), { maxReplayTicks: 64 });
      expect(out.kind).toBe(ReconcileKind.replayed);
      let s = auth;
      for (let t = k + 1; t < 1030; t++) s = { x: s.x + s.v + inputs[t - 1000]!, v: s.v };
      expect(out.state!.x).toBeCloseTo(s.x, 9);
    }
  });

  it("ring wraps after capacity", () => {
    const history = new PredictionHistory<S, number>(8);
    run(history, { x: 0, v: 0 }, new Array(20).fill(0), 0);
    expect(history.oldestTick).toBe(12);
    expect(history.has(11)).toBe(false);
    expect(history.has(12)).toBe(true);
  });
});

describe("ownerMoveWithinTolerance", () => {
  const base = { xMm: 1000, yMm: 1000, zMm: 1000, vxMmS: 0, vyMmS: 0, vzMmS: 0, stance: 0, grounded: true, sprinting: false, jumpHeld: false, moveMode: 0, coyoteTicks: 5, jumpBufferTicks: 0, groundIgnoreTicks: 0 };
  it("1 cm, 5 cm/s, exact discrete, ±1 tick timers", () => {
    expect(ownerMoveWithinTolerance(base, { ...base, xMm: 1010, vzMmS: -50, coyoteTicks: 6 })).toBe(true);
    expect(ownerMoveWithinTolerance(base, { ...base, xMm: 1011 })).toBe(false);
    expect(ownerMoveWithinTolerance(base, { ...base, vyMmS: 51 })).toBe(false);
    expect(ownerMoveWithinTolerance(base, { ...base, grounded: false })).toBe(false);
    expect(ownerMoveWithinTolerance(base, { ...base, coyoteTicks: 3 })).toBe(false);
  });
});

describe("CorrectionSmoother", () => {
  it("decays with τ = 100 ms and snaps beyond 1 m", () => {
    const s = new CorrectionSmoother();
    s.add(0.1, 0, 0);
    for (let i = 0; i < 30; i++) s.update(0.01);
    expect(s.x).toBeCloseTo(0.1 * Math.exp(-3), 6);
    expect(s.add(2, 0, 0)).toBe(false);
    expect(s.magnitude).toBe(0);
    expect(s.snaps).toBe(1);
  });
});
