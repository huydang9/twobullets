# Real-world map (OpenStreetMap): investigation

Investigation only (2026-09-15). Nothing is implemented; waiting on the user's decisions listed at the end.

Repo untouched by this investigation; probe scripts and cached OSM/DEM data stayed in a temporary scratchpad.

**1. Data sources and licenses**
- **Google Maps: not usable.** Its Platform Terms forbid scraping, caching, making new content from Google Maps data, and using it with non-Google maps. A map built from it breaks all of these.
- **OpenStreetMap via Overpass (ODbL 1.0):** use this.
  - Credit "© OpenStreetMap contributors" and link openstreetmap.org/copyright wherever the map is shown (credits screen and `credits.json`).
  - ODbL is share-alike for the derived *database*. Our generated map data would count, but that only matters if we release it publicly. It's fine for an internal release.
  - Overpass is unreliable: about half my calls hit 504/429 and needed retries or fallback servers (private.coffee, kumi.systems).
- **Elevation, option A: AWS Terrain Tiles (terrarium PNG, no login).** About 360 KB for 4 z14 tiles per place, and the root `sharp` package decodes them.
  - Credit "courtesy of the U.S. Geological Survey" (SRTM/GMTED).
  - EU places also need "Produced using Copernicus data and information funded by the European Union - EU-DEM layers".
- **Elevation, option B: Copernicus GLO-30 (free, on AWS).** I didn't verify its credit line. From memory it is "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA".

**2. Candidate places** (each a 1×1 km square; road km counts only the part inside the square)
| Place (lat, lon) | Buildings (by area) | Roads km | Land use | Height range |
|---|---|---|---|---|
| **CZ Holašovice** (48.9697, 14.2736), farm village | 154: 27 under 40 m², 69 at 40–150, 38 at 150–300, 20 over 300; tags: house, barn, garage, chapel | tertiary 1.97, residential 1.45, unclassified 0.26, service 1.24, track 1.96; stream 0.84 | farmland 43 ha, meadow 18, residential 16, forest/wood 9, water 1 | 466–523 m (57 m) |
| **JP Shirakawa-go** (36.2570, 136.9060), valley village | 305: 37 under 40, 215 at 40–150, 53 over 150 | trunk 0.74, tertiary 0.82, residential 2.46, unclassified 2.34, service 2.43, track 1.09; river 1.25 | wood 33 ha, farmland 14, water 3.4 | 471–678 m (206 m, steep) |
| **VN Hội An, Cẩm Thanh** (15.8720, 108.3700) | 481, almost all tagged only `yes`: 74 under 40, 313 at 40–150, 94 over 150 | primary 1.68, tertiary 1.69, residential 4.05, service 0.55; river 2.64 | water 29 ha, wetland 20 | −2–17 m (flat) |
| UK Imber (51.236, −2.051), military training village | 34 (too few) | 14 roads, 18 service/track | 8 green areas | not measured |

- **Vietnam coverage is all or nothing:**
  - Too dense: Đường Lâm 2,112 buildings, Tam Cốc 1,363, Hội An west 1,118.
  - Almost empty: Mai Châu 5, Sa Pa Cát Cát 11, Hoa Lư 13, Đà Lạt 0, Ba Vì 0, Mekong Cái Bè 1.
  - Cẩm Thanh is the only medium option. It is half water, and we have no water renderer.
- **Recommended default: Holašovice.** About 127 usable footprints, a readable tertiary and residential grid, big farmland and meadow for fights between compounds, a gentle 57 m of relief, and barns and houses that fit our kit. It also looks like PUBG's Central Europe.

**3. How OSM fits our map system**
- **Roads:**
  - Each OSM `highway` way becomes a `RoadSpec` with `straight: true`, simplified, joined into chains and clipped to the square.
  - Asphalt for trunk through residential; dirt for service, track and rural unclassified; footways and paths skipped.
  - `ROAD_STYLES` has only 7 m and 4.5 m widths, so `RoadSpec` needs an optional `width`. Scatter caps road half-width at 6 m.
  - These places have 7–10 km of road against about 3 km in Map v1. Flattening cost grows with that, so drop short service stubs and driveways.
- **Buildings:**
  - Each footprint becomes a minimum-area rectangle, then the best-fitting prefab: houses → `house_small`/`two_story` (a few ruined), barns and farmyards → `barn`, over 300 m² → `warehouse`, chapel → `watchtower`, garages → a container or skipped.
  - Each building gets a rect flatten pad with `snapToTerrain`, and its door faces the nearest road.
  - `validate.ts` will reject many as they are. It wants 1 m from road edges, 1 m between buildings, the building on its pad and a steppable entrance. Real houses sit 3–6 m from the street centre line, so we need a push-back-or-drop loop. I expect 20–40% to be dropped.
- **Budget:** `buildings.md` plans for about 60 buildings (154k tris). Most of the 642 ms load cost is baking geometry once per prefab type; placing 60 buildings costs only about 35 ms. So about 60 fits today, and about 120 needs a `?bench` run.
  - Holašovice: 127 candidates. Keep the village core and thin the outskirts.
  - Shirakawa-go: 268 candidates. Cẩm Thanh: 407 candidates.
- **POIs:** cluster buildings and name them from OSM place, landuse or amenity names.
  - `PoiKind` is a fixed list, so we either map to existing kinds or add one such as `village`.
  - `validate.ts` expects POIs 250 m apart, which is an option we can pass. Loot already reads `pois` and `buildings`.
- **Land use:**
  - Forest and wood polygons become one `ScatterRule` each. Multipolygons need their rings joined, and holes go in `exclude`.
  - Farmland and meadow get field cover, hay and bushes.
  - Flatten has no polygon shape, so farmland can't be painted dirt and water can't be marked. Water only excludes scatter and buildings.
  - Streams can become cut polylines painted dirt: dry creek beds.
- **Elevation:** `TerrainSpec` is noise plus features only. Real heights need a new feature kind, e.g. `heightGrid`: 65×65 at 20 m, about 20 KB in the map file.
  - It would be sampled with a smooth spline in `terrain/generate.ts` using basic arithmetic, which the determinism test allows.
  - Heights get smoothed and clamped; Shirakawa-go would need scaling to about 0.3×.
  - Keep a flat option. The procedural mountain border stays.
- **Terrain bake:** works per map as it is, keyed by an inputs hash. About 2.4 MB per map.
- **Must be generalized:**
  - `tools/map/build.ts`: add `--map <id>` and a record file per map.
  - `MapRuntime.load`: it defaults to `MAP_V1` and always builds the Training Yard (its arena is also excluded in `BuildingAcoustics`). The yard must become optional.
  - `Game.ts` lines 49–56: the `mapV1` flag and the hard-coded bake URL.
  - `packages/shared/src/index.ts`: one export line.
- **Stays untouched:** v1 terrain and checksums, the building kit and prefabs, scatter and prop renderers, vegetation, the worker and bake format, combat and equipment. The bench (`checkBenchPath`, `benchVariants`) stays v1-only.

**4. Proposed design for `?map=real` / `?map=<placeId>`**
- **Recommendation: generated data committed to the repo, not fetched at runtime.**
  - Same data on the Node server and the client, bake checksums checked in CI, and no network or rate limits at load.
  - A runtime fetch changes whenever someone edits OSM, needs about 1 s of terrain generation with no bake, and breaks the server story.
  - Keep a snapshot date in the file header.
- **File layout:**
  - `tools/map/osm/`: `places.ts` (the default is one value), `fetch.ts` (cached in `assets-src/map/osm/<id>/`), `generate.ts`.
  - `packages/shared/src/map/real/convert/*`: pure projection, roads, buildings, POIs, land use, elevation and the fix-until-valid loop. Not exported from the index, so it can be unit-tested with a small OSM fixture.
  - Generated per place: `real/<id>.ts` (MapData), `real/<id>Bake.ts`, `real/index.ts` registry.
  - Assets and docs: `public/assets/map/<id>.terrain.bin` plus a `credits.json`, `docs/map/<id>.svg`, `docs/map/real-world.md`.
  - `mapRuntime/maps.ts`: map id → `{ map, bakeUrl, trainingYard | null }`.
- **Game.ts patch (for later):** `const def = import.meta.env.DEV ? resolveMapDefinition(benchmark === "v1" ? "v1" : params.get("map")) : null;` then use `largeWorld: def !== null` and `MapRuntime.load(scene, environment, { ...def, overlay: new MapOverlay() })`.

**5. Effort, risks and questions**
- **Phases:**
  - A: fetch/projection/roads/elevation plus the `build.ts` generalization.
  - B: buildings, POIs, land use and the validation loop, with tests.
  - C: client hook, docs and a browser check.
  - About 2–3 agent-days plus review; B and C can run in parallel after A.
- **Risks:**
  - Overpass is flaky, but it's only needed at generation time.
  - Prefab repetition means the place won't look like the real one.
  - Road clearance will drop buildings.
  - Steep terrain.
  - No water.
  - Load time and triangles above about 60 buildings.
  - Bundle size of the map data, about 50–150 KB per map.
  - ODbL share-alike if the game is ever released publicly.
- **Questions for you:**
  1. Which place: Holašovice, Shirakawa-go, or a Vietnam spot despite the water?
  2. Real, scaled or flat elevation?
  3. Building cap: 60 now, or about 120 after a bench?
  4. Keep the Training Yard on real maps?
  5. Add a `village` POI kind?
  6. Dry creek beds now and a water renderer later?
  7. POI names with diacritics (Czech or Vietnamese) as they are?
