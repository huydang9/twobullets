# Real-world maps (OpenStreetMap)

A real-world map is a 1×1 km square of a real place, rebuilt from OpenStreetMap roads, buildings, land use and water, plus scaled elevation, with the game's own building prefabs and props. Generation runs offline. The result is committed pure data (`MapData`), so the client and a Node server build identical terrain and layouts, and nothing is fetched at runtime.

Design and candidate places: [`docs/research/real-world-map-investigation.md`](../research/real-world-map-investigation.md).

| Map | Preview |
|---|---|
| Holašovice, CZ (recommended default) | ![Holašovice](cz-holasovice.svg) |
| Hội An – Cẩm Thanh, VN | ![Cẩm Thanh](vn-camthanh.svg) |
| Shirakawa-gō, JP | ![Shirakawa-gō](jp-shirakawago.svg) |

## Try it

- `http://localhost:5173/?map=cz-holasovice` (or `vn-camthanh`, `jp-shirakawago`) in DEV builds, once `Game.ts` uses `resolveMapDefinition` (`apps/client/src/world/mapRuntime/README-maps.md`).
- `?bots=1&map=<id>`: the offline bot match on that map.
- Headless: `node --experimental-transform-types tools/bench/bots/match.ts --map <id> --brain real`.

## Add any location

```sh
# A preset from tools/map/osm/places.ts
node --experimental-transform-types tools/map/osm/generate.ts cz-holasovice

# Any place: writes a new preset into places.ts, then generates it
node --experimental-transform-types tools/map/osm/generate.ts --lat 49.0156 --lon 14.4406 --name "Český Krumlov" \
  --cc cz --country Czechia [--id cz-krumlov] [--flat | --scale 0.5] [--max-relief 55] [--tropical]
```

Pick the center of a village or hamlet. The square is 1 km around it. What works well:
- **Building count:** about 60–400 buildings in the square. Fewer leaves open fields; dense towns get thinned to the cap and lose their character.
- **Roads:** a mapped road network.
- **Relief:** modest. Use `--scale 0.3` for valleys and `--flat` where the DEM is noise (coastal lowlands).

A run takes 10–60 s:
1. **Fetch** (`fetch.ts`, cached in gitignored `assets-src/map/osm/<id>/`):
   - one Overpass query for a 1.32 km square;
   - four AWS Terrain Tiles.
   - It sends a generic User-Agent (`twobullets-dev/0.1`) and no personal info. It waits 5 s or more between Overpass calls and backs off over three public mirrors on 429/504. Cached data is reused unless `fetch.ts <id> --refresh`.
2. **Convert** (pure, `packages/shared/src/map/real/convert/`), fixing the layout until it validates and every POI, spawn and door is reachable.
3. **Write** `packages/shared/src/map/real/<id>.ts`, `<id>.info.ts` and the `index.ts` registry.
4. **Build** (`tools/map/build.ts --map <id>` in a fresh process):
   - terrain bake `apps/client/public/assets/map/<id>.terrain.bin`;
   - checksum record `real/<id>.bake.ts`;
   - `docs/map/<id>.svg`;
   - picker preview `apps/client/public/assets/map/<id>.preview.svg`.
   - The generator then checks that the written module rebuilds the converter's exact layout checksum.

It exits 1 if validation issues or unreachable probes remain. After changing the converter, regenerate every map, then run `pnpm --filter @twobullets/shared test` (`real.test.ts` checks the bakes). `tools/map/build.ts --map all --check` verifies all outputs without writing.

## How OSM becomes a map

| Layer | Rule |
|---|---|
| Projection | Tangent plane at the center with the WGS84 meters-per-degree series. +X east, +Z north, meters. |
| Elevation | DEM sampled at 10 m and blurred to drop canopy and roof bumps. Measured from the lowest playable point, × `scale`, then smoothly compressed toward `maxRelief`. Stored as a 65 × 65, 20 m `heightGrid` terrain feature (Catmull-Rom, basic arithmetic only, so it passes the determinism rules). A gentle noise relief and the procedural mountain border stay. `flat` keeps only the noise. |
| Roads | Highway class → asphalt or dirt with a width: trunk 8 m … residential 5.5 m, service 3.8 m, track 3.5 m. `surface` and `width` tags override. Motorways, tunnels, driveways and parking aisles are skipped. Foot and cycle **bridges** are kept (3 m), since they are sometimes the only river crossing. Ways continuing each other are joined, simplified to 1 m and clipped 8 m inside the edge; stubs are dropped. `RoadSpec.width` is the additive field. |
| Creeks | Streams, ditches and small rivers become dry creek beds: cut flatten polylines 0.5–1.4 m deep, painted dirt (so trees and buildings keep off them). |
| Water | Water polygons (`natural=water`, riverbanks, reservoirs) are **not walkable**. A wooden fence (movement blocker, bullets pass) follows every bank, with gaps where roads cross. Crossings get railings on both shoulders that overlap the gap ends. Banks meeting the map edge run 12 m on into the border. Road ends inside water are trimmed to the bank. No water renderer yet: the fenced ground is plain grass. |
| Buildings | Footprint → minimum-area rectangle → prefab by tag and size (see below). The entrance (+Z) faces the nearest road. If it touches a road or creek (1.6 m gap), a neighbour (2 m) or water (5 m), the building is pushed back up to 8 m and nudged sideways, else dropped. The cap is 90: each 45 m settlement cluster gets a share by size, core first. Each building gets a rect pad at its mean natural height; neighbouring pads within 1.2 m share one level (a terrace). |
| POIs | 40 m clusters of placed buildings; sprawling ones are split into ~90 m parts. Accepted biggest first at ≥ 200 m (major) or ≥ 130 m and both radii + 40 m (minor, radius ≤ 40). With fewer than 10, named localities, then the open spot farthest from every POI, become landmark POIs (woods or fields). Names come from OSM place nodes, temples, chapels, museums, ponds and named areas (diacritics kept). Duplicates get a local direction word (`sever`, `Bắc`, `北`). Kind: farm (≥ 40 % barns or sheds), town (≥ 10 buildings), village; `village` is the additive `PoiKind`. Loot tier: 2 for ≥ 10 buildings (at most three), 1 for ≥ 4. |
| Spawns | Two per POI on rings just outside its radius, facing it. Each must be nearest to its own POI (spawn groups are by nearest POI), under 22°, off roads and water, and clear of buildings and fences. |
| Land use | Forests and woods: fungus oaks, then conifers (broadleaf in the tropics) and undergrowth, one rule per outline (28 largest). Wetland, scrub and orchards get their own rules. Residential areas get garden trees. Tree rows become 5 m bands. Farmland gets hay. Map-wide: groves, tree lines along roads, field cover clusters, lone oaks, slope rocks, gap-filling boulders, meadow bushes and grass. POI cores, water and fence gaps are excluded. |
| Isolation | A nav grid over terrain, roads and water fences alone finds land cut off by water (no bridge inside the square). Buildings, landmark POIs and spawns stay off it. |

**Prefab mapping** (`convert/buildings.ts`):

| Footprint | Prefab |
|---|---|
| Chapel, shrine, temple | `watchtower` under 70 m², else `barn` |
| Garage, shed, hut, anything under 38 m² | `container_open` / `_blue` (`house_small` from 60 m²) |
| Barn, stable, farm building | `barn` from 130 m², `warehouse` from 300 m² and 14 m wide |
| Industrial, commercial, retail | `warehouse` from 320 m², `barracks` when long, `house_two_story`, `house_small` |
| School, civic, hotel, apartments | `barracks` when long from 170 m², else `house_two_story` / `house_small` |
| House or untagged | long wings (≥ 17 m, 1.6:1) `barn`; ≥ 260 m² `barn` or `house_two_story`; ≥ 125 m² or 2+ levels `house_two_story`; else `house_small` (12 % ruined) |

The limits per map are 4 warehouses, 5 barracks, 4 watchtowers and 16 containers; extras fall back to barns or houses. `house_small` stays under 20 m², and roofs and carports are skipped.

**Fix-until-valid loop** (`convert/assemble.ts`), up to 12 passes, each rebuilding from scratch:
1. Place buildings.
2. Derive POIs, pads and terrain.
3. Pick spawns and scatter.
4. Run `validateMapLayout` (with `REAL_POI_SPACING` and the fence openings). Offenders are excluded or blocked: the later of an overlapping pair, a building off its pad, a steep entrance, a bad spawn.
5. Once validation is clean, run the nav reachability pass: POIs, spawns, entrances and ground-floor rooms must sit on the main component, with ≥ 98 % of loot spots reachable.

Everything is seeded from ids and OSM ids. There is no `Math.random`.

## The three maps

Generated from the OSM snapshot of 2026-09-15T03:54Z.

| | Holašovice (`cz-holasovice`) | Hội An – Cẩm Thanh (`vn-camthanh`) | Shirakawa-gō (`jp-shirakawago`) |
|---|---|---|---|
| Buildings kept / candidates | 90 / 139 | 90 / 392 | 90 / 274 |
| Dropped: conflicts / cap / validation+nav | 10 / 20 / 19 | 12 / 290 / 0 | 4 / 174 / 6 |
| Prefabs | 34 small, 3 ruined, 21 two-story, 22 barns, 2 warehouses, 7 containers, 1 watchtower (chapel) | 54 small, 6 ruined, 12 two-story, 2 barns, 16 containers | 32 small, 5 ruined, 41 two-story, 9 barns, 3 containers |
| POIs (settlements + landmarks) | 10 (7 + 3) | 10 (8 + 2) | 11 (11 + 0) |
| Spawns | 20 | 20 | 22 |
| Roads | 3.58 km asphalt, 2.05 km dirt | 7.28 km asphalt, 0.78 km dirt | 5.46 km asphalt, 1.94 km dirt (with the Deai-bashi footbridge) |
| Elevation | real 466–524 m → 47.5 m relief (×1) | flat (the DEM is canopy noise) | real 473–680 m → 51.6 m relief (×0.3, compressed) |
| Water | 5 ponds, 1.1 ha, 846 m fence | Thu Bồn and a channel, 28 ha, 3.6 km fence and railings | Shō river and ponds, 3.5 ha, 2.9 km fence |
| Prop instances | 5,529 | 4,492 | 9,620 |
| Validation | 0 issues | 0 issues | 0 issues |
| Reachable POIs / spawns / entrances / loot | 10/10, 20/20, 198/198, 100 % | 10/10, 20/20, 162/162, 100 % | 11/11, 22/22, 186/186, 100 % |
| Fenced water on the main nav component | 0 of 250 samples | 0 of 7,153 | 0 of 726 |
| Terrain bake | 2.26 MB | 2.43 MB | 2.31 MB |
| Map module | 136 KB | 113 KB | 126 KB |

POI names:
- **Holašovice:** Holašovice, Holašovice (východ), Nekysel, Fenclů rybník, Holašovice (sever), kaple Sv. Jana, and four landmark farms (Statek).
- **Cẩm Thanh:** Cẩm Thanh and its Bắc / Nam / Đông / Tây hamlets, plus Nông trại fields. OSM has no place nodes there, so the preset sets `localName`.
- **Shirakawa-gō:** 荻町, 長瀬家, 信称寺本堂, 和田家住宅, スイレン池, 合掌造り生活資料館, Jin Homura, 白川八幡神社, 荻町 (北), 荻町 (西), 明善寺郷土館.

**Headless bot matches.** `tools/bench/bots/match.ts --map <id> --brain real --seed 1`: 10 players in duos, normal difficulty, real brains, the map's own nav grid, spawn plan and loot.

| Map | Ends | Combat | Kills / knocks / revives | Stuck incidents (longest) | Tick p50 / p99 |
|---|---|---|---|---|---|
| Holašovice | last team | 4.4 min | 8 / 4 / 0 | 1 (10 s) | 0.35 / 1.14 ms |
| Cẩm Thanh | last team | 9.5 min | 9 / 9 / 4 | 5 (20 s) | 0.27 / 1.04 ms |
| Shirakawa-gō | last team | 8.5 min | 8 / 8 / 4 | 5 (10 s) | 0.47 / 1.43 ms |

## Runtime

- `apps/client/src/world/mapRuntime/maps.ts`:
  - `resolveMapDefinition(id)` → `{ id, name, map, bakeUrl, trainingYard }`. Real maps load their module as a separate chunk; the registry (`real/index.ts`) holds only the small `info` facts.
  - `mapChoices()` lists Map v1 and the real maps for menus.
- `MapRuntime.load(scene, environment, { ...definition, overlay })`: `trainingYard: null` skips the arena, its soldier range and its audio ray zone. Real maps have no Training Yard.
- `apps/client/src/ui/mapPicker`:
  - `MapPicker` shows a card per map (preview, name, country, POIs, buildings, road km, relief) and the selected map's credits.
  - It reports the chosen id through `selected`, `onSelect`, `onConfirm` and `confirmed`.
  - All text is in `strings.ts` for the i18n pass.
- `tools/map/build.ts --map <id>` builds one map, `--map all` builds everything. Without `--map` it builds Map v1 exactly as before, plus `mapV1.preview.svg`.

## Limits

- **Looks:**
  - Prefab repetition means a place reads like the real one from above (street plan, fields, woods, river), not up close. Shirakawa-gō's gasshō farmhouses become barns and two-story houses.
  - No water surface: fenced water is grass for now.
  - Palms are broadleaf trees.
- **Buildings:** capped at 90. Dense places (Cẩm Thanh has 392 candidates) keep their core and a share of each hamlet. Real houses 3–6 m from the street centerline get pushed back, so streets feel wider.
- **POI spacing:** real maps validate with 200 m / 130 m (Map v1 uses 250 m / 150 m).
- **Spawn groups:** 10–11 per map with 2 spawns each, so a 20-team solo match needs the spawn planner to share POIs.
- **Terrain:** heights are real only to ±1–2 m (SRTM at 20 m, blurred). Village pads flatten local slopes.
- **ODbL share-alike:** the generated modules and bakes are a derivative database. That is fine for the internal release; a public release must offer them under the ODbL.
- **OSM coverage** varies a lot. The Vietnam survey is in the investigation: most places are all-or-nothing.

## Licenses and credits

`apps/client/public/assets/map/credits.json` has the full attribution text; the picker shows the short lines.
- **OpenStreetMap (ODbL 1.0):** "© OpenStreetMap contributors", linking https://www.openstreetmap.org/copyright. Every real map needs it.
- **AWS Terrain Tiles:** the tilezen required attribution (https://github.com/tilezen/joerd/blob/master/docs/attribution.md). For these maps that is "SRTM and GMTED2010 terrain data courtesy of the U.S. Geological Survey", plus "produced using Copernicus data and information funded by the European Union - EU-DEM layers" for Holašovice.
- **Google Maps data is never used.** Its terms forbid it.

## Browser viewpoints (feet x, z; heights from the terrain)

| Map | Where | x, z | Look at |
|---|---|---|---|
| Holašovice | Village core | (−82, −100) | Houses and barns facing the streets, terraced pads, garden trees |
| Holašovice | East cluster | (213, 20) | Two-story houses along the tertiary road, road tree lines |
| Holašovice | Pond | (−197, −148) | Bank fence: can't be entered; walk the whole edge |
| Holašovice | Chapel | (−35, 128) | `watchtower` as the chapel, open fields to the north |
| Cẩm Thanh | Main hamlet | (7, −187) | Dense small houses, river bank fence to the south |
| Cẩm Thanh | River bank | walk south from (0, −300) | Fence continuity, road gaps with railings, no way into the water |
| Cẩm Thanh | NE channel | (280, 440) | Road crossing the channel: railings meet the bank fences |
| Shirakawa-gō | Ogimachi (荻町) | (−73, −17) | Two-story houses and barns on terraces, 0.3× valley slopes |
| Shirakawa-gō | Deai-bashi footbridge | (−143, −50) | 3 m bridge over the fenced river, railings on both sides |
| Shirakawa-gō | East slope | (200, 117) | 長瀬家 cluster, conifer woods up the valley side |
| Any | Out of bounds | walk past x = 500 | Warning and respawn, as on Map v1; bank fences run on into the border |

Not verified in a browser yet:
- terrain and pad transitions on real slopes;
- the look of wide fenced grass where water should be;
- creek beds;
- the picker cards;
- load time with 90 buildings (same prefab set as Map v1, so similar).
