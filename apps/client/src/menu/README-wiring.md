# Front door: wiring

The menu (`menu/`) and the server-api client (`platform/`) hand over to the game through an explicit launch
(`game/launch.ts`), so networked play and practice work in production builds.

## Launches

| Launch | From | Game.create does |
|---|---|---|
| `{ kind: "net", wsUrl, accountId, teamId, mapId, matchId, tokens, onExit }` | `MenuController.connect` → `main.ts startNetworkedGame` (`netGameLaunch`) | loads `mapId` (`resolveMapDefinition`), joins with server-api join tokens (`tokens()` per connect, so rejoins get fresh ones), `NetMatch` presents phases, zone, roster names, death and results; no ground loot |
| `{ kind: "practice", options, mapId }` | production `?bots=1&players&mode&difficulty&map` (menu practice reloads with `practiceSearch`) | offline bot match on `mapId` |
| `{ kind: "dev" }` | DEV URLs with game flags | `?net=` (+ `&map=`, default arena), `?bots=1`, `?map=`, `?bench=` exactly as before |

`resolveLaunch` is the single place that decides; `test/game/launch.test.ts` covers it.

## Entry (`main.ts`)

- `shouldShowMenu(search)`: no query params besides `?lang=` → the menu. Production: always the menu, except `?bots=`
  (practice). DEV: any game flag starts the game directly.
- `Game` is imported dynamically, so the menu paints before Babylon and Havok download.
- A start failure or a throwing frame shows `ui/FatalError` (message, stack, reload, back to menu) instead of a frozen
  picture or a stuck loading card.

## After the match

1. `MatchEnd` → the in-game result screen (`NetMatch`). Meanwhile the menu may already know the match ended
   (`match.updated` push or polling): it moves to `results` with `awaitingGame: true`, stays hidden and loads the result.
2. **Xem kết quả** (or 10 s) → `onExit({ reason: "ended" })` → `MenuController.gameExited` → `gameExited` event → the
   results table shows over the game (`awaitingGame: false`). If the game never hands over (lost `MatchEnd`), the menu
   takes over after `GAME_HANDOFF_TIMEOUT_MS`.
3. **Về sảnh** → `reloadToMenu()`: a navigation to the menu URL (the game can't be torn down in place). Boot resync lands
   in the lobby when the account is still in one, else the main menu.
4. **Rời trận** during the match → `onExit({ reason: "left" })` → straight back to the menu, which offers "Vào lại trận"
   while the match runs and shows its results on a later boot.

## Local run

See [docs/release/local-stack.md](../../../../docs/release/local-stack.md): `pnpm stack:dev -- --fast`.
