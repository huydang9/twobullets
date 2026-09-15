# Map v1 layout

Map v1 puts seven points of interest and four minor ones (hamlets and camps) on the v1 terrain (`docs/map/terrain.md`), links them with asphalt and dirt roads, and fills the space between them with lone buildings, forests, groves, tree lines and field cover. Everything below the renderer is pure data: a Node server builds the same terrain, building positions, prop instances and colliders from `MAP_V1`.

![Map v1 overview](mapV1.svg)

`mapV1.svg` is generated from MapData by `tools/map/build.ts`. It shows contours every 5 m, pads, roads, trees, rocks, fences, buildings, spawns (red rings) and each POI's radius and loot tier.

| Part | Where |
|---|---|
| Layout data | `packages/shared/src/map/mapV1.ts` (`MAP_V1`, `MAP_V1_POIS`, `MAP_V1_ROADS`, `MAP_V1_SCATTERS`, `MAP_V1_TRAINING_YARD`) |
| Pure helpers | `packages/shared/src/map/layout/`: geometry, prop catalog, roads, building resolution, scatter, POI frames, layout build, colliders, validation, SVG, worker transport |
| Terrain bake | `packages/shared/src/map/terrain/bake.ts`; output `apps/client/public/assets/map/mapV1.terrain.bin` |
| Client runtime | `apps/client/src/world/mapRuntime/` (wiring, spawns, out-of-bounds, overlay, audio hooks, Training Yard), `world/props/` (visuals, instancing, colliders), `world/vegetation/` (grass) |
| Build tool | `node --experimental-transform-types tools/map/build.ts [--check]` |

`draftMapV1.ts` stays as history: the terrain tests and the old `createDevMapV1` still use it.

## Try it

Open `http://localhost:5173/?map=v1` (DEV builds). With no query, or `?map=arena`, you get the arena as before.

- **Loading.** A loading card shows the stage and a progress bar. The console prints `[map] Map v1 ready in … ms` with a per-step breakdown.
- **Spawn.** You spawn at a random POI spawn (falling below the kill height picks another at random).
- **Handle.** `window.__twobullets.world` is the `MapRuntime`. `world.stats()` returns terrain, building, prop, collider and grass numbers.

## Load time

**Choice: a baked binary, with worker generation as the fallback.**

Why bake:
- **Speed.** A worker alone keeps the page responsive, but the wait stays at generation speed: about 1.0 s in Node and 7.8 s measured on the lead's main thread. That can't meet 1.5 s.
- **Size.** The bake is 2.42 MB and decodes and verifies in about 60–140 ms.
- **Parallel loading.** It downloads alongside the weapon and character models.

Why keep a worker fallback:
- A stale bake (someone edited the flatten regions and didn't re-bake) or a failed download never blocks the main thread.
- The page still loads, just slower, and the console says to re-bake.

**Pipeline.**
1. The main thread starts the `map-world` module worker (`layout/mapWorker.ts`, 49 KB, pure map code, no Babylon).
2. The worker downloads the bake, checks the header's inputs hash against the map's terrain spec and flatten regions, and gunzips the payload (`DecompressionStream`).
3. It rebuilds the heights (float32 bits XORed with a planar prediction, stored as byte planes), the mask and the paint.
4. It verifies `Terrain.checksum()` against the recorded one.
5. It runs `buildMapLayout` (buildings, props, scatter, about 85 ms).
6. It transfers the heights, mask, paint and instance arrays back. The main thread wraps them in a `Terrain` with `Terrain.fromSnapshot`, which copies and generates nothing.

**Determinism.** Generation code is untouched, apart from an optional progress callback. The golden terrain checksum test still passes. `layout.test.ts` checks that bake round-trips are bit-exact, that stale and corrupt bakes are rejected, and that a decoded terrain keeps flattening identically. `mapV1.test.ts` checks the recorded inputs hash and terrain and layout checksums, so a stale bake fails CI.

**Measured.** Node 24 on an M-series Mac with NullEngine and Havok (`scratchpad/layout/headless.ts`):

| Step | Where | ms |
|---|---|---|
| Bake decode + checksum verify | worker | 122 |
| Layout (buildings, 8,230 prop instances) | worker | 93 ¹ |
| *Fallback: generate terrain* | *worker* | *976* |
| Terrain physics body | main | 18 |
| Terrain chunk meshes + horizon | main | 207 |
| Buildings: 85 placements (prefab geometry and AO bake, compound bodies) | main | ≈ 670 ² |
| Prop visuals + instances | main | 7 |
| Prop colliders (6,080 bodies, 219 shapes) | main | ≈ 47 ² |
| **Map total** | | **≈ 1.15 s** (≈ 0.2 s off-thread) |

¹ Re-measured after the 85-building pass, with the exclusion-bounds prefilter in `scatter.ts` (the old layout takes 87 ms with it).
² Not re-measured headless. The geometry and AO bake is per prefab type (still the same 12 prefabs); the extra 42 placements add thin instances and compound bodies (≈ 35 ms per 60 buildings). Collider creation scales with bodies (30 ms for 3,857 before).

- **Browser timing.** Browser numbers print on load. Environment textures and prop GLBs download in parallel and aren't counted above.
- **Biggest cost.** The building geometry and AO bake (the buildings kit's `getPrefabGeometry` cache) is the largest remaining main-thread block; see Risks.

**Rebuilding.** Run `node --experimental-transform-types tools/map/build.ts` after changing the terrain, flatten regions, buildings, props or scatter. It validates, writes the bake, the checksum record (`layout/mapV1Bake.ts`) and the SVG. `--check` only verifies.

## Points of interest

The seven major centers are 281–381 m from each other (validated at ≥ 250 m). The four **minor POIs** (radius ≤ 40 m) sit in the biggest empty stretches and are validated at ≥ 150 m, and at least both radii + 40 m, from every other POI; their nearest neighbours are 163–233 m away. Each POI is authored in a `PoiFrame` (local coordinates plus a yaw), so a whole POI can move or turn at once.

| POI | Center (x, z) | Ground (m) | Radius | Buildings | Loot tier | Nearest |
|---|---|---|---|---|---|---|
| Central Town | (0, 20) | 30 | 80 | 5× two-story, 7× small, 3× ruined, bell tower (watchtower) | 2 | Millbrook 166 m |
| Farm | (300, 290) | 31 | 75 | barn, farmhouse (two-story), cottage and bunkhouse (small), 4 container sheds | 1 | Orchard 163 m |
| Military Compound | (320, −270) | 27 | 70 | 2× barracks, 2× watchtower, guard booth, 7 containers (1 stacked) | 2 | Truck Stop 233 m |
| Radar Hill | (−300, 255) | 63 | 45 | radar station, watchtower | 1 | Millbrook 340 m |
| Quarry | (−60, −340) | 1 (pit floor) | 95 | warehouse, 5 containers (1 stacked), ruined site office | 1 | Truck Stop 208 m |
| Forest Cabins | (−340, −120) | 26 | 50 | 3× small, 1× ruined | 0 | Millbrook 202 m |
| Training Yard | (340, 10) | 29 | 55 | blockout arena + soldier range (gate in the north wall) | 0 | Military 281 m |
| *Millbrook* (minor) | (−150, −50) | 29 | 38 | two-story, 3× small, ruined, barn, container shed | 1 | Central Town 166 m |
| *Truck Stop* (minor) | (135, −412) | 24 | 32 | shop (small), kiosk (guard booth), ruined workshop, 4 containers (1 stacked) | 1 | Quarry 208 m |
| *Hunter's Camp* (minor) | (−290, −380) | 30 | 30 | cabin (small), ruined cabin, hunting tower (watchtower), store container | 0 | Quarry 233 m |
| *Orchard* (minor) | (350, 445) | 27 | 32 | farmhouse (two-story), cottage (small), ruined cider house, 2 container sheds | 0 | Farm 163 m |
| *Lone buildings* | countryside | – | – | 4× small, 5× ruined, 4 containers (road shoulders and fields, see below) | outskirts | – |

What gives each one its identity:

- **Central Town.**
  - Streets and square: an asphalt main street (E–W) and a cross street (N–S), meeting at a paved 30 m square.
  - Buildings: twelve houses face the streets, and a watchtower "bell tower" stands on the square's corner as the town silhouette.
  - Dressing: fenced back yards with gate gaps, garden trees and hedges, car wrecks and a half-built checkpoint.
- **Farm.**
  - Layout: a rotated farmyard (yaw 0.25) inside a paddock fence with three gates, around a barn, farmhouse, cottage and two container sheds.
  - Surroundings: a plowed dirt field to the north with an edge fence, and a hay meadow of round bales in rows to the east.
- **Military Compound.**
  - Perimeter: rotated 0.3, on a dirt pad. Concrete walls run along the south and east sides, and chain-link along the north and west with a 10 m gate. The guard booth's boom sits across the gate, and a breach in the south wall faces the quarry road.
  - Inside: two barracks, watchtowers in opposite corners, and a container yard with a stacked pair. Sandbags, barriers and military crates add cover.
- **Radar Hill.**
  - The station and a watchtower stand on the ridge crest (the highest ground inside the map), on a dirt pad aligned with the crest.
  - An about 8° switchback road climbs the south-east flank. It was traced along the contours, with hairpins rounded by hand.
- **Quarry.**
  - The terraced pit keeps the north ramp from the draft; a second ramp from the east means the pit isn't a trap.
  - The pit floor holds a warehouse, containers, rock piles and dense rock scatter. A ruined site office sits on the floor.
- **Forest Cabins.** Four cabins ring a small dirt clearing and face it, inside the dense western pine forest. A dirt track enters from the north-east and leaves south toward the quarry.
- **Training Yard.** The arena sits on its 88 m pad (floor 0.2 m above the pad), and the east highway ends at its north gate.
- **Millbrook.** A hamlet in the west meadow: five houses face a dirt lane (`millbrook_road`) that leaves the west road and runs on south to the forest–quarry road, with the barn's big doors toward the lane and garden fences behind both rows. One grass pad under the hamlet, one pad per building.
- **Truck Stop.** A roadside cluster on the quarry–compound road, turned to the road (yaw 0.23): a shop, a kiosk (the guard booth), a ruined workshop and a container yard behind a dirt forecourt with wrecks, barrels and a barrier.
- **Hunter's Camp.** Two cabins, a hunting tower (watchtower) and a store container round a small dirt clearing in the new southern woods, reached by `camp_track` from the forest–quarry road. Fungus oaks ring the clearing.
- **Orchard.** A farmstead north of the farm, reached by `orchard_track` from the farm road: farmhouse, cottage, cider-house ruin and two sheds inside a part-fenced yard, with 55 fruit trees (small broadleaf, hand-picked row spots) east and south.
- **Lone buildings** (`roadsideBuilding` in `mapV1.ts`, poi `countryside`, outskirts loot): each faces its road from 10–16 m off the centerline, on its own pad. West road (−110, 31) ruin; farm road (46, 171) house and (151, 238) two sheds; east highway (173, 53) house; south highway (93, −194) ruin; quarry road (2, −150) house; forest–quarry road (−106, −210) two sheds; quarry–compound road (205, −363) ruin; farm–yard road (370, 109) house; fields (−60, 300) and (440, 250) ruins.

**Loot tiers** (`PointOfInterest.lootTier`, used by `generateLoot`): 2 for the hot drops (town, military), 1 for the farm, radar, quarry, Millbrook and the Truck Stop, and 0 for the forest cabins, Hunter's Camp, the Orchard and the yard. Lone buildings get outskirts loot (tier 0 × 0.8). With 85 buildings the loot test seed rolls 311 piles (the test caps it below 320) and 60 items per player (cap 70). Buildings carry their `poi`, so loot tables can subsample `BuiltBuilding.lootSpots` per tier.

**Spawns.** There are 22, two on the outskirts of each POI (minor POIs included), until landing exists. `spawnsByPoi` assigns each to its nearest POI center, so the offline spawn plan now draws teams from 10 POIs. They face the POI and are validated: walkable, under 30°, 2 m from buildings and collidable props, and ≥ 20 m inside the edge.

## Roads

Roads are `RoadSpec`s. Catmull-Rom control points (or straight legs) become flatten polylines:

| Style | Width | Falloff | Painted surface |
|---|---|---|---|
| Asphalt | 7 m | 5 m | `road` |
| Dirt | 4.5 m | 4 m | `dirt` |

They are applied after every pad, so they cut cleanly through pad edges.

| Road | Kind | Length | Connects |
|---|---|---|---|
| town_main, town_cross | asphalt | 160 + 148 m | town streets |
| highway_east | asphalt | 285 m | town → Training Yard north gate (max grade ≈ 12° across the valley) |
| highway_south | asphalt | 347 m | town → Military Compound gate |
| farm_road | dirt | 375 m | town north → farm west gate (tree-lined) |
| west_road | dirt | 299 m | town west → forest clearing |
| radar_approach + radar_switchbacks | dirt | 219 + 205 m | west road junction → radar pad |
| quarry_road | dirt | 120 m | south highway → quarry north ramp |
| forest_quarry | dirt | 350 m | forest clearing → quarry ramp top |
| quarry_military | dirt | 281 m | quarry east ramp → compound south breach |
| farm_yard | dirt | 211 m | farm south gate → east highway by the yard |
| millbrook_road | dirt | 243 m | west road → Millbrook lane → forest–quarry road |
| camp_track | dirt | 135 m | forest–quarry road → Hunter's Camp clearing |
| orchard_track | dirt | 222 m | farm road → Orchard yard (round the field fence's west end) |
| ramps | dirt | 93 + 83 m | quarry rim → floor (linear, ≈ 17–21°) |

**Totals:** 940 m of asphalt and 2.66 km of dirt, plus the ramps. `mapV1.test.ts` asserts:
- a road within each POI's radius;
- a road ending at the yard gate;
- a single connected network (roads join when they touch or meet on the same pad).

## Sightlines and cover

Crossing open ground between POIs should never be a death run or trivially safe. The layers that provide cover:

- **Field cover.** `field_cover` scatters clusters of 2–4 boulders, mossy rocks, large bushes, fallen logs or young firs, one cluster per about 50 m (density 0.04 clusters/100 m²).
  - Clusters stay outside POI cores and off roads.
  - A 160 m noise mask thins them in a few meadows, so some crossings are riskier than others.
  - One cluster in ten is anchored by a `rock_boulder_large` or `log_mossy`.
- **Gap filler.** `cover_fill` puts a `rock_boulder_large` wherever open ground still has no hard cover within 25 m (outside the dense woods). Straight crossings between POIs now pass within 25 m of hard cover at least every 58 m (216 m before); see `docs/map/cover-props.md`.
- **Big trees and rocks.** Fungus oaks in the western forest and on the wood edges, big oaks in the river valley, big boulders and open rock faces on steep slopes.
- **Groves and tree lines.**
  - Clumpy groves (north, south, east, west meadow, north-east, east fields and south-east masks) break long sightlines; each mask keeps open lanes between clumps.
  - Deciduous trees and solitary big oaks follow the river valley; `field_oaks` puts a lone `tree_oak_large` in open meadows (≥ 55 m apart, outside the woods).
  - Conifer `south_woods` (with fungus oaks) fill the strip south of the western forest round Hunter's Camp.
  - Tree lines run along the farm road, both sides of every dirt road and track, and both sides of both highways.
- **Countryside props.**
  - Broken wooden field fences.
  - Hay-bale walls north of town, hay stacks in the fields round the farm and town.
  - Car wrecks on road shoulders, 80 m or more apart.
  - An abandoned roadblock on the south highway: barriers, sandbag walls and two wrecks.
- **Cover inside POIs.** See `docs/map/cover-props.md`:
  - hay-bale walls in the farm meadow;
  - sandbag walls, cable drums and pipe stacks in the compound, the town checkpoint and the quarry yard;
  - rock faces on the quarry terraces and the radar flank;
  - big oaks in town, round the farm and the forest clearing.

## Props and scatter

**The gameplay catalog: `layout/props.ts`.**
- **Data.** Category, footprint, collision (none, trunk cylinder, or box with `bulletproof`), acoustic surface, `alignToTerrain` and sink per prop id.
- **Ids.** They match the environment manifest's `PropId` (`world/propAssets.ts`) wherever an asset exists, so the client draws the real GLB as soon as the pipeline marks it ready.
- **Map-only props** without an asset yet (`fence_wood`, `wall_concrete`, `rock_pile`) render as procedural stand-ins (`world/props/standInMeshes.ts`). The `sandbags`, `hay_bale` and `hay_stack` stand-ins stay in the catalog but Map v1 now uses `sandbag_barrier`, `hay_bale_wall` and `hay_bale_stack`.
- **Collision sizes.** They follow the manifest's measured bounds. Rock and prop hulls stay client-only in the manifest, so the shared boxes are the gameplay approximation that client and server both build.

**Scatter rules: `ScatterRule extends PropScatter`, all extras optional.**
- **Fields:** seed, noise density mask, edge fade, min/max slope, `avoidPads`, clearance, exclusion polygons, clusters (optionally with a large `anchor`), and `detail` (grass).
- **Cover fields:**
  - `spots`: hand-picked candidates instead of the lattice;
  - `faceDownhill`: front down the fall line, seated half a footprint downhill;
  - `minDistance` between the rule's own instances;
  - `bareRadius`: only where no `isHardCover` prop or building is that close;
  - `edgeBand`: only near the area outline.
- **Candidates.** One seeded candidate per cell of a jittered lattice anchored at the world origin, so any sub-rectangle expands to exactly the same instances.
- **Per-spot tests** (integer-hash randomness, `sinCos`-based slope thresholds):
  - polygon membership and the noise mask;
  - slope and dominant surface;
  - pads (trees and rocks), road distance and building outlines;
  - explicit prop footprints, spawn circles and earlier accepted footprints;
  - collidable instances keep 1.5 m beyond their collider from building entrances, and cluster members honour `exclude`.
- **Openings.** `PoiFrame.line` records its gaps (`MAP_V1_OPENINGS`); Map v1 adds them, widened by 3 m, to every non-detail rule's `exclude`.
- **Snapping.** Instances snap to `sampleHeight` minus sink × scale. Rocks tilt to the terrain normal; trees stay upright.
- **Instance format.** 7 floats: x, y, z, yaw, scale, normal x, normal z. Scales are quantized to 1/20 so collider shapes can be shared.

**Counts** (layout checksum `ce63f1c3`, 8,230 instances plus 85 buildings; 712 explicit placements, the rest scatter):

| Category | Instances | Props |
|---|---|---|
| Trees | 4,236 | fir_b 1,498, broadleaf_a 1,149, fir_a 673, broadleaf_b 634, fir_young 117, oak_fungi 90, oak_large 75 |
| Bushes | 2,150 | fern 745, bush_a 624, bush_c 449, bush_b 332 |
| Rocks | 1,092 | rock_small 502, boulder_a 172, moss_b 131, moss_a 97, boulder_b 86, boulder_large 74, face_large 25, rock_pile 5 |
| Props | 752 | fence_wood 379, fence_chainlink 83, wall_concrete 43, log_fallen 41, log_mossy 40, hay_bale_stack 27, stump_boubin 25, sandbag_barrier 24, car_wreck 19, car_covered 16, cable_spool 12, hay_bale_wall 12, road_barrier 10, barrel_rusty 7, pipe_stack 7, others 7 |
| Grass (client only, near the viewer) | ≈ 600–950 visible | short / medium / tall clumps, density 30/100 m² under a patch mask |

Trees roughly doubled (2,253 before). They also count as hard cover, so `cover_fill` now needs 25 gap boulders instead of 110 and `field_cover` places 556 instances instead of 694.

**Per rule** (in expansion order):

| Rule | Instances |
|---|---|
| forest_west_oaks / forest_west_floor | 31 / 41 |
| ridge_edge_oaks / east_edge_oaks | 10 / 12 |
| valley_oaks / south_woods_oaks / field_oaks | 17 / 18 / 47 |
| orchard_rows (hand-picked spots) | 55 |
| forest_west / forest_west_under | 921 / 1,035 |
| ridge_woods | 468 |
| east_woods / east_woods_under | 366 / 317 |
| south_woods / south_woods_under | 345 / 311 |
| north_groves / south_groves / east_groves | 387 / 223 / 256 |
| valley_trees | 249 |
| west_groves / north_east_groves / east_field_groves / south_east_groves | 257 / 136 / 74 / 48 |
| town_gardens | 36 |
| farm_road_trees_l / _r | 25 / 27 |
| highway_east_trees / highway_south_trees (original side) | 10 / 17 |
| roadside tree lines (`ROADSIDE_TREE_LINES`: 20 bands on 11 roads) | 170 |
| field_cover | 556 |
| field_hay_farm / field_hay_town | 6 / 4 |
| slope_boulders / slope_faces | 17 / 5 |
| radar_faces / quarry_faces (hand-picked spots) | 6 / 14 |
| slope_rocks | 343 |
| quarry_rocks | 151 |
| cover_fill | 25 |
| meadow_bushes | 482 |

The build prints the exact current values.

**Per 250 m cell** (x cell, z cell):

| z \ x | −2 | −1 | 0 | 1 |
|---|---|---|---|---|
| 1 | 504 | 299 | 420 | 420 |
| 0 | 626 | 323 | 395 | 270 |
| −1 | 1,472 (western forest) | 432 | 389 | 385 |
| −2 | 843 (southern woods) | 496 | 285 | 671 (eastern woods) |

### Blank space

User feedback on the 43-building layout: "add more building, tree (too much blank space)". Measured on a grid of cell centers inside the playable square (`scratchpad` script, same layout data):

| Metric | Before (43 buildings, 2,253 trees) | After (85 buildings, 4,236 trees) |
|---|---|---|
| 50 m cells with no building, tree or hard cover within 40 m | 1.0 % | 0.3 % |
| 50 m cells with no building or tree within 40 m | 27.3 % | 2.3 % |
| 25 m cells with no building or tree within 25 m | 43.6 % | 12.6 % |
| 25 m cells with no building, tree or hard cover within 25 m | 10.4 % | 3.4 % |

- **Before**, the gap boulders already put hard cover almost everywhere, so the brief's first metric hid the problem. The emptiness players saw was the tree/building gap: a west-meadow corridor (x −225…−125 from z −325 to 125), the whole strip south of the western forest and quarry (z < −375), the north-east corner above the farm and the east fields past it.
- **After**, the remaining 25 m gaps are deliberate: the quarry pit and terraces, the Radar Hill slopes, the Training Yard and compound pads, the farm's plowed field and the meadows between clumps.

**Budget of the pass** (manifest LOD triangles, 100° view cone, worst of 8 directions; compare `docs/map/cover-props.md`):

| | Before | After |
|---|---|---|
| Trees, worst case all at their last level (trunks are cover and never cull) | 30k | 55k (billboards are 6 tris; the 165 oaks are most of it) |
| Tree triangles in view: town square / radar pad / field town–farm | 28k / 35k / 73k | 41k / 59k / 87k |
| Tree triangles in view: forest clearing / deep western forest | 170k / 168k | 184k / 192k |
| Tree triangles in view: Millbrook / Hunter's Camp / Truck Stop / Orchard | 35k / 56k / 28k / 28k | 73k / 129k / 74k / 73k |
| Tree batches in view (prop × 250 m cell × level) | 17–74 | 32–95 |
| Buildings, all 85 in view | 101k | 178k (`buildings.md` planned 154k for 60) |
| `rock_boulder_large` far levels (400 tris each, never cull) | 164 → 66k | 74 → 30k |

Net worst-case cover at far levels drops by about 10k: the extra oak and billboard triangles are smaller than the 90 gap boulders that trees replaced. If `?bench=v1` shows vertex cost at the camp or the orchard, first thin `south_woods` or the grove densities; they are single numbers in `mapV1.ts`.

## Rendering

**Instanced props: `PropInstances`.**
- **Batches.** Thin instances per prop per 250 m cell, split into buckets of LOD level × "casts shadow". LOD distances come from the manifest (for example, firs switch at 45 m and become billboards at 140 m).
- **Shadow band.** Shadows are cast only within 70 m for trees, 50 m for rocks and props and 25 m for bushes, and never by billboards.
- **Updates.**
  - Instances are re-bucketed when the camera moves 4 m.
  - A cell that falls entirely into one bucket (most distant cells) is handled without per-instance work.
  - A batch's buffer is rewritten only when its membership changes.
- **Culling.** Past `cullDistance` from the manifest.

**Grass: `GrassField`.**
- **Expansion.** The detail rule expands per 16 m cell through the same `ScatterContext` (off roads, pads, dirt and buildings), cached for 400 cells.
- **Buffers.** One thin-instance buffer per clump prop and LOD, rebuilt every 8 m of movement.
- **Range.** Drawn within 45 m, shrinking to zero over the last 12 m instead of popping. No shadows, no collision.

**Headless batch counts** (stand-ins, one mesh per batch, before frustum culling; measured on the 43-building layout, not re-measured after trees doubled):

| View | Prop batches | Shadow-casting instances | Grass |
|---|---|---|---|
| Town square | 195 | 61 | 607 |
| Forest cabins | 161 | 178 | 942 |
| Radar crest | 159 | 32 | 681 |
| 300 m above the center | 114 | 0 | 782 |

Real assets add one mesh per material per batch.

## Collision

- **Buildings.** One compound Havok body per building, with the shape shared per prefab (buildings kit).
- **Props: `PropColliders`** (from the pure `propColliderGroups`).
  - **Grouping.** Instances of the same prop at the same quantized scale form one group: one shape and one `PhysicsBody` over an invisible thin-instanced mesh. The Havok plugin creates a static body per instance, all sharing that shape. In total: 219 shapes and 6,080 bodies (167 and 3,857 in 30 ms before the 85-building pass).
  - **Trees** get trunk cylinders; the canopy never blocks.
  - **Rocks and set dressing** get yaw-only boxes, even when the visual is tilted.
  - **Fences** (`bulletproof: false`) sit on the `blocker` membership layer: they stop movement, and bullets pass through.
  - **Grass, bushes and ferns** get no collision.
- **Headless checks.**
  - Horizontal rays into every sampled collidable instance hit its own tagged collider, apart from terrain in front of some rocks on slopes.
  - Bullets pass 26/26 wooden fences and 28/28 chain-link fences.
  - Sprinting into trunks, walls and boulders never gets closer than trunk radius + capsule radius. Thin firs deflect the capsule around them.

## Audio hooks

`MapRuntime.attach(player, presentation.audio.probe)` registers:

1. **Surface providers**, in order:
   - `BuildingAcoustics.surface` finds the nearest face of the nearest building part (from prefab data, no rays) and maps its material slot through audio's `taggedSurface`. Results: house floors → wood, barn floor and walls → concrete, container floors → wood. It returns null outside buildings.
   - `terrainSurfaceProvider(terrain.surface)` covers terrain.
2. **`probe.enclosureProvider = BuildingAcoustics.enclosure`**:
   - 1 inside an indoor room;
   - 0 in open-air rooms (balconies, roofless ruins, tower platforms, the radar roof) and in the open;
   - null inside a building's bounds but outside its rooms, and over the Training Yard arena, so the probe's rays decide there.
3. **`metadata.surface`** on every prop collider mesh (`wood`, `concrete`, `metal`, `dirt`, `grass`, `gravel`), so hits on trees, rocks and fences resolve directly. Building bodies are deliberately left untagged, so the part-accurate provider above answers for them.

## Out of bounds

- **Warning.** Leaving the playable square (±500 m) shows a red warning with a countdown: "Outside the play area. Return in 9.4 s". The console logs it too.
- **Countdown.** It runs for `bounds.outOfBoundsGraceSeconds` (10 s in v1). Returning cancels it.
- **Respawn.** When the countdown runs out, the player respawns at the spawn nearest their position. `MapSpawns.respawnNear` narrows the level's spawn list to that one point for the call, because `PlayerController` only offers random respawns.
- **Falling.** Falling below `killY` still uses the controller's random respawn.

## Validation

**Pure checks: `validateMapLayout`, asserted by `mapV1.test.ts`.**
- Buildings stay ≥ 1 m from each other (stacked containers excepted) and ≥ 1 m from road edges.
- Terrain under every foundation stays below the floor and above the foundation bottom; containers sit on flat pads.
- Every entrance is at most a 0.35 m step from the ground outside.
- Major POI centers are ≥ 250 m apart; a minor POI (radius ≤ 40 m) is ≥ 150 m and at least both radii + 40 m from every other POI (`poiSpacing`, `minorPoiSpacing`, `minorPoiRadius`).
- Spawns are clear and walkable.
- No collidable scatter sits on a road.
- No collidable prop is within 1.5 m of a building entrance (`prop-at-entrance`), or in or next to a fence gate or wall breach (`prop-in-opening`, when `openings` are passed; `mapV1.test.ts` passes `MAP_V1_OPENINGS`).

**Unit tests: `layout.test.ts`** cover the geometry helpers, fence segmentation, bake round-trips, scatter exclusions and determinism, region-tiling equivalence and the worker pipeline's generate fallback.

**Headless check** (NullEngine + Havok + the client's `CharacterBody`): on the 43-building layout, all 14 spawns settled within 2 cm and walk 11–39 m each way with no ticks below ground. Also verified:
- range rays reach all 10 soldiers;
- walking in through the yard gate works;
- the out-of-bounds countdown expires at 10.0 s and respawns at the nearest spawn;
- enclosure and surface lookups return the values above.

## What to check at `?map=v1`

**Load.** Watch the loading card, then find `[map] Map v1 ready in … ms (terrain bake …)` in the console. A `terrain bake not used` warning means the bake is stale.

**Vantage points.** Positions are feet coordinates (x, z). Heights come from the terrain, so fly or walk there with the DEV tools.

| Where | x, z | Look at |
|---|---|---|
| Radar tower platform | (−290, 263), 9 m up | The whole west half: forest cabins in the pines (SW), the town silhouette and bell tower (SE), switchbacks below |
| Town bell tower | (9, 30), 9 m up | Streets, square, back-yard fences, garden trees; highways leaving east and south with their tree lines |
| Quarry east rim | (60, −370) | Pit, both ramps, warehouse, rock scatter on the terraces |
| Military tower NE | (370, −253) | Walls vs. chain-link, gate and boom, container stack, the eastern woods behind |
| Farm meadow | (360, 270) | Hay rows as cover, paddock fence gates, plowed field |
| Open field between town and farm | (130, 160) | Field fences, hay, cover clusters: whether crossings feel fair |
| Training Yard gate | (340, 70) | Road into the north gate, soldier range working inside |
| Forest clearing | (−340, −120) | Tree density, canopy LOD and shadows within 70 m, grass fade at 45 m |
| Out of bounds | walk past x = 500 near (495, 60) | Warning, countdown, respawn at (400, 60) |
| Millbrook lane | (−150, −5), looking south | Houses on both sides of the lane, barn doors, garden fences, west-meadow groves |
| Hunter's Camp tower | (−284, −402), 9 m up | Clearing, cabins, the new southern woods and fungus oaks |
| Truck Stop forecourt | (125, −398), looking south-east | Shop, kiosk, container yard; road tree lines both sides |
| Orchard yard | (348, 437), looking east | Fruit-tree rows, sheds, north-east groves, farm to the south |
| West meadow | (−170, 120), looking south | Whether the groves keep open lanes and crossings still feel fair |

**Visuals I could not verify** (no browser here):
- stand-in fence, wall, sandbag and hay meshes (faceted, vertex-coloured PBR);
- prop LOD and billboard pops at 45/140 m;
- the grass density and fade;
- tree shadow cut-off at 70 m;
- building floors meeting the pads (10 cm lip) and the chunk-edge look around pads and road embankments.

## Risks and follow-ups

- **Main-thread building bake.** It takes about 0.64 s (Node) inside `BuildingVisuals`' private geometry cache. `buildPrefabGeometry` is pure and could run in the map worker if the buildings kit exposed `primePrefabGeometry(id, geometry)`. Terrain chunk meshes (0.2 s) could move off-thread the same way with a `TerrainRenderer` option to accept prebuilt chunk geometry. Both files belong to other owners.
- **Draw calls.** Props take 115–195 batches per camera pass before frustum culling with stand-ins, and more with multi-material GLBs. Options:
  - bigger cells for small props;
  - merging bushes and rocks into shared atlased batches;
  - dropping LOD0 batches beyond the frustum.
  This is for the performance engineer. Grass is about 600–950 clumps at 400–1,100 triangles each; the density or radius may need tuning on real GPUs.
- **Collision parity.** Shared collision boxes and cylinders are hand-fitted to the manifest's measured bounds. The generated trunk cylinders for `tree_fir_b` (r 1.33 m) and `tree_fir_young` (r 0.95 m) look wrong in `environmentManifest.ts`, so I didn't use them. The asset pipeline should emit collision into shared data, so the server gets the hulls and nothing drifts.
- **Respawn at a point.** `MapSpawns.respawnNear` works around `PlayerController` having no `respawnAt(spawn)`. A small API there would remove the level-getter trick.
- **Stale bakes.** Editing `MAP_V1` flatten regions without re-running the build falls back to worker generation (seconds) and fails `mapV1.test.ts`. There is no root `pnpm` script yet (`map:build` would be `node --experimental-transform-types tools/map/build.ts`).
- **Tilted props** (rocks, wooden fences on slopes) keep yaw-only colliders, a few cm off the visual on steep ground.
- **Fence yaw uses `Math.atan2`** at authoring time. That's fine in V8 (Chrome and Node), but other engines could differ in the last ulp and change the layout checksum; gameplay isn't affected.
- **No HUD integration.** The loading card and out-of-bounds warning are the runtime's own DOM overlay; the UI can take them over later.
