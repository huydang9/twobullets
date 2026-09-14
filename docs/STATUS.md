# Project status

Last updated: 2026-09-15 (overnight session, ~06:30). Updated at the end of every phase by the `phase-complete` skill. Check `git log` and `git status` before acting on it.

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
| — | **Realistic throwables and gear:** CC0 flipbook VFX; real FP throw arms, grenades, consumables, helmet/vest/backpack | ✅ Done, browser-checked | `f57776a`, `a1e6bdf`, `762a1dc` |
| — | Cover props: big oaks, rocks, wrecks, sandbags, hay, pipes, spools; 432 placed on Map v1; radar roof reachable | ✅ Done, browser-checked | `6b63415`, `a36a539` |
| — | **Offline bots on Map v1** (5×2, zone, easy/normal/hard) | ✅ Nav (2 rounds), brain (2 rounds), MatchSim, client + HUD, Mixamo bot animations; full browser combat check pending | `fc4ced2`, `59c0d5a`, `bbd3ef3`, `258292e`, `32eb8ee`, `ea5356f`, `762a1dc` |
| M3 | **Networked movement** (local server + client prediction) | ✅ Core done locally: sim refactor, protocol, netcode, server-match (ws), client net; WebTransport, CI gates, Linux staging not done | `d093110`, `2df36fd`, `357c19f`, `7c1066b` |
| — | Real-world map (OpenStreetMap), optional | 🔍 Investigation done, waiting on user decisions | `15fb288` |
| M4 | **Networked combat** (friendly fire, knock/revive, respawn) | ✅ Core done locally: shared weapon step, protocol v2 events, reliable events, lag-comp rewind, server hitreg/damage/life, client prediction + presentation; browser-checked with 2 tabs. Not done: bot agreement gates, control plane/login/queue, playtest, ops | `f387fad`, `11f9089`, `063b672`, `4693985`, `dacff59` (pacing fixes) |
| M5 | BR loop networked: landing/glide, zone, equipment, knock/revive, lobby bots | Planned (offline versions exist) | |

## How to try things
- Offline arena `http://localhost:5173/`, full map `?map=v1` (knock/revive `&teammate=1`, armored targets `&targetArmor=1`).
- **Bot match:** `?bots=1&difficulty=easy|normal|hard` (implies Map v1). Extras: `&seed=`, `&zoneScale=0.25`, `&spectate=1`, `&botDebug=1`. Console: `__twobullets.match` (`state`, `debug(slot)`, `events(n)`, `follow(slot)`, `setZonePhase(n)`, `killAll()`).
- **Local multiplayer with combat:** `pnpm server:dev`, then windows at `?net=ws://localhost:7350&team=0&netId=alice` and `&team=1&netId=bob` (F6 net HUD). Details: `docs/backend/m4-local-run.md`.
- Props preview `/props.html`; equipment previews `__twobullets.presentation.debugThrow("frag")`, `debugSmoke()`, `debugMolotov(6)`, `debugUse("energy_drink")`.

## In progress
Nothing running.

## Known issues / follow-ups
- **Bots:** full browser combat not yet watched (headless: 6-9/10 armed by 90 s, 36% hit at 30 m on normal). Nav grid builds on the main thread (0.55 s Node, slower in browser) — move to the map worker. Contract gaps: `itemUse` event lacks item id, no loot `pickup` fx event (client infers both). Per-weapon third-person props.
- **Hidden-tab testing:** `?bots=1` froze when the first `scene.render()` happened after START in a hidden automation tab; rendering once before start avoids it. Not expected in a visible tab — user to confirm.
- **Visuals:** frag dust slightly speckled; molotov flames look like separate tongues; car wreck very dark.
- **Backend:** in `?net` equipment is still local (grenades/heals affect only that tab); no revive events on the wire (reviver sees a local estimate); spectate can't cycle (teams not replicated); damage on during warmup (M5 turns off); spread seed is per shotId only; M4 gates not built (bot hit-reg agreement 99%/97%, misprediction rate, input logs, OTel, agent mode); WebTransport, CI perf gates, Linux re-measure, body blocking in the sim.
- **Docs:** netcode.md §11.1 still says a hard resync fetches a full snapshot (it no longer does); `docs/equipment/art.md` still says there is no `assets:equipment` script (there is); `docs/bots/design.md` §9 still lists heal/throw clips as missing; `docs/architecture-overview.md` predates M4 combat.

## Pending user decisions
- **Real-world map** (`docs/research/real-world-map-investigation.md`): place (Holašovice recommended / Shirakawa-go / Hội An), elevation real/scaled/flat, building cap 60 vs ~120, Training Yard on real maps, diacritics in names.
- **Bot defaults** (agents used these): random start POI, death screen with spectate or new match, death drops the whole inventory, teammate bot uses the selected difficulty, ~11 min zone.
- Body blocking conflict: product rule ON vs architecture D6 (pass-through) — sim hook exists, not built.

## Pending user actions
- Play `?bots=1` in a visible tab and say how the bots feel (difficulty, aim, looting).
- Re-run `?bench=v1` (perf round 2 plus vegetation, VFX, cover props, bots) and paste the results; F4 numbers with `?bots=1&spectate=1`.
- Listen to the equipment sounds; review the Vietnamese devlog in `docs/devlog/` (chapters 13–18 cover tonight; uncommitted until you approve).

## Workflow notes
- Weekly usage guard: if weekly Claude usage > 50% (checked hourly from `~/.claude/usage-last.json`), stop all agents and rewrite this file as a resumable report.
- Downloads of researched, license-checked assets don't need the user's approval (user, 2026-09-15). Raw files and download records are in gitignored `assets-src/` (`DOWNLOADS-2026-09-15.md`, `DOWNLOADS-CC0-2026-09-15.md`).
- Browser checks while agents edit files: use a no-HMR Vite on :5174 (config in the session scratchpad) so pages don't reload mid-test.

## Decisions log
Product decisions live in `CLAUDE.md` ("Product decisions"). Backend defaults live in `docs/backend/architecture.md`, overridden by: friendly fire ON, 5 s revive, body blocking ON, lobby bots YES, internal release (no legal work).
