import { appendFileSync } from "node:fs";
import { expect, it } from "vitest";
import { runSoldierAnimationBench, type BenchMode } from "./soldierAnimationBench";

// Regression guard for the soldier animation CPU cost: 20 real soldiers in mixed match states (soldierAnimationBench).
// Budgets are generous (several times the M2 Pro numbers, for loaded CI machines). `SOLDIER_BENCH=<file>` runs the long
// version of every mode and appends the results to that file (Vitest swallows console output here).

const LONG = process.env.SOLDIER_BENCH;

async function measure(mode: BenchMode) {
  const result = await runSoldierAnimationBench({ mode, frames: LONG ? 600 : 180, repeats: LONG ? 3 : 1 });
  if (LONG) appendFileSync(LONG, `${JSON.stringify({ mode, ...result })}\n`);
  return result;
}

it("20 soldiers animate within the CPU budget (baked clips, level of detail)", async () => {
  if (LONG) await measure("babylonGroups");
  const full = await measure("baked");
  const lod = await measure("bakedLod");
  // No Babylon animatables: soldiers are posed by the animator.
  expect(lod.activeAnimatables).toBe(0);
  // M2 Pro, steady state: 0.13 ms (no level of detail) and 0.11 ms (with it) against 1.2–2.0 ms for AnimationGroups.
  // The budgets are ~10× that, since the whole suite runs in parallel and this file gets a contended core.
  expect(full.msPerFrame).toBeLessThan(2);
  expect(lod.msPerFrame).toBeLessThan(1.5);
  // Off-screen and settled bodies skip pose writes; visible ones are posed every frame out to ANIMATION_LOD's full-rate
  // distance (M2 Pro: 0.133 ms per frame with no level of detail at all, 0.105 with it — the skip is worth ~0.03 ms, so
  // it only ever applies where the steps can't be seen).
  expect(lod.posesPerFrame).toBeLessThan(full.posesPerFrame * 0.95);
}, 120_000);
