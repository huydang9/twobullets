# M4 local run: networked combat on the arena

- **Scope:** T4.5 client combat networking against the T4.3/T4.6 `server-match` (commit `063b672`). See [architecture.md](architecture.md) §7.4, [netcode.md](netcode.md) §3.6, §5.7, §6.5 and [m3-local-run.md](m3-local-run.md) for the connection basics (server start, URL flags, F6 panel).
- **Authority in M4:** the server owns movement, weapons (ammo, fire rate, reloads), hits, damage, armor, knocks, revives, deaths and respawns. The client predicts its own movement and weapon, and presents everything else from server events.
- **Still local in `?net` mode:** equipment (grenades, heals, loot pickups) and its visuals. There are no practice dummies and no offline `PlayerLife`.

## Run it

1. Terminal 1: `pnpm --filter @twobullets/server-match dev` (add `-- --fake-net=typical` for a realistic link; `-- --max-players=20 --team-mode=squad` for a bigger match, then `&team=0..teamCount-1`).
2. Terminal 2: `pnpm dev`.
3. Open the tabs, ideally as separate windows side by side (hidden tabs are throttled):

   | Tab | URL | Why |
   |---|---|---|
   | A | `http://localhost:5173/?net=ws://localhost:7350&team=0&netId=alice` | shooter |
   | B | `http://localhost:5173/?net=ws://localhost:7350&team=1&netId=bob` | enemy of A |
   | C (knock/revive, friendly fire) | `http://localhost:5173/?net=ws://localhost:7350&team=1&netId=carol` | B's teammate |

   Add `&debug=hitboxes` to draw the shared procedural rig (green, what the server tests) over the bone-driven hitboxes of the rendered soldier (red).

   A third shooter without a browser: `pnpm --filter @twobullets/server-match load -- --clients=1 --fire --seconds=60`. It holds fire at the nearest player (dev token team 0).

## Server rules the client mirrors

All of these live in `apps/client/src/net/netCombatRules.ts`.

- **Loadout:** rifle, empty slot, pistol (`NET_WEAPON_LOADOUT`). Keys 1 and 3 switch (`select` = slot + 1).
- **Downed:** crawl gates, and fire, aim, reload and select are cleared before the step. At 0 HP you are knocked while a teammate is alive, otherwise killed.
- **Dead:** the server doesn't step you. The client stops predicting, holds the body, lowers the gun and spectates the killer over the shoulder. You respawn after 5 s with a fresh loadout and 100 HP, and prediction restarts from the server state.
- **Revive:** hold F (`Btn.interact`) within 2 m horizontally and 1.5 m vertically of a downed teammate for 5 s. The downed player sees BEING REVIVED from the owner vitals. The reviver sees a local REVIVING estimate.
- **Events:**
  - `Shot`: everyone but the shooter. Tracer, third-person flash, spatial gunshot, near-miss crack and world impact, played when the render timeline reaches the fire tick.
  - `PlayerHit`: everyone but the victim. Blood and flesh impact on the remote body.
  - `HitConfirm`: shooter only. Hitmarker, confirm sound, armor clank, kill notice (through `CombatSystem.onDamage`).
  - `DamageTaken`: victim only. Red direction arc. The health bar follows the owner vitals.
  - `Kill`: everyone. Death banner for you, kill blood pool for others.
  - `KillFeed` stream: the match kill feed (top right). Knocks are dimmer, and team kills get "(Team kill)".
- **Inputs:** every input carries `ackEventSeq`. Inputs with fire set carry `viewOffset8` = 8 × (input tick − rendered remote tick).

## Make tab A shoot tab B (console)

With real mouse control, click into each window and play. Automation or unfocused tabs refuse pointer lock, so fake it in **tab A**:

```js
const g = __twobullets, net = g.net;
Object.defineProperty(g.input, "isLocked", { get: () => true, configurable: true });
g.hud.setLocked(true);
net.remotes();                 // → [{ slot, x, y, z, life }]; B is the only entry with two tabs
net.aimAt();                   // aims at the first remote's chest (net.aimAt(slot, 1.6) for the head)
document.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
setTimeout(() => document.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true })), 1500);
```

The render loop must be running: the tab is visible, or a window that isn't minimized. `aimAt` aims once, so call it again if B moves. Recoil climbs over a long burst; for single shots, tap with `mousedown`/`mouseup` 100 ms apart.

What to check:

| Where | Expect |
|---|---|
| A | Instant muzzle flash and recoil. The ammo count drops. Then a hitmarker with the confirm sound about RTT + 20 ms later. With no RTT, a faint body thud plays first when the local tracer crosses B's rig (cosmetic prediction). |
| B | A's tracer, gunshot and crack. A red arc points at A. The health bar drops. Blood appears on B's body in A's view. |
| Kill (two teams, no teammate standing) | A: kill notice "YOU KILLED PLAYER …" and a feed line. B: "YOU WERE KILLED" banner, killer and distance, spectating A, then respawns after 5 s at full health. |
| F6 on A | `weapon mispredict 0/min`, `confirms` counting up, `events N (dup M)`, `life alive`. On B: `dmg taken` counting up, `life dead` → `alive`. |

## Friendly fire, knock and revive (three tabs)

1. Tabs A (team 0), B and C (both team 1). B and C stand close together.
2. **Friendly fire:** in C, `net.aimAt(<B's slot>)` and fire. B takes damage. When B's health reaches 0 and C is alive, B is knocked: KNOCKED on the health bar, crawling, gun lowered. The feed reads "Player … knocked Player …".
3. **Revive:** walk C onto B (≤ 2 m) and hold F. In the console: `window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF" }))`, then `keyup` after 5.5 s. C shows REVIVING; B shows BEING REVIVED. After 5 s, B stands up with 10 HP.
4. **Bleed-out:** knock B again and wait. B's pool drains. The kill is credited to the knocker as `bleedOut`.
5. **Team wipe:** knock B while C is dead. B is killed with "teamWipe".
6. **Team kill:** C kills a knocked B. The feed line ends in "(Team kill)", and so does B's death banner.

## Headless checks

`pnpm --filter @twobullets/client test` runs everything in `apps/client/test/net/`. `NET_VERBOSE=/tmp/net.jsonl` appends each run's numbers.

- **`weaponPrediction.test.ts`:** the real `NetClient`, `LocalPlayerNet` and `stepPlayer(..., { weapons: true })` on both sides over LinkConditioner, with fire bursts, ADS, reloads and weapon switches while moving.
  - lan: 0 corrections, 0 weapon mispredictions, every server shot presented once.
  - typical: 3 seeds × 60 s give 2 / 11 / 1 weapon mispredictions.
  - A server that drops fire for whole bursts: corrected, replays produce no shots, and reused shot ids are suppressed.
- **`netCombatEvents.test.ts`:** bit-packed snapshots with reliable resends and the `KillFeed` stream through the real decode path. Each HUD/presentation call happens exactly once with dequantized values. A `Resync` resets the receiver.
- **`localPlayerNet.test.ts`:** the M3 movement-only regression.

## Known gaps

- Equipment isn't networked (M5). Local grenades and heals still run in `?net` mode and affect only this tab.
- Spectating follows the killer, or the first player still standing. There's no cycling, and teammates can't be identified: the protocol doesn't replicate teams.
- The reviver's progress ring is a local estimate. The server reports progress only to the downed player.
- A shot the server fired that the client first learns about during a replay isn't presented. By design (R11), replays never emit.
- `PlayerHit` has no weapon id, so remote blood uses rifle-sized effects.
- `ClientSnapshotStore.decode` drops a snapshot whose delta baseline is gone, and its `Shot` events go with it. Reliable events are resent, so they aren't lost.
