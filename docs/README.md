# Documentation index and how-to

Start with [`architecture-overview.md`](architecture-overview.md) for the tech stack, repo layout, runtime architecture and data flows. Project rules for Claude are in [`../CLAUDE.md`](../CLAUDE.md).

## Docs map

| Area | Doc | What's inside |
|---|---|---|
| Overview | [architecture-overview.md](architecture-overview.md) | Stack, layout, frame loop, contracts, data flows |
| Backend (planned) | [backend/architecture.md](backend/architecture.md) | Merged decisions, reconciled capacity/bandwidth/cost, SLOs, prerequisite refactors, M3–M5 plan, risks |
| | [backend/netcode.md](backend/netcode.md) | Authority, tick and snapshot rates, prediction, lag compensation, protocol, transport, equipment and audio replication |
| | [backend/runtime-performance.md](backend/runtime-performance.md) | Node vs Rust, Havok tick benchmarks, process model, scheduler, CI gates |
| | [backend/platform.md](backend/platform.md) | Matchmaking, hosting, join tokens, data stores, observability, cost |
| | [backend/adr/README.md](backend/adr/README.md) | ADR index (00xx principal, 01xx platform, 02xx netcode, 03xx runtime) |
| Assets | [assets-plan.md](assets-plan.md) | Vetted free asset sources and license rules |
| | [assets-pipeline.md](assets-pipeline.md) | Weapons and character GLB pipeline, clip tables, loader API |
| | [map/environment-assets.md](map/environment-assets.md) | Terrain and building textures, props, vegetation models, PropLibrary contract |
| Map | [map/terrain.md](map/terrain.md) | Heightfield, flatten API, surface mask, LOD, physics, MapData contract |
| | [map/buildings.md](map/buildings.md) | Building kit, prefabs, collision, placement API, budgets |
| | [map/layout.md](map/layout.md) and [map/mapV1.svg](map/mapV1.svg) | POIs, roads, scatter, load-time bake, out-of-bounds, audio hooks |
| Equipment | [equipment/design.md](equipment/design.md) | Item stats, rules, state diagrams, EquipmentView contract, bindings |
| | [equipment/inventory.md](equipment/inventory.md) | Weapon slots, ammo migration, loot rendering, interaction, inventory UI |
| Audio | [audio.md](audio.md) | Sources and credits, pipeline, engine, weapon loudness hierarchy, equipment sounds, DEV commands |
| Effects | [fx-blood.md](fx-blood.md) | Blood mist, decals, wounds, settings |
| Performance | [perf/benchmark.md](perf/benchmark.md) | How to run `?bench=v1`, variants, flags, graphics presets |
| Devlog (Vietnamese) | [devlog/00-tong-quan.md](devlog/00-tong-quan.md) | Blog series overview, timeline, chapters, lessons (`bai-hoc.md`) |

## How to…

**Run the game**
```bash
pnpm install
pnpm dev                      # http://localhost:5173
```
- `/` is the arena with the soldier target range; `?map=v1` is the full 1×1 km map.
- `/buildings.html` previews building prefabs.
- Controls: WASD, mouse, Space, Shift sprint, C crouch, LMB fire, RMB aim, R reload/cook, 1–3 weapons, 5 throwable, G cycle throwable, F pick up/revive, Tab inventory, X holster, 7/8/9/0 heals. F3 stats, F4 perf, F8 physics shapes, F9 inspector.
- Test flags: `?teammate=1` (knock/revive), `?targetArmor=1`, `?quality=high|balanced|performance`, `?opt=off` or `?opt=<flag>:0`.

**Check code**
```bash
pnpm typecheck
pnpm test
pnpm build
```

**Measure performance** (visible tab, don't touch for about 10 min): open `http://localhost:5173/?bench=v1`, then click "Copy results". Use `&variants=0` for the quick run. Details: [perf/benchmark.md](perf/benchmark.md).

**Add or rebuild assets**
- Raw files go in `assets-src/…` (gitignored). Licenses must be CC0/CC-BY/Mixamo; record credits.
- Weapons and characters: `pnpm assets` → `pnpm assets:verify` (config in `tools/assets/config.ts`).
- Environment textures, props and vegetation: `node --experimental-transform-types tools/environment/fetch.mjs` / `process.mjs` / `props.mjs` / `verify.mjs` (see `docs/map/environment-assets.md`).
- Audio: `node tools/audio/pipeline.ts` (use `--only=` for a subset) → `node tools/audio/verify.ts`.
- Map terrain bake after changing MapData: `node --experimental-transform-types --import ./tools/map/lib/resolve.ts tools/map/build.ts` (add `--check` to verify only).

**Add a weapon, item or building (where to edit)**

| To add | Edit |
|---|---|
| Weapon | stats in `packages/shared/src/weapons/weapons.ts`; model and clips via `tools/assets/config.ts`; viewmodel profile in `apps/client/src/viewmodel/weaponProfiles.ts` |
| Item | `packages/shared/src/equipment/items.ts` (plus rules in the matching module); loot weights in `equipment/loot.ts`; HUD labels in `ui/equipment/labels.ts` |
| Building prefab | `packages/shared/src/map/buildings/prefabs/*`; place it in `packages/shared/src/map/mapV1.ts`, then rebuild the bake |

**Debug in the browser console** (DEV builds)

| Handle | Contents |
|---|---|
| `window.__twobullets` | `{ engine, scene, player, combat, equipment, presentation, hud, assets, life, world }` |
| `window.__audio` | `__audio.help()` lists commands, e.g. `ab("sniper","rifle")`, `explosion(d)`, `ambience(true)` |
| `presentation` | `presentation.debugHit("body")`, `presentation.debugBlood({ intensity })` |
| `hud` | `hud.debugPreview("demo")` |
