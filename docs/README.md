# Documentation index and how-to

Start with [`STATUS.md`](STATUS.md) for the roadmap and what's in progress, then [`architecture-overview.md`](architecture-overview.md) for the tech stack, repo layout, runtime architecture and data flows. Project rules for Claude are in [`../CLAUDE.md`](../CLAUDE.md).

## Docs map

| Area | Doc | What's inside |
|---|---|---|
| Status | [STATUS.md](STATUS.md) | Roadmap, in-progress work, known issues, pending user decisions |
| Overview | [architecture-overview.md](architecture-overview.md) | Stack, layout, package dependencies, frame loop, contracts, data flows |
| Backend | [backend/architecture.md](backend/architecture.md) | Merged decisions, reconciled capacity/bandwidth/cost, SLOs, prerequisite refactors, M3–M5 plan, risks |
| | [backend/m3-local-run.md](backend/m3-local-run.md) | Running the local match server and two networked tabs, URL flags, F6 panel, expected numbers, known M3 gaps |
| | [backend/netcode.md](backend/netcode.md) | Authority, tick and snapshot rates, prediction, lag compensation, protocol, transport, equipment and audio replication |
| | [backend/runtime-performance.md](backend/runtime-performance.md) | Node vs Rust, Havok tick benchmarks, process model, scheduler, CI gates |
| | [backend/platform.md](backend/platform.md) | Matchmaking, hosting, join tokens, data stores, observability, cost |
| | [backend/adr/README.md](backend/adr/README.md) | ADR index (00xx principal, 01xx platform, 02xx netcode, 03xx runtime) |
| Release | [release/quit-match.md](release/quit-match.md) | Pause menu, leaving alone vs ending for everyone, host rules, "play again", how to try it in two tabs |
| Bots | [bots/design.md](bots/design.md) | Offline bot match: MatchSim, navigation grid, perception, brain, aim model and difficulty table, zone and match rules, client wiring, HUD, URL flags, tests |
| Assets | [assets-plan.md](assets-plan.md) | Vetted free asset sources and license rules |
| | [assets-pipeline.md](assets-pipeline.md) | Weapons and character GLB pipeline, clip tables, loader API |
| | [assets-research/equipment-environment-2026-09-15.md](assets-research/equipment-environment-2026-09-15.md) | Vetted shortlist: throw arms, throwables, consumables, gear, third-person clips, VFX textures, cover trees and rocks |
| | [map/environment-assets.md](map/environment-assets.md) | Terrain and building textures, props, vegetation models, PropLibrary contract |
| Map | [map/terrain.md](map/terrain.md) | Heightfield, flatten API, surface mask, LOD, physics, MapData contract |
| | [map/buildings.md](map/buildings.md) | Building kit, prefabs, collision, placement API, budgets |
| | [map/layout.md](map/layout.md) and [map/mapV1.svg](map/mapV1.svg) | POIs, roads, scatter, load-time bake, out-of-bounds, audio hooks |
| | [map/cover-props.md](map/cover-props.md) | Big trees, rocks and cover props: sources, LODs, colliders, placement per POI, budget, `/props.html` |
| | [map/vegetation-stability.md](map/vegetation-stability.md) | LOD hysteresis, cross-fades, zoom-aware LOD, headless stability check |
| | [research/real-world-map-investigation.md](research/real-world-map-investigation.md) | OpenStreetMap map investigation: data licenses, candidate places, open decisions (nothing implemented) |
| Equipment | [equipment/design.md](equipment/design.md) | Item stats, rules, state diagrams, EquipmentView contract, bindings |
| | [equipment/inventory.md](equipment/inventory.md) | Weapon slots, ammo migration, loot rendering, interaction, inventory UI |
| | [equipment/art.md](equipment/art.md) | Equipment models and throw arms: pipeline, outputs, clip phases, framing check, known issues |
| Audio | [audio.md](audio.md) | Sources and credits, pipeline, engine, weapon loudness hierarchy, equipment sounds, DEV commands |
| Effects | [fx-blood.md](fx-blood.md) | Blood mist, decals, wounds, settings |
| | [fx-throwables.md](fx-throwables.md) | Frag, smoke, molotov and flashbang VFX from CC0 flipbooks: pipeline, sheets, draw calls, DEV console |
| Performance | [perf/benchmark.md](perf/benchmark.md) | How to run `?bench=v1`, variants, flags, graphics presets |
| Devlog (Vietnamese) | [devlog/00-tong-quan.md](devlog/00-tong-quan.md) | Blog series overview, timeline, chapters, lessons (`bai-hoc.md`) |

## How to…

**Run the game**
```bash
pnpm install
pnpm dev                      # http://localhost:5173
```
- `/` is the arena with the soldier target range; `?map=v1` is the full 1×1 km map.
- `/buildings.html` previews building prefabs; `/props.html` previews the cover props and big trees (DEV only, see below).
- Controls: WASD, mouse, Space jump, Shift sprint, C crouch, LMB fire, RMB aim, R reload (cook while a pin is pulled), 1–3 or wheel weapons, 5 throwable, G cycle throwable, F pick up (hold: revive), Tab inventory, X holster, 7/8/9/0 bandage/first aid/medkit/boost, Esc release mouse.
- Debug keys: F3 stats, F4 perf, F6 net panel (with `?net`), F7 bot debug overlay (with `&botDebug=1`), F8 physics shapes, F9 inspector. While spectating in a bot match: `[` / `]` cycle players, Enter reopens the death or result screen.
- Test flags (DEV): `?teammate=1` (knock/revive), `?targetArmor=1`, `?quality=high|balanced|performance`, `?aa=msaa|fxaa`, `?opt=off` or `?opt=<flag>:0`, `?perf=1`, `?bench=v1`.

**Play an offline bot match**
- `?bots=1&difficulty=easy|normal|hard` (implies Map v1; default normal, also selectable on the play overlay). Click START MATCH.
- Options: `&seed=<u32>` (replay the same spawns and zone; the seed is printed to the console), `&teams=2..5`, `&teammate=none`.
- DEV options: `&zoneScale=0.25` (faster zone), `&spectate=1` (bots only, follow camera), `&botDebug=1` (labels, paths, rays, hitboxes), `&botsPassive=1` (bots never fire), `&matchTrace=1` (breadcrumbs in `localStorage["tb.matchTrace"]`), `&matchSkip=bodies,hud,fx,wall,equipment,sim` (turn client parts off to bisect).
- Headless: `node tools/bench/bots/match.ts [--seed 1] [--matches 1] [--difficulty normal] [--brain real]` (full matches) and `node tools/bench/bots/nav.ts` (nav build and queries). One heavy process at a time. Details: [bots/design.md](bots/design.md) §11–12.

**Run local multiplayer (M3, movement only)**
```bash
pnpm server:dev               # ws://localhost:7350/m/local; add -- --fake-net=typical to impair links
pnpm dev
```
- Open two tabs at `http://localhost:5173/?net=ws://localhost:7350/m/local`. Extras: `&team=0..4`, `&netId=alice`, `&netAvatar=capsule`.
- F6 toggles the net panel; `__twobullets.net` has `client.stats`, `connect()`, `disconnect()`. Details: [backend/m3-local-run.md](backend/m3-local-run.md).

**Check code**
```bash
pnpm typecheck
pnpm test                     # includes headless Havok tests and the package boundary gate (apps/bot/test/boundaries.test.ts)
pnpm build
```

**Measure performance** (visible tab, don't touch for about 10 min): open `http://localhost:5173/?bench=v1`, then click "Copy results". Use `&variants=0` for the quick run. Details: [perf/benchmark.md](perf/benchmark.md). For a bot match, F4 numbers with `?bots=1&spectate=1`.

**Add or rebuild assets**
- Raw files go in `assets-src/…` (gitignored), with a `DOWNLOADS-<date>.md` record of files, sources, sizes and licenses. Licenses must be CC0/CC-BY/Mixamo; record credits. The full flow is the `asset-sourcing` skill.
- Weapons and characters (including third-person bot clips): `pnpm assets` → `pnpm assets:verify` (config in `tools/assets/config.ts`).
- Equipment models and throw arms: `pnpm assets:equipment` (after `pnpm assets`; flags `--force`, `--only=frag,throw_arms`, `--textures=webp`) → `pnpm assets:verify`. Details: [equipment/art.md](equipment/art.md).
- Throwable VFX sheets: `node tools/vfx/build.mjs [--only=explosion,smokeCloud] [--preview]` (writes `public/assets/vfx/` and `equipment/presentation/vfxManifest.ts`). Details: [fx-throwables.md](fx-throwables.md).
- Environment textures, props, cover props and vegetation: `node --experimental-transform-types tools/environment/fetch.mjs` / `process.mjs` / `props.mjs` / `verify.mjs` (see `docs/map/environment-assets.md` and `docs/map/cover-props.md`). Check new props at `http://localhost:5173/props.html`: F walk/fly, `[` `]` select, T go to it, K colliders, M player-height markers.
- Audio: `node tools/audio/pipeline.ts` (use `--only=` for a subset) → `node tools/audio/verify.ts`.
- Map terrain bake after changing MapData: `node --experimental-transform-types --import ./tools/map/lib/resolve.ts tools/map/build.ts` (add `--check` to verify only).

**Add a weapon, item or building (where to edit)**

| To add | Edit |
|---|---|
| Weapon | stats in `packages/shared/src/weapons/weapons.ts`; model and clips via `tools/assets/config.ts`; viewmodel profile in `apps/client/src/viewmodel/weaponProfiles.ts` |
| Item | `packages/shared/src/equipment/items.ts` (plus rules in the matching module); loot weights in `equipment/loot.ts`; HUD labels in `ui/equipment/labels.ts`; model spec in `tools/assets/equipment/config.ts` |
| Building prefab | `packages/shared/src/map/buildings/prefabs/*`; place it in `packages/shared/src/map/mapV1.ts`, then rebuild the bake |
| Bot tuning | `packages/shared/src/bots/profiles/profiles.ts` (difficulty table); zone schedule in `packages/shared/src/match/zone.ts` |

**Debug in the browser console** (DEV builds)

| Handle | Contents |
|---|---|
| `window.__twobullets` | `{ engine, scene, input, player, combat, equipment, life, presentation, hud, loot, inventory, assets, world, perf, net, match }` |
| `__twobullets.match` | With `?bots=1`: `state`, `bots`, `debug(slot)`, `events(n)`, `stats()`, `skipZone()`, `setZonePhase(n)`, `follow(slot)`, `killActor(slot)`, `killAll()`, `damageActor(slot, hp)`, `placeBot(slot, x, z)`, `navStats()`; `match` is the `OfflineMatch` |
| `__twobullets.net` | With `?net`: `client.stats`, `localNet.stats`, `roster.poses[slot]`, `connect()`, `disconnect()` |
| `window.__audio` | `__audio.help()` lists commands, e.g. `ab("sniper","rifle")`, `explosion(d)`, `ambience(true)` |
| `presentation` | `debugHit("body")`, `debugBlood({ intensity })`, `debugThrow("frag")`, `debugSmoke()`, `debugMolotov(6)`, `debugUse("energy_drink")` |
| `hud` | `hud.debugPreview("demo")` |
