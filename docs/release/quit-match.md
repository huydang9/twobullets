# Quitting a match

- **Audience:** the owner. Plain language; the wire details are in [../backend/netcode.md](../backend/netcode.md) §6.9.
- **Scope:** leaving a match on your own, ending it for everyone, and starting the next one.

## 1. What a player can do

| From | Action | What happens |
|---|---|---|
| In a match (Esc) | **Rời trận (một mình)** / Leave the match (just me) | You go back to the front door. The match carries on for everyone else. |
| In a match (Esc), host only | **Kết thúc trận cho tất cả** / End the match for everyone | Asks once, then the match ends for everybody: results are scored as they stand, everyone lands on the results screen, and the match server shuts down. |
| Results screen | **Chơi lại** / Play again | The same mode, size, map and bots. Back into the same lobby when it still exists, otherwise a new one; a quick-play match queues again. |
| Results screen | **Về sảnh** / Back to menu | The front door. |
| Practice (`?bots=1`) | **Chơi lại** and **Thoát ra menu** | A new match with the same settings, or back to the menu. "End for everyone" is meaningless offline and is hidden. |

## 2. Esc and the mouse

The browser reserves **Esc** for releasing the mouse, and never passes that key press to the page. So:

- **While playing**, Esc releases the mouse — and that is what opens the pause menu.
- **Esc again**, or **Tiếp tục chơi** (Resume), closes the menu and takes the mouse back.
- Tab (bag) and M (map) release the mouse too; the pause menu deliberately stays shut while either is open, and while a death or result screen is up.
- Esc inside the "are you sure?" step goes back one step instead of resuming.

## 3. What leaving costs

Battle royale has no free exit once the fighting starts, so leaving alone is treated exactly like closing the tab and never coming back:

- **During warmup:** you simply give up your slot. Nothing is recorded, and somebody else could take it.
- **After warmup:** you are **eliminated**. Your inventory drops as a death pile where you stood, your placement is recorded, and if you were the last one standing on your team, the team is out. Teammates see you leave the roster.
- Either way the server closes your connection with "you left", so the reconnect grace does not keep a ghost standing in the world.
- The match keeps running for the others, but the menu will not offer you "Vào lại trận" for it: quitting is meant to be final. (Closing the tab by accident still offers a rejoin, as before.)

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
