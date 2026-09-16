# Real-world maps (OpenStreetMap)

A real-world map is a 500 × 500 m square of a real place, rebuilt from OpenStreetMap roads, buildings, land use and water, plus scaled elevation, with the game's own building prefabs and props. Generation runs offline. The result is committed pure data (`MapData`), so the client and a Node server build identical terrain and layouts, and nothing is fetched at runtime.

The square was 1×1 km until 2026-09-16, when it halved because the browser build was too heavy. The village maps generated at 1 km (Holašovice, Hội An – Cẩm Thanh, Shirakawa-gō) were removed with it; only the two Saigon city maps ship. The pipeline still supports villages and real elevation — regenerate them with a fresh `generate.ts` run if they come back.

Design and candidate places: [`docs/research/real-world-map-investigation.md`](../research/real-world-map-investigation.md).

| Map | Preview |
|---|---|
| Ngã Tư Hàng Xanh, VN (city, `DEFAULT_REAL_MAP_ID`) | ![Ngã Tư Hàng Xanh](vn-hangxanh.svg) |
| Phú Nhuận, VN (city) | ![Phú Nhuận](vn-phandangluu.svg) |

## Try it

- `http://localhost:5173/?map=vn-hangxanh` (or `vn-phandangluu`) in DEV builds.
- `?bots=1&map=<id>`: the offline bot match on that map.
- Headless: `node --experimental-transform-types tools/bench/bots/match.ts --map <id> --brain real`.

A saved map preference naming a map that no longer exists falls back to `v1` (`apps/client/src/menu/preferences.ts` validates with `isMapId`).

## Add any location

```sh
# A preset from tools/map/osm/places.ts
node --experimental-transform-types tools/map/osm/generate.ts vn-hangxanh

# Any place: writes a new preset into places.ts, then generates it
node --experimental-transform-types tools/map/osm/generate.ts --lat 49.0156 --lon 14.4406 --name "Český Krumlov" \
  --cc cz --country Czechia [--id cz-krumlov] [--flat | --scale 0.5] [--max-relief 55] [--tropical]
```

Pick the center of a village, a hamlet or a city block. The square is 500 × 500 m centred on it. What works well:
- **Building count:** about 20–120 buildings in the square. Fewer leaves open fields; dense towns get thinned to the cap and lose their character.
- **Roads:** a mapped road network.
- **Relief:** modest. Use `--scale 0.3` for valleys and `--flat` where the DEM is noise (coastal lowlands).

A run takes 10–60 s:
1. **Fetch** (`fetch.ts`, cached in gitignored `assets-src/map/osm/<id>/`):
   - one Overpass query for a 680 m square (`FETCH_HALF` 340; the caches in `assets-src/` were fetched at 660 m and are a superset, so they stay valid);
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
| Elevation | DEM sampled at 10 m over a 320 m half and blurred to drop canopy and roof bumps. Measured from the lowest playable point, × `scale`, then smoothly compressed toward `maxRelief`. Stored as a 65 × 65, 10 m `heightGrid` terrain feature over the 640 m square (Catmull-Rom, basic arithmetic only, so it passes the determinism rules). A gentle noise relief and the procedural mountain border stay. `flat` keeps only the noise. `REAL_TERRAIN` is `{ size: 640, resolution: 513, playableHalfExtent: 250 }`. |
| Roads | Highway class → asphalt or dirt with a width: trunk 8 m … residential 5.5 m, service 3.8 m, track 3.5 m. `surface` and `width` tags override. Motorways, tunnels, driveways and parking aisles are skipped. Foot and cycle **bridges** are kept (3 m), since they are sometimes the only river crossing. Ways continuing each other are joined, simplified to 1 m and clipped at ±244 m (`ROAD_CLIP`, 6 m inside the playable edge); stubs are dropped. `RoadSpec.width` is the additive field. |
| Creeks | Streams, ditches and small rivers become dry creek beds: cut flatten polylines 0.5–1.4 m deep, painted dirt (so trees and buildings keep off them). |
| Water | Water polygons (`natural=water`, riverbanks, reservoirs) are **not walkable**. A wooden fence (movement blocker, bullets pass) follows every bank, with gaps where roads cross. Crossings get railings on both shoulders that overlap the gap ends. Banks meeting the map edge run 12 m on into the border. Road ends inside water are trimmed to the bank. No water renderer yet: the fenced ground is plain grass. |
| Buildings | Footprint → minimum-area rectangle → prefab by tag and size (see below). The entrance (+Z) faces the nearest road. If it touches a road or creek (1.6 m gap), a neighbour (2 m) or water (5 m), the building is pushed back up to 8 m and nudged sideways, else dropped. Footprints are kept inside ±225 m (`BUILDING_EDGE`). The default cap is 90 (`DEFAULT_BUILDING_CAP`; the city maps set 110): each 45 m settlement cluster gets a share by size, core first. Each building gets a rect pad at its mean natural height; neighbouring pads within 1.2 m share one level (a terrace). |
| POIs | 40 m clusters of placed buildings; sprawling ones are split into ~90 m parts. Accepted biggest first at ≥ 120 m (major) or ≥ 85 m and both radii + 40 m (minor, radius ≤ 40) — `REAL_POI_SPACING`. With fewer than `TARGET_POIS` (7), named localities, then the open spot farthest from every POI (searched over ±(half − 45) = ±205 m), become landmark POIs (woods or fields). Names come from OSM place nodes, temples, chapels, museums, ponds and named areas (diacritics kept). Duplicates get a local direction word (`sever`, `Bắc`, `北`). Kind: farm (≥ 40 % barns or sheds), town (≥ 10 buildings), village; `village` is the additive `PoiKind`. Loot tier: 2 for ≥ 10 buildings (at most three), 1 for ≥ 4. |
| Spawns | Two per POI on rings just outside its radius (+12, 20, 30, 42, 56 m), facing it. Each must be nearest to its own POI (spawn groups are by nearest POI), under 22°, off roads and water, clear of buildings and fences, 24 m from the POI's other spawn, 16 m from any other spawn and inside ±226 m (half − 24). |
| Land use | Scatter outlines are clipped at ±244 m (`SCATTER_CLIP`). Forests and woods: fungus oaks, then conifers (broadleaf in the tropics) and undergrowth, one rule per outline (28 largest). Wetland, scrub and orchards get their own rules. Residential areas get garden trees. Tree rows become 5 m bands. Farmland gets hay. Map-wide: groves, tree lines along roads, field cover clusters, lone oaks, slope rocks, gap-filling boulders, meadow bushes and grass. POI cores, water and fence gaps are excluded. |
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

## Headless bot matches

Both shipped maps are Saigon city squares; their numbers are in "City maps" below.

`tools/bench/bots/match.ts --map <id> --brain real --seed 1`: 10 players in duos, normal difficulty, real brains, the map's own nav grid, spawn plan and loot.

| Map | Ends | Combat | Kills / knocks / revives | Stuck incidents (longest) | Tick p50 / p99 |
|---|---|---|---|---|---|
| Map v1 | last team | 5.9 min | 7 / 6 / 2 | 2 (20 s) | 0.18 / 0.79 ms |
| Hàng Xanh | last team | 3.95 min | 8 / 7 / 3 | 3 (10 s) | 0.18 / 0.90 ms |
| Phú Nhuận | last team | 4.88 min | 8 / 8 / 4 | 5 (20 s) | 0.26 / 0.96 ms |

20-player solo matches finish cleanly on Map v1 and Hàng Xanh. The nav grids are now 1,000 × 1,000 cells = 1,000,000 terrain nodes (4,000,000 at 1 km).

## City maps (urban mode)

Both squares use `PlaceConfig.urban` and a per-map `buildingCap` of 110. Without `urban`, the converter's village path is unchanged.

**What urban mode does:**
- **Roads:** alleys (hẻm) and unclassified ways are paved; service ways are 3.5 m.
- **Buildings from OSM footprints** (`urbanPrefabFor`, city set in `docs/map/buildings.md`). Tags on the footprint, or on an amenity/shop node inside it (`ParsedOsm.amenities`), pick the prefab:

  | Tags | Prefab |
  |---|---|
  | `place_of_worship`, church/temple/shrine buildings | `church` (christian, church/chapel/cathedral), else `pagoda`; under 90 m² a row house |
  | `marketplace` / `fuel` | `market_hall` (≥ 200 m², else `shop_kiosk`) / `petrol_station` |
  | school, college, university, kindergarten | `school` from 300 m², else `boarding_house` |
  | cafe, restaurant, fast food, bar | `cafe_terrace` up to 260 m², else `shophouse_french` |
  | bank, post office, townhall, police, civic | `office_tower` from 700 m², else `shophouse_french` |
  | apartments, hotel, dormitory, names starting "Chung cư" | `highrise_apartment` (≥ 8 levels or ≥ 1,100 m²), `apartment_block` (≥ 280 m²), `boarding_house` |
  | office, commercial / shop, retail | `office_tower` (≥ 500 m² or 6 levels), `shophouse_french`, `shop_kiosk`, `market_hall` |
  | industrial, sheds | `warehouse` (≥ 700 m²), `workshop`, `shop_kiosk` |
  | construction / house, villa ≥ 160 m² | `construction_site` / `villa` |
  | untagged | by width and area: row houses up to 6.5 m wide (narrow under 4 m, wide or mezzanine from 5.8 m), then shophouses, cafés, workshops, villas, apartment blocks, towers, in a mix seeded by the OSM id |

  - Limits per map: 3 high-rises, 4 office towers, 6 apartment blocks, 3 schools, 2 markets, 2 churches, 3 pagodas, 2 petrol stations, 3 construction sites, 6 villas, 6 workshops, 6 boarding houses. Extras fall back one step (tower → apartment block → boarding house → shophouse).
  - Landmarks (named, towers, apartment blocks, schools, places of worship, markets, petrol stations) rank first. Other real footprints rank ahead of generated frontage: rank × 0.02 / 0.3 / 0.5 for row houses.
- **Frontage rows** fill the streets OSM doesn't map:
  - fronts at the road gap, neighbours 0.16 m apart, a 3 m walk-through every 5–7 houses;
  - none on parks, pitches, school, market or hospital grounds, water or mapped footprints, or within 40 m of the center.
  - Each street class has a weighted mix of the tube-house variants, `shophouse_french`, `cafe_terrace` and `shop_kiosk`: main roads get taller shophouses, alleys lower ones. A slot never repeats the prefab next door.
  - Facade colours come from the placement position (`facadeColor`), so neighbours differ in prefab and usually in colour.
  - Frontage ids are `bld_9000000000000+n`, from road order.
- **Bridges** (`convert/bridges.ts`):
  - A bridge prefab is laid along a road where it crosses a water area, or where an OSM `bridge=*` highway crosses a waterway line.
  - Placement: centered on the crossing, 2 m of bank plus a 4 m ramp beyond the water at each end. The road must run within 0.8 m of the bridge axis over its whole length.
  - Size: a lane bridge for roads up to 3.9 m, a road bridge up to 8.6 m, lengths 16/80 and 24/40 m.
  - The shoulder railings of that crossing are dropped (the bridge parapets replace them). Bank fences keep their gap, which the bridge body closes.
  - Houses keep off the bridge rect. Bridges are map buildings (ids `bld_8000000000000+n`) without POI, pad or loot, and validation and reachability can exclude them.
  - Neither map has one today: both 500 m squares fall clear of every water area and mapped waterway.
- **Land use:** no village groves or field oaks. Instead:
  - park and grass rules (trees and bushes in `leisure=park/garden/playground`, `landuse=grass`, squares);
  - street trees along roads ≥ 5.5 m wide (they land in the walk-throughs and open lots, since houses and pads keep them out);
  - `urban_cover` clusters (covered cars, utility boxes, barrels, road barriers, the odd car wreck or pipe stack);
  - fewer garden trees and meadow bushes;
  - **wilderness** hills and tropical woodland over the ground the cap leaves empty (below).
- **POI names:** markets, schools, churches, pagodas, apartment blocks and hospitals name POIs. Numbered quarters ("Khu phố 12") come after them.

### Wilderness: hills and woodland on the empty ground

A city square keeps only `buildingCap` buildings, so the built-up part is a core a few hundred meters across and the rest is flat grass with an alley grid on it. `convert/wilderness.ts` fills that ground the way Map v1 fills its fields. It is on by default for `urban` maps and off for villages (whose groves and field cover already do the job); `PlaceConfig.wilderness` tunes it or turns it off with `false`, and village output is unchanged either way. It is skipped when it would dress under `MIN_WILDERNESS_HA` (1 ha).

**Coverage mask** (`COVERAGE_SPACING` 10 m over the whole 640 m square, so 65 × 65):

| Source | Counts as | Margin |
|---|---|---|
| Buildings the map places (a placement run with nothing excluded, so the mask never moves while the fix-until-valid loop drops one) | city | 26 m |
| Bridge decks (their approaches must stay level, or the bridge no longer meets its banks) | city | 30 m |
| Water, land use, leisure and natural areas (parks, schoolyards, pitches, woods: already dressed) | city | 12 m |
| Streets 5.5 m wide or more | verge | 6 m |
| Creek beds | verge | 10 m |
| Alleys (hẻm) | nothing: the woods grow round them | |

Two exact Euclidean distance transforms turn that into a weight per cell:

- **Scatter weight** = min(ramp 50 m off the city, ramp 20 m off a street), quantized to one digit per cell and stored once per map as `WILDERNESS` in the generated module. Every woodland rule multiplies its density by it (and by `density`, 0.6 since the shrink); `urban_cover` and `cover_fill` read it inverted, so parked cars and utility boxes stay in town.
- **Hill weight** = min(ramp 90 m off the city, ramp 90 m off a street). Much longer, because a road is flattened along a path smoothed over about 40 m: ground that changes faster leaves the alleys crossing it in cuttings with banks at the edge of what a player can climb.

Defaults, all halved or better on 2026-09-16: `relief` 10 m, `edgeRise` 8 m, `ramp` 50 m, `roadRamp` 20 m, `hillRamp` 90 m, `density` 0.6.

**Terrain.** The hill weight scales two long-wavelength noise layers (260 m rolling, 420 m ridges, two octaves each) plus an `edgeRise` that lifts the ground from `half × 0.38` (95 m) out toward the playable edge, so the map climbs into the border mountains. The result is a second `heightGrid` feature (65 × 65 at 10 m), added on top of any real-elevation grid. It is **exactly 0 over the city**, so the mapped ground keeps its elevation and no building lands on a slope. A slope-limiting pass pulls neighbouring samples together until no step between samples exceeds 14°, each sample moving in proportion to its own weight so a city sample never moves.

**Woodland** (`wildernessScatters` in `convert/landuse.ts`), placed before the map-wide cover layers so the big trunks go down first:

| Rule | Density /100 m² | Props |
|---|---|---|
| `wild_canopy` | 0.4, `minDistance` 9 m | `tree_broadleaf_a`, `vn_palm_coconut` at 1.0–1.35 scale |
| `wild_forest` | 2 | `tree_broadleaf_b`, `tree_broadleaf_a`, `vn_palm_coconut` |
| `wild_thicket` | 2.4 | `vn_bamboo_clump`, `vn_banana_plant` |
| `wild_undergrowth` | 3.5 | `fern`, `vn_tropical_shrub_1/3/5`, `bush_a`, `bush_c`, `vn_monstera` |
| `wild_cover` | 0.11 clusters of 2–4 | `rock_boulder_large`, `rock_small`, `bush_c`; one cluster in three is anchored by a fallen log or a big boulder |
| `wild_slope_rocks` | 0.5, from 12° | `rock_small`, `rock_boulder_large` |

Every rule carries a noise mask, so the woods have clearings rather than a wall of trunks, and every tree keeps its catalog clearance (about 5 m between trunks), so bots and players always have a way through. Map v1's generic `slope_boulders` / `slope_faces` / `slope_rocks` are skipped on a wilderness map: `wild_slope_rocks` dresses the hills with a deliberately narrow palette instead, because a prop that blocks bullets is never distance-culled and each extra kind of them costs a draw call per prop LOD cell (125 m) it lands in.

**Vietnamese plants.** `vn_palm_coconut`, `vn_palm_coconut_trio`, `vn_bamboo_clump`, `vn_banana_plant`, `vn_monstera` and `vn_tropical_shrub_1/3/5` joined the gameplay prop catalog (`layout/props.ts`) and the client manifest (`world/propAssets.ts` reads their files, LODs and bounds from `VN_PROP_MANIFEST`). Palm trunks are solid cover (0.2 m radius); bamboo, banana and the shrubs are walk-through sight cover like the other bushes. Credits are in `docs/assets-vietnam.md` and `public/assets/environment/credits.json`.

| | Hàng Xanh | Phú Nhuận |
|---|---|---|
| Built-up share of the playable square | 50 % | 52 % |
| Woodland at half density or more | 3.7 ha | 6.4 ha |
| Any woodland at all | 8.6 ha | 11.1 ha |
| Hills above the city level | up to 14 m | up to 13.9 m |

Loot and spawns stay in the city: POIs come from placed buildings, so no new POI, loot pile or spawn lands in the woods. Spawn circles, POI cores, water, fence gaps, roads and building pads are all excluded from the woodland rules, so the zone can close anywhere without trapping anyone.

## Names

- **No political map, POI, area or landmark names:** `convert/names.ts` (`isPoliticalName`) matches political figures and revolutionaries, political events and dates (30/4, Cách Mạng Tháng Tám), party and state organs (Ủy ban nhân dân, Công an, Quân khu), memorials, and the city name "Hồ Chí Minh" / "TP.HCM", ignoring case and diacritics, whole words only. Such OSM names never name a POI; the POI takes the next named thing nearby or a generic word. A place's `name`, `localName` or landmark name that matches stops the converter (and `generate.ts --name`). Historical kings, generals and scholars are not listed. Player-visible text says "Sài Gòn" for the city.
- **Road names keep the real street name**, political or not (owner decision 2026-09-15: street names are addresses players navigate by). The filter is not applied to road labels or street signs.
- **Road labels** (`convert/roadLabels.ts`, `MapData.roadLabels`, `ROAD_LABEL_MIN_LENGTH`): named trunk, primary and secondary roads of 60 m or more inside the map, tertiary from 120 m, any other named road from 180 m. Same-name ways join into chains, clipped and simplified to 2 m. Alleys ("Hẻm …") and names with a house number are skipped. The map screen (M) draws them along the road, upright, at the straightest stretches, once per 400 m, clear of POI names; below 2× zoom only trunk, primary and secondary names show. The minimap has none. The screen itself halved with the maps: `MapProjection.span` 500 m, `GRID_CELL` 50 m (still A–J columns, 1–10 rows), `MAP_IMAGE_SIZE` 1024 px over the 500 m square (~2 px/m) with its terrain raster at 512.
- **Landmarks** (`PlaceConfig.landmarks`, `MapData.landmarks`, additive): a named building picked by OSM way id. The converter resolves it to the placed building on that footprint (`generate.ts` fails when the footprint got no building). A footprint the regular pass leaves out is placed after it, on top of the cap, with the preset's `prefab` and its entrance toward `frontsWay`, so no other building moves. The map screen draws a small blue square with the name; the street signs put the name on its entrance facade. Not a POI: no spawns, loot tier or spacing.
- **Phú Nhuận landmark:** "Aga Building" on OSM way 1044664010 (`tube_house_4` at 201.6, 194.6 — its reprojected footprint centroid is 200.8, 196.1 — facing service way 127299447). OSM does not name it, so the footprint is an estimate from the alley layout.

### Street signs

`layout/streetSigns.ts` (`planStreetSigns`, pure) plans them from `MapData` and the resolved buildings at load; `apps/client/src/world/streetSigns/StreetSigns.ts` renders them from `MapRuntime`. Visual only: no colliders.
- **Look:** Vietnamese blue blade (1.1 × 0.275 m) with a thin white border and the road name in white capitals, full diacritics, on a 3.2 m grey pole. Landmark boards are 2.8 × 0.7 m, 2.6 m above the floor, 8 cm off the entrance facade.
- **Corners:** where two labeled roads cross (T junctions included), one pole per junction (crossings within 28 m merge), with a blade along each road. The pole goes on the first corner, 0.9, 1.3 or 2 m past the widest road edge, whose pole and blade ends clear every road by 0.6 m (blade ends 0.1 m) and every building outline by 0.35 m. Crossings flatter than about 20° get none.
- **Along roads:** every 175 m (one per chain from 60 m), alternating sides, sliding up to 30 m along the road when blocked, skipped within 90 m of another sign naming the road and 12 m of any sign.
- **Rendering:** one merged mesh and one PBR material over a canvas atlas baked at load (512 × 128 px per name, Arial/Helvetica/Roboto/Noto stack). One draw call. Signs past 120 m (hysteresis 124 m) are hidden by collapsing their vertices onto a visible sign, rewritten only when the visible set changes, so the mesh bounds and frustum culling follow the nearby signs. No shadow casting. Planning takes 1–3 ms.

| Map | Road labels | Signs (corner / along / facade) | Draw calls |
|---|---|---|---|
| Hàng Xanh | 6 | 13 (8 / 5 / 0) | ≤ 1 |
| Phú Nhuận | 5 | 10 (5 / 4 / 1 Aga Building) | ≤ 1 |

Regenerated from the cached OSM snapshots for the 500 m square on 2026-09-16.

| | Ngã Tư Hàng Xanh (`vn-hangxanh`) | Phú Nhuận (`vn-phandangluu`; the id keeps the street name it was first generated under) |
|---|---|---|
| Center | junction node 2899907852 "Ngã tư Hàng Xanh" (10.80144, 106.71132), unchanged | 10.80288, 106.68456 — moved about 230 m east and 170 m north of the old ward-road center, so the Aga Building and the Phan Đăng Lưu / Phan Xích Long blocks stay inside the smaller square |
| Snapshot | 2026-09-15T05:23:48Z | 2026-09-15T05:34:53Z |
| Buildings (cap) | 110 (110), 18 types | 111 (110 + the landmark), 18 types |
| Row houses | 77: 16 wide, 14 ×3, 13 narrow, 10 planters, 9 mezzanine, 6 ×4, 6 ×2, 3 shed | 76: 18 narrow, 16 mezzanine, 11 ×3, 10 ×4, 8 wide, 5 planters, 5 ×2, 3 shed |
| Shops and houses | 28: 12 French shophouses, 5 cafés, 4 kiosks, 3 workshops, 3 boarding houses, 1 villa | 30: 13 French shophouses, 7 cafés, 4 workshops, 3 kiosks, 2 villas, 1 boarding house |
| Landmarks | 2 apartment blocks, Chùa Phước Viên (pagoda), 1 market hall, 1 construction site | 2 churches, 1 school, 1 apartment block, 1 construction site, plus the Aga Building on top of the cap |
| From OSM / frontage | 52 / 58 | 69 / 42 |
| Bridges | none: no water area or mapped waterway falls inside the square | none |
| Candidates | 2,139 (OSM footprints + frontage slots) | 1,941 |
| POIs | 7, 14 spawns | 7, 14 spawns |
| Roads | 126, 9.60 km paved | 96, 8.43 km paved |
| Water | none: Rạch Văn Thánh and Cầu Sơn now fall outside the square | none |
| Prop instances | 1,237 | 1,512 |
| Validation / reachability | 0 issues; 7/7, 14/14, 112/112, loot 100 % | 0 issues; 7/7, 14/14, 114/114, loot 100 % |
| Wilderness | 3.7 ha at half density or more, 8.6 ha touched, hills to 14 m, city ratio 50 % | 6.4 / 11.1 ha, hills to 13.9 m, city ratio 52 % |
| Loot (8 seeds, buildings + outdoors) | 725 piles, 2,108 items (568 / 1,712 in buildings, 372 guns) | 684 piles, 1,968 items |
| Terrain bake | 0.62 MB | 0.64 MB |
| Map module | 120 KB | 94 KB |

POI names:
- **Hàng Xanh:** Ngã Tư Hàng Xanh, Chùa Phước Viên, Khu phố 39, Khu phố 43, Khu phố 38, Khu phố 12, Nhà thờ Nguyễn Duy Khang.
- **Phú Nhuận:** Phú Nhuận, Trung Tâm Ngoại Ngữ Dương Minh, Cầu Kiệu, Trung tâm Y tế khu vực Phú Nhuận, Nhà thờ Tin Lành Gia Định, Bãi đất trống, Khu phố 9.

Road names on the map screen and street signs (see "Names" below):
- **Hàng Xanh:** Điện Biên Phủ, Cầu vượt Hàng Xanh, Xô Viết Nghệ Tĩnh, Bạch Đằng, Đinh Bộ Lĩnh, Ngã tư Hàng Xanh.
- **Phú Nhuận:** Phan Đăng Lưu, Phan Xích Long, Thích Quảng Đức, Đường Phùng Văn Cung, Cầm Bá Thước.

**Budget.** The table below was measured at cap 190 on the 1 km squares and is kept as the shape of the cost; the cap is 110 now, so triangles and compound children fall with it, while the geometry and AO bake stays per prefab type.

| Map | Tris, all buildings | Tris within 200 m of center | Compound children | Geometry + AO bake (types used) | Nav build |
|---|---|---|---|---|---|
| Hàng Xanh | 1.06 M | 0.67 M | 36.1k | 2.7 s (24 types) | 636 ms |
| Phú Nhuận | 1.04 M | 0.64 M | 35.3k | 2.8 s (23 types) | 637 ms |

- **Triangles** stay under 1.2 M, so no far LOD was needed. The tallest prefabs are cheap per height because their upper floors are closed bodies. The current per-frame numbers are in the headless render bench (`docs/perf/benchmark.md`).
- **Loot** is well under the equipment caps.
- **Main thread:** the per-prefab geometry and AO bake is the main load-time cost, a candidate for a worker or a precomputed bake. It does not fall with the map: it is per prefab type, and both maps still use 18. Havok building bodies take about 35 ms.
- **Stuck incidents** in the bot matches are all inside buildings: tube-house upper floors round the stair core and partition door (the original `tube_house_3/4` too), plus door pinches. None are in alleys.
- **Browser checks:** a `?bench=` run in a real browser is still needed.

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
  - Prefab repetition means a place reads like the real one from above (street plan, fields, woods, river), not up close.
  - No water surface: fenced water is grass for now. Neither shipped map has water inside its square.
  - Palms are broadleaf trees.
- **Buildings:** capped at 90 by default (the city maps set 110). Dense places keep their core and a share of each cluster. Real houses 3–6 m from the street centerline get pushed back, so streets feel wider.
- **POI spacing:** real maps validate with 120 m / 85 m, the same as Map v1 since 2026-09-16.
- **Spawn groups:** 7 per map with 2 spawns each, so a 20-team solo match shares POIs through the spawn planner (`TEAM_SPAWN_STACK` 25 m keeps two teams on one spawn more than 20 m apart).
- **Terrain:** heights are real only to ±1–2 m (SRTM, blurred). Village pads flatten local slopes.
- **ODbL share-alike:** the generated modules and bakes are a derivative database. That is fine for the internal release; a public release must offer them under the ODbL.
- **City maps:**
  - Frontage rows are generated, not surveyed: the street plan is real, the individual houses are not.
  - Half the square is built up, so the outer landmark POIs sit on wilderness ground.
  - Village scatter (groves, meadow bushes) still fills the blocks between streets.
- **A 500 m square cuts real landmarks out.** Phú Nhuận's center had to move to keep the Aga Building; Hàng Xanh lost Cầu Sơn, Rạch Văn Thánh, Chung cư Mỹ Đức and Nhà Thờ Hàng Xanh.
- **OSM coverage** varies a lot. The Vietnam survey is in the investigation: most places are all-or-nothing.

## Licenses and credits

`apps/client/public/assets/map/credits.json` has the full attribution text; the picker shows the short lines.
- **OpenStreetMap (ODbL 1.0):** "© OpenStreetMap contributors", linking https://www.openstreetmap.org/copyright. Every real map needs it.
- **AWS Terrain Tiles:** the tilezen required attribution (https://github.com/tilezen/joerd/blob/master/docs/attribution.md). Any map with real elevation needs the line for its region — for example "SRTM and GMTED2010 terrain data courtesy of the U.S. Geological Survey", or "produced using Copernicus data and information funded by the European Union - EU-DEM layers" in Europe. The two shipped maps are `flat`: their tiles were fetched but not used, which `credits.json` records.
- **Google Maps data is never used.** Its terms forbid it.

## Browser viewpoints (feet x, z; heights from the terrain)

Rebuilt for the 500 m squares on 2026-09-16. **None of these has been checked in a browser yet.** Rows for features that no longer exist (Cầu Sơn, the Rạch Văn Thánh bridge, the water fences, Chung cư Mỹ Đức, Nhà Thờ Hàng Xanh) are gone: both maps now have zero water and no bridge.

| Map | Where | x, z | Look at |
|---|---|---|---|
| Hàng Xanh | Junction | (93, −55) | Frontage mix, pastel facades, French shophouses and cafés round the open center |
| Hàng Xanh | Chùa Phước Viên / market hall | (69, −59) / (−44, −62) | Pagoda gate, courtyard and roof; open market hall next to it |
| Hàng Xanh | Apartment blocks | (94, −143) and (72, −156) | Two blocks on their real footprints, podium stair up to the terrace |
| Hàng Xanh | Construction site | (192, −101) | Scaffolds and slabs at the east edge of the built-up core |
| Hàng Xanh | North-west quarter | (−185, 133) | Khu phố 43: alleys and row houses where the cap thins out |
| Hàng Xanh | West woods | (−210, 60) → walk east to (−120, 60) | How the woods thin out as the city starts: no hard line |
| Hàng Xanh | Corner wilderness | (200, 200), (−200, −200) | The tallest rises (+14 m) under palms, bamboo and banana; clearings in the canopy mask |
| Hàng Xanh | Street signs | (93, −55) | Corner poles round the junction, Điện Biên Phủ / Xô Viết Nghệ Tĩnh blades, diacritics intact |
| Phú Nhuận | Center | (−6, 85) | Phan Đăng Lưu frontage, shophouses and cafés |
| Phú Nhuận | Churches | (146, 92) and (43, 31) | Nave, bell tower and spire on their real footprints |
| Phú Nhuận | School | (35, 151) | Schoolyard kept clear of frontage and street trees |
| Phú Nhuận | Aga Building | (202, 195) | The landmark row house and its facade name board |
| Phú Nhuận | South-west block | (−115, −41) → (−86, −105) | Dương Minh POI, villa and construction site |
| Phú Nhuận | Corner wilderness | (−200, 200), (200, −200) | +13.9 m of rolling ground, thickets and undergrowth running into the border mountains |
| Phú Nhuận | Alleys through the woods | walk (−150, 150) → (−200, 200) | Alleys still cross the hills: check the cut banks are climbable |
| Phú Nhuận | Street signs | walk Phan Đăng Lưu across the square | Blue name blades at the corners and along the road, readable from both sides, off the carriageway, hidden past ~120 m |
| Any | Out of bounds | walk past x = 250 | Warning and respawn, as on Map v1 |

Not verified in a browser yet (everything above, plus):
- street signs: text orientation on both faces, atlas legibility, the hide distance;
- terrain and pad transitions where the wilderness hills meet the city;
- the picker cards;
- load time at cap 110.
