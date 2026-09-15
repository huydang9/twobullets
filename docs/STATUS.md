# Project status

Last updated: 2026-09-15 13:45. Check `git log` and `git status` before acting on it. Nothing is running right now.

## Roadmap

| # | Phase | Status | Commits |
|---|---|---|---|
| M1–M2 | Movement, shooting, art swap, Map v1, audio, blood, perf | ✅ Done | see git history |
| M2.5 | Equipment (offline, server-ready) + real models, VFX, redesigned bag with item pictures | ✅ Done | `2169d6d`, `f57776a`, `a1e6bdf`, `762a1dc`, `7854d2e` |
| — | Map v1: cover props, 85 buildings, 4 minor POIs, ~4.2k trees; M map + minimap with blue zone | ✅ Done | `a36a539`, `fbf1274`, `943875f` |
| — | Offline bots on any map: nav, brain, MatchSim, HUD, animations; 2–20 players, solo/duo/squad | ✅ Done | `59c0d5a`…`32eb8ee`, `cb7cdc2` |
| — | Real-world maps (OpenStreetMap): Holašovice, Hội An–Cẩm Thanh, Shirakawa-go, Ngã Tư Hàng Xanh, Phan Đăng Lưu; generator CLI for any location; map picker | ✅ Done | `be9d025`, `a7dbbc5`, fix `5d0551a` |
| — | Vietnamese default UI, English selectable | ✅ Done | `9e43ff4` |
| M3–M4 | Networked movement + combat (prediction, lag comp, friendly fire, knock/revive) | ✅ Core done locally | `2df36fd`…`dacff59` |
| Release P1–P2 | server-api (guest auth, lobbies, quick queue, allocation, results), deploy kit, release plan + runbook | ✅ Built, not deployed | `bd329b8` |
| Release P3, B1, B2, B6 | server-match agent mode, BR phases + zone, maps on the server, server bots, roster names | ✅ Done (tests), not browser-played end to end | `9788093`, `5c0bd08`, `2abc5e5` |
| Release P4 | Front door (login, lobby, quick play, results, rejoin) + networked BR client (map, zone, phases, names, results) | ✅ Built; full flow not browser-played yet | `3b096e3`, `7816511` |
| B3 | Landing select + glide | ⏭ Next | |
| B5 | Networked loot and equipment (today everyone online gets rifle + pistol) | Planned (2 waves) | |
| B7 | Revive progress / teammate health on the wire | Planned | |
| B8 | Reconnect polish, full-state resync | Planned | |
| B9 | 20-player load check on the target VPS | Planned | |
| P5 | First deploy with friends (owner buys VPS + domain; `docs/release/runbook.md`) | Planned | |

## How to try things
- **Stable build (no agent reloads):** a git worktree of the last commit runs on `http://localhost:5175` (scratchpad `stable/`; update with `git checkout --detach <hash>`). `:5173` is the live dev server and reloads when agents edit code.
- **Menu:** `http://localhost:5173/` (login, practice, lobby). Full local online stack: `pnpm stack:dev -- --fast` (`docs/release/local-stack.md`).
- **Practice:** `?bots=1&map=<v1|cz-holasovice|vn-camthanh|jp-shirakawago|vn-hangxanh|vn-phandangluu>&players=10|16|20&mode=solo|duo|squad&difficulty=easy|normal|hard`.
- **Keys:** M map, N zoom, Tab bag, F3 FPS/stats, F6 net stats.

## Known issues / follow-ups
- **Hàng Xanh performance:** ~1.1M building triangles; needs an FPS check and cheaper far LODs for tube houses. Bots got stuck 14× in one headless match there (alley nav tuning).
- **Camera tilt** seen twice by the user in `?bots=1`; guard + console warning added (`8d4bac6`), root cause not found. Ask for the `[camera]` console warning if it recurs.
- **Networked BR gaps:** no landing/glide (B3), no loot/equipment online (B5), counters estimated from kill feed between PhaseChange messages, no revive progress for the reviver, Welcome lacks map id (arena zone radius copied locally), no lobby ready state in server-api.
- **Assets/visuals:** inventory icons for small items may still be dark; frag dust speckle; molotov flames look like separate tongues.
- **Infra not exercised:** Docker images never built here (no Docker), Caddy/compose/workflow only syntax-checked.
- **Docs:** netcode.md §6.4 lacks the `0x4D Roster` row; §11.1 still says hard resync fetches a full snapshot; `docs/equipment/inventory.md` §6 describes the old bag.

## Pending user decisions / actions
- Play practice on the new maps and report FPS (F3) on Hàng Xanh; say how bots feel.
- Try the full local online flow with `pnpm stack:dev -- --fast` (login → Tạo phòng → Bắt đầu).
- Run `?bench=v1` after the map densification and paste results.
- For release: buy a VPS (recommended OVH VPS-2 Singapore ~US$8.50/mo) and a domain; follow `docs/release/runbook.md`.
- Review the Vietnamese devlog (`docs/devlog/` chapters 13–18, uncommitted; today's afternoon work not written up).
- Spacing rule: minor POIs use 150 m spacing (the big ones 250 m) — keep or revert.

## Workflow notes
- Usage guard: stop all agents and rewrite this file if weekly Claude usage > 65% (hourly check from `~/.claude/usage-last.json`).
- Downloads of researched, license-checked assets don't need approval; never send personal info in API requests.
- Browser checks while agents edit client code: use the no-HMR verify server on :5174 or the stable worktree on :5175.

## Decisions log
Product decisions live in `CLAUDE.md` ("Product decisions"), including today's: up to 20 players with solo/duo/squad, real-world maps with a picker, Vietnamese default language. Backend defaults live in `docs/backend/architecture.md`, overridden by: friendly fire ON, 5 s revive, body blocking ON, lobby bots YES, internal release.
