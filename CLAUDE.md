# twobullets — project rules for Claude

Browser multiplayer first-person battle royale: **realistic, PUBG-like**. Up to 10 players in 5 teams (max 2 per team) on a 1×1 km map. Internal release. Owner: a TypeScript engineer who is new to game dev and blogs about the build in Vietnamese.

## Product decisions (don't re-litigate)
- **Art:** realistic everything, including a minimal PUBG-style HUD. Free assets only: CC0 preferred; CC-BY with credits; Mixamo allowed.
- **Match rules:** friendly fire ON. Knocked + teammate revive in 5 s. Player body blocking ON.
- **Bots:** lobby bots YES, for testing and to fill empty slots.
- **Map and match:** teams pick a landing spot, then glide down. Shrinking zone. Match length about 10–12 min. No vehicles.
- **Order of work:** equipment built offline first, then offline bots on Map v1 (easy/normal/hard), then backend M3–M5 per `docs/backend/architecture.md`.

**Start here:** [`docs/architecture-overview.md`](docs/architecture-overview.md) (stack, layout, frame loop, data flows) and [`docs/README.md`](docs/README.md) (docs index and how-tos).

## Stack and layout
- pnpm monorepo, TypeScript 7, Vite 8, **Babylon.js 9.26 + Havok**, vitest. Node 24.
- `packages/shared`: **pure, deterministic gameplay** (movement, weapons, equipment, map terrain/layout, buildings data) that the future Node server runs identically.
  - Babylon-dependent but render-agnostic code lives in separate folders (`map/physics`, `map/buildings/babylon`, `level/buildLevel`).
- `apps/client/src`:
  - `game/Game.ts`: wiring and frame loop
  - `player`: Havok character controller, fixed 60 Hz tick
  - `combat`: weapon tick, raycasts, hitboxes
  - `equipment`: offline equipment system, presentation, loot
  - `targets`: Mixamo soldiers
  - `viewmodel`: first-person rigs
  - `fx`, `audio`, `ui`
  - `world`: environment, terrain, buildings, props, vegetation, map runtime
  - `assets`: GLB loader and manifest
  - `perf`: bench, flags, graphics presets
- `tools/`: asset pipelines (`assets`, `environment`, `audio`, `map`) and benches.
  - Raw downloads go in gitignored `assets-src/`.
  - Processed outputs go in `apps/client/public/assets/`.
- `docs/`: `backend/` (architecture + ADRs), `map/`, `equipment/`, `perf/`, `audio.md`, `fx-blood.md`, `assets-*.md`, `devlog/` (Vietnamese blog log).

## Commands
- `pnpm dev` (http://localhost:5173) · `pnpm typecheck` · `pnpm test` · `pnpm build`
- `pnpm assets` / `assets:verify` · `node tools/audio/verify.ts` · `node --experimental-transform-types tools/map/build.ts`
- Test URLs: `?map=v1`, `?bench=v1`, `/buildings.html`, `?teammate=1`, `?targetArmor=1`, `?quality=`, `?opt=`. Keys: F3 stats, F4 perf, F8 physics shapes, F9 inspector.

## Code rules
- **Server-bound gameplay** is pure state-in/state-out and deterministic.
  - No `Math.random`: use seeded RNG from counters.
  - No Babylon imports in pure folders.
  - Use injected raycast functions.
  - Tick-time gates/modifiers, never per-frame.
  - Prefer `Math.sqrt` over `Math.hypot` in hot paths, and typed arrays for many simulated objects.
- **Hot paths:** no per-frame allocations. Pool effects, thin-instance repeated meshes.
- **Contracts:** changes to shared contracts (`combat/types.ts`, `equipment/types.ts`, `map/types.ts`) are additive.
- **Style:** match the surrounding code; comments sparse and useful.

## How we work (important)
- **Claude is the lead coordinator** and spawns agent teams for implementation (user: "spawn a team, don't do it by yourself"). Follow `.claude/skills/agent-team`.
  - Each agent gets exclusive file ownership plus contracts.
  - Agents send cross-file requests to the lead, who relays them.
- **Verify in the real browser** (`.claude/skills/browser-verify`) before calling a phase done.
  - Automation tabs are hidden and throttled, so frame rates there are meaningless.
  - Ask the user to run `?bench=v1` for performance numbers.
- **Finish every phase** with `.claude/skills/phase-complete`:
  - typecheck and test
  - browser check
  - commit only that phase's paths (co-author trailer)
  - update memory
  - update the Vietnamese devlog; don't commit devlog unless asked
- **Machine:** M2 Pro with 16 GB, swap-prone.
  - At most about 4 heavy agents at once; check `sysctl vm.swapusage`.
  - Agents: no dev servers, no browser automation, self-terminating scripts (macOS has no `timeout`), one heavy process at a time.
- **Assets:**
  - Verify licenses before use (no NC, ripped or unclear licenses).
  - Downloads need the user's explicit OK with file names and sizes.
  - The user logs in to Sketchfab/Mixamo themselves; never handle credentials.
  - Record credits (`public/assets/*/credits.json`).
