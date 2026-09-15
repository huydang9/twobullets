# Local stack: front door → lobby → networked match vs bots

- **Date:** 2026-09-15
- **Scope:** run the whole internal-release loop on one machine, without Docker: server-api (login, lobby, queue, match processes, results) and the Vite client. Related: [plan.md](plan.md) (what the MVP is), [runbook.md](runbook.md) (the VPS), [../backend/m4-local-run.md](../backend/m4-local-run.md) (the `?net=` developer flow).

## What runs

| Process | Started by | Port | Notes |
|---|---|---|---|
| server-api | `pnpm stack:dev` | 8080 | `TB_ALLOCATOR=process`, `TB_CORS_ORIGINS=http://localhost:5173`, dev JWT keys generated on first run in `apps/server-api/.data/` (git-ignored), SQLite results there too |
| server-match (one per match) | server-api | 7400–7419 | `--mode=agent`: loads the lobby's map (Map v1 or a real-world map), runs the battle royale loop, fills empty seats with server bots, reports the result, exits |
| Vite client | `pnpm stack:dev` | 5173 | the menu at `/`; the game module loads only when a match starts |

`tools/dev/stack.ts` prefixes each process's log (`[api]`, `[web]`) and stops everything, match processes included, on Ctrl+C or when one of them exits.

## Play a match against bots

1. Memory first: the stack plus one match needs about 1.5 GB. Close other heavy processes (`sysctl vm.swapusage`).
2. Start it:

   ```sh
   pnpm stack:dev -- --fast     # --fast: 20 s warmup, zone ×0.35 (≈4 min), 5 s quick-play wait
   pnpm stack:dev               # real timings: 60 s warmup, ≈11 min zone
   ```

   Wait for `[api] … allocator process` and `[web] … Local: http://localhost:5173/`.
3. Open http://localhost:5173 in a normal (visible) browser window.
4. **Login:** type a nickname (3–16 characters), press **Vào chơi**.
5. **Lobby:** **Tạo phòng** → mode **Đôi**, players **4–10**, map **Map v1** (or a real-world map), **Thêm bot vào chỗ trống** on → **Bắt đầu**.
   - Or **Chơi nhanh**: pick a mode and size; with nobody else queued the match starts with bots after the quick-play wait.
6. **Connecting:** "Đang vào trận…" while server-api starts the match process (Map v1 + nav grid ≈ 1–2 s), then the map loads in the browser.
7. **In the match:**
   - Click the page to lock the mouse.
   - Warmup: "Trận bắt đầu sau 20s" banner (the last 5 s as a big number); damage off, respawns on.
   - Combat: everyone is put on their team's start. Alive/teams counters top right, zone timer under the compass, blue wall, blue screen edge outside the zone, 30 s / 10 s zone warnings. Teammate cards bottom left and a name over your teammate. **M** opens the map with both circles.
   - Kill feed with nicknames and "Bot n"; your team's lines are highlighted.
   - Death: the death screen after a second. **Theo dõi đồng đội** follows a teammate (or your killer); **[** and **]** cycle, **Enter** reopens the screen. No respawn in combat. **Rời trận** goes back to the menu, which offers **Vào lại trận** while the match runs.
8. **End:** the in-game result (placement, kills, damage, survival). **Xem kết quả** (or 10 s) opens the front-door results table (every player, bots marked); **Về sảnh** returns to the lobby (or the main menu after quick play) without a manual reload.

## Without server-api (developer shortcut)

```sh
pnpm --filter @twobullets/server-match dev -- --flow=br --map=v1 --max-players=4 --warmup-seconds=20 --time-scale=0.35
pnpm dev
# http://localhost:5173/?net=ws://localhost:7350&map=v1&zoneScale=0.35&netId=alice
```

Dev tokens instead of server-api's; bots fill empty seats when warmup ends; no results screen after the end (the in-game result has **Đóng**). `&zoneScale=` only tells the HUD the time scale before the first zone phase is announced.

## Troubleshooting

| Symptom | Check |
|---|---|
| Login shows "Không kết nối được máy chủ" | server-api isn't up (`[api]` log) or the page isn't on `http://localhost:5173` (CORS) |
| Stuck on "Đang vào trận…", then "Máy chủ đang bận" | match process failed to start: look for `[api] … server-match` errors; `TB_MAX_MATCHES` (4) reached |
| "Có bản cập nhật mới, tải lại trang" | client and servers built from different protocol versions: restart the stack after pulling |
| A red "Không khởi động được trận" / "Trò chơi gặp lỗi và đã dừng" panel | the message and stack say what failed; copy them into the bug report |
| Results say "Trận đã bị hủy" | nobody connected within 120 s of allocation, or the stack was stopped during warmup |

## Known gaps (MVP)

- **B3:** no landing select or glide; teams start on the ground at their spawn.
- **B5:** no loot or networked equipment; everyone keeps the starting rifle and pistol. Local grenades/heals only affect your own screen.
- **B7:** teammates' health and revive progress aren't replicated (cards show standing/knocked/dead only); the reviver's progress is a local estimate.
- **B8:** a tab reload mid-match lands on the menu with **Vào lại trận**; the full-state resync and per-phase grace are still to do.
