# Project status

Last updated: 2026-09-15. Updated at the end of every phase by the `phase-complete` skill. Check `git log` and `git status` before acting on it.

## Roadmap

| # | Phase | Status | Commits |
|---|---|---|---|
| M1 | First-person movement in a blockout arena | ✅ Done | `4f2940f` |
| M2 | Shooting: 4 weapons, projectile ballistics, target dummies | ✅ Done | `2c8324b` |
| — | Realistic art swap: DJMaesen FP weapons, Mixamo Swat soldiers, PBR environment, PUBG HUD | ✅ Done | `12f0d9c` |
| — | Backend design: netcode, runtime perf, platform, merged architecture | ✅ Done (design only) | `b9143f6` |
| — | Map v1: terrain, building kit, 7-POI layout, CC0 materials/props/vegetation | ✅ Done | `c919201`, `02925d4` |
| — | Audio v2: CC0 recordings, spatial mix, distance acoustics, footsteps | ✅ Done (ambience off by default) | `4843c7a` |
| — | Blood hit effects | ✅ Done | `5d29a3f` |
| — | Performance: bench, overlay, cascade culling; round 2 presets/terrain/shadows | ✅ Done (awaiting 2nd user bench) | `5d050d6`, `7520858` |
| — | Project rules, skills, architecture docs, STATUS.md | ✅ Done | `cf7ec07`, `6b3221f`, this commit |
| M2.5 | **Equipment** (offline, server-ready rules) | 🔄 Phase 1 committed; phase 2 built but uncommitted | `f1e36ef` |
| — | Real equipment models/animations/VFX; big-trunk trees, boulders, cover props | 🔄 Research in progress | — |
| — | Vegetation stability (trees unstable while moving) | 🔄 In progress | — |
| — | Offline match with bots on Map v1: 5 teams × 2, zone, easy/normal/hard | ⏭ Next | — |
| M3 | Networked movement | Planned | `docs/backend/architecture.md` |
| M4 | Networked combat (friendly fire) | Planned | |
| M5 | BR loop: landing/glide, zone, networked equipment, knock/revive, lobby bots | Planned | |

## Uncommitted work (equipment phase 2)
All 4 phase-2 agents reported done, with typecheck and 311 tests passing. The pieces are not yet integrated or browser-tested:

| Area | Contents | Location |
|---|---|---|
| Integration | Prone/crawl stance, boost speed, jump gate, fall damage, `respawnAt`, PlayerLife death/respawn, soldier blast reactions | `game/Game.ts`, `player/**`, `packages/shared/src/movement`, `targets/**` |
| Items/inventory/loot | Inventory weapon slots, ammo items, armor routing, loot rendering, F interaction, Tab inventory | `combat/**`, `equipment/EquipmentSystem.ts`, `equipment/loot/**`, `ui/inventory/**` |
| HUD + audio | Armor/boost/knocked HUD, cook/use rings, prompts, pickup feed, death recap, equipment sounds | `ui/equipment/**`, `audio/equipment/**` |
| Throwables presentation | Procedural hands and grenade meshes, smoke/fire/explosion/flash renderers | `equipment/presentation/**`, `viewmodel/HandsRig.ts` |

**To close the phase:**
1. Final wiring in `Game.ts`:
   - `LootRenderer` and `InventoryScreen`, with their per-frame updates
   - `soldierTargets(dummies, combat.targetArmor)`
   - construct presentation after `EquipmentSystem`
   - Engine antialias from `loadGraphicsSettings()`
2. Browser test of the full flow.
3. Commit, then update the devlog.

## Open user feedback
- **Throwing looks fake:** the procedural hands, grenades and effects need replacing with downloaded realistic models, FP throw animations and VFX textures (research running; downloads need user OK).
- **Trees:** "not stable when moving" (stability agent running). The user wants big-trunk trees with roots and big rocks/boulders as cover, using 3D models.
- **Blood:** may be too subtle on the dark uniform; offer an intensity tweak (`presentation.debugBlood({ intensity })`).

## Pending user actions
- Re-run `?bench=v1` after perf round 2 and paste the results.
- Listen to the equipment sounds (explosions, pin pull, bandage, fire loop, flash ring).
- Review the Vietnamese devlog in `docs/devlog/` (uncommitted until the user asks).

## Decisions log
Product decisions live in `CLAUDE.md` ("Product decisions"). Backend defaults live in `docs/backend/architecture.md`, overridden by: friendly fire ON, 5 s revive, body blocking ON, lobby bots YES, internal release (no legal work).
