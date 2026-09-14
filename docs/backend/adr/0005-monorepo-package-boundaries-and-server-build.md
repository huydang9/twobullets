# ADR 0005: Monorepo package boundaries, dependency direction, and a bundled, erasable-TypeScript server build

- Status: Accepted
- Date: 2026-09-14
- Owner: Principal Architect
- Related: ADR 0101, ADR 0201, ADR 0301, ADR 0302, ADR 0003; [netcode.md §12.1](../netcode.md#121-module-layout), [platform.md §8](../platform.md#8-repo-layout-proposal), [runtime-performance.md §1.3](../runtime-performance.md#13-requirements-the-recommendation-puts-on-the-code-base)

## Context

Three layouts were proposed:

- **Platform** (§8): `shared`, `protocol`, `contracts`, `tools/loadtest`, `tools/netem`.
- **Netcode** (§12.1): `shared`, `protocol`, `netcode`, `sim`, `apps/bot`.
- **Runtime** (§1.3): `shared` + `sim`, bundled with rolldown.

Checks against the code at commit 12f0d9c:

- `packages/shared/src/index.ts` re-exports `level/buildLevel`, which imports `@babylonjs/core`. Importing `@twobullets/shared` on a server costs 680–840 ms and 85–97 MB of heap (runtime-performance.md §2.5).
- `packages/shared/package.json` depends on `@babylonjs/core` with a caret range.
- **Native type stripping fails in two ways**, verified with Node 24:
  - `HavokRaycaster.ts`, `SoldierHitboxes.ts`, `CombatInputQueue.ts`, `CombatSystem.ts` and other client files use TypeScript parameter properties (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`);
  - `packages/shared` uses extensionless relative imports (`from "./types"`), which Node's ESM loader rejects (`ERR_MODULE_NOT_FOUND`).
- TypeScript 7.0.2 in the repo supports `erasableSyntaxOnly` (verified: TS1294 on a parameter property).

## Decision

1. **Packages and ownership boundaries:**

   | Package | Contains | May import | Must not import |
   |---|---|---|---|
   | `packages/shared` | Gameplay rules and tuning: constants, movement, glide, weapons, ballistics, throwables, items/armor, zone, loot generation, audibility radii, match phase params, `hitreg` table/rig/intersectors (ADR 0003), math helpers (`len2`, `len3`), `PlayerInput`/`PlayerState` types, level **data** (`arena.ts`, `LevelData`) | nothing (zero runtime deps) | `@babylonjs/*`, `node:*`, DOM |
   | `packages/sim` | Babylon NullEngine + Havok glue: `SimWorld` (collision-only level build, no render meshes), `CharacterBody` (moved), `WorldRaycaster`, `PlayerSim.step` | `shared`, `@babylonjs/core/**` **deep paths only**, `@babylonjs/havok` | the `@babylonjs/core` barrel, DOM, `node:*` |
   | `packages/protocol` | Wire format: `BitWriter`/`BitReader`, quantizers, message IDs and codecs, `PROTOCOL_VERSION`, generated `version.ts` (`contentHash`), decode-to-JSON tool | `shared` (types and tuning ranges only) | Babylon, `node:*` |
   | `packages/netcode` | Transport-agnostic algorithms: time sync, time dilation, server input buffer + token bucket, baselines, reliable events, interpolation, prediction history/replay driver, hit-reg history/rewind, relevance, `Session` interface, `LinkConditioner` | `shared`, `protocol` | Babylon, `node:*`, DOM |
   | `packages/contracts` | REST/WS/internal schemas (TypeBox), join-token claims, agent↔match IPC messages, error codes | nothing | runtime code |
   | `apps/client` | Rendering, input, audio, UI, `src/net/*` | all packages | — |
   | `apps/server-match` | `MatchHost`, scheduler, `Match`, sessions, snapshot builder, server projectiles/throwables, transports (`ws`, WT binding), agent mode | `shared`, `sim`, `protocol`, `netcode`, `contracts` | the barrel |
   | `apps/server-api` | Modular monolith (ADR 0101) | `contracts`, `shared` (constants only) | `sim` |
   | `apps/bot` | Headless client (real `sim`, `protocol`, `netcode`) + behaviours; also the load-test driver | `shared`, `sim`, `protocol`, `netcode`, `contracts` | the barrel |
   | `tools/bench/*`, `tools/assets/*` | Benchmarks and the asset pipeline (+ rig fit / drift gate, ADR 0003) | any | — |

   Platform's `tools/loadtest` becomes scenario files under `apps/bot/scenarios/`. Platform's `tools/netem` becomes OS-level scripts under `infra/hosts/netem/`. In-process shaping is `LinkConditioner`.

2. **Dependency direction:** `shared ← protocol ← netcode`, `shared ← sim`, and apps on top. There are no cycles, and `protocol` and `netcode` never see Babylon. These rules are enforced by `dependency-cruiser` or an equivalent lint in CI (a script is fine at first).

3. **TypeScript mode:** `packages/{shared,sim,protocol,netcode,contracts}`, `apps/server-*` and `apps/bot` set `"erasableSyntaxOnly": true`. That rules out parameter properties, enums and namespaces, keeping the code runnable by Node type stripping and by Bun (ADR 0301 item 3). Client-only code is not forced to follow, but files that move into `sim` are converted.

4. **Server build:** `apps/server-match` and `apps/bot` ship as **one rolldown ESM bundle** each, plus `HavokPhysics.wasm` and the `server/` asset folder (runtime-performance.md §6.1).
   - No runtime TypeScript in production.
   - Local dev runs rolldown in watch mode and `node --watch` on the output.
   - Tests use vitest.

5. **Version pins:** `@babylonjs/core`, `@babylonjs/havok` and `@babylonjs/loaders` are pinned to **exact** versions workspace-wide (ADR 0002 §6).

6. **CI gates:**
   - no `@babylonjs/*` import under `packages/{shared,protocol,netcode}`;
   - no `@babylonjs/core"` (barrel) import under `packages/sim`, `apps/server-*` or `apps/bot`;
   - the server bundle must not contain `@babylonjs/core/index.js` (ADR 0305);
   - `tsc` with `erasableSyntaxOnly` passes.

## Consequences

- The server's import cost drops to the deep-import surface (~70 ms, ~19 MB heap at import).
- Client code moves (`CharacterBody`, `buildLevel`, `HavokRaycaster`) require one coordinated refactor PR series (architecture.md §7.2), owned by one agent at a time to avoid merge conflicts.
- `packages/sim` must be importable by the Vite client too. Deep imports work in Vite and tree-shake better than the barrel.

## Alternatives considered

- **Keep one `shared` package with sub-path exports.** The barrel leak stays one careless import away, and the package keeps a Babylon dependency. Rejected.
- **Put `sim` inside `apps/server-match`.** The client and bots need the same `PlayerSim`. Rejected.
- **Run TypeScript at runtime (`--experimental-transform-types`, tsx).** +40 MB RSS and slower startup, and it is experimental. Rejected for production; bundles only.
