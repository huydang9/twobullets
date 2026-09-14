# Project status

Last updated: 2026-09-15 (overnight session). Updated at the end of every phase by the `phase-complete` skill. Check `git log` and `git status` before acting on it.

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
| — | Project rules, skills, architecture docs, STATUS.md | ✅ Done | `cf7ec07`, `6b3221f`, `e2a18a7` |
| M2.5 | **Equipment** (offline, server-ready rules) | ✅ Done, browser-verified | `f1e36ef`, `2169d6d` |
| — | Vegetation stability (LOD hysteresis/cross-fade, zoom-aware LOD, cover never culls) | ✅ Done, browser-checked | `d8d6794` |
| — | Chain-link fence renders solid black; wall gaps 2× too wide (user's "see through wall" report) | 🔄 Fix agent running | — |
| — | Real equipment models/animations/VFX; big-trunk trees, boulders, cover props | 🔄 Research done (`docs/assets-research/`); downloads pending | — |
| — | Real-world map (OpenStreetMap) as an optional map | 🔍 Investigation only (user: "don't touch anything") | — |
| M3 | Networked movement | 🔄 T3.0 skeleton done; T3.1 sim refactors + T3.2/T3.3 protocol/netcode running | `d093110` |
| — | Offline match with bots on Map v1: 5 teams × 2, zone, easy/normal/hard | ⏭ After M3 core (user asked for backend tonight) | — |
| M4 | Networked combat (friendly fire) | Planned | `docs/backend/architecture.md` |
| M5 | BR loop: landing/glide, zone, networked equipment, knock/revive, lobby bots | Planned | |

## In progress (overnight)
| Area | Owner task | Files | Next |
|---|---|---|---|
| Sim refactors R1–R14 + real `stepPlayer` (movement) | T3.1 | `packages/shared/**` (except `map/layout/placement.ts`), `packages/sim/**`, `apps/client/src/{player,combat,game}/**` | Browser-check offline feel, commit; then T3.4 server-match + T3.5 client net |
| Protocol codecs + netcode lib | T3.2/T3.3 | `packages/protocol/**`, `packages/netcode/**` | Commit; T3.4 uses them |
| Chain-link alpha + gap trimming | map fix | `world/props/**`, `map/layout/placement.ts`, Map v1 bake/checksums | Browser-check at (240, −285) yaw 80 and the user's spot (100, −347) yaw 64 scoped |
| Real-map investigation | research | none (report only) | Present report; user picks place and scope |

**Backend plan for the rest of the night:** T3.4 server-match (MatchHost, scheduler, ws transport, sessions) and T3.5 client net (NetClient, prediction glue, remote players) once T3.1–T3.3 land; T3.6 bots + in-process integration test. Hosting (OVH), CI soak, control plane, login/queue and playtests need the user and are not started.

## Open user feedback
- **Throwing looks fake:** replace procedural hands/grenades/effects with the researched set (`docs/assets-research/equipment-environment-2026-09-15.md`). CC0 sources (Unity Labs flipbooks, Poly Haven rocks/medkit, Kenney particles) can be fetched without asking. Sketchfab/Mixamo downloads go through the user's Chrome and need one "y" per batch in chat.
- **Trees/rocks:** user wants big-trunk trees and big boulders as cover (picks in the research doc).
- **Blood:** may be too subtle on the dark uniform; offer `presentation.debugBlood({ intensity })`.
- **Architecture conflict:** `docs/backend/architecture.md` D6 assumes players pass through each other; product rule is body blocking ON. The contract carries a `bodyBlocking` flag; sim needs player capsules later.

## Pending user actions
- One "y" for the Sketchfab + Mixamo download batch (list in the research doc's starter set).
- Real-map decisions after the investigation report (place, real vs flat elevation, building count).
- Re-run `?bench=v1` after perf round 2 and the vegetation changes, and paste the results.
- Listen to the equipment sounds; review the Vietnamese devlog in `docs/devlog/` (uncommitted until asked; tonight's phases not yet written up).

## Workflow notes
- Weekly usage guard: if weekly Claude usage > 50% (checked hourly from `~/.claude/usage-last.json`), stop all agents and rewrite this file as a resumable report.
- Downloads from open APIs don't need the user's OK; browser downloads need one batched "y".

## Decisions log
Product decisions live in `CLAUDE.md` ("Product decisions"). Backend defaults live in `docs/backend/architecture.md`, overridden by: friendly fire ON, 5 s revive, body blocking ON, lobby bots YES, internal release (no legal work).
