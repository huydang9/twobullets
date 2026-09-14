import { getHeapSpaceStatistics } from "node:v8";
import { stepProjectiles } from "@twobullets/shared/weapons/ballistics";
import { ProjectileBuffer, projectileId, type ProjectileSink } from "@twobullets/shared/weapons/projectileBuffer";
import type { RayHit, RaycastFn } from "@twobullets/shared/weapons/types";
import { describe, expect, it } from "vitest";

// Refactor R7 acceptance (architecture.md §7.2): stepping the shared ProjectileBuffer allocates 0 B per tick. Lives in
// sim because the measurement needs node:v8 (shared is pure).

const DT = 1 / 60;

describe("ProjectileBuffer", () => {
  it("allocates nothing per tick (zero-allocation gate)", () => {
    const buffer = new ProjectileBuffer(512);
    const hit: RayHit = { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: -1 }, fraction: 0.5, colliderId: null };
    let casts = 0;
    // Slow bullets stay alive through a sample (under the lifetime cap); every 9973rd segment "hits" with a preallocated result, so impacts and removals are on the measured path too.
    const raycast: RaycastFn = () => (++casts % 9973 === 0 ? hit : null);
    const sink: ProjectileSink = { impact() {}, expired() {} };
    const refill = (): void => {
      while (buffer.count < 400) buffer.add(projectileId(1, buffer.count, 0), 0, 1, 1, 0, 1.6, 0, 3, 0.5, 30, 0, 0);
    };
    const newSpaceUsed = (): number => getHeapSpaceStatistics().find((space) => space.space_name === "new_space")!.space_used_size;

    // Warm up so the JIT settles and the stats call's own objects are the same every sample.
    for (let i = 0; i < 2000; i++) {
      refill();
      stepProjectiles(buffer, DT, raycast, sink);
    }
    const sample = (ticks: number): number[] => {
      const deltas: number[] = [];
      for (let trial = 0; trial < 15; trial++) {
        refill();
        const before = newSpaceUsed();
        for (let i = 0; i < ticks; i++) buffer.step(DT, raycast, sink);
        const after = newSpaceUsed();
        if (after >= before) deltas.push(after - before); // a scavenge in between makes it negative: skip that trial
      }
      return deltas.sort((a, b) => a - b);
    };
    const TICKS = 150;
    const baseline = sample(0); // the stats call's own objects
    const measured = sample(TICKS);
    // Per-bullet allocations (60k segments) force scavenges, leaving too few clean trials.
    expect(measured.length).toBeGreaterThan(5);
    // Even one 16-byte object per tick would add 2.4 KB over the baseline noise.
    expect(measured[Math.floor(measured.length / 2)]! - baseline[baseline.length - 1]!).toBeLessThan(1024);
    expect(buffer.count).toBeGreaterThan(0);
  });

});
