# Project status

Last updated: 2026-09-15 (overnight session, ~04:00). Updated at the end of every phase by the `phase-complete` skill. Check `git log` and `git status` before acting on it.

## Roadmap

| # | Phase | Status | Commits |
|---|---|---|---|
| M1 | First-person movement in a blockout arena | ✅ Done | `4f2940f` |
| M2 | Shooting: 4 weapons, projectile ballistics, target dummies | ✅ Done | `2c8324b` |
| — | Realistic art swap: DJMaesen FP weapons, Mixamo Swat soldiers, PBR environment, PUBG HUD | ✅ Done | `12f0d9c` |
| — | Backend design: netcode, runtime perf, platform, merged architecture | ✅ Done (design only) | `b9143f6` |
| — | Map v1: terrain, building kit, 7-POI layout, CC0 materials/props/vegetation | ✅ Done | `c919201`, `02925d4` |
| — | Audio v2 · blood · performance rounds 1–2 · rules/skills/docs | ✅ Done | `4843c7a`, `5d29a3f`, `5d050d6`, `7520858`, `cf7ec07` |
| M2.5 | **Equipment** (offline, server-ready rules) | ✅ Done, browser-verified | `f1e36ef`, `2169d6d` |
| — | Vegetation stability; chain-link alpha and wall gaps (user's "see through wall") | ✅ Done | `d8d6794`, `cd57479`, `a43cc02` |
| — | **Realistic throwables and gear:** CC0 flipbook VFX; real FP throw arms, grenades, consumables, helmet/vest/backpack | ✅ Done, browser-checked (medkit hold still large) | `f57776a`, `a1e6bdf` |
| — | Cover props library: big oaks, rocks, wrecks, sandbags, hay, pipes, spools | ✅ Library done; 🔄 placement on Map v1 running | `6b63415` |
| — | **Offline bots on Map v1** (5×2, zone, easy/normal/hard) | ✅ Nav, brain, MatchSim, client + HUD committed; browser check of combat pending | `fc4ced2`, `59c0d5a`, `bbd3ef3`, `258292e`, `32eb8ee` |
| M3 | **Networked movement** (local server + client prediction) | ✅ Core done locally: sim refactor, protocol, netcode, server-match (ws), client net; WebTransport, CI gates, Linux staging not done | `d093110`, `2df36fd`, `357c19f`, `7c1066b` |
| — | Real-world map (OpenStreetMap), optional | 🔍 Investigation done, waiting on user decisions | `15fb288` |
| M4 | Networked combat (friendly fire) | Planned | `docs/backend/architecture.md` |
| M5 | BR loop networked: landing/glide, zone, equipment, knock/revive, lobby bots | Planned (offline versions exist) | |

## How to try things
- Offline arena `http://localhost:5173/`, full map `?map=v1` (knock/revive `&teammate=1`, armored targets `&targetArmor=1`).
- **Bot match:** `?bots=1&difficulty=easy|normal|hard` (implies Map v1). Extras: `&seed=`, `&zoneScale=0.25`, `&spectate=1`, `&botDebug=1`. Console: `__twobullets.match` (`state`, `debug(slot)`, `events(n)`, `follow(slot)`, `setZonePhase(n)`, `killAll()`).
- **Local multiplayer (movement only):** `pnpm server:dev`, then two tabs at `?net=ws://localhost:7350/m/local` (F6 net HUD). Details: `docs/backend/m3-local-run.md`.
- Props preview `/props.html`; equipment previews `__twobullets.presentation.debugThrow("frag")`, `debugSmoke()`, `debugMolotov(6)`, `debugUse("energy_drink")`.

## In progress
| Area | Owner | Files | Next |
|---|---|---|---|
| Cover props placement on Map v1 + radar roof stair fix | map layout agent | `packages/shared/src/map/{mapV1.ts,layout/**}`, bake/checksums, nav/match test expectations | Browser-check viewpoints, commit; then nav wall-link fixes |

## Known issues / follow-ups
- **Bots:** browser combat not yet watched in a full match (headless: bots arm, shoot, 36% hit at 30 m on normal). Nav links through walls on four small buildings (farm sheds at (316.8, 273.8)/(312.3, 274.8), military containers 2 and 5), two town-house staircases where bots loop, tight quarry office door. Nav grid builds on the main thread (0.55 s Node; slower in browser) — move to the map worker. Per-weapon third-person props (Mixamo knocked/crawl/revive/heal/throw clips are in since `762a1dc`).
- **Hidden-tab testing:** a `?bots=1` page froze when the first `scene.render()` happened after START in a hidden automation tab; rendering once before starting avoids it. Not expected in a visible tab, but the user should confirm.
- **Equipment:** medkit held in first person covers the centre of the screen; frag dust slightly speckled; molotov flames look like separate tongues.
- **Backend:** WebTransport, CI perf gates, Linux re-measure, body blocking in the sim (hook in `CharacterBody` `MOVEMENT_COLLIDE_MASK`), `replication.ts` should move from server-match to netcode, protocol `quantize` duplicates shared `aim.ts`.
- **Docs stale:** `docs/map/terrain.md`, `docs/map/buildings.md` and `CLAUDE.md` still name pre-`packages/sim` folders; `docs/architecture-overview.md` lacks sim/protocol/netcode/server-match/bots.

## Pending user decisions
- **Real-world map** (`docs/research/real-world-map-investigation.md`): place (Holašovice recommended / Shirakawa-go / Hội An), elevation real/scaled/flat, building cap 60 vs ~120, Training Yard on real maps, diacritics in names.
- **Bot defaults** (agents used these): random start POI, death screen with spectate or new match, death drops the whole inventory, teammate bot uses the selected difficulty, ~11 min zone.
- Body blocking conflict: product rule ON vs architecture D6 (pass-through) — sim hook exists, not built.

## Pending user actions
- Play `?bots=1` in a visible tab and say how the bots feel (difficulty, aim, looting).
- Re-run `?bench=v1` (perf round 2 plus vegetation, VFX, cover props, bots) and paste the results; F4 numbers with `?bots=1&spectate=1`.
- Listen to the equipment sounds; review the Vietnamese devlog in `docs/devlog/` (tonight's phases not written up yet).

## Workflow notes
- Weekly usage guard: if weekly Claude usage > 50% (checked hourly from `~/.claude/usage-last.json`), stop all agents and rewrite this file as a resumable report.
- Downloads of researched, license-checked assets don't need the user's approval (user, 2026-09-15). Raw files and download records are in gitignored `assets-src/` (`DOWNLOADS-2026-09-15.md`, `DOWNLOADS-CC0-2026-09-15.md`).
- Browser checks while agents edit files: use a no-HMR Vite on :5174 (config in the session scratchpad) so pages don't reload mid-test.

## Decisions log
Product decisions live in `CLAUDE.md` ("Product decisions"). Backend defaults live in `docs/backend/architecture.md`, overridden by: friendly fire ON, 5 s revive, body blocking ON, lobby bots YES, internal release (no legal work).
