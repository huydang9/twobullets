# Buildings kit (Map v1)

No free, cleanly licensed, realistic enterable houses exist. So buildings are generated from data: a modular kit of axis-aligned boxes and wedges, rendered with the Poly Haven PBR scans already in `apps/client/public/assets/environment/textures`. **Every part is a visual and an identical collision shape**, so what you see is exactly what stops players and bullets. The server can load the collision headless from pure data.

| Where | What |
|---|---|
| `packages/shared/src/map/buildings/` | Pure data: types, kit (`kit.ts`), prefabs (`prefabs/`), geometry and AO bake (`geometry.ts`), BVH ray/box queries (`raycast.ts`), collision, transforms and loot (`placement.ts`), tests |
| `packages/sim/src/map/` (`@twobullets/sim`) | Babylon, headless-safe: compound Havok bodies (`buildingPhysics.ts`), placement API (`buildBuilding.ts`), headless Map v1 collision (`mapCollision.ts`) |
| `apps/client/src/world/buildings/` | Client only: looks and PBR materials, interior shading plugin, thin-instanced renderer |
| `apps/client/buildings.html`, `src/dev/buildingsPreview.ts` | DEV preview page |

## Conventions

- Prefab-local frame: meters, Y up. The origin is at the footprint center, on the **ground-floor finished floor level** (y = 0). The main entrance faces local +Z.
- `yaw` works like `LevelBlock.rotationY`: local +Z turns toward world (sin yaw, 0, cos yaw).
- Foundations extend 0.8 m below the floor. Flatten terrain under `prefab.bounds` (XZ) to 0.05–0.2 m below `position[1]`, and never above it, or the heightfield pokes through the floors. The terrain engineer's `MapBuilding extends BuildingPlacement` already uses this contract. Use `isBuildingPrefabId(mapBuilding.prefab)` to narrow the string.
- Story height is 3.0 m (2.8 m clear, 0.2 m slabs). Exterior walls are 0.2 m thick and partitions 0.15 m.

## Kit pieces (`PrefabBuilder`)

| Piece | Notes |
|---|---|
| `wall` | Openings (`door`, `window`, `hole`) are subtracted from the wall rectangle into a minimal set of solid boxes. Doors and windows get 0.08 m frame boxes that protrude 0.03 m past both faces. Holes have no frame and may reach the wall top or ends, so overlapping holes make jagged broken walls. The exterior face, interior face and frames each take their own material. |
| `shell` | Four exterior walls with openings per side. The ±Z walls span the full width. |
| `slab` | Floor/ceiling with rectangular holes (stair openings). Top, bottom and side materials are separate. |
| `foundation` | Plinth whose top is the floor finish. |
| `flight` | Straight stairs between two heights. The rise is split evenly at ≤ 0.3 m with a 0.3 m run. Solid steps or floating block treads, plus an optional stepped balustrade panel on open sides. Returns the landing coordinate. |
| `railing` | Posts ≤ 1.5 m apart, with a top rail at 1.05 m and a mid rail at 0.5 m, along an axis-aligned polyline. |
| `gableRoof` | Two wedges (convex hulls in physics), eave and gable overhangs, fascia boards. The slope is walkable below 50°. |
| `box`, `wedge` | Props: rubble, bunks, racks, beams, antenna. |
| `room`, `entrance`, `crouchPassage` | Metadata for loot, navigation and tests. |

Default openings are sized to the controller:
- Exterior door: 1.1 × 2.2 m clear. Interior door: 1.0 × 2.2 m.
- Window: 1.2 m wide, sill 1.0 m, head 2.3 m. The 1.3 m clear height fits a crouched capsule (1.1 m + skin), so windows can be crouch-jumped. The sill is above crouched eye height (0.95 m).
- Small windows (sill 1.4–1.5 m, 0.7 m tall) can't be vaulted.
- There is no glass. Bullets pass through window and door openings.

## Prefabs

Triangles and draw calls are per prefab, after hidden-face removal and AO gridding. A draw call is one look, after merging material slots that share a look. "Shapes" counts the children of the one compound body.

| id | Size W × D × H (m) | Content | Tris | Draws | Shapes | Rooms / loot spots |
|---|---|---|---|---|---|---|
| `house_small` | 9.5 × 8.4 × 5.1 | Living room, bedroom, bathroom, front and back doors, gable roof | 2,168 | 5 | 89 (2 hulls) | 3 / 20 |
| `house_small_ruined` | 9.1 × 8.0 × 3.0 | Same plan with no roof, broken ceiling, blast holes, rubble, a fallen-slab ramp, and a crouch-only beam across the bedroom door | 2,732 | 4 | 87 (1) | 3 / 15 |
| `house_two_story` | 10.5 × 9.9 × 8.5 | Stair hall, living room, kitchen, bathroom, 2 bedrooms, balcony over the porch | 5,150 | 5 | 227 (2) | 8 / 55 |
| `barn` | 12.8 × 18.6 × 9.5 | Plank barn with 4 m gable doors, stalls, stairs to a hay loft | 4,850 | 3 | 122 (2) | 3 / 95 |
| `warehouse` | 24.6 × 17.0 × 8.8 | Corrugated shed with roller-door openings, clerestory windows, an office with a mezzanine and stairs, racks and crates | 10,194 | 6 | 218 (2) | 4 / 138 |
| `barracks` | 20.1 × 10.2 × 3.6 | Flat parapet roof, dormitory with bunks, hall, office, washroom | 5,008 | 5 | 142 | 4 / 61 |
| `watchtower` | 5.6 × 5.6 × 11.6 | Concrete core with a square spiral of 3 flights and corner landings up to a 9 m platform, parapet and roof | 2,140 | 3 | 85 | 1 / 6 |
| `guard_booth` | 8.0 × 3.2 × 3.0 | Booth on a 0.2 m base with windows on 3 sides and a boom barrier | 740 | 4 | 34 | 1 / 1 |
| `radar_station` | 11.1 × 7.1 × 8.1 | Control and equipment rooms, exterior stairs through a parapet gap onto the roof, antenna mast | 2,234 | 5 | 97 | 3 / 46 |
| `container_open` / `_blue` | 2.5 × 6.1 × 2.6 | 20 ft ISO container with both doors swung back | 336 | 2 | 10 | 1 / 4 |
| `container_closed` | 2.4 × 6.1 × 2.6 | Solid cover block that can be stacked with `position[1] = 2.59` | 96 | 1 | 1 | – |
| `tube_house_2` | 4.2 × 13.0 × 6.9 | Saigon tube house (nhà ống): shopfront with a 2.8 m roll-up door opening, stair core, front and back room per floor, front balcony, flat parapet roof | 3,452 | 6 slots | 130 | 5 / 4 |
| `tube_house_3` | 4.5 × 15.0 × 12.8 | Same plan over 3 stories, balconies, roof terrace reached through a stair head under a steep roof | 6,522 | 6 slots | 223 | 10 / 7 |
| `tube_house_4` | 4.8 × 16.3 × 15.4 | 4 stories, balconies, steep gable roof (no roof deck) | 8,066 | 6 slots | 274 | 11 / 8 |

**Vietnamese city set** (sizes W × D × H; draws are material slots before look merging; all 0 nav-overflow columns):

| id | Size (m) | Content | Tris | Slots | Shapes | Rooms / loot spots |
|---|---|---|---|---|---|---|
| `tube_house_narrow` | 3.8 × 13.0 × 10.7 | Nhà ống, 3 stories, parapet roof, balcony door only | 5,392 | 6 | 180 | 8 / 6 |
| `tube_house_wide` | 6.2 × 15.0 × 10.7 | Nhà ống, 3 stories, 6 m frontage | 6,394 | 6 | 204 | 8 / 6 |
| `tube_house_planters` | 4.6 × 14.0 × 10.7 | 3 stories, terracotta plant boxes on the balconies | 6,126 | 7 | 207 | 8 / 6 |
| `tube_house_shed` | 4.4 × 14.0 × 10.6 | 2 stories, roof terrace with a corrugated lean-to shed | 4,640 | 7 | 153 | 7 / 5 |
| `tube_house_mezzanine` | 5.0 × 16.0 × 9.2 | 4.5 m shop story with a gác lửng over its back half, one upper story, parapet | 4,694 | 8 | 145 | 6 / 5 |
| `shophouse_french` | 10.3 × 12.7 × 7.7 | Nhà phố Pháp: arcade under the upper floor, shuttered windows, cornice, parapet | 4,180 | 7 | 155 | 5 / 5 |
| `cafe_terrace` | 7.0 × 13.6 × 7.6 | Quán cà phê: tiled terrace, tables, planters, awning, upstairs room and balcony | 3,466 | 8 | 132 | 3 / 3 |
| `villa` | 18.0 × 20.1 × 9.7 | Biệt thự: 2 stories, tiled gable roof, porch balcony, walled garden with a gate | 5,080 | 8 | 222 | 5 / 5 |
| `boarding_house` | 18.8 × 7.7 × 7.5 | Nhà trọ: 8 rooms off an open corridor, stair in the corridor, tin roof | 6,950 | 5 | 293 | 8 / 8 |
| `apartment_block` | 24.0 × 8.3 × 17.8 | Chung cư cũ: 5 stories; 9 flats on 3 floors off a front gallery, stair well; closed top floors | 10,028 | 6 | 385 | 9 / 9 |
| `pagoda` | 16.0 × 21.4 × 8.8 | Chùa: courtyard behind a tam quan gate, hall on a plinth, two-pitch tiled roof with horn ends | 3,584 | 6 | 85 | 2 / 3 |
| `church` | 11.0 × 20.6 × 20.2 | Nhà thờ: nave with pews and tall windows, bell tower with belfry and spire | 4,122 | 8 | 137 | 1 / 2 |
| `school` | 24.1 × 20.1 × 7.6 | Trường học: L plan, 10 classrooms on 2 floors off galleries, stair up the gallery | 13,110 | 6 | 532 | 10 / 10 |
| `market_hall` | 20.8 × 15.2 × 7.2 | Chợ: open-sided, columns, stall counters, low corrugated roof | 2,794 | 5 | 45 | 1 / 3 |
| `shop_kiosk` | 8.4 × 11.4 × 4.7 | Cửa hàng tiện lợi: glass shopfront, sign band, awning, shelves, counter | 1,986 | 8 | 87 | 1 / 2 |
| `petrol_station` | 13.0 × 15.7 × 7.3 | Trạm xăng: canopy on columns over two pump islands, shop | 2,328 | 8 | 49 | 2 / 2 |
| `workshop` | 12.8 × 16.6 × 7.0 | Xưởng: roll-up door opening, corner office, benches, low tin gable | 2,750 | 7 | 105 | 2 / 4 |
| `office_tower` | 20.2 × 18.1 × 33.8 | 8 floors: lobby and first floor enterable, 6 closed floors behind a banded curtain wall with fins | 12,908 | 6 | 381 | 4 / 5 |
| `highrise_apartment` | 30.1 × 24.1 × 52.8 | 16 floors on a shop podium (3 shops, hall, stair to the roof terrace); closed tower | 17,836 | 5 | 381 | 5 / 6 |
| `construction_site` | 16.1 × 13.1 × 10.6 | Concrete frame, 3 slab levels with stairs, front scaffolding with plank decks, rebar | 5,322 | 5 | 103 | 4 / 4 |
| `bridge_lane_16`, `_80` | 5.7 × 16 / 80 × 8.1 | Lane bridge: 3.6 m roadway, sidewalks, parapets, lamp posts, ramps both ends | 748 / 3,668 | 4 | 21 / 37 | – |
| `bridge_road_24`, `_40` | 10.5 × 24 / 40 × 8.1 | Road bridge: 7.6 m roadway, 1.2 m sidewalks | 1,232 / 2,116 | 4 | 21 / 25 | – |

The city set (`prefabs/vnHouses.ts`, `vnCivic.ts`, `vnCommercial.ts`, `bridges.ts`, helpers in `vnCommon.ts`) follows the tube-house rules:
- **Loot:** `lootRoom` tiles every room with the 0.12 m raised floor, leaving bare floor round doors (`doorAprons`), under props standing on the slab and round 1–3 kept loot spots. A kept hole is ±0.41 m, so tile edges never sit on a nav cell center.
- **Nav:** a prefab column keeps at most 4 walkable levels. So the office tower and high-rise have 2–3 enterable levels and a solid body above. Their facade layers (bands, glass, fins, the apartment block's upper parapets) are 0.1 m thick, under the nav grid's 0.12 m support width. Tests assert 0 overflow columns and a standing capsule's headroom over every tread.
- **Bridges** set `BuildingPrefab.spansRoad` (additive): layout validation skips their road clearance. The deck body reaches 1.2 m below the floor, so nothing crawls under it, and it closes the gap the bank fences leave for the road.

**Tube houses** (`prefabs/tubeHouses.ts`, one parametric builder) are row houses for the city maps (`docs/map/real-world.md`, urban mode):
- Party walls have no windows, so neighbours can stand 0.12 m apart; the entrance faces the street (+Z).
- One straight flight per story, stacked in a 1.1 m stair core on the west wall. Upper floors wall the core off and put a railing across it where no flight continues.
- Nav: the grid keeps at most 4 walkable levels per column. So only the 3-story house has a roof deck, its stair head roof is steeper than 50°, and the 4-story house has a gable.
- Loot: each room is tiled with a 0.12 m raised floor (walkable, under the step height) except round its doors and one kept spot. Loot spots need bare floor, so a tube house holds 4–8 spots instead of 20–60, and a street of them doesn't flood a map with loot.
- Materials: `darkSteel` frames, railings and the shutter drum; plaster walls; `roofMetal` for the gable and stair head.

Loot spots are on a 1.5 m grid inset 0.6 m from room edges. They skip anything blocked below 1 m and anything without a floor underneath (stair holes). Loot tables should subsample them.

## Materials

The shared data names **material slots**. The client maps slots to **looks** (`BuildingMaterials.ts`), and slots that share a look merge into one mesh.

| Slot(s) | Look (texture set, tint) | Used for |
|---|---|---|
| `plaster` | `concrete_wall_008` ×(1.75, 1.8, 2.2) | Exterior render on houses, barracks, radar, booth |
| `plasterInterior` | `concrete_wall_008` ×(2.1, 2.15, 2.6) | Interior walls and ceilings |
| `concrete` | `concrete_floor_worn_001` ×1.8 | Foundations, stairs, slab tops, rubble |
| `woodFloor`, `woodPlanks`, `woodTrim` | `weathered_planks` ×(1.9, 1.8, 1.7) | House floors, barn siding and loft, frames, railings, crates |
| `corrugated` | `corrugated_iron_02` ×1.6 | Warehouse and barn cladding/roof, tower parapet |
| `roofMetal` | `rusty_metal_02` ×(0.5, 0.24, 0.2) | Red painted, rusting house roofs |
| `roofAsphalt` | `asphalt_02` | Flat bitumen roofs |
| `paintedSteel` | `rusty_metal_02` ×(0.34, 0.37, 0.27) | Military frames, tower steel, mezzanine, racks, bunks |
| `darkSteel` | `rusty_metal_02` ×0.2 | Available, currently unused |
| `containerRed` / `containerBlue` | `corrugated_iron_02` tinted | Containers; café awning, petrol canopy fascia |

**City looks** (client only; the shared slots are unchanged):
- **Facade pastels:** `plasterYellow`, `plasterMint`, `plasterPink`, `plasterSky`, `plasterWhite` (`white_plaster_02` tints).
- **Towers:** `glass` (dark `painted_plaster_wall`).
- **Per prefab:** pagoda and school yellow; church pink; petrol station and high-rise white; office tower and workshop `concreteWall`, with `glass` for `darkSteel`; construction bricks.
- **Facade colours per placement:** `facadeColor(prefabId, x, z)` (`buildings/palette.ts`) hashes the placement's world XZ to one of 6 colours (default plaster or a pastel) for the city houses (`PALETTED`). `BuildingVisuals` batches each prefab per cell per look, and a colour swaps only the exterior plaster group, so each colour adds one draw per prefab per cell.

Each look also gets the world-space luma breakup of `SurfaceVariationPlugin` (so repeated instances differ) and `BuildingShadePlugin`, which:
- darkens wall albedo near the ground floor (grime keyed to the prefab-local height, not world Y, so it works on terrain);
- scales **only the IBL irradiance and radiance** by a per-vertex sky visibility. The visibility is baked at load with 24 cosine-weighted rays per vertex against the prefab's own parts, and faces are gridded to ≤ 1.5 m cells to hold it. The mapping is `mix(0.22, 1, visibility^0.6)`. Direct sunlight and CSM shadows are untouched, so sun patches through windows and doors stay bright while enclosed corners drop to about a quarter of the sky light. No light probes or extra lights are needed.

### Requested textures (Poly Haven, CC0; IDs verified against api.polyhaven.com)

Ask the environment pipeline owner (`tools/environment/`) to add these. Each replaces a tinted stand-in above.

| Need | Candidates |
|---|---|
| Exterior render/plaster | `white_plaster_02`, `painted_plaster_wall`, `worn_plaster_wall`, `peeling_painted_wall` |
| Interior plaster | `white_plaster_rough_01`, `plastered_wall_02` |
| Ruins | `damaged_plaster`, `broken_brick_wall`, `worn_cracked_plaster` |
| Brick (town variety) | `red_brick_03`, `brick_wall_02`, `whitewashed_brick` |
| Roof tiles | `clay_roof_tiles_02`, `roof_tiles_14`, `grey_roof_tiles` |
| Wood floor / siding | `wood_floor_worn`, `plank_flooring_02`, `weathered_plank_siding` (barn) |
| Wet rooms | `floor_tiles_06` |
| Military / industrial | `concrete_block_wall_02`, `box_profile_metal_sheet`, `container_side`, `rusty_painted_metal`, `concrete_floor_painted` |

## Rendering

- **Geometry:** Rectangular faces covered by a touching opposite face (a wall on a slab, a wall end in a corner) are removed cell by cell. The rest is gridded and written per material slot with prefab-local planar UVs in meters (the same mapping as `buildLevel`).
- **Instancing over merged unique meshes:** `BuildingVisuals` builds one mesh per look per prefab and draws every placement as a thin instance.
  - With world-space UVs, each building would need its own merged meshes: about 5 draws per building, so about 300 draws for 60 buildings before shadows.
  - Prefab-local UVs lose texture continuity *between* buildings, which never touch.
  - Repetition is broken by the world-space macro variation in the material, which still varies per instance.
  - Thin instances are culled as a batch, so batches are keyed per prefab per 250 m world cell (`cellSize`) to keep the culling unit about the size of a POI.
  - Geometry is not shared between cells (Babylon stores thin-instance buffers on the geometry). That costs about 2 MB of vertex data for all prefabs, per cell that uses them.
- **Budget for about 60 buildings** (mix: 12 small houses, 4 ruined, 8 two-story, 2 barns, 3 warehouses, 3 barracks, 5 towers, 4 booths, 1 radar, 18 containers):
  - 154k triangles if everything were in view.
  - At most 45 building draw calls for a cell containing every prefab type, versus 221 for merged unique meshes. A typical POI has 3–4 prefab types, which is 12–20 draws.
  - Each CSM cascade repeats the draws for batches in its range.
  - Geometry and AO bake about 0.56 s on the main thread for all 12 prefabs, done once per page per prefab used. It can move to a worker or be precomputed if load time matters.
- **Map v1 today: 85 placements** (43 before the blank-space pass; see `docs/map/layout.md`): 22 small houses, 14 ruined, 8 two-story, 2 barns, 1 warehouse, 2 barracks, 5 watchtowers, 2 guard booths, 1 radar station, 28 containers (10 open, 7 open blue, 11 closed, 2 of them stacked).
  - 178k triangles if all 85 were in view, over the 154k planned for 60; houses and containers are most of the increase.
  - No new prefab types, so the per-prefab geometry and AO bake is unchanged. The extra placements add thin instances and compound bodies only (about 35 ms per 60 buildings).
  - The four new minor POIs use 4–5 prefab types each, so 16–22 draws per cell that holds one.

## Physics

- `getPrefabCollision(id)`: pure `{ kind: "box" | "wedge", center, size, rises? }[]` in prefab-local space, one entry per part.
- `getBuildingShape(scene, id)` (`@twobullets/sim`, like `createBuildingBody`): one `PhysicsShapeContainer` per prefab per scene (boxes plus wedge convex hulls). It is **shared by all placements**, which is the shared-static-shape layout from `docs/backend/runtime-performance.md`.
- `createBuildingBody(scene, id, placement)`: one static body per building, friction 0.6, default filter bits (bullets hit it).
- `prefabLevelBlocks(id, placement)`: the same shapes as `LevelBlock`s for tools that consume `LevelData`.

Headless validation (NullEngine + Havok + the player's `CharacterBody`, now in `packages/sim`, 12 prefabs placed at assorted yaws): **25/25 checks pass**.
- **Doors and walls:** walk in and out through the doors; sprinting into walls from inside and outside stops at the face.
- **Stairs:** the two-story house stairs, balcony and upstairs door, then back down and out; the watchtower's three flights to 9 m and back down; the barn loft; the warehouse mezzanine; the radar stairs through the parapet gap onto the roof.
- **Small steps:** container floor (0.15 m) and booth step (0.2 m).
- **Guards:** the balcony railing, loft railing and tower parapet hold.
- **Crouching:** the ruined-house beam stops a standing player and passes a crouched one. A crouch-jump vaults a 1.0 m sill window; a standing jump does not.
- **Bullets:** 305/305 Havok raycasts pass through the center of every door and window, hit the frame 4 cm outside the opening, and hit the wall 12 cm below every sill.
- **Cost:** building 60 placed buildings takes about 35 ms, with shapes shared.

Unit tests (`buildings.test.ts`, 125 cases) check every prefab for:
- no overlapping parts;
- collision equal to parts;
- stair rises ≤ 0.3 m and tread size;
- standing headroom above every tread;
- door clearance for a standing capsule on both sides, except declared crouch passages;
- rays through openings and below sills;
- loot spots clear and supported;
- clear entrances;
- deterministic geometry;
- visibility in range and interior darker than roofs.

## Placement API

```ts
import { getPrefabCollision, type BuildingPlacement } from "@twobullets/shared";
import { buildBuilding } from "@twobullets/sim";
import { BuildingVisuals } from "../world/buildings";

const visuals = new BuildingVisuals(scene, environment); // client only
const house = buildBuilding(scene, "house_two_story", { position: [x, y, z], yaw }, visuals);
house.lootSpots; // world-space { position, roomId }
house.prefab.rooms; // prefab-local; house.toWorld(localPoint)
house.bounds; // world AABB
house.dispose();

// Headless server: same call without visuals, or build from pure data.
buildBuilding(scene, "barracks", placement);
getPrefabCollision("barracks");
```

## Preview page

Open http://localhost:5173/buildings.html.
- Row 1 shows every prefab facing the camera. Row 2 shows rotated repeats and a stacked container; they reuse row 1's batches.
- Click to capture the mouse. `F` toggles walk (the real player controller) and fly (WASD, Space/C, Shift).
- `[` `]` select a building and `T` goes to it. `O` toggles interior occlusion, `L` shows loot spots, `F8` shows collision shapes, `F9` opens the inspector.
- The panel shows tris, draws, shapes, rooms and loot for the selected prefab, plus scene totals and FPS.
