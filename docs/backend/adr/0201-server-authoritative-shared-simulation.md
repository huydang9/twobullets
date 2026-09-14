# ADR 0201: Server-authoritative simulation reusing the shared TypeScript tick, with no player-vs-player movement collision

- Status: Proposed
- Date: 2026-09-14
- Owner: Netcode Architect
- Related: [netcode.md §1](../netcode.md#1-authority-model), ADR 0205, ADR 0206; Platform Q3/Q5

## Context

- Milestone 2 already has deterministic, engine-free gameplay steps in `packages/shared`:
  - `computeDesiredVelocity` (movement)
  - `stepWeapon`, with spread and recoil seeded only by `shotCounter`
  - `stepProjectiles` / `computeDamage`, with an injected `RaycastFn`
- The engine-side movement (`CharacterBody`: Havok `PhysicsCharacterController`, step-up, ground snap, crouch shape cast) lives in `apps/client`.
- A competitive shooter can't trust client positions, hits or fire rate.
- Havok is not bit-deterministic across different world states, and ECMAScript `Math.sin/cos/...` are implementation-approximated, so V8, SpiderMonkey and JavaScriptCore can differ in the last ULP.
- `PhysicsCharacterController` has private per-step state (`_manifold`, `_lastDisplacement`, `_lastVelocity`, `_lastInvDeltaTime`) that `setPosition` doesn't reset.

## Decision

1. **The server is authoritative** for movement, weapons, projectiles, damage, throwables, items, inventory, loot, zone and match phases. Clients send intent only: movement axes, buttons, quantized aim and actions. `speedScale` is removed from the wire and derived in the tick.
2. **One tick function, `PlayerSim.step`**, is used by server authority, client prediction and bots. It lives in `packages/sim` (Babylon NullEngine + Havok, no rendering) and calls the pure steps in `packages/shared`. `CharacterBody` moves from `apps/client` to `packages/sim` and gains `resetForReplay()`.
3. The server runs the **full Havok character controller** for every player at 60 Hz. Player hitboxes are **not** Havok bodies (ADR 0206).
4. **No player-vs-player collision** in movement queries on client or server. The movement world is the static level on both sides, so prediction mismatches come only from input loss or late input and float noise. Optional server-side soft separation later.
5. **No bitwise determinism requirement** between client and server. The owner block carries full MoveState/WeaponState, so the client can restart from exact server state. Tolerances: 1 cm position, 5 cm/s velocity, exact discrete fields, ±1 tick timers.
6. The client **quantizes its aim before simulating** (yaw 20 bits, pitch 18 bits), so fired directions are identical on client and server.
7. Replays use input logs + 10 s keyframes. Re-simulation is trusted on the same server build and Node version only, verified by state hashes.

## Consequences

- Cheats can't move faster, fire faster, fake hits or remove spread server-side. Aim assistance remains a detection problem (telemetry).
- Requires the refactors in netcode.md §1.4, including moving `speedScale`/`allowSprint` derivation from the render-frame `CombatSystem.update` into the tick.
- The server sim must be TypeScript on V8 (Runtime assumption A1). A native sim would duplicate gameplay code.
- No body blocking; players can overlap. That's a design trade (PUBG-style body blocking is gone), revisited with soft separation if playtests dislike it.
- The M3 replay-consistency test is a gate: restore + replay must be bitwise equal in Node and ≤ 1 mm in Chromium.

## Alternatives considered

- **Client-authoritative movement with server sanity checks.** Cheaper, but speed and teleport hacks become heuristics. Rejected for competitive play.
- **Deterministic lockstep.** Needs bit-determinism across browsers and Havok. Impossible here, and input delay grows with the slowest player. Rejected.
- **Player collision in prediction.** Remote players are interpolated in the past, so every contact mispredicts and rubber-bands. Rejected.
- **A different server physics (custom BVH / Rapier).** Movement would behave differently from the client's Havok controller, causing constant corrections. Rejected unless Runtime proves Havok-in-Node can't meet budgets.
