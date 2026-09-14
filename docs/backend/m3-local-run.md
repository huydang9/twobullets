# M3 local run: networked movement on the arena

> **M4 update:** combat is networked now. See [m4-local-run.md](m4-local-run.md) for shooting, damage, knock/revive and the kill feed. The connection steps, URL flags and F6 panel below still apply.

- **Scope:** T3.5 client networking against the T3.4 `server-match` in local mode. See [architecture.md](architecture.md) §7.3 and [netcode.md](netcode.md) §3, §4, §7 and §11.
- **Authority in M3:** the server is authoritative for **movement only**. Combat, equipment, target dummies, loot, health and the HUD stay local/offline, as in single player. Shots don't reach other players, and nobody takes damage from them.

## Run it

1. Start the match server (terminal 1):

   ```sh
   pnpm --filter @twobullets/server-match dev
   ```

   It listens on `127.0.0.1:7350` and serves the match `ws://localhost:7350/m/local`, the dev token endpoint `GET /dev/token?sub=<id>&team=<0..4>` and `GET /healthz`.
   - Add `-- --fake-net=typical` (or `lan`, `good`, `bad`, `awful`, `tcp-fallback`) to impair the server's links in process.
   - Add `-- --exit-after=<seconds>` to have it stop by itself.
2. Start the client (terminal 2): `pnpm dev`.
3. Open **two browser tabs** (or two windows side by side, which avoids hidden-tab throttling):

   ```
   http://localhost:5173/?net=ws://localhost:7350/m/local
   ```

4. Click to play in each tab and walk around. Each tab sees the other as a soldier.

### URL flags (DEV builds)

| Flag | Meaning |
|---|---|
| `?net=ws://host:port/m/local` | Join that match. `ws://localhost:7350` alone gets `/m/local` added. The token endpoint is derived from the same host. Without `?net` the game is offline and unchanged. |
| `&team=0..4` | Team for the dev token (default 0). A team holds 2 players, so a third tab needs `&team=1`. |
| `&netId=alice` | Dev account id. By default each tab gets its own id, kept in `sessionStorage`, so a reload rejoins as the same player. |
| `&netAvatar=capsule` | Draw remote players as capsules instead of Mixamo soldiers. |

`?map=v1` is ignored with `?net`, because the M3 server runs `ARENA_LEVEL`. `?bench=` disables networking.

### Keys and console

- **F6** toggles the net debug panel (top right). It shows the transport, state, slot/team, RTT, jitter, loss, the server's input buffer depth against its target, time dilation, lead, interpolation delay, remote count, extrapolated frames, corrections per minute with the last and mean size, replayed ticks, resyncs, decode failures and KB/s in and out.
- A banner at the top shows *Connecting*, *Synchronizing clock*, *Connection interrupted* (no snapshot for 1 s) or *Disconnected: reason*.
- Console handle `__twobullets.net`:
  - `net.client.stats`: the same numbers as the panel.
  - `net.localNet.stats`: corrections, replays, snaps, resets and replayed ticks.
  - `net.roster.poses[slot]`: interpolated remote poses.
  - `net.disconnect()` / `net.connect()`: leave, then rejoin with a fresh single-use token.

## What to expect

- **Startup (~0.3–0.5 s after the socket opens):** Hello → Welcome, then 10 snapshots and 5 ping echoes. The client places your body from the server's owner block (server-owned spawn, R12) and starts ticking ahead of the server at `clientTargetTickAt`. The tab's own spawn is never used.
- **Local player:** input is sampled every 60 Hz tick, simulated at once with the shared `stepPlayer` and sent with up to 6 unacked redundant inputs. Each snapshot's owner block is compared with the prediction for that tick (1 cm, 5 cm/s, exact flags, ±1 tick timers). A mismatch restores the server state and replays the recorded inputs (`replay: true`, no observers, so no recoil, FX or audio). The visual jump decays over τ = 100 ms and snaps beyond 1 m.
- **Remote players:** Hermite interpolation at `serverTime − interpDelay`. On WebSocket the delay floor is 50 ms, and it grows with arrival jitter and loss. Locomotion comes from the replicated velocity, stance, sprint and grounded flags.
- **Localhost numbers:**
  - RTT < 2 ms.
  - The buffer settles at its target of 3 ticks (WS).
  - Interpolation delay is 50 ms.
  - **0 corrections** while walking, sprinting, crouching and jumping.
  - About 2 KB/s in and 2–3 KB/s out per client.
  - With `--fake-net=typical`: RTT ~70 ms, interpolation delay ~80 ms, and a correction every so often.
- **Falling below `killY`:** the server respawns you. That shows up as one snapped correction.
- **Server stop or kick:** the banner shows the `Disconnect` reason, for example "server shut down", "match or team full" or "join token rejected". Movement freezes; call `__twobullets.net.connect()` to rejoin.

## Headless checks

- `pnpm --filter @twobullets/client test`: `apps/client/test/net/` runs the real `NetClient`, `LocalPlayerNet` and `NetClock` against an in-process server built from netcode primitives. It uses `LinkConditioner` profiles, and both sides run `stepPlayer` on NullEngine + Havok. Set `NET_VERBOSE=/tmp/net.jsonl` to append each run's numbers.

## Known gaps (M3 definition of done)

- **WebTransport isn't implemented.** `net/transportPolicy.ts` is the fallback-policy stub: WT for 3 s, a datagram ping check, then WSS, remembered per network. The "fallback < 5 s" gate is untested.
- **Correction rate at the `typical` profile is 4–10/min** in the headless test, with the aim turning every tick. The target is < 1/min. Every correction is a server-synthesized input: an input lost beyond what redundancy recovers before the server needs it. Tuning belongs with the input buffer target and time dilation in `packages/netcode`.
- **No session resume:** a dropped socket needs a manual `connect()`. There's also no Worker-side receive timestamping (M4).
- **Remote players are visual only:** no hitboxes and no body blocking. The upper body doesn't use aim pitch.
