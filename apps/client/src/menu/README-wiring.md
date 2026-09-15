# Front door: wiring

The menu (`menu/`) and the server-api client (`platform/`) are wired in `main.ts` already. One `Game.ts` change is left
for the lead, because `Game.create` still takes its mode from DEV-only URL flags.

## What `main.ts` does today

- `shouldShowMenu(location.search)`: no query params besides `?lang=` → the menu. Any game flag (`?map=`, `?bots=1`,
  `?net=`, `?bench=`, `?teammate=1`, `?quality=`, …) → `Game.create` as before. In production builds the menu is shown
  unless the URL has `?bots=` (offline practice reloads with `?bots=1&players&mode&difficulty&map`).
- `Game` is imported dynamically, so the menu paints before Babylon and Havok download.
- **Networked launch** (`startNetworkedGame`):
  1. `setJoinTokenProvider(() => launch.tokens())` in `net/handshake.ts`. `fetchDevToken` returns server-api join tokens
     (the one the connecting screen fetched, then a fresh `POST /v1/matches/{id}/join` for every later connect) instead
     of calling `/dev/token`. `?net=` dev play never installs a provider, so it is unchanged.
  2. It writes `?net=<wsUrl>&netId=<accountId>&team=<teamId>&map=<mapId>` into the URL, calls `Game.create`, and puts the
     menu URL back straight after. `Game.create` reads `new URLSearchParams(location.search)` in its first, synchronous
     statement, so the flags are seen. A reload mid-match lands on the menu, which offers "Vào lại trận".
- The `MenuController` keeps the lobby socket open during the game. When the match ends (`match.updated` push, or REST
  polling while the socket is down) the results screen is shown over the game. "Về sảnh" reloads to the menu.

## Game.ts change for the lead (needed for production builds)

Today `readNetConfig`, `?bots=1` and `?map=` are gated on `import.meta.env.DEV`, so in a production build the URL shim
opens the blockout arena offline and practice has no bots. Replace the shim with an explicit launch option:

```ts
// game/Game.ts
import type { NetGameConfig } from "../net/NetGame";
import type { OfflineMatchOptions } from "../match";

export interface GameLaunch {
  /** Networked match from the menu (production too). */
  readonly net?: NetGameConfig;
  /** Map of a networked match; ignored until server-match loads maps (then pass it to resolveMapDefinition). */
  readonly netMapId?: string;
  /** Offline practice from the menu (production too). */
  readonly practice?: OfflineMatchOptions;
}

static async create(canvas: HTMLCanvasElement, hudRoot: HTMLDivElement, launch: GameLaunch = {}): Promise<Game> {
  const params = new URLSearchParams(window.location.search);
  // …
  const netConfig = launch.net ?? (import.meta.env.DEV && !benchmark ? readNetConfig(params) : null);
  const matchOptions = launch.practice ?? readOfflineMatchOptions(window.location.search);
  const botsMatch = (import.meta.env.DEV || launch.practice !== undefined) && !benchmark && !netConfig && matchOptions.enabled;
  const mapId = netConfig
    ? null // later: launch.netMapId once the server runs the map
    : benchmark === "v1"
      ? "v1"
      : launch.practice
        ? (params.get("map") ?? "v1")
        : import.meta.env.DEV
          ? (params.get("map") ?? (botsMatch ? "v1" : null))
          : null;
```

Then in `main.ts`:

```ts
// startNetworkedGame: drop the replaceState shim
const { parseNetParam } = await import("./net/handshake");
await Game.create(canvas, hudRoot, {
  net: { endpoint: parseNetParam(launch.join.wsUrl), sub: launch.account.id, team: launch.join.teamId, avatar: "soldier", debugHitboxes: false },
  netMapId: launch.mapId,
});

// production practice: `?bots=1…` URLs
const { readOfflineMatchOptions } = await import("./match/options");
await Game.create(canvas, hudRoot, { practice: readOfflineMatchOptions(location.search, false) });
```

`readOfflineMatchOptions(search, false)` already ignores the DEV-only flags (`zoneScale`, `botDebug`, …).

## Local run

```sh
# terminal 1: server-api (port 8080) allowing the Vite origin; real match processes need server-match --mode=agent
TB_CORS_ORIGINS=http://localhost:5173 TB_ALLOCATOR=process pnpm --filter @twobullets/server-api dev
# terminal 2: client
pnpm dev   # http://localhost:5173 (menu), or VITE_TB_API_URL=http://host:port pnpm dev
```

`TB_ALLOCATOR=fake` gives lobbies, queue and "match found" without game servers (the join then points at a port with
nothing listening, so the game shows "cannot reach").
