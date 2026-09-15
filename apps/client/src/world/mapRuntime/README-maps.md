# Wiring map ids into `Game.ts` (for the lead)

`maps.ts` resolves a map id to a `MapDefinition` (`{ id, name, map, bakeUrl, trainingYard }`):

| Id | Map | Training Yard |
|---|---|---|
| `v1` | Map v1 (`MAP_V1`) | yes |
| `cz-holasovice`, `vn-camthanh`, `jp-shirakawago` (and any generated place) | `packages/shared/src/map/real/<id>.ts`, loaded on demand as its own chunk | no (`null`) |
| missing, `arena`, unknown (warned) | `null`: the blockout arena | – |

`MapRuntime.load` takes the definition spread into its options. `trainingYard: null` skips the arena, its soldier range and its audio ray zone.

## Patch for `apps/client/src/game/Game.ts`

Replace the `mapV1` flag and the hard-coded bake URL (currently lines 71–86) with:

```ts
import { MAP_FAR_PLANE, MapOverlay, MapRuntime, resolveMapDefinition } from "../world/mapRuntime";

// DEV: `?map=v1|<realMapId>` loads a full map; no query (or `?map=arena`) keeps the blockout arena.
// DEV: `?bench=v1` implies `?map=v1`; `?bots=1` implies `?map=v1` unless `map` names another map.
// DEV: `?net=` joins a match server (arena only in M3).
const netConfig = import.meta.env.DEV && !benchmark ? readNetConfig(params) : null;
const matchOptions = readOfflineMatchOptions(window.location.search);
const botsMatch = import.meta.env.DEV && !benchmark && !netConfig && matchOptions.enabled;
const mapId = !import.meta.env.DEV || netConfig ? null : benchmark === "v1" ? "v1" : (params.get("map") ?? (botsMatch ? "v1" : null));
if (netConfig && params.get("map")) console.warn("[net] ?map= is ignored in networked play (the M3 server runs the arena)");
const mapDefinition = await resolveMapDefinition(mapId);
const environment = createEnvironment(scene, { largeWorld: mapDefinition !== null });
// Models download while the map builds (its terrain comes from a worker) and the environment textures load.
const assetsLoading = loadAssets(scene);
scene.blockMaterialDirtyMechanism = OPTIMIZATIONS.blockMaterialDirtyOnLoad;
const world = mapDefinition ? await MapRuntime.load(scene, environment, { ...mapDefinition, overlay: new MapOverlay() }) : null;
```

Everything below keeps using `world` (`world.map`, `world.layout`, `world.level`), so equipment loot, the map screen, the minimap and `OfflineMatch` pick the chosen map up unchanged.

Notes:
- `?bots=1&map=cz-holasovice` needs no change in `apps/client/src/match/options.ts`: `OfflineMatch` reads `world.map` (POIs, spawns, nav grid) and `Game.ts` picks the map. If the play overlay should show the map name, `mapDefinition.name` is available at that point.
- A match needs at least as many POIs with spawns as teams (`planTeamSpawns`). The real maps have 10–11 spawn groups with 2 spawns each; a 20-team solo match needs the match-size agent's spawn planner to share POIs.
- The benchmark (`?bench=v1`) stays Map v1 only.

## Map picker

`apps/client/src/ui/mapPicker` renders `mapChoices()` as cards and reports the chosen id; the play overlay can mount it and reload with `?map=<id>` (or pass the id into the next match).
