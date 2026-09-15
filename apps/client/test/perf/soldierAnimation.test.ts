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
  expect(full.msPerFrame).toBeLessThan(1.5);
  expect(lod.msPerFrame).toBeLessThan(1);
  // Far, off-screen and settled bodies skip most pose writes.
  expect(lod.posesPerFrame).toBeLessThan(full.posesPerFrame * 0.75);
}, 120_000);
