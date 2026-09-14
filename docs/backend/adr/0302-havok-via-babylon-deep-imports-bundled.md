# ADR 0302: Load Havok through Babylon deep imports in a bundled server build, and split `packages/shared` into pure and Babylon parts

- Status: Proposed
- Date: 2026-09-14
- Owner: Server Runtime & Performance Engineer
- Related: [runtime-performance.md §1.3, §2.1, §2.5](../runtime-performance.md#13-requirements-the-recommendation-puts-on-the-code-base), ADR 0301, Netcode §1.4 #1 and #9, Platform Q3

## Context

Measured in fresh processes (Node 24.19, M2 Pro):

| Import | Time | RSS | V8 heap |
|---|---|---|---|
| `@babylonjs/core` barrel | 0.7–1.4 s | 204–234 MB | 86 MB |
| `packages/shared/src/index.ts` (re-exports `buildLevel`, so it pulls the barrel) | 0.68–0.84 s | 221–242 MB | 85–97 MB |
| Deep imports (NullEngine, Scene, HavokPlugin, physics v2, CC, Mesh) | 70 ms | 104 MB | 19 MB |
| Shared movement/weapons modules only | 4–6 ms | 86 MB | 9.5 MB |
| Full Babylon match, barrel | 1.2–1.8 s | 336–382 MB | 149 MB |
| Full Babylon match, deep-import shim | 0.32 s setup | ~200 MB (incl. TS tooling) | 39–58 MB |

Other constraints:

- Client code such as `HavokRaycaster.ts` uses TypeScript parameter properties, which Node's strip-only mode rejects.
- The TS stripper itself adds about 40 MB RSS.
- Babylon wrapper overhead vs raw `HP_*` calls:
  - per query: raycast 1,622 vs 1,409 ns; shape cast 4,036 vs 3,743 ns; teleport 1,153 vs 546 ns;
  - per tick: +0.16 ms without Havok hitbox bodies, +0.19 ms with them.

## Decision

1. **`packages/shared` stays pure** (no `@babylonjs/*`), enforced with lint. `buildLevel`, `CharacterBody`, the raycaster adapter and the Havok world move to **`packages/sim`**, which imports Babylon **only through deep module paths**. The benchmark's `tools/bench/runtime/lib/babylonDeep.ts` lists the needed surface.
2. The server ships as **one bundled ESM file** (rolldown, already a root devDependency) plus `HavokPhysics.wasm`. No runtime TypeScript.
3. The server keeps Babylon's `PhysicsCharacterController` and `CharacterBody` for **prediction parity**. It does **not** call `scene.render()` and advances physics with the engine step directly.
4. Hot query paths the client doesn't share bit-for-bit (world rays for bullets and relevance LOS) may call `HP_*` directly with reused query arrays, behind the `RaycastFn` interface.
5. CI fails if the server bundle contains the `@babylonjs/core` barrel entry (ADR 0305).

## Consequences

- Process memory ≈ 110–150 MB (est.) and boot < 0.5 s instead of ~380 MB and ~2 s. This makes Platform A2 (≤ 150 MB, ≤ 3 s) achievable.
- A small, explicit list of Babylon modules to maintain across Babylon upgrades.
- Client engineers must move files into `packages/sim` (a coordination cost; Netcode already asked for it).

## Alternatives considered

| Option | Why not |
|---|---|
| Import the barrel and accept the cost | +230 MB and +2 s per match process; the warm pool gets expensive |
| Drop Babylon entirely on the server (raw `HP_*` plus our own controller) | Fastest (−0.16 ms per tick) but breaks CC parity with the client unless the client switches too (ADR 0306 step 1) |
| Run TypeScript directly (`--experimental-transform-types`) | Experimental, +40 MB, slower startup |
