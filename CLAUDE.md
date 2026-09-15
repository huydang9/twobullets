# twobullets — project rules for Claude

Browser multiplayer first-person battle royale: **realistic, PUBG-like**. Configurable match size up to 20 players, team modes solo / duo / squad (4), on a 1×1 km map. Internal release. Owner: a TypeScript engineer who is new to game dev and blogs about the build in Vietnamese.

## Product decisions (don't re-litigate)
- **Art:** realistic everything, including a minimal PUBG-style HUD. Free assets only: CC0 preferred; CC-BY with credits; Mixamo allowed.
- **Match rules:** friendly fire ON. Knocked + teammate revive in 5 s. Player body blocking ON.
- **Bots:** lobby bots YES, for testing and to fill empty slots.
- **Map and match:** teams pick a landing spot, then glide down. Shrinking zone. Match length about 10–12 min. No vehicles.
- **Match size and modes (2026-09-15):** the host picks the match size (up to 20 players) and team mode (solo, duo, squad of 4); bots fill empty slots.
- **Maps (2026-09-15):** Map v1 plus real-world locations generated from OpenStreetMap (MVP includes a location picker; prebuilt presets, and a tool to add any place). Defaults: scaled real elevation, building cap ~90, no Training Yard on real maps, place names keep diacritics.
- **Language (2026-09-15):** Vietnamese is the default UI language; English is selectable.
- **Order of work:** equipment built offline ✅, offline bots on Map v1 (easy/normal/hard) ✅ (in tuning), backend M3 core ✅ locally; next is M4 (networked combat), then M5, per `docs/backend/architecture.md`.

**Start here:** read [`docs/STATUS.md`](docs/STATUS.md) first (roadmap, uncommitted work, open feedback, next steps), then [`docs/architecture-overview.md`](docs/architecture-overview.md) (stack, layout, frame loop, data flows) and [`docs/README.md`](docs/README.md) (docs index and how-tos).

## Stack and layout
- pnpm monorepo, TypeScript 7, Vite 8, **Babylon.js 9.26 + Havok**, vitest. Node 24.
- `packages/shared`: **pure, deterministic gameplay** (movement, input/aim, weapons, equipment, map terrain/layout, buildings data, hitbox rig, bots, match rules and zone) that the Node server runs identically. No Babylon, no `node:*`.
- `packages/sim`: Babylon-dependent but render-agnostic code (NullEngine + Havok, deep imports only): `CharacterBody`, `WorldRaycaster`, `stepPlayer`/`createSimWorld`, `level/buildLevel`, map terrain/building physics and headless map collision, `match/MatchSim`.
- `packages/protocol` (bit-packed messages), `packages/netcode` (time sync, prediction, interpolation, input buffer), `packages/contracts` (match/agent IPC types).
  - Dependency direction: shared → sim / protocol / netcode / contracts → client / server-match / bot (netcode also uses protocol; contracts imports nothing). `apps/bot/test/boundaries.test.ts` enforces it.
- `apps/server-match`: Node match server (M3: local mode over WebSocket, server-authoritative movement). `apps/bot`: headless bot client / load driver (stub).
- `apps/client/src`:
  - `game/Game.ts`: wiring and frame loop
  - `player`: local player on the sim's `CharacterBody`, fixed 60 Hz tick
  - `combat`: weapon tick, raycasts, hitboxes
  - `equipment`: offline equipment system, presentation, loot
  - `targets`: Mixamo soldiers
  - `viewmodel`: first-person rigs
  - `fx`, `audio`, `ui`
  - `world`: environment, terrain, buildings, props, vegetation, map runtime, zone wall
  - `match`: offline bot match host (`OfflineMatch` runs `MatchSim`), bot bodies, spectate; HUD in `ui/match`
  - `net`: networked play (`NetGame`, `NetClient`, prediction/reconcile, remote players)
  - `assets`: GLB loader and manifests (weapons, characters, equipment)
  - `perf`: bench, flags, graphics presets
- `tools/`: asset pipelines (`assets` incl. `assets/equipment`, `environment`, `vfx`, `audio`, `map`) and benches (`bench/bots`, `bench/netcode`, `bench/runtime`).
  - Raw downloads go in gitignored `assets-src/`.
  - Processed outputs go in `apps/client/public/assets/`.
- `docs/`: `backend/` (architecture, ADRs, `m3-local-run.md`), `bots/`, `map/`, `equipment/`, `perf/`, `research/`, `audio.md`, `fx-blood.md`, `fx-throwables.md`, `assets-*.md`, `devlog/` (Vietnamese blog log).

## Commands
- `pnpm dev` (http://localhost:5173) · `pnpm server:dev` (match server, ws://localhost:7350/m/local) · `pnpm typecheck` · `pnpm test` · `pnpm build`
- `pnpm assets` / `assets:verify` · `pnpm assets:equipment` · `node tools/vfx/build.mjs` · `node tools/audio/verify.ts` · `node --experimental-transform-types tools/map/build.ts`
- Test URLs: `?map=v1`, `?bench=v1`, `?bots=1&difficulty=easy|normal|hard`, `?net=ws://localhost:7350/m/local`, `/buildings.html`, `/props.html`, `?teammate=1`, `?targetArmor=1`, `?quality=`, `?opt=`. Keys: F3 stats, F4 perf, F6 net panel, F7 bot debug, F8 physics shapes, F9 inspector.

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
  - Download researched, license-verified assets without asking (owner: "download file don't need my approval"); report what was downloaded.
  - The user logs in to Sketchfab/Mixamo themselves; never handle credentials, and never send personal info in requests.
  - Record credits (`public/assets/*/credits.json`).
  - For the full find → verify → download → pipeline flow, use `.claude/skills/asset-sourcing`.
