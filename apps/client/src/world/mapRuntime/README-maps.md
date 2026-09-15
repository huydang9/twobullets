# Wiring map ids into `Game.ts` (for the lead)

`maps.ts` resolves a map id to a `MapDefinition` (`{ id, name, map, bakeUrl, trainingYard }`):

| Id | Map | Training Yard |
|---|---|---|
| `v1` | Map v1 (`MAP_V1`) | yes |
| `cz-holasovice`, `vn-camthanh`, `jp-shirakawago` (and any generated place) | `packages/shared/src/map/real/<id>.ts`, loaded on demand as its own chunk | no (`null`) |
| missing, `arena`, unknown (warned) | `null`: the blockout arena | – |

`MapRuntime.load` takes the definition spread into its options. `trainingYard: null` skips the arena, its soldier range and its audio ray zone.

## In `Game.ts` (applied)

`resolveLaunch` (`game/launch.ts`) picks the map id: a networked launch uses the match's `mapId`, practice its map
(Map v1 by default), DEV flags `?map=` / `?bench=v1` / `?bots=1` (implies `v1`) / `?net=…&map=` (default arena). Then
`resolveMapDefinition(mapId)` → `MapRuntime.load(scene, environment, { ...definition, overlay })`.

Everything below keeps using `world` (`world.map`, `world.layout`, `world.level`), so equipment loot, the map screen, the minimap and `OfflineMatch` pick the chosen map up unchanged.

Notes:
- `?bots=1&map=cz-holasovice` needs no change in `apps/client/src/match/options.ts`: `OfflineMatch` reads `world.map` (POIs, spawns, nav grid) and `Game.ts` picks the map. If the play overlay should show the map name, `mapDefinition.name` is available at that point.
- A match needs at least as many POIs with spawns as teams (`planTeamSpawns`). The real maps have 10–11 spawn groups with 2 spawns each; a 20-team solo match needs the match-size agent's spawn planner to share POIs.
- The benchmark (`?bench=v1`) stays Map v1 only.

## Map picker

`apps/client/src/ui/mapPicker` renders `mapChoices()` as cards and reports the chosen id; the play overlay can mount it and reload with `?map=<id>` (or pass the id into the next match).
