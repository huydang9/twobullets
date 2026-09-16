# ADR 0301: The authoritative match server runs on Node.js 24 + TypeScript, reusing the shared simulation code and Havok WASM

- Status: Proposed
- Date: 2026-09-14
- Owner: Server Runtime & Performance Engineer
- Related: [runtime-performance.md §1, §2](../runtime-performance.md#1-language-and-runtime-for-the-authoritative-match-server), ADR 0201, ADR 0302, ADR 0306

## Context

- Client prediction needs the server to run the same movement and weapon maths:
  - `computeDesiredVelocity`, `stepWeapon` and `stepProjectiles` in `packages/shared`;
  - Babylon's JS `PhysicsCharacterController` over the Havok WASM binary, through `CharacterBody`.
- The product owner wants many cheap concurrent matches with a stable tick.
- Candidates: Node + TS, Bun, a Rust or Go port, or a hybrid with a native core.
- Measured on an M2 Pro with Node 24.19:
  - **Full 10-player tick:** 0.38 ms p50 with direct Havok, 0.57 ms p50 on the Babylon `CharacterBody` path (the scenario includes 1 km terrain, 300 buildings, 200 hitbox bodies and 50 projectiles; superseded on 2026-09-16: the maps are now 500 × 500 m and the bench scenario's `mapSize` with them, which only lowers the cost). That is 2–4% of a 16.67 ms tick.
  - **Pure shared code:** < 2 µs per tick for 10 players.
  - **Bun:** runs the same code about 13% faster.
  - **Determinism:** simulation results are identical across processes on the same engine but diverge between V8 and JavaScriptCore.

## Decision

1. The match server (`apps/server-match`) is **TypeScript on Node.js 24 LTS**, bundled to ESM (ADR 0302).
2. It imports gameplay rules from `packages/shared` (pure) and engine glue from `packages/sim` (Babylon + Havok WASM). This is the same source the browser runs.
3. Simulation code stays **Bun-compatible**: no Node-only APIs inside `packages/shared` or `packages/sim`. The benchmarks run on both. Re-evaluate Bun after the transport choice (Netcode N1).
4. No Rust or Go port of the simulation. Native code is allowed for **transport** (a QUIC sidecar) and, later, for a **WASM** physics core used by both client and server (ADR 0306). A Node native addon for physics is not allowed.

## Consequences

- One language and one test suite, and prediction parity by construction. Gameplay changes ship once.
- Tick CPU is small enough that capacity is limited by memory, scheduling, transport and bandwidth rather than by the language.
- We inherit V8 GC. Hot paths must be allocation-light (ADR 0305). Measured scavenges average 0.08 ms, with a maximum of 0.5 ms on a quiet host.
- Embind marshalling (at least 123 ns per call) caps scaling for much larger player counts. At 100 players a tick takes 4.2 ms, which is still fine.
- The server depends on Babylon/Havok release cadence, so pin versions identically on client and server.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| Bun | 13% faster simulation, but a younger ecosystem for WebTransport, metrics and profiling. Kept as an option |
| Rust (rapier/Jolt) + port | Two implementations of movement and weapons, and a different physics engine, so every contact is a potential misprediction. Buys CPU we don't need |
| Go | Same as Rust, with no mature Go physics engine |
| Native physics addon + TS orchestration | The native core ≠ the browser's WASM, so parity is lost. Crashes in native code take down the process |
