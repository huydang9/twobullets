# ADR 0306: Performance migration path: shared minimal controller → packed matches → WASM physics core → transport sidecar

- Status: Proposed
- Date: 2026-09-14
- Owner: Server Runtime & Performance Engineer
- Related: [runtime-performance.md §7](../runtime-performance.md#7-risks-and-fallbacks), ADR 0301, ADR 0303, Netcode §7.2

## Context

- Node + Havok WASM is fast enough for 10-player matches, but the ceilings are known:
  - embind marshalling, at 123 ns or more per crossing and 3–4 crossings per query;
  - the Babylon JS character controller, at 27 µs per player per tick;
  - a closed-source Havok binary, so no custom batch API is possible;
  - Node WebTransport maturity.
- A 100-player variant measured 4.2 ms per tick.
- Any step we take must keep client/server simulation parity, which rules out native-only physics on the server.

## Decision

Take these steps **in order, each only when its trigger fires**:

| Step | Trigger | Change | Measured / expected gain |
|---|---|---|---|
| 0. Hygiene | Always | ADR 0302 and ADR 0305 (deep imports, allocation-free paths, direct `HP_*` rays) | Process memory −60%; allocation cut |
| 1. **Shared minimal capsule controller** | CC cost > 1 ms p99 per tick, or CC hidden state keeps breaking replay | Replace `PhysicsCharacterController` on **both** client and server with a `packages/sim` controller built on raw Havok shape casts (support cast, collide-and-slide, step-up probe, ground snap). Prototype: `tools/bench/runtime/lib/directMatch.ts` | Move phase 0.14 vs 0.27 ms for 10 players; no Scene needed on the server. Needs a movement-feel parity pass |
| 2. **Packed matches** | Host > ~60 matches, lateness SLO misses, memory cost | ADR 0303 packed mode with shared static shapes | 3–4 MB per match; per-match tick 0.4 ms vs 1.7 ms for an isolated low-duty process |
| 3. **Transport sidecar** | Node WebTransport fails the M3/M4 soak, or send CPU > 1 ms p99 | Rust QUIC/WebTransport process per host (e.g. `wtransport`/`quinn`) feeding per-match SharedArrayBuffer or UDS rings | Transport off the V8 heap and event loop |
| 4. **WASM physics core with a batch API, shared by client and server** | Much larger player counts, or query cost dominates after steps 0–2 | Build Jolt (`CharacterVirtual`) or Rapier (KCC) to WASM with a flat-memory API: batch rays and casts written into and read from typed-array views, one crossing per batch. Same `.wasm` in the browser and on the server | Removes per-query embind marshalling (the dominant cost per query). Keeps parity because the binary is identical |
| 5. Native server physics | Never for the authoritative simulation | — | Would break parity with the browser |

## Consequences

- Most of the known ceilings have a mitigation that keeps one simulation implementation. Step 4 is a large project (a new physics engine for client and server), justified only by product scale changes.
- Steps 1 and 4 change client movement feel and need playtests and the replay-consistency test (Netcode §11.4).

## Alternatives considered

| Option | Why not |
|---|---|
| Rewrite the server in Rust now | See ADR 0301 |
| Native Havok SDK on the server | Licensing and a different binary from the browser's WASM, so no parity |
| Keep scaling Node processes horizontally without steps 1–4 | Works for 10-player matches (cost is in bandwidth, not CPU), but not for much larger modes |
