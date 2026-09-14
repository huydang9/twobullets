# ADR 0305: Per-tick performance budgets, allocation-free hot paths and CI regression gates

- Status: Proposed
- Date: 2026-09-14
- Owner: Server Runtime & Performance Engineer
- Related: [runtime-performance.md §4.1, §5](../runtime-performance.md#5-performance-engineering-practices-adr-0305), Netcode A3 and A5

## Context

The simulation is cheap today (0.38–0.57 ms per 10-player tick), but the benchmarks found avoidable costs that will grow with features:

| Finding | Measured |
|---|---|
| `Math.hypot` vs `Math.sqrt` | 15 ns + ~10 B vs 1.1 ns + 0 B per call; used in every shared hot path |
| Immutable `stepProjectiles` vs SoA | 3.3 µs + 3.9 KB per tick vs 0.28 µs + 0 B |
| Polymorphic snapshot records (`structuredClone`) | Encoder 10× slower |
| Embind crossing floor | 123 ns per call; Babylon's `raycast` allocates a BigInt and arrays per call |
| Allocation per tick | ~0.36 MB, so a scavenge every ~15 ticks |
| `@babylonjs/core` barrel | +230 MB and +2 s per process |
| `PhysicsCharacterController.setShapeOptions` | Creates a new WASM capsule on every stance change |

Benchmark noise on shared machines is large, so tails more than doubled under host load.

## Decision

1. **Budgets per 10-player match tick (p99, target hardware):**
   - movement ≤ 1 ms
   - projectiles + hit registration ≤ 1 ms
   - relevance ≤ 0.5 ms
   - snapshots for all clients ≤ 0.3 ms
   - send ≤ 1 ms
   - **total work ≤ 4 ms; lateness ≤ 2 ms**
2. **Coding rules for `packages/shared`, `packages/sim` and the server hot path:**
   - `len2`/`len3` helpers instead of `Math.hypot`;
   - SoA typed arrays for projectiles, hitbox history and per-player scalars;
   - preallocated scratch objects and query arrays;
   - one construction site per record shape;
   - no per-call BigInt or closure creation;
   - precreated stance shapes;
   - no `scene.render()`;
   - no Havok bodies for hitboxes.
3. **CI gates on a dedicated self-hosted runner**, using `tools/bench/runtime`:
   - tick p50 +10% fails (p99 +25% warns);
   - a new allocation in a zero-allocation case fails;
   - sanity counters must equal the golden file for fixed seeds;
   - ready > 500 ms or RSS > 160 MB fails;
   - the barrel present in the server bundle fails.
4. **Production telemetry:** tick work and lateness histograms, GC pauses, `havok_heap_bytes`, inputs dropped, snapshots skipped, cgroup `nr_throttled`.
5. **Profiling:**
   - local: `--cpu-prof` and `--heap-prof`;
   - Linux: `perf` + `--perf-basic-prof-only-functions`;
   - `--trace-gc` and `perf_hooks` for GC.

## Consequences

- Some shared code will be refactored: `Math.hypot`, and the projectile representation. This must be coordinated with the client engineers because it affects prediction. Using the same helpers on both sides keeps parity.
- A dedicated benchmark runner is a small fixed cost (e.g. one Hetzner/OVH box or a spare host).

## Alternatives considered

| Option | Why not |
|---|---|
| No gates; profile when problems appear | Regressions get found in production tick tails |
| Gates on shared CI runners | Measured noise on a loaded machine exceeds 2× at p99 |
