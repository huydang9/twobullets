# Match server runtime and performance

- Owner: Server Runtime & Performance Engineer. Status: proposal for the Principal Architect to merge with [netcode.md](netcode.md) and [platform.md](platform.md).
- Date: 2026-09-14. Measured at repo commit `12f0d9c`; `CharacterBody.ts`, `HavokRaycaster.ts` and `packages/shared` were clean at that commit.
- ADR numbers **0300–0399** (`docs/backend/adr/03NN-*.md`) avoid collisions with Platform (0100–0199) and Netcode (0200–0299).
- Benchmarks live in `tools/bench/runtime/`. Raw JSON results are in `tools/bench/runtime/results/`. The method is in [Appendix A](#appendix-a-methodology). Every number marked **measured** comes from those scripts on this machine. Numbers marked **est.** are estimates, and the assumptions behind them are stated.

---

## 0. Summary

| Topic | Recommendation | Key measured numbers (Apple M2 Pro, Node 24.19) |
|---|---|---|
| Language/runtime | **Node.js 24 + TypeScript** reusing `packages/shared` and the Havok WASM that the client runs. Keep the code Bun-compatible, but don't adopt Bun yet. No Rust/Go port of the simulation. [ADR 0301](adr/0301-node-typescript-match-runtime.md) | Full 10-player tick: **0.38 ms p50 / 0.7–1.2 ms p99** (direct Havok) and **0.57 ms p50 / 1.2–2.1 ms p99** (Babylon `CharacterBody` path). That is 2–4% of the 16.67 ms budget. |
| Babylon layer | Keep Babylon's `PhysicsCharacterController` on the server for prediction parity. Load Babylon through **deep imports in a bundled server build**, never the `@babylonjs/core` barrel. Split `packages/shared` into pure code and a Babylon adapter. [ADR 0302](adr/0302-havok-via-babylon-deep-imports-bundled.md) | Barrel: **0.7–1.9 s import, 86–150 MB heap**. Deep imports: **70–200 ms, 19–40 MB heap**. The Babylon wrappers add +50% tick time vs direct HP_* calls, still < 1 ms. |
| Process model | **One OS process per match** for M3–M5, as Platform A1 assumes. Build the server as a `MatchHost` that can also **pack K matches per worker thread** with a shared Havok instance and shared static shapes. Switch to packing when memory or boot time costs money. [ADR 0303](adr/0303-process-per-match-with-packable-match-host.md) | Worker with 1 match: +25–33 MB RSS. Each extra packed match: **+3–4 MB RSS**, +0.2 MB WASM with shared shapes. **6 workers × 15 matches = 90 matches** ticked at 60 Hz on this laptop, with work p99 ≈ 12 ms. |
| Tick scheduling | Absolute-deadline (drift-free) timer plus a **1–2 ms `setImmediate` spin**. Catch up back-to-back and never skip tick numbers. Pin with cpusets, not CFS quotas. [ADR 0304](adr/0304-drift-free-hybrid-tick-scheduler.md) | Tick start lateness p99: `setTimeout` drift-free 8.3 ms; hybrid 2 ms **0.38 ms** for about +2% of a core; `setInterval` drifts 430 ms in 8 s. |
| Capacity | Plan **0.15 vCPU per match** (low) to **0.25** (high, allowing for unmeasured transport cost), and **150 MB** per match process. | Sim alone, real time: **~0.4–0.55 ms per match-tick → 20–25 matches per M2 P-core** at p99 ≤ 12 ms |
| Cost | At 1,000 CCU: compute **≈ $400–950/month**, depending on provider. Egress on metered clouds costs 3–4× more than compute. | §4.4 |
| Engineering | Allocation-free hot loops, no `Math.hypot`, stable hidden classes, fewer embind crossings, CI performance gates. [ADR 0305](adr/0305-performance-budgets-and-ci-gates.md) | `Math.hypot`: **15 ns + ~10 B per call vs 1.1 ns** for `sqrt`. The immutable `stepProjectiles` costs **12× the SoA version**. An embind crossing costs at least **123 ns** per call. |
| Plan B | (1) Shared minimal capsule controller in `packages/sim` for client and server, (2) packed matches, (3) a Rust/Jolt **WASM** physics core used by client *and* server. Never a native addon. [ADR 0306](adr/0306-performance-migration-path.md) | Minimal controller: move phase **0.14 ms vs 0.27 ms** for 10 players |

**Bottom line.** On Node, the simulation isn't the bottleneck at 10 players. A full authoritative tick with 1 km terrain, 300 buildings, 10 character controllers, 200 bone hitboxes and 50 projectiles costs under 0.6 ms. What decides cost is **process memory** (Babylon barrel imports), **real-time scheduling on shared cores**, **transport I/O** (not measured here) and **egress bandwidth**.

---

## 1. Language and runtime for the authoritative match server

### 1.1 What the code base already implies

- `packages/shared` is pure TypeScript at a fixed 60 Hz: `computeDesiredVelocity`, `stepWeapon`, `stepProjectiles` with an injected `RaycastFn`, and `computeDamage`.
- The engine side of movement is `apps/client/src/player/CharacterBody.ts`. It wraps Babylon's `PhysicsCharacterController`, which is **a JavaScript solver in Babylon** (`Physics/v2/characterController.js`, 1,760 lines). It runs shape-proximity and shape-cast queries against Havok WASM through `plugin._hknp`, and `CharacterBody` adds its own step-up ray and ground-snap shape casts on top.
  - Prediction parity depends on the server running the **same JS solver and the same WASM binary** as the browser.
- Netcode ([ADR 0201](adr/0201-server-authoritative-shared-simulation.md)) makes the server run `CharacterBody.step` for every player. Hitboxes are analytic and procedural, not Havok bodies ([ADR 0206](adr/0206-procedural-capsule-hitboxes.md)).

### 1.2 Options compared

Criteria weights reflect the product requirement: cheap, stable ticks, and correctness of prediction.

| Criterion (weight) | (a) Node + TS + Havok WASM | (b) Bun + same code | (c) Rust sim (rapier/Jolt), port shared code | (d) Go sim | (e) Hybrid: native core (addon) + TS orchestration |
|---|---|---|---|---|---|
| Code sharing / prediction correctness (×3) | **Identical**: same TS, same Babylon CC, same WASM as the client | Identical source. JSC float results differ from V8 (**measured**: sim counters diverge after 36k ticks, §2.6), same as Safari clients | Two implementations of movement, weapons, ballistics and the CC. A different physics engine means different contact behaviour, so mispredictions are **structural** | Same as (c), and no mature Go physics engine | Native core ≠ browser WASM, so parity is lost unless the core *is* the WASM the client uses (see ADR 0306) |
| Iteration speed (×2) | One language and one test suite (vitest) | Same | Two code bases; every gameplay change is done twice | Same as (c) | Two build chains, N-API ABI |
| Raw performance (×1) | 0.38–0.57 ms per 10-player tick (**measured**) | **~13% faster** sim, 0.33 ms p50 (**measured**) | Likely 3–10× faster per query (no embind marshalling); irrelevant at 10 players | Similar to Rust, with GC | Fast queries; crossings via N-API are cheaper than embind |
| GC pauses (×2) | Scavenges ≈ 0.08 ms mean, 0.5–5 ms max; 1 major ≤ 1.3 ms in 10 min (**measured**) | JSC GC, no `gc` perf entries (not observable with our tools) | None | Go GC sub-ms | Depends |
| Memory per match (×2) | 25–33 MB (worker) to ~150 MB (bundled process est.); 3–4 MB packed (**measured**) | Similar RSS (**measured** 145–154 MB with TS) | ~10–30 MB | ~20–40 MB | Similar to (a) |
| Ops maturity (×2) | perf_hooks, `--cpu-prof`, `perf` maps, heap snapshots, worker_threads, OTel | Younger. Node API gaps (no `registerHooks`, no `gc` perf entries) | Excellent (perf, tokio-console) | Excellent (pprof) | Worst: crashes in native code take the process down |
| Hiring (×1) | TS/game-web devs are already on the team | Same | Rust game-server engineers are scarce | Go devs are common, game physics experience is scarce | Needs both |
| **Weighted score (1–5 scale)** | **4.4** | 4.0 | 2.6 | 2.2 | 2.9 |

**Recommendation: (a) Node.js 24 LTS + TypeScript**, with the migration path in §7.3 and [ADR 0306](adr/0306-performance-migration-path.md).

- **Why not Bun now?** It ran the direct benchmark unmodified and 13% faster, which is a real option. But:
  - the Node WebTransport ecosystem that Netcode needs (§7) targets Node;
  - Node has `perf_hooks` GC entries and `process.threadCpuUsage`;
  - Bun's Node-API coverage is still moving.

  Keep `tools/bench/runtime` and `packages/sim` runnable on Bun, and re-evaluate once transport is settled.
- **Why not Rust/Go?** The simulation costs < 4% of a tick. A port buys CPU we don't need, and pays for it with the thing we can't afford to lose: client/server movement parity.

### 1.3 Requirements the recommendation puts on the code base

1. **Bundle the server** (e.g. `rolldown`, already a root devDependency) to one ESM file:
   - Node's built-in type stripping can't run the client sources, because `HavokRaycaster.ts` uses TypeScript parameter properties (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). The benchmark needed `--experimental-transform-types`.
   - Type stripping also loads amaro/swc: about +40 MB RSS and +30 ms at startup (**measured**, `tsBaseline` vs bare node).
2. **Never import the `@babylonjs/core` barrel on the server.** `packages/shared/src/index.ts` re-exports `buildLevel`, so importing `@twobullets/shared` costs **680–840 ms and 85–97 MB heap** (**measured**). Importing only the pure modules costs **4–6 ms** (**measured**). This agrees with Netcode §1.4 #9 and Platform Q3.
3. Move `CharacterBody` into `packages/sim` (Netcode §1.4 #1) and import Babylon there via deep paths. The benchmark's `lib/babylonDeep.ts` lists the exact surface: 16 exports from 13 modules.

---

## 2. Benchmarks

Machine: **Apple M2 Pro** (`machdep.cpu.brand_string`), `hw.ncpu` = 10 (6 performance + 4 efficiency cores), `hw.memsize` = 17,179,869,184 (16 GB). macOS (Darwin 25.5), Node **v24.19.0** (V8 13.6.233.17), Bun 1.4.0.

> **Caveats.**
> - This is a developer laptop under **heavy memory pressure**: 9–12 GB of 12–13 GB swap was in use throughout.
> - Other engineers were running the game in Chrome, so the 1-minute load average ranged from 1.7 to 18.
> - macOS can't pin threads and schedules low-duty threads onto efficiency cores.
> - Back-to-back CPU costs (§2.1–2.5) are robust across repeats (p50 within ±3%).
> - Tails (p99.9, max) and real-time capacity (§2.7) are sensitive to background load. Both the noisy and the quiet runs are reported. **Re-run everything on the target Linux x86-64 host before committing capacity** (Appendix A.4).

### 2.1 Havok headless: full authoritative tick (the headline)

Scenario (`lib/scenario.ts`), identical in every mode:

- **Terrain:** 1×1 km rolling terrain, `PhysicsShapeHeightField` with 513×513 samples (1.95 m spacing, ±20 m relief).
- **Buildings:** 300 static blocks placed through `LevelBlock` in 4 towns plus scattered ones: houses, walls, 0.15–0.30 m steps, and 10% wedge ramps as convex hulls.
- **Players:** 10 players with scripted random inputs: walk/sprint/strafe/crouch, jumps, 30% firing.
- **Hitboxes:** 10 × **20 bone hitboxes** (spheres, boxes, capsules) as ANIMATED/kinematic trigger bodies, teleported every tick along a synthetic gait.
- **Projectiles:** a steady **50 projectiles** doing segment raycasts every tick (rifle, 620 m/s). 60% aim at a same-town player.
- **Weapons:** `stepWeapon` for every player.
- **Timing:** tick order is move → weapons → hitboxes → world step → projectiles. 600 warm-up ticks, then **36,000 measured ticks (10 min of match time)**, three separate processes per mode.

Modes:

- **`babylon`**: `NullEngine` + `Scene` + `HavokPlugin(false)`. The shared `buildLevel` builds the level, the **client's `CharacterBody`** moves the players, hitboxes are `TransformNode` + `PhysicsBody` with the TELEPORT prestep (like `TargetDummy`), bullets go through the **client's `HavokRaycaster`**, and the world advances with `scene._advancePhysicsEngineStep`.
- **`direct`**: no Babylon at all, only raw `HP_*` calls. A minimal capsule controller (`lib/directMatch.ts`: support cast, collide-and-slide ×4, the same step-up probe and ground snap as `CharacterBody`) feeds the same `computeDesiredVelocity`. Query arrays are reused.
- **`babylon-render`**: like `babylon`, but calls a full `scene.render()` each tick (a naive NullEngine render loop).

**Sanity checks** confirm the modes simulate the same game: in every run, 0 player-ticks below terrain, ~85% grounded, a mean speed of 5–6.8 m/s, and thousands of hitbox impacts. The Babylon and direct modes agree within a few percent over 600 ticks.

| Mode (runs) | Tick p50 | p99 | p99.9 | max | Ticks > 4 ms / 36k | Match-s per CPU-s |
|---|---|---|---|---|---|---|
| **direct** (3) | **0.379 / 0.381 / 0.392 ms** | 0.68 / 1.15 / 0.82 | 1.27 / 3.34 / 1.72 | 9.1 / 18.8 / 3.0 | 3 / 26 / 0 | 41 / 40 / 39 |
| **babylon** (3) | **0.574 / 0.584 / 0.575 ms** | 1.20 / 2.13 / 1.57 | 2.02 / 4.91 / 4.20 | 16.4 / 27.4 / 59.9 | 3 / 64 / 43 | 27 / 25 / 26 |
| babylon with deep imports (1 × 3.6k) | 0.644 | 1.83 | — | 4.9 | — | — |
| babylon-render (1 × 3.6k) | 0.694 | 1.69 | 3.81 | 4.3 | — | 19 |
| direct on **Bun** (2) | **0.332 / 0.331** | 0.85 / 0.89 | 1.38 / 1.36 | 25.4 / 3.8 | 1 / 0 | 45 / 45 |

Per-phase p50, in ms, for 10 players:

| Phase | direct | babylon | What it is |
|---|---|---|---|
| move | 0.142–0.149 | **0.269–0.274** | 10 × controller step. Babylon: `checkSupportToRef` + `integrate` + step-up ray + snap cast |
| weapons | 0.0013–0.0015 | 0.0017–0.0019 | 10 × `stepWeapon` |
| hitboxes | **0.109–0.112** | 0.015 | direct: 200 × `HP_Body_SetQTransform`. babylon: JS node writes only, since the Havok call happens in the prestep |
| worldStep | 0.049–0.052 | **0.188–0.190** | `HP_World_Step`. Babylon adds the prestep loop over all 510 bodies (200 teleports) |
| projectiles | 0.071–0.073 | 0.082–0.083 | `stepProjectiles` (50) + 50 world raycasts |

Variants:

| Variant | direct p50 / p99 | babylon p50 / p99 | Note |
|---|---|---|---|
| **No Havok hitboxes** (Netcode ADR 0206 model) | **0.207 / 0.85 ms** | **0.371 / 0.82 ms** | Babylon worldStep drops to 0.035 ms, so the prestep over 200 teleports cost 0.15 ms |
| 200 projectiles (heavy firefight) | 0.606 / 1.03 | 0.858 / 1.54 | Projectile phase 0.28–0.32 ms |
| 50 players, 250 projectiles | 2.02 / 6.08 | — | Linear scaling |
| 100 players, 500 projectiles | 4.20 / 8.05 | — | Still inside 16.67 ms. Would need packing limits (§4) |

**Memory, GC and startup:**

| | direct | babylon (barrel) | babylon (deep imports) |
|---|---|---|---|
| RSS after 10 min run | 142–155 MB (incl. ~40 MB TypeScript stripper) | 220–285 MB | 204 MB |
| V8 heap used | 12–14 MB | **148–153 MB** | 39–58 MB |
| Havok WASM heap | 16.9 MB, **no growth over 36k ticks** | 16.9 MB | 16.9 MB |
| Setup (process start → first tick) | **~60 ms** setup (Havok init 13–16, terrain 22–26, buildings 2–10, players 6–10) | **2.3–2.6 s** (barrel import 1.9 s) | **320 ms** (deep import 199 ms) |
| GC over 36k ticks | ~930 scavenges (max 1.7–5.0 ms on a loaded machine), 1 major ≤ 1.24 ms | 350 scavenges (max 0.9–3.1 ms), 0 major | — |

`--trace-gc` (direct, 4.2k ticks):

- 283 scavenges, 21.6 ms in total, max 0.50 ms, mean 0.08 ms;
- 1 Mark-Compact of 0.54 ms;
- about **0.36 MB allocated per tick**.

The allocations come mostly from embind tuple returns, BigInt body ids and the immutable projectile objects.

**Babylon wrapper overhead**:

- Tick p50: **+51%** (0.575 vs 0.381 ms). About 0.13 ms is the heavier CC solver, and about 0.14 ms is the prestep and teleport path for Havok hitbox bodies.
- If hitboxes follow ADR 0206 (not Havok bodies), the gap is **+0.16 ms per tick** (0.371 vs 0.207 ms), nearly all from the CC solver.
- Wrapper cost per query call is 8–15% (§2.2).

### 2.2 Per-call Havok query cost (`havok-queries.ts`)

Measured in the same benchmark world, as 20 batches × 20,000 calls (p50 per call).

| Call | Babylon `HavokPlugin` | Direct `HP_*` (reused arrays) |
|---|---|---|
| Segment raycast, 10 m (30% hit) | **1,622 ns** | **1,409 ns** |
| Capsule shape cast, 0.4 m down (ground snap) | 4,036 ns | 3,743 ns |
| Teleport one kinematic body | 1,153 ns (node + prestep) | 546 ns |
| Empty embind call (`HP_QueryCollector_GetNumHits`) | — | **123 ns** (floor per JS↔WASM crossing) |
| `HP_World_Step`, idle world | — | 2,764 ns |

- **Answers Netcode A4 and §5.5:** a Havok world ray costs **~1.5 µs**, not the assumed 5–20 µs.
  - 150 bullets in flight ≈ 0.23 ms per tick.
  - LOS relevance with 150 rays ≈ 0.23 ms.
- A `CharacterBody.step` costs **~27 µs per player** in Node.
- Each query makes **3–4 embind crossings** (query, count, result, plus tuple and BigInt marshalling). The WASM work itself is a small part, so batching queries in a custom WASM build is the lever at scale (ADR 0306).

### 2.3 Pure shared code (`shared-code.ts`)

Timings are p50 over 40 batches. "Heap" is bytes allocated per call, taken from GC-free batches.

| Case | Node 24 | Bun 1.4 | Per 10-player tick (Node) | Heap / call (Node) |
|---|---|---|---|---|
| `computeDesiredVelocity` | 130–138 ns / player | 104 ns | **0.0013 ms** | 30 B |
| `stepWeapon` (auto rifle, firing) | 38–42 ns / player | 67 ns | **0.0004 ms** | 61 B |
| `stepProjectiles`, 50 projectiles, no-hit ray | 3,030–3,340 ns / tick | 2,385 ns | 0.003 ms | **3.9 KB** |
| Same integration as SoA `Float64Array`s | **276–281 ns / tick** | 123 ns | 0.0003 ms | **0 B** |
| Synthetic 69-bone skeleton (2-clip blend, local→world) | 3,350–3,450 ns / player | 1,927 ns | **0.034 ms** | ~1.1 KB |
| Analytic lag-comp worst case: 50 rays × 10 players × 20 capsules | 157–160 µs / tick | 131 µs | 0.16 ms | ~6.8 KB |
| Hitbox history ring write (10×20×7 floats) | 130 ns / tick | 133 ns | 0.0001 ms | 0 B |
| `Math.hypot(x,y,z)` | **15.0 ns** | 12.7 ns | — | **~5–14 B** |
| `Math.sqrt(x*x+y*y+z*z)` | **1.1 ns** | 0.95 ns | — | 0 B |
| `Math.hypot(x,z)` | 10.0 ns | 12.8 ns | — | ~6–14 B |

Takeaways:

- The pure gameplay code is nearly free: **< 2 µs per tick** for movement and weapons across 10 players.
- `Math.hypot` is 9–13× slower than `sqrt` in V8 and allocates. It appears in every shared hot path: `computeDesiredVelocity` ×4, `approach`, `stepProjectiles`, `buildShot`.
- The immutable spread-copy style in `stepProjectiles` costs 11× the SoA version and generates most of the young-generation garbage.
- **Server-side skeletal animation is affordable if ever needed:** 0.034 ms per tick for 10 players. ADR 0206's procedural rig is still the better choice for rewind and parity.

### 2.4 Serialization (`serialization.ts`)

Workload: a realistic 10-player snapshot with zone state and 0–6 events. The delta is taken against the snapshot 3 ticks back.

| Format | Bytes (mean) | Encode | Decode | Per send to 10 clients |
|---|---|---|---|---|
| `JSON.stringify` + UTF-8 | **3,365** | 11.5–12.8 µs | 7.8–8.3 µs (`JSON.parse`) | 0.12–0.13 ms |
| DataView float32 | 495 | **97–102 ns** | 222–269 ns | 0.001 ms |
| DataView quantized (1/64 m, cm/s, 16-bit angles) | 317 | 293–312 ns | 227–251 ns | 0.003 ms |
| Quantized + per-player field mask delta | **188** | 886–979 ns | 535–793 ns | **0.009 ms** |

- The byte-aligned DataView formats are 30–110× faster than JSON and 7–18× smaller.
- Netcode's bit-packed format (~105 B, [ADR 0204](adr/0204-bitpacked-delta-snapshot-protocol.md)) is smaller still at about 2 µs per client. **Both are negligible against the tick budget; pick on bytes, not CPU.**
- **Hidden-class trap (measured):** building snapshots with `structuredClone` instead of object literals made the float32 encoder **10× slower** (1,082 → 102 ns), because property access went polymorphic. Build wire records with one literal shape per type, or better, from SoA state.

### 2.5 Startup and imports (`startup.ts`, fresh process per case, 3 runs)

| Case | Time | RSS after | Heap used |
|---|---|---|---|
| Bare `node -e` | 36–41 ms wall | **43.7 MB** | 3.8 MB |
| Node + TS-stripped probe (nothing imported) | 70–73 ms wall | 83 MB | 9 MB |
| + Havok WASM instantiate | **12–15 ms** | 92–93 MB | 10.8 MB |
| + `import("@babylonjs/core")` barrel | **695–1,365 ms** | 204–234 MB | **86 MB** |
| + deep imports (NullEngine, Scene, HavokPlugin, physics v2, CC, Mesh) | **69–70 ms** | 104–105 MB | 19 MB |
| + `packages/shared/src/index.ts` | 680–837 ms | 221–242 MB | 85–97 MB |
| + shared movement/weapons modules only | 4–6 ms | 86–88 MB | 9.5–9.9 MB |
| Direct match fully built (Havok + terrain + 300 buildings + players) | **60–65 ms** | 111–113 MB | 12 MB |
| Babylon match fully built (barrel) | 1,193–1,792 ms | 336–382 MB | 149 MB |

Estimates for a bundled production process (no TS stripper, ~44 MB node base):

- Direct/sim-only: **~70–80 MB RSS**.
- Babylon deep imports: **~110–150 MB RSS**.
- Boot to ready: **< 400 ms**.

The ≤ 150 MB and ≤ 3 s targets (Platform A2) hold only if the barrel import is removed.

### 2.6 Determinism observation (for Netcode §1.2 and Platform Q5)

The `sanity` counters (hitbox impacts, world impacts, expiries, grounded ticks) over 36,000 ticks:

- **identical across 3 separate Node processes** in each mode;
- **identical across 2 Bun processes**;
- **different between Node (V8) and Bun (JavaScriptCore)**: e.g. 17,071 vs 17,492 hitbox impacts.

So the same build on the same engine is reproducible in practice, and cross-engine float differences grow chaotically. This supports Netcode's choice of tolerance-based reconciliation plus keyframed replays. It doesn't prove bitwise determinism across CPU architectures (not tested).

### 2.7 Worker threads and real-time capacity (`capacity.ts`, `memory-per-match.ts`)

Setup:

- W worker threads × M direct matches per worker, each ticking at 60 Hz with the hybrid scheduler (2 ms spin).
- One timestamped input message per match per tick from the parent, and one 200-byte snapshot message back per worker tick.
- Workers load a stripped-JS build, so no TS stripper is inside the measured memory.
- Havok is compiled once and shared by `WebAssembly.Module`; each worker has one Havok instance.

**Memory:**

| Configuration | Measured |
|---|---|
| Idle worker thread (no Havok) | **+15.8 MB RSS** |
| Worker with 1 match (own Havok instance, 16.9 MB WASM heap) | **+25 to +33 MB RSS** |
| Extra match in the same isolate + Havok instance, own static shapes | +2.3 MB WASM, **+3.7 MB RSS**, ~0 JS heap |
| Extra match with **static shapes shared across worlds** (terrain + buildings created once per Havok instance, bodies per world) | **+0.2 MB WASM**, 3–4 MB RSS per match in capacity runs (players, bodies, broadphase) |
| Extra Babylon match in the same isolate (Scene + 300 meshes + CC) | **+8 MB heap** (barrel or deep) |
| WASM heap growth when packing | 16.9 → 29 (10 worlds) → 61 (20) → 88 (30) → 105 MB (40), own shapes; **never shrinks** |

Shared static shapes were verified: 3 worlds sharing one heightfield and 300 building shapes simulated 1,200 ticks each with 0 below-terrain ticks.

**Real-time CPU**, work = time to tick all M matches once, 20 s at 60 Hz (1,200 ticks), in ms:

| Run (load avg) | Work p50 | Work p99 | Overruns / 1,200 | Thread CPU | Per match p50 |
|---|---|---|---|---|---|
| W1 × M1 (1.7) | 1.66 | 4.28 | 0 | 14% | 1.66 ms ← low duty cycle, cold core |
| W1 × M10 (1.7) | 5.11 | 8.40 | 4 | 33% | 0.51 |
| W1 × M15 (1.8) | 6.28 | 10.58 | 1 | 41% | 0.42 |
| W1 × M20 (2.0) | 7.86 | **9.70** | 4 | 50% | **0.39** |
| W1 × M25 (2.4) | 9.85 | 12.16 | 5 | 62% | 0.39 |
| W1 × M30 (2.0) | 12.06 | 13.97 | 9 | 75% | 0.40 |
| **W6 × M15 = 90 matches** (4.4) | 6.5–7.3 | **11.5–12.3** | 7–11 per worker | 43–48% | 0.43–0.49 |
| W3 × M12 (1.7) | 5.2–5.6 | 6.6 | 4 | 34–36% | 0.45 |
| *Earlier session, busy host:* W1 × M20, own shapes | 10.8 | 17.8 | 30 | 68% | 0.54 |
| *Earlier session, busy host:* W1 × M30, own shapes | 15.8 | 28.2 | 577 | 94% | 0.53 |
| *Earlier session, busy host:* W4 × M10, own shapes | 6.7–7.0 | 29 | 60–67 | 43–45% | 0.67 |
| *Earlier session, busy host:* W1 × M40 **at 30 Hz** | 21.6 | 39.6 (budget 33.3) | 28 / 600 | 68% | 0.54 |

The "earlier session" runs predate load-average recording; the host was swapping and running the client in Chrome. At load average 10–18, runs identical to the quiet ones measured much worse: W1 × M15 work p99 **96.7 ms**, W1 × M20 p99 48.5 ms, W3 × M12 p99 45–51 ms, with 25–35% of ticks overrunning. Those files were later overwritten by the quiet re-runs, so the numbers are quoted from the run log.

**Messaging** (parent ↔ worker `postMessage`):

- quiet: input p50 **0.02–0.06 ms**, p99 2–5 ms; snapshot to parent p50 0.03–0.09 ms, p99 0.07–0.3 ms;
- noisy: p99 of seconds when the worker was overloaded, because messages queue behind the tick.

Findings:

1. **A tick is much cheaper when the core stays busy.** A single match on its own took 1.66 ms per tick, vs 0.39–0.45 ms when 15–30 matches shared the thread. Causes: cache/branch-predictor cooling, frequency scaling, macOS efficiency-core scheduling of low-duty threads.
   - On Linux the same effect comes from cpufreq governors and C-states.
   - **Process-per-match makes every process a low-duty thread.** Use the `performance` governor, limit deep C-states on game hosts, and prefer packing when possible.
2. **Sim-only capacity is ~20–25 matches per M2 P-core at 60 Hz** at p99 ≤ 12 ms with a quiet host. A noisy neighbour cuts that roughly in half and causes second-long tails. This is why §3 insists on cpusets and no oversubscription.
3. At 60 Hz the parent → worker message path adds < 0.1 ms p50, so moving I/O off the sim thread is cheap as long as the receiving thread isn't overloaded.

### 2.8 Timer precision (`scheduler.ts`, 60 Hz, 1 ms synthetic work, 480 ticks each)

| Strategy | Lateness p50 | p99 | max | Drift after 8 s | Thread CPU |
|---|---|---|---|---|---|
| `setInterval(16.67)` | 208 ms | 426 ms | 430 ms | **430 ms** | 6.4% |
| `setTimeout(16.67)` re-armed | 461 ms | 909 ms | 914 ms | **914 ms** | 6.2% |
| Drift-free `setTimeout` to absolute deadline | 1.17 ms | 8.35 ms | 58.7 ms | 1.2 ms | 6.3% |
| Hybrid, 1 ms spin | 0.39 ms | 1.35 ms | 2.1 ms | 0.07 ms | 7.5% |
| **Hybrid, 2 ms spin** | **0.011 ms** | **0.38 ms** | 10.7 ms | 0.01 ms | 8.4% |
| Hybrid, 4 ms spin | 0.011 ms | 0.33 ms | 7.3 ms | 0.01 ms | 10.9% |
| Pure `setImmediate` spin | 0.010 ms | 0.12 ms | 1.2 ms | 0.01 ms | 23.7% |

Spinning costs about 1% of a core per spin-millisecond per tick at 60 Hz (6% of wall time for a 1 ms window). libuv timers have millisecond resolution ([libuv timers](https://docs.libuv.org/en/v1.x/timer.html)), and Linux adds timer slack, 50 µs by default ([prctl `PR_SET_TIMERSLACK`](https://man7.org/linux/man-pages/man2/prctl.2.html)). Expect Linux lateness around 1 ms p50 without a spin window: better than macOS, but not tight.

---

## 3. Process and threading model

### 3.1 Options

| Model | Isolation | Memory per match | Boot per match | Scheduling | Fit |
|---|---|---|---|---|---|
| **A. One OS process per match** (Platform A1) | Best: crash, leak or WASM heap growth dies with the match; `taskset`/cgroups per process | ~110–150 MB (bundled, Babylon deep, est.) | ~0.3–0.4 s (est. from §2.5) | Each process is a low-duty 60 Hz thread; many timers per core | **Default for M3–M5** |
| B. One worker thread per match inside a host process | Crash kills the host; per-thread heaps | 25–33 MB (**measured**) | ~50–100 ms | Same low-duty issue | Rarely worth it: loses A's isolation, gains less than C |
| **C. K matches per worker, W workers per host process** (a sim worker per core) | A worker crash or major GC hits K matches | **3–4 MB per match** + ~50 MB per worker (**measured**) | ~60 ms per match | Busy cores tick cheaply (§2.7); one scheduler per worker | **Scale-out / burst mode** |
| D. Several matches on the main event loop | Worst: I/O and GC shared with sim | Lowest | Lowest | I/O jitter lands on every tick | Dev/local mode only |

### 3.2 Decision ([ADR 0303](adr/0303-process-per-match-with-packable-match-host.md))

1. **Build `apps/server-match` around a `MatchHost` interface:** `createMatch(config) → Match`, a scheduler that ticks N matches, and per-match transport bindings. Then A and C are deployment flags, not rewrites:
   - `--mode=single-match` → model A: one process, one match, sim on the main thread, transport on the same loop at first.
   - `--mode=packed --workers=W --matches-per-worker=K` → model C: one Havok instance per worker, static shapes shared within the worker, transport terminated in the main thread or a sidecar and forwarded over `postMessage` or a SharedArrayBuffer ring.
2. **Start with A** on owned hosts, as Platform assumes. At ≤ 150 MB per process, a 32 GB host fits 150+ matches, so memory is not binding and the CPU limit (§4) comes first. Burst providers pay per container: use A with ≥ 0.5 vCPU, or C when they bill by memory or boot time.
3. **Switch owned hosts to C** when any of these holds:
   - hosts exceed ~60 matches;
   - p99 tick lateness of low-duty processes becomes a problem (§2.7 finding 1);
   - warm-pool memory starts to cost money.
4. **Recycle long-lived hosts.** The WASM heap never shrinks: drain a packed worker after N matches (e.g. 200) or when its heap exceeds 256 MB.

### 3.3 CPU pinning and host tuning (Linux)

- **Pin with cpusets** (`taskset -c`, cgroup v2 `cpuset.cpus`), grouping processes per physical core. On SMT hosts, give match processes both sibling threads of a core rather than half-loading many cores. Keep 1 core (both threads) for the host agent, kernel networking and IRQs.
- **No CFS CPU quotas for match processes.** With `cpu.max` = 25 ms / 100 ms (a "0.25 vCPU" container), a GC or JIT burst that spends the quota early stalls the process for up to 75 ms, i.e. 4 lost ticks. See the cgroup v2 `cpu.max` semantics ([kernel docs](https://docs.kernel.org/admin-guide/cgroup-v2.html#cpu-interface-files)).
  - Measured steady-state CPU per match is well under 25% of a core (sim ~2.5%, §2.1), so average quota isn't the problem; **bursts are**.
  - **Answer to Platform Q11:** request ≥ 0.5 vCPU or a pinned cpuset on fractional-vCPU providers, and alert on `nr_throttled`.
- `cpufreq` governor `performance`, and limit deep C-states (`intel_idle.max_cstate` / `processor.max_cstate` or the BIOS power profile) on game hosts. Low-duty 60 Hz threads suffer most from wake-up latency and cold cores (§2.7).
- Raise UDP buffers (`net.core.rmem_max`/`wmem_max`), as Platform already plans. Spread NIC IRQs away from sim cores.
- Node flags, to be evaluated with the CI benchmark before adopting:
  - `--max-semi-space-size=32` (fewer scavenges at ~0.36 MB/tick allocation);
  - no `--max-old-space-size` below 512 MB;
  - `--perf-basic-prof-only-functions` on canaries for `perf` flamegraphs.

### 3.4 Tick scheduling ([ADR 0304](adr/0304-drift-free-hybrid-tick-scheduler.md))

```ts
// Sketch (see tools/bench/runtime/lib/matchWorker.ts for the measured implementation)
const period = 1000 / 60;
let tick = 0;
const t0 = now();
for (;;) {
  const due = t0 + tick * period;
  while (now() < due) {                          // absolute deadlines: no drift
    const remaining = due - now();
    if (remaining > spinMs) await sleep(remaining - spinMs);   // coarse sleep
    else await setImmediate();                   // short spin; lets I/O callbacks in
  }
  drainInputs();                                 // non-blocking; bounded per client
  for (const m of matches) m.tick(tick);         // sim + hitreg + snapshot build/encode
  flushSends();                                  // hand datagrams to the transport
  metrics.record(now() - due, now() - start);    // lateness, work, overrun
  tick++;
  // Behind schedule? Run the next tick immediately (catch-up). Tick numbers are never
  // skipped (Netcode A2). After > 250 ms behind (VM stall), signal a hitch so netcode
  // re-syncs clocks.
}
```

- `spinMs` = **1 ms** in single-match processes (lower CPU waste across many processes) and **2 ms** in packed workers (the core is busy anyway).
- Timestamps come from `performance.now()`. The monotonic clock is shared across workers through `performance.timeOrigin`.
- The sim loop must never `await` I/O. `await setImmediate()` is the only yield inside the spin window.

### 3.5 Keeping I/O off the simulation thread, and backpressure

- **Receive:** transport callbacks decode input datagrams into a **per-client bounded ring** (16 inputs, preallocated) and never touch sim state. The tick drains at most 1 input per client, plus Netcode's catch-up bucket.
  - Oldest inputs drop on overflow, and a counter is exported.
  - With a sidecar or transport worker, the ring is a SharedArrayBuffer per match (`Atomics` counters, no locks on the hot path).
- **Send:** encode into a preallocated `Uint8Array` per client and hand it to the transport. **Per-client backpressure:** if the transport's queued bytes for a client exceed ~2 snapshots (WebTransport datagram writer `desiredSize`, WS `bufferedAmount`):
  - skip that client's snapshot this tick; the next delta uses the last acked baseline, so nothing is lost;
  - if skips persist, step that client down to 30/20 Hz (Netcode §2.3 adaptive rates).
  - Never block the tick on a slow client.
- **Logs, metrics and telemetry:** write to a ring and flush from a timer outside the tick, or from a worker. No synchronous `console.log` on the sim thread; stdout to a pipe can block.
- **Control plane (agent IPC, Platform A8):** handled on the same event loop between ticks. It is low rate and must never be awaited inside a tick.
- Results and replays (≈ 1–3.5 MB) are uploaded after the match ends, from the agent or a worker.

---

## 4. Tick budget and capacity plan

### 4.1 Frame budget at 60 Hz (10 players, per match)

"Measured" means this document's benchmarks. "Netcode" means netcode.md §5.5 and §2.4 on the same machine class.

| Stage | p50 | p99 (planning) | Source |
|---|---|---|---|
| Network ingest: decode ≤ 10 input datagrams | 0.02 ms | 0.05 | Netcode decode ~2.3 µs each |
| Input apply + movement: 10 × `CharacterBody.step` | **0.24–0.27** | 0.7 | Measured (babylon, no Havok hitboxes → with) |
| Physics world step (static world + 10 CC bodies) | **0.035** | 0.1 | Measured (babylon, no hitboxes) |
| Weapons: 10 × `stepWeapon` | 0.002 | 0.01 | Measured |
| Projectiles: step + world rays, 50 → 150 in flight | **0.08 → 0.25** | 0.5 | Measured (50, 200) |
| Lag-comp history write + rewound analytic hit tests | 0.13 | 0.3 | Netcode (150 bullets); my worst case 0.16 |
| Relevance LOS (≤ 150 Havok rays) | 0.23 | 0.4 | Est. 150 × 1.5 µs (measured ray) |
| Snapshot build + delta + encode × 10 clients | 0.01–0.12 | 0.2 | Measured / Netcode |
| Send: 10 datagrams handed to the transport | **0.2–0.4 (unmeasured)** | 1.0 | **Est.**, allowing ~20–40 µs per datagram for a Node QUIC binding incl. AEAD; to be measured in the M3 soak (Netcode N1) |
| GC (amortized) | 0.005 | 0.5 (scavenge landing in a tick) | Measured |
| **Total per match** | **≈ 1.0–1.4 ms** | **≈ 3–4 ms** | Leaves > 75% of the 16.67 ms budget even on a slower vCPU |

At **30 Hz** each tick costs about the same, except the projectile segments double in length (ray cost is broadphase-bound, roughly the same). CPU per match-second roughly halves. Netcode chose 60 Hz and the budget allows it, so **no runtime reason to drop to 30 Hz**.

### 4.2 CPU per match and matches per core

- **M2 Pro P-core, real time, 60 Hz:**
  - sim only: ~0.4–0.55 ms per match-tick packed, ~1.7 ms if isolated on a cold core (§2.7);
  - with the netcode and transport estimates from §4.1 added: **≈ 1.2–1.8 ms per match-tick**, i.e. 7–11% of a core.
- **Conversion to cloud vCPUs (assumption, to verify on target hardware):** one SMT thread of a current EPYC (Zen 4), or one Graviton3 vCPU, delivers ~0.6–0.8× the single-thread throughput of an M2 Pro P-core. Use 0.6 for planning.
- **Per match: ≈ 0.12–0.18 vCPU** at 60 Hz, plus headroom for p99.
- **Planning values for Platform §4.6:**
  - **c = 0.15 vCPU per match (low)** / **0.25 (high)**. The high value covers the unmeasured transport cost and low-duty penalties in process-per-match mode.
  - Matches per vCPU at a 70% utilisation ceiling: **≈ 4.5 (low) / 2.8 (high)**.
  - An OVH Advance-1 (6c/12t; 11 threads for matches × 0.7) fits **≈ 50 / 30 matches**. Platform's current "30 matches" is the high case.

### 4.3 Memory per match

| Deployment | Per match | Host of 30 matches |
|---|---|---|
| A: process per match, bundled, Babylon deep imports (est. from measured 104 MB deep import + 12 MB match + TS-stripper removed) | **110–150 MB** | 3.3–4.5 GB |
| A: process per match, **barrel import** (measured) | 336–382 MB | 10–11.5 GB ← avoid |
| C: packed, direct/minimal controller, shared shapes (measured) | 3–4 MB + ~50 MB per worker | ~0.4 GB |
| C: packed, Babylon Scene per match (measured +8 MB heap) | ~12 MB + ~100 MB per worker (deep) | ~1 GB |
| Warm idle process (Platform §4.5) | Same as A: Havok + level loaded, no players; ~0 CPU with a 1 Hz idle tick | — |

### 4.4 Cost per 1,000 concurrent players

**Assumptions:**

- 1,000 concurrent in-match players = **100 full 10-player matches**. Conservative: Platform's model of 6 average live players gives 133 smaller matches, and CPU scales mostly with live players.
- 60 Hz sim and snapshots.
- Compute: c = 0.15–0.25 vCPU per match → 15–25 vCPU, **+30% headroom → 20–33 vCPU**.
- Egress: Netcode's measured **~85 kbps down per player** at 60 Hz, so 1,000 players ≈ 85 Mbps ≈ **38 GB per hour** at a sustained peak.
- Prices checked 2026-09-14; list prices, excluding tax.

| Provider / instance | Price | Instances for 20–33 vCPU | Compute per hour at 1,000 CCU | Egress per hour at 1,000 CCU | Sources |
|---|---|---|---|---|---|
| AWS `c7g.xlarge` (Graviton3, 4 vCPU, 8 GB), on-demand | $0.145/h (1-yr RI $0.096, spot $0.072) | 5–9 | **$0.73–1.31** | 38 GB × $0.09 = **$3.42** | [Vantage c7g.xlarge](https://instances.vantage.sh/aws/ec2/c7g.xlarge), [AWS egress tiers](https://egresscost.com/aws/data-transfer-pricing/) |
| Hetzner `CCX33` (8 dedicated vCPU, 32 GB), EU | €138.49/mo (€0.2219/h) | 3–5 | **€0.67–1.11** | Included: 20 TB/mo per server in DE/FI, roughly 1,000 CCU for 730 h ≈ 27 TB | [costgoat Hetzner (Sep 2026)](https://costgoat.com/pricing/hetzner), [2026 increases](https://northflank.com/blog/hetzner-cloud-server-price-increases) |
| OVH Advance-1 SG (6c/12t) (Platform's baseline) | US$136/mo | 3 at c=0.25 (N+1 = 4) | **$0.56–0.75** | Unmetered | platform.md §4.2 |

**Monthly equivalents (730 h at a constant 1,000 CCU)**, compute only:

| Provider | Compute per month |
|---|---|
| AWS on-demand | $530–960 |
| AWS 1-year reserved | $350–630 |
| Hetzner | €415–690 |
| OVH | $408–544 |

**Metered egress on AWS adds ≈ $2,500/month at a sustained 1,000 CCU.** That's 3–4× the compute bill, and it confirms Platform's choice of unmetered bare metal. Real CCU follows a daily curve (Platform: average ≈ 0.55 × peak), so scale both columns by the average.

Per player-hour, compute costs **$0.0006–0.0013**. Bandwidth on metered clouds costs **$0.0034**.

---

## 5. Performance engineering practices ([ADR 0305](adr/0305-performance-budgets-and-ci-gates.md))

### 5.1 Hot-loop rules (with the measured reason)

| Rule | Why (measured) |
|---|---|
| **No `Math.hypot` in shared hot paths.** Add `len2(x,z)` and `len3(x,y,z)` helpers using `Math.sqrt` in `packages/shared/src/math.ts` | 15 ns + allocation vs 1.1 ns (§2.3). Floats still match across client and server because both use the helper (`sqrt` is correctly rounded by IEEE-754, unlike `hypot`) |
| **Entity state as SoA typed arrays** for projectiles, hitbox history and per-player sim scalars; keep plain-object state at the API boundary for tests | `stepProjectiles`: 3.3 µs + 3.9 KB per tick immutable vs 0.28 µs + 0 B SoA |
| **Object pools / preallocated scratch** (`Vector3` temps, query arrays, result structs) | `CharacterBody` already does this. The direct harness reuses HP query arrays: raycast 1,409 vs 1,622 ns |
| **Stable hidden classes:** construct each record type in one place with all fields; no `delete`, no `structuredClone`-built hot objects | 10× encoder slowdown from polymorphic property access (§2.4) |
| **Avoid megamorphic call sites** in per-entity loops: no `RaycastFn` closure per call site when it can be a method on a monomorphic class; no `switch` over many object shapes | Guidance, not measured here; see [V8 shapes & inline caches](https://mathiasbynens.be/notes/shapes-ics) |
| **Minimise JS↔WASM crossings:** one query plus one result read; read results from `HEAPF32` views where the API allows; never create BigInt ids per query (cache `[BigInt]` tuples) | 123 ns floor per crossing; Babylon's `raycast` allocates a BigInt and 3–5 arrays per call |
| **Precreate stance shapes** (stand/crouch capsules) and swap them. Don't let `setShapeOptions` allocate a new `PhysicsShapeCapsule` per stance change | `PhysicsCharacterController.setShapeOptions` creates and disposes a WASM shape each call (read in `characterController.js:259–280`) |
| **Don't make hitboxes Havok bodies on the server** (ADR 0206 agrees) | 200 teleports + prestep = 0.11–0.15 ms of a 0.38–0.57 ms tick |
| **Share read-only Havok shapes** across worlds in packed mode | 2.3 → 0.2 MB WASM per match |
| **No work in `scene.render()`** on servers; call the physics step directly | +0.08 ms per tick and needs a camera (§2.1) |

### 5.2 Havok WASM memory

- Instance baseline: **16.9 MB**. Each world with its own 513² heightfield and 300 buildings adds ~2.3 MB; with shared shapes, ~0.2 MB.
- **Linear memory grows but never shrinks.** It has a 4 GB ceiling with wasm32 (see [WebAssembly memory](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/grow)).
  - Process-per-match: a non-issue.
  - Packed workers: recycle by match count or heap size (§3.2 item 4).
  - Export `havok_heap_bytes` as a metric.
- `HP_*` shape creation `_malloc`s scratch buffers (the heightfield copy, hull vertices) and frees them. Fragmentation is possible over hundreds of matches per worker, which is another reason to recycle.

### 5.3 Profiling workflow

1. **Local, deterministic:** `node --cpu-prof --cpu-prof-dir=prof tools/bench/runtime/havok-tick.ts --mode=babylon` → open the `.cpuprofile` in Chrome DevTools or [speedscope](https://www.speedscope.app/). WASM frames show as `wasm-function[N]`. ([Node `--cpu-prof`](https://nodejs.org/api/cli.html#--cpu-prof))
2. **Allocation:**
   - `--heap-prof`, or DevTools allocation sampling;
   - `--trace-gc` and `perf_hooks` `gc` entries for pause distributions (`lib/stats.ts GcTracker`);
   - `--trace-deopt` / `--trace-opt` for deopt loops in shared code.
3. **Linux host:** `perf record -g` with `node --perf-basic-prof-only-functions` → Brendan Gregg flamegraphs ([Node on perf](https://nodejs.org/en/learn/diagnostics/poor-performance/using-linux-perf)); `clinic flame` / `clinic doctor` ([clinicjs](https://clinicjs.org/)) or [0x](https://github.com/davidmarkclements/0x) for quick flamegraphs.
4. **In production:** per match, export histograms of tick work, tick lateness, GC pause, inputs dropped, snapshots skipped, `havok_heap_bytes`, and `nr_throttled` from cgroup stats. Platform's OTel pipeline carries them, and the tick p99 SLO is computed from lateness + work.

### 5.4 Load-test harness

- **Level 1, in-process capacity (exists):** `tools/bench/runtime/capacity.ts` ticks W×M matches with scripted inputs (`lib/scenario.ts InputScript`) in real time. Extend it with the real `MatchHost` once `apps/server-match` exists.
- **Level 2, headless network bots:** `apps/bot` (Netcode §12.1) runs K bot clients per process, using the same `PlayerSim` + transport and scripted or behaviour-tree inputs. One bot process can drive ~100 clients (a bot's sim costs ~30 µs per tick, §2.3). The server exports its metrics and the harness asserts SLOs:
  - tick work p99 < 4 ms;
  - lateness p99 < 2 ms;
  - 0 overruns per minute per match;
  - snapshot skip rate < 1%.
- **Level 3, soak:** 1,000 simulated CCU across 2 hosts for 2 h (Platform Phase 2 exit criterion). This includes WebTransport session churn and a drain deploy.
- Bots for matchmaking fill (Netcode N8): **in-process `PlayerSim` bots**. They cost the same sim CPU as a player (~27 µs per tick for the CC) with no network, so count a bot as a player in the capacity plan.

### 5.5 Performance regression gates in CI

| Gate | How | Threshold |
|---|---|---|
| Tick cost | `havok-tick.ts --mode=babylon --ticks=3600` and `--mode=direct` on a **dedicated self-hosted runner** (shared CI runners are too noisy, see §2.7) | p50 regression > 10% vs the `main` baseline fails; p99 > 25% warns |
| Allocation | Heap bytes per tick (GC-free batches, `shared-code.ts`) | Any hot-path case moving from 0 B to > 0 B fails |
| Determinism | `sanity` counters for fixed seeds must equal the golden file (same Node version) | Exact match |
| Startup / memory | `startup.ts` probe of the bundled server | Ready > 500 ms or RSS > 160 MB fails |
| Bundle | Server bundle must not contain `@babylonjs/core/index.js` (barrel) | Fail |
| Micro | `serialization.ts`, `havok-queries.ts` | Report only, charted over time |

Store the JSON artifacts (they already include machine info and load average) to plot trends. Also run the gates weekly on the production instance type.

---

## 6. Server-side assets

### 6.1 What the server loads

| Asset | Format | Size | Used for |
|---|---|---|---|
| Level manifest (content hash, version) | JSON | < 1 KB | Protocol `contentHash` (Netcode §6.8) |
| Level blocks (`LevelData`: boxes, ramps, spawns) | JSON/TS module | ~50–100 KB for 300–3,000 blocks | Havok static shapes; spawn logic |
| **Terrain heightfield** | Raw `Float32Array` 513×513 (little-endian, row = X, col = Z, see `lib/scenario.ts` note on Havok's axis order) or 16-bit quantized + scale | **1.05 MB** (0.53 MB quantized) | `HP_Shape_CreateHeightField`; JS-side `heightAt(x,z)` for relevance, bots and zone |
| Props/buildings collision | Convex hulls / boxes (not render meshes) | ~10–200 KB | Static shapes |
| Hitbox rig table (ADR 0206: fitted joint offsets + `SOLDIER_HITBOXES` sizes per stance) | JSON | ~2–5 KB | Analytic hit tests |
| Weapon/item/loot/zone tables | TS modules in `packages/shared` | small | Already in code |
| *(Only if bone-driven hitboxes return)* skeleton bind pose + clip channels for the 69 `mixamorig` bones | Extracted from the GLB at build time into a compact binary (no meshes, textures or skin weights) | ~0.5–1 MB | 0.034 ms per tick for 10 players (§2.3) |

**Never on the server:** textures, render meshes, KTX2, audio, `AssetLibrary` (not even headless). The asset pipeline should emit a `server/` folder (collision + heightfield + rig) with its own manifest hash.

### 6.2 Startup path

1. Process start: bundled JS (~44 MB node base), 40–70 ms.
2. `WebAssembly.compile` of Havok. It's cached in the image's code cache, or compiled once per host process and passed to workers as a `WebAssembly.Module`: **5 ms compile + 12–16 ms instantiate** (measured).
3. Load the level assets (mmap/read files, verify hash): < 10 ms.
4. Create shapes: heightfield ~22–26 ms, 300 buildings 2–10 ms (measured). In packed mode this happens once per worker.
5. The process reports `ready` to the agent and becomes a warm pool entry: **~0.15–0.4 s total**.
6. On `allocate`: create the world bodies for this match (6–10 ms), bind ports, start ticking.

### 6.3 Sharing a read-only level between matches

- **Havok side (packed mode):** share shape handles across worlds in one Havok instance. Measured to work, and saves 2.1 MB per match. Havok copies height samples into its own heap, so a SharedArrayBuffer **can't** feed Havok zero-copy.
- **JS side:** load the heightfield once per host into a **`SharedArrayBuffer`** and give every worker a `Float32Array` view for `heightAt`, relevance LOS pre-checks (the "open air" skip in Netcode §5.5), bot navigation and zone logic. That's 1 MB per host instead of 1 MB per worker.
- **Process-per-match:** use the OS page cache (read-only file mmap isn't directly available in Node; plain reads of a 1 MB file are cheap). Memory duplication is ~1–2 MB per process, which isn't worth optimising.

---

## 7. Risks and fallbacks

| Risk | Likelihood | Impact | Evidence | Mitigation / plan B |
|---|---|---|---|---|
| Babylon `PhysicsCharacterController` too costly at scale, or hidden state breaks replay (Netcode §1.2) | Low (cost) / Medium (state) | Medium | 27 µs per player per tick (**measured**); private `_manifold` etc. | `resetForReplay()` (Netcode). Plan B: a **shared minimal capsule controller** in `packages/sim`, used by client *and* server, built on raw `HP_*` shape casts (prototype `lib/directMatch.ts CapsuleController`: 14 µs per player, no Scene required). It needs a feel-parity pass on stairs and ramps. |
| Havok CC non-determinism across engines | Medium | Low | Node ≠ Bun counters after 36k ticks; identical within an engine (**measured**) | Tolerance-based reconciliation (Netcode); telemetry per browser |
| `@babylonjs/core` barrel import sneaks into the server | High without a gate | Medium (2 s boot, +150 MB per process) | §2.5 | Bundle gate (§5.5); split `packages/shared` |
| **Real-time tails from noisy neighbours / low-duty cores** | High on shared or burst hosts | High (rubber-banding) | p99 work 9.7 → 17.8 ms for the same 20 matches under host load (**measured**) | cpusets, no CFS quota, performance governor, ≥ 0.5 vCPU on fractional providers, overrun alerts, per-host admission control (stop allocating when host tick-lateness p99 > 2 ms) |
| GC spikes | Low | Medium | Scavenge max 0.5–5 ms, major ≤ 1.3 ms per 10 min (**measured**) | Allocation-free hot paths (§5.1); `--max-semi-space-size` tuning; never trigger a full GC manually |
| WASM heap growth / 4 GB limit | Low | Medium (packed only) | 105 MB for 40 worlds (**measured**) | Shared shapes; worker recycling; heap metric |
| embind marshalling limits scale (e.g. 100-player modes, 600 bullets) | Low for 10p | Medium | 4.2 ms per tick at 100 players (**measured**); 123 ns per crossing | Batch queries via SAB views; long term, a **Rust/Jolt (or Rapier) WASM physics core with a flat-memory batch API, used by client and server** (keeps parity; [JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js/releases) has `CharacterVirtual`; [Rapier KCC](https://rapier.rs/docs/user_guides/rust/character_controller/)) |
| Node WebTransport server immaturity (Netcode N1) | Medium | High | Not measured here | Transport behind an interface; transport in a worker or a **Rust QUIC sidecar** feeding SAB rings (§3.5), which is the first native component we'd add |
| Transport CPU larger than estimated | Medium | Medium | §4.1 marks it unmeasured | Measure in the M3 soak; the high planning value c = 0.25 vCPU absorbs 2–3× the estimate |
| Havok for Babylon is a closed-source binary | Low | Medium | No custom batch API possible | The Jolt/Rapier WASM path above |
| Laptop measurements don't transfer to x86-64 SMT | Certain to differ | Medium | §2 caveats | Re-run `tools/bench/runtime` on an OVH ADV-1 before Phase 1 exit; Platform Q2 closes then |

---

## 8. Interfaces with Netcode / Platform

### 8.1 Assumptions others must align with

| # | Assumption / contract | Value | Owner to confirm |
|---|---|---|---|
| R1 | Simulation and snapshot tick | **60 Hz fixed, no sub-stepping**; tick numbers never skipped; catch-up back-to-back; hitch signal after > 250 ms behind | Netcode (agrees with A2) |
| R2 | Language/runtime | Node 24 LTS, TypeScript, bundled ESM; Havok WASM `@babylonjs/havok` 1.3.x; Babylon 9.26 deep imports; Bun-compatible sim code | Netcode A1 ✓ |
| R3 | Process model | `MatchHost` supports **single-match process (default)** and **packed workers** (K ≤ 15 matches per worker at 60 Hz); the agent IPC (Platform A8) is identical in both | Platform A1 (default unchanged) |
| R4 | CPU per 10-player match | **0.15 vCPU (low) / 0.25 vCPU (high)** at 60 Hz, including netcode and a transport estimate. Sim alone measured ≈ 0.4–0.6 ms per tick on an M2 P-core | Platform §4.6 (replace c) |
| R5 | Memory per match | **≤ 150 MB RSS** single-match process (bundled, deep imports); 3–4 MB per match packed + ~50–100 MB per worker; warm idle process same as active minus players | Platform A2 ✓ (conditional on no barrel import) |
| R6 | Boot | Process ready (Havok + level loaded) **≤ 0.5 s**; allocate → ticking ≤ 50 ms | Platform A2 ✓ |
| R7 | Tick p99 target | Work p99 ≤ 4 ms and start lateness p99 ≤ 2 ms per match on a pinned, non-quota'd core at ≤ 70% host utilisation | Platform A3 (tighter than 16.7 ms, so SLO alerts fire before players notice) |
| R8 | Per-tick budget handed to Netcode | Movement ≤ 1 ms p99, projectiles + hit-reg ≤ 1 ms, relevance ≤ 0.5 ms, snapshot build + encode for all clients ≤ 0.3 ms, send ≤ 1 ms. Havok world ray = **1.5 µs**; `CharacterBody.step` = **27 µs** per player | Netcode A3/A4 ✓ |
| R9 | Snapshot size assumption for runtime sizing | Netcode's ~105 B delta at 60 Hz (my byte-aligned prototype: 188 B). Encode CPU negligible (< 0.12 ms per tick for 10 clients) | Netcode ✓ |
| R10 | I/O model | Transport never runs sim code; inputs in bounded per-client rings (16); per-client send backpressure by skipping snapshots, then rate step-down | Netcode §2.3 |
| R11 | Hitboxes | Not Havok bodies on the server (ADR 0206). Havok = static world + CC bodies only | Netcode ✓ |
| R12 | Fractional vCPU / CFS quota | Match containers must not run under a CPU quota below ~0.5 vCPU; prefer cpusets | Platform Q11 |
| R13 | Host tuning | `performance` governor, limited C-states, IRQs off sim cores, 1 core reserved for agent/kernel | Platform §4.3 |
| R14 | Image | Node 24 distroless (~50–60 MB) + bundle (~3–5 MB) + Havok WASM (2.1 MB) + server assets (~2 MB) → **≤ 80 MB**, x86-64 (arm64 also works) | Platform A10 ✓ |
| R15 | Determinism | Same build + same Node version + same CPU arch: reproducible in practice (measured within an engine); cross-engine: not. Replays = inputs + keyframes | Netcode §1.2 / Platform Q5 ✓ |
| R16 | Local dev | `server-match --mode=single-match` runs on the laptop: ~110 MB (direct) to ~200 MB (Babylon deep, TS) per match | Platform Q9 ✓ |

### 8.2 Answers to open questions

| From | Question | Answer |
|---|---|---|
| Platform Q2 | CPU/memory per match, tick p99 | R4, R5, R7; §2.1 and §2.7. SMT vs physical: not measurable on this machine; re-run on an ADV-1 |
| Platform Q3 | What does the server use for collision; split `shared`? | Havok WASM (same binary as the client) under deep-imported Babylon for the CC; raw `HP_*` for rays. **Yes, split**: pure `packages/shared` + Babylon `packages/sim` (§1.3) |
| Platform Q9 | Local mode on the laptop | Yes (R16) |
| Platform Q11 | Fractional vCPU at 60 Hz | Average fits, bursts don't: ≥ 0.5 vCPU or a cpuset (§3.3) |
| Netcode A5 | GC < 2 ms p99 | Scavenges: mean 0.08 ms, max 0.5 ms on a quiet host; tails to 5 ms under host load. Met at p99 (pauses are rare: ~1.5 per second, most ticks see none) |
| Netcode A6 | Datagram I/O < 1 ms p99 | Not measured (no transport installed). `postMessage` hop p99 ≤ 0.3 ms (quiet) if transport lives in another thread |
| Netcode N1 | Node WebTransport at 20–30 matches per host | Open; the M3 soak decides. Sidecar fallback in ADR 0306 |
| Netcode N2 | Terrain representation, ray cost | Havok **heightfield** (513² = 1.05 MB input, ~2.3 MB WASM per world, shareable); ray 1.4–1.6 µs, capsule cast 3.7–4.0 µs |
| Netcode N3 | CC in a client worker | Runtime-feasible: Havok + CC + shared code need no DOM (ran headless here). Cost 27 µs per tick for the local player. It's a client-engineering decision about replay latency |
| Netcode N8 | Server bots | In-process `PlayerSim` (§5.4) |

---

## 9. ADRs

| ADR | Title |
|---|---|
| [0301](adr/0301-node-typescript-match-runtime.md) | Node.js 24 + TypeScript match runtime reusing shared code and Havok WASM |
| [0302](adr/0302-havok-via-babylon-deep-imports-bundled.md) | Havok through Babylon deep imports in a bundled server build; split `packages/shared` |
| [0303](adr/0303-process-per-match-with-packable-match-host.md) | Process per match by default, with a `MatchHost` that can pack matches per worker |
| [0304](adr/0304-drift-free-hybrid-tick-scheduler.md) | Drift-free hybrid tick scheduler, catch-up, cpusets instead of CPU quotas |
| [0305](adr/0305-performance-budgets-and-ci-gates.md) | Performance budgets, allocation-free hot paths and CI gates |
| [0306](adr/0306-performance-migration-path.md) | Performance migration path: minimal shared controller → packing → WASM physics core → transport sidecar |

---

## Appendix A: Methodology

### A.1 Scripts (`tools/bench/runtime/`)

- Every script calls `setTimeout(() => process.exit(2), 180000).unref()` (`lib/stats.ts installWatchdog`).
- Only Node built-ins, `@babylonjs/core` and `@babylonjs/havok` are used, resolved from `apps/client` through `lib/resolve.ts` (`module.registerHooks`).
- Benchmarks were run one at a time.

| Script | Measures | Command |
|---|---|---|
| `havok-tick.ts` | Full tick per mode: per-phase times, GC entries, memory series every 3,600 ticks, sanity counters | `node tools/bench/runtime/havok-tick.ts --mode=direct --ticks=36000 --warmup=600`<br>`node --experimental-transform-types tools/bench/runtime/havok-tick.ts --mode=babylon …`<br>`TB_BABYLON_DEEP=1 node --experimental-transform-types … --mode=babylon` (deep-import shim)<br>`--mode=babylon-render`, `--hitboxes=0`, `--projectiles=200`, `--players=50`<br>`bun tools/bench/runtime/havok-tick.ts --mode=direct …` |
| `havok-queries.ts` | Per-call plugin vs HP_* cost | `node --experimental-transform-types tools/bench/runtime/havok-queries.ts` |
| `shared-code.ts` | Pure shared code, SoA, skeleton, analytic lag comp, Math micro | `node tools/bench/runtime/shared-code.ts` (also `bun …`) |
| `serialization.ts` | JSON vs DataView float/quantized/delta | `node tools/bench/runtime/serialization.ts` |
| `startup.ts` | Fresh-process import/startup costs (3 repeats each) | `node tools/bench/runtime/startup.ts --repeat=3` |
| `scheduler.ts` | Timer strategies | `node tools/bench/runtime/scheduler.ts` |
| `capacity.ts` (+ `lib/matchWorker.ts`) | Real-time W×M matches in worker threads, memory, messaging | `node tools/bench/runtime/capacity.ts --workers=6 --perWorker=15 --shareStaticShapes=true --seconds=20` |
| `memory-per-match.ts` | Marginal memory per match in one isolate | `node --expose-gc tools/bench/runtime/memory-per-match.ts --mode=direct --matches=16 [--shareStaticShapes=true]` |

Supporting modules:

- `lib/scenario.ts`: world, inputs, hitbox layout.
- `lib/directMatch.ts`, `lib/babylonMatch.ts`: the two engine paths.
- `lib/buildJs.ts`: type-stripped JS build into `node_modules/.cache/twobullets-bench` for workers.
- `lib/babylonDeep.ts`: deep-import shim.

### A.2 Measurement details

- **Timing:** `performance.now()` around each tick and phase; `process.hrtime.bigint()` for micro batches. Percentiles are nearest-rank over all samples. Warm-up is excluded (600 ticks, or 5 batches for micro benchmarks).
- **Tick loop:** back-to-back ticks (CPU cost), yielding to the event loop every 60 ticks *outside* the timed region so GC observer callbacks run.
- **GC:** `PerformanceObserver` `gc` entries (kind + duration), plus one `--trace-gc` run parsed into `results/trace-gc-direct.json`.
- **Memory:** `process.memoryUsage()`; Havok heap = `HEAPU8.buffer.byteLength`; per-match marginal after a forced full GC (`--expose-gc`). **RSS on macOS is noisy under memory pressure** because of page compression. WASM and V8 heap sizes are the reliable accounting.
- **Allocation per call:** median positive `heapUsed` delta over GC-free batches. It is approximate (linear allocation buffer granularity) and unreliable on Bun.
- **Real time:** `process.threadCpuUsage()` per worker; lateness = actual start − absolute deadline; overrun = tick finished after the next deadline.
- **Equivalence of modes:** identical scenario seeds; sanity counters reported and compared (§2.1, §2.6).
- **Babylon hitbox bodies** use unparented TransformNodes with world transforms computed in JS. The client's bone-parented nodes would add `computeWorldMatrix` work, so the Babylon numbers are a lower bound for that design.
- **Weapon shots** from `stepWeapon` are counted, but the projectile population is held at the target count independently, so the ray load is fixed.

### A.3 Raw results

All JSON is in `tools/bench/runtime/results/`. The key files are:

| File(s) | Content |
|---|---|
| `havok-tick-direct-{1,2,3}.json`, `havok-tick-babylon-{1,2,3}.json` | 36k-tick runs (the §2.1 table) |
| `havok-tick-direct-bun-{1,2}.json`, `havok-tick-babylon-deep.json`, `havok-tick-babylon-render-1.json` | Runtime/import variants |
| `havok-tick-*-nohitbox.json`, `*-proj200.json`, `havok-tick-direct-p50.json`, `havok-tick-direct-p100.json` | Scenario variants |
| `shared-code.json`, `shared-code-bun.json`, `serialization.json`, `startup.json`, `scheduler.json`, `trace-gc-direct.json` | Micro, startup, scheduling and GC results |
| `capacity-w*-m*[-shared].json` | Real-time capacity. The `-shared` files (W1 × M1/10/15/20/25/30, W3 × M12, W6 × M15) are the quiet-period runs, and their `machine.loadAvg` field records conditions. Files without `-shared` (`capacity-w1-m{0,1,10,20,30}`, `capacity-w4-m10`, `capacity-w6-m1`, `capacity-w1-m40-30hz`) come from the earlier, busy session |
| `memory-per-match-{direct,direct-shared-shapes,babylon,babylon-deep}.json` | Marginal memory per match |

### A.4 Reproducing on the target host

```bash
# Linux x86-64, Node 24, repo checked out with pnpm install done
taskset -c 2 node tools/bench/runtime/havok-tick.ts --mode=direct --ticks=36000 --out=direct.json
taskset -c 2 node --experimental-transform-types tools/bench/runtime/havok-tick.ts --mode=babylon --ticks=36000 --out=babylon.json
node tools/bench/runtime/capacity.ts --workers=$(( $(nproc) / 2 - 1 )) --perWorker=15 --shareStaticShapes=true --seconds=60
node tools/bench/runtime/scheduler.ts
# Compare against results/*.json; replace §4.2's 0.6× conversion factor with the measured ratio.
```

### A.5 Packages we would want (not installed; `package.json` not edited)

| Package | Purpose |
|---|---|
| `rolldown` | Already present at the root: the server bundle (ADR 0302) |
| `hdr-histogram-js` | Low-overhead tick histograms in production |
| `@opentelemetry/sdk-metrics` | Metrics export, aligned with Platform |
| `clinic`, `0x` | Profiling |
| `@fails-components/webtransport` | Netcode's M3 transport, so transport CPU (§4.1) can be measured |
| `tinybench` | Would replace the hand-rolled micro harness |

## Appendix B: Sources

- Node.js: [TypeScript type stripping](https://nodejs.org/api/typescript.html) · [`module.registerHooks`](https://nodejs.org/api/module.html#customization-hooks) · [worker_threads](https://nodejs.org/api/worker_threads.html) · [perf_hooks](https://nodejs.org/api/perf_hooks.html) · [`process.threadCpuUsage`](https://nodejs.org/api/process.html#processthreadcpuusagepreviousvalue) · [CLI `--cpu-prof`](https://nodejs.org/api/cli.html#--cpu-prof) · [Linux perf with Node](https://nodejs.org/en/learn/diagnostics/poor-performance/using-linux-perf)
- libuv timers (millisecond resolution): https://docs.libuv.org/en/v1.x/timer.html
- Linux: [prctl timer slack](https://man7.org/linux/man-pages/man2/prctl.2.html) · [cgroup v2 `cpu.max` / cpuset](https://docs.kernel.org/admin-guide/cgroup-v2.html#cpu-interface-files) · [taskset](https://man7.org/linux/man-pages/man1/taskset.1.html)
- V8: [Trash talk: the Orinoco garbage collector](https://v8.dev/blog/trash-talk) · [Hidden classes](https://v8.dev/docs/hidden-classes) · [Shapes and inline caches (Bynens)](https://mathiasbynens.be/notes/shapes-ics)
- ECMAScript `Math` functions are implementation-approximated: https://tc39.es/ecma262/#sec-math.hypot
- WebAssembly memory growth: https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory/grow · Emscripten embind: https://emscripten.org/docs/porting/connecting_cpp_and_javascript/embind.html
- Babylon.js: [Havok plugin](https://doc.babylonjs.com/features/featuresDeepDive/physics/havokPlugin) · [Character controller](https://doc.babylonjs.com/features/featuresDeepDive/physics/characterController)
- Alternatives: [JoltPhysics](https://github.com/jrouwe/JoltPhysics) · [JoltPhysics.js releases](https://github.com/jrouwe/JoltPhysics.js/releases) · [Jolt `CharacterVirtual`](https://jrouwe.github.io/JoltPhysics/class_character_virtual.html) · [Rapier character controller](https://rapier.rs/docs/user_guides/rust/character_controller/) · [Bun docs](https://bun.sh/docs)
- Fixed timestep: [Gaffer On Games, Fix Your Timestep!](https://gafferongames.com/post/fix_your_timestep/)
- Lag compensation background: [Valve, Latency Compensating Methods](https://developer.valvesoftware.com/wiki/Latency_Compensating_Methods_in_Client/Server_In-game_Protocol_Design_and_Optimization)
- Profiling tools: [Clinic.js](https://clinicjs.org/) · [0x](https://github.com/davidmarkclements/0x) · [speedscope](https://www.speedscope.app/)
- Pricing (checked 2026-09-14): [Vantage, AWS c7g.xlarge](https://instances.vantage.sh/aws/ec2/c7g.xlarge) · [AWS egress tiers (EgressCost)](https://egresscost.com/aws/data-transfer-pricing/) · [Hetzner pricing (costgoat, Sep 2026)](https://costgoat.com/pricing/hetzner) · [Hetzner 2026 price increases (Northflank)](https://northflank.com/blog/hetzner-cloud-server-price-increases) · OVH per platform.md §4.2
