# Quitting a match

- **Audience:** the owner. Plain language; the wire details are in [../backend/netcode.md](../backend/netcode.md) §6.9.
- **Scope:** leaving a match on your own, ending it for everyone, and starting the next one.

## 1. What a player can do

| From | Action | What happens |
|---|---|---|
| In a match (Esc) | **Rời trận (một mình)** / Leave the match (just me) | You go back to the front door. The match carries on for everyone else. |
| In a match (Esc), host only | **Kết thúc trận cho tất cả** / End the match for everyone | Asks once, then the match ends for everybody: results are scored as they stand, everyone lands on the results screen, and the match server shuts down. |
| Death screen, spectating (Esc) | the same two | Being dead never traps you: see §2. |
| Results screen | **Chơi lại** / Play again | The same mode, size, map and bots. Back into the same lobby when it still exists, otherwise a new one; a quick-play match queues again. |
| Results screen | **Về sảnh** / Back to menu | The front door. |
| Front door, rejoin card | **Vào lại trận** / Rejoin | Back into the match that is still running. |
| Front door, rejoin card | **Chơi trận mới** / Start a new match | Gives that match up and opens a new one with the same mode, size and map (a new lobby, or the queue again). |
| Front door, rejoin card | **Thoát hẳn / bỏ trận** / Abandon this match | Asks once, then gives the match up: the card is gone for good. See §3.1. |
| Practice (`?bots=1`) | **Chơi lại** and **Thoát ra menu** | A new match with the same settings, or back to the menu. "End for everyone" is meaningless offline and is hidden. |

## 2. Esc and the mouse

The browser reserves **Esc** for releasing the mouse, and never passes that key press to the page. So:

- **While playing**, Esc releases the mouse — and that is what opens the pause menu.
- **Esc again**, or **Tiếp tục chơi** (Resume), closes the menu and takes the mouse back.
- Tab (bag) and M (map) release the mouse too; the pause menu deliberately stays shut while either is open.
- Esc inside the "are you sure?" step goes back one step instead of resuming.

**Once you are dead the mouse is already free, so the Esc key itself reaches the page** — and that is what opens the pause menu over the death screen, over spectating and over the result screen. The first button then reads **Quay lại màn hình trận** (Back to the match screen) instead of Resume, because there is no mouse to take back. The spectating strip says so: `[ ] đổi người · Esc: tùy chọn`.

So a dead player is never trapped, in every state:

| State | Leave | Host: end for everyone |
|---|---|---|
| Knocked (not out yet) | Esc → pause menu | Esc → pause menu |
| Dead, death screen up | **Rời trận** on the screen, or Esc | **Kết thúc trận cho tất cả** on the screen (it asks first), or Esc |
| Dead, spectating | Esc | Esc |
| Match over, result screen up | **Xem kết quả**, or Esc → **Xem bảng kết quả** | — (the match already ended) |
| Practice, dead or finished | **Trận mới** / **Về menu** on the screen, or Esc | — (offline) |

## 3. What leaving costs

Battle royale has no free exit once the fighting starts, so leaving alone is treated exactly like closing the tab and never coming back:

- **During warmup:** you simply give up your slot. Nothing is recorded, and somebody else could take it.
- **After warmup:** you are **eliminated**. Your inventory drops as a death pile where you stood, your placement is recorded, and if you were the last one standing on your team, the team is out. Teammates see you leave the roster.
- Either way the server closes your connection with "you left", so the reconnect grace does not keep a ghost standing in the world.
- The match keeps running for the others, but the menu will not offer you "Vào lại trận" for it: quitting is meant to be final. (Closing the tab by accident still offers a rejoin, as before.)

### 3.1 Abandoning from the front door

The rejoin card is an offer, not a trap. Next to **Vào lại trận** it carries **Chơi trận mới** and **Thoát hẳn / bỏ trận**, and both give the match up:

- `POST /v1/matches/{id}/leave` tells server-api the account is done with it. The API drops its active-match pointer — which is what was blocking a new lobby or a new queue ticket with `alreadyInMatch` — and bumps the account's join epoch, so a join token already in hand is stale and cannot put a ghost back in. The match process is not touched: it runs on for the others and ends on the normal rules, and the reconnect grace eliminates the missing player as it always did.
- The client also remembers the match id (`tb.menu.leftMatch`), so the card does not come back after a reload while the match is still running.
- **Thoát hẳn / bỏ trận** asks once in place before it does any of this; the card never disappears on its own, only when the player abandons it or the match ends.
- **Chơi trận mới** does the same and then opens a fresh private lobby with the mode, size and map of the match it dropped (or queues again, for a quick-play match). The old lobby is still busy, so this is always a new one.

## 4. Who may end a match for everyone

- The **lobby host**. `MatchConfig.hostAccountId` carries that account to the match server, and the server refuses the request from anyone else.
- **Quick play has no host**, so nobody can end those matches early; they end on the normal rules.
- **If the host leaves**, the right moves to the connected human in the **lowest slot**. Everybody's pause menu follows along, because the roster message carries a "host" bit.
- Bots are never asked and never inherit the right.

When the host ends a match, teams still in play are ranked as if the time limit had been reached, so every player has a placement. The match is stored as `completed` (or `cancelled` when the host ends it before the fighting starts), and the results screen says "Chủ phòng đã kết thúc trận".

## 5. What the server frees

Ending a match runs the normal end path, not a socket kill:

1. `MatchEnd` to every client (reason `hostEnded`), so the in-game result screen appears.
2. The result summary goes to `server-api`, which stores it and marks the match finished.
3. After the end linger the match closes, the process exits, and the allocator frees its port and slot.
4. The lobby reopens by itself, so the same party can press **Bắt đầu** again.

## 6. Trying it in two tabs

```bash
pnpm stack:dev -- --fast
```

1. Tab A: log in as **Host**, *Tạo phòng*, copy the 6-letter code.
2. Tab B (a different browser profile, or a private window so it is a different account): log in as **Friend**, *Vào phòng bằng mã*, paste the code.
3. Tab A: *Bắt đầu*. Both tabs load the match; bots fill the rest.
4. In tab B press **Esc**: the pause menu shows only **Rời trận (một mình)** — no "end for everyone", because B is not the host. Leave; tab B lands on the front door while tab A keeps playing, and the kill feed / roster in tab A shows B gone.
5. In tab A press **Esc**: it also offers **Kết thúc trận cho tất cả** with "Bạn là chủ phòng" under the title. Confirm it; the results screen appears in tab A.
6. On the results screen press **Chơi lại**: tab A goes back into the same lobby, ready to start another match.

Checks worth making: the match server process for the old match is gone (`ps` or the stack log), the lobby code still works for tab B, and the results list every player with a placement.

### Abandoning and dying

7. Start another match from tab A and, in tab B, **close the tab mid-match** and open the front door again: the rejoin card is there.
8. Press **Thoát hẳn / bỏ trận** and confirm. The card goes, and *Tạo phòng* now works instead of answering "bạn đang ở trong một trận" — that is the API's active-match pointer being freed. Reload: the card stays gone.
9. Do it again with **Chơi trận mới** instead: tab B lands straight in a new lobby with the same mode, size and map.
10. In tab A, get killed (or `__twobullets.match` helpers offline). On the death screen press **Theo dõi** to spectate, then **Esc**: the pause menu opens over it with **Rời trận (một mình)**, and **Kết thúc trận cho tất cả** while you are the host. Both still work.
11. Offline (`?bots=1`): die, spectate, press **Esc** — **Chơi lại (trận mới)** and **Thoát ra menu** are there too.
