# Environment assets (Map v1)

Real CC0 materials for the terrain and the buildings kit, plus game-ready props and vegetation for the map layout. Everything comes from Poly Haven (CC0; credited anyway in `credits.json`, which the HUD shows).

| Where | What |
|---|---|
| `tools/environment/config.mjs` | Texture sets, models, props (processing options, LODs, collision kind) |
| `tools/environment/fetch.mjs` | Downloads textures, HDRI and models with MD5/size checks, sequentially. Large multi-tree `.bin` files are fetched by HTTP byte range (only the meshes used). Writes `credits.json` |
| `tools/environment/process.mjs` | Textures (JPEG) and sky; `--only=textures\|sky` |
| `tools/environment/props.mjs` | Prop and vegetation GLBs; `--only=<model>,<model>` |
| `tools/environment/geometry.mjs`, `foliage.mjs` | Mesh helpers (extraction, simplification, collision) and the CPU card/impostor baker |
| `tools/environment/manifest.mjs` | `build.json` record and the generated `apps/client/src/world/environmentManifest.ts` |
| `tools/environment/verify.mjs` | Headless checks of the prop outputs |
| `apps/client/src/world/propAssets.ts` | Prop/vegetation contract and `PropLibrary` loader |

```sh
node tools/environment/fetch.mjs                 # raw files into assets-src/environment (gitignored)
node tools/environment/process.mjs               # textures + sky → public/assets/environment, manifest
node tools/environment/props.mjs                 # props → public/assets/environment/props, manifest
node --experimental-transform-types tools/environment/verify.mjs
```

Scripts self-terminate (10–30 min limits), process one asset at a time and use one KTX2 worker. Encoded textures are cached in `assets-src/environment/.cache`, so re-running `props.mjs` only re-bakes geometry. Vegetation debug renders (side views of every level) land in `.cache/previews/<propId>.png`. Peak memory: about 0.8 GB for a single tree model, 1.2 GB for a full run.

## Terrain

| Layer | Set | Projection, tile | Notes |
|---|---|---|---|
| grass | `sparse_grass` | top, 2.4 m | dense blades over soil; the dark scan is tinted to a target mean albedo (0.12, 0.145, 0.042), anti-tile second sample kept |
| dirt | `forest_ground_04` | top, 3.15 m | brown soil with pebbles (was: forest ground desaturated) |
| rock | `rock_face_03` | triplanar, 5 m | weathered rock face (was: worn concrete tinted ×2.3) |
| road | `asphalt_02` | top, 4 m | core of painted roads |
| road shoulder | `rocky_trail` (albedo only) | top, 2.5 m | where the road weight fades (0.3–0.75, ragged by macro noise); reuses the asphalt normal/AO |
| macro | `aerial_grass_rock` | 190 m / 47 m | unchanged |

Layers now ship **albedo + NXA** (normal X, normal Y, AO in one JPEG; normal Z reconstructed; roughness is the scan's mean from its ARM map, raised slightly in cavities). Every layer is sampled only where its mask weight is non-zero.

Texture fetches per pixel in the terrain plugin (excluding the PBR IBL/shadow samplers):

| Pixel | Before | After |
|---|---|---|
| grass only | 7 | 6 |
| dirt pad | 7 | 5 |
| road | 10 | 6 |
| grass or dirt with rock (slopes) | 16 | 11–14 |
| all four layers overlapping (worst case) | 19 | 17 |

Samplers: 11, as before (mask, grass ×2, dirt ×2, rock ×2, road ×2, shoulder, macro).

## Buildings

New sets (1K albedo, 512–1K normal, 512 ARM): `white_plaster_02`, `painted_plaster_wall`, `damaged_plaster`, `red_brick_03`, `whitewashed_brick`, `clay_roof_tiles_02`, `wood_floor_worn`, `weathered_plank_siding`, `box_profile_metal_sheet` and `container_side` (both stored desaturated so paint colors come from the look). Not used: `white_plaster_rough_01` (green-stained), `roof_tiles_14` (payload; one tile set), `concrete_block_wall_02` (diagonal retaining-wall pattern) and `floor_tiles_06` (the kit has no wet-room slot).

Looks now declare a **target mean albedo**; the tint is target ÷ the scan's measured mean. `lookOf(prefabId, slot)` applies per-prefab overrides on top of the default slot → look table:

| Slot | Default look (set) | Overrides |
|---|---|---|
| `plaster` | `plaster` (`white_plaster_02`, off-white render, no formwork seams) | ruined house `plasterDamaged`; two-story house `brick` (`red_brick_03`); barracks and guard booth `brickWhitewashed`; radar station `concreteWall` (`concrete_wall_008`) |
| `plasterInterior` | `painted_plaster_wall` | – |
| `concrete` | `concrete_floor_worn_001` | – |
| `woodFloor`, `woodPlanks`, `woodTrim` | `woodFloor` (`wood_floor_worn`) | barn: all `plankSiding` (`weathered_plank_siding`); warehouse props/floors `planks` (`weathered_planks`) |
| `corrugated` | `corrugated_iron_02` (barn roof) | warehouse and watchtower `boxProfile` (grey-blue painted box profile) |
| `roofMetal` | `roofTiles` (`clay_roof_tiles_02`, pitched house roofs) | – |
| `roofAsphalt`, `paintedSteel`, `darkSteel` | unchanged scans | – |
| `containerRed` / `containerBlue` | `container_side` painted red / blue | – |

Draw calls per prefab are unchanged (house_small 5, ruined 4, two-story 5, barn 3, warehouse 6, barracks 5, watchtower 3, booth 4, radar 5, open containers 2, closed 1); 17 looks exist in total. `BuildingVisuals.ts` and `dev/buildingsPreview.ts` call `lookOf` instead of indexing `LOOK_OF_MATERIAL` (one line each).

## Props and vegetation

One GLB per source model in `public/assets/environment/props/`; each prop and level is a root node `<propId>_LOD<n>` inside it, so props from the same model share the file and its textures. Textures are KTX2 (ETC1S color and ORM, UASTC normals; 1K color for props, 2K card atlases for trees), geometry is meshopt-compressed. Alpha cutouts: Poly Haven's glTF exports reference opaque JPEG albedo, so the pipeline merges the separate opacity maps and switches the materials to alpha test.

| Prop | Source (Poly Haven, CC0) | Source tris | LOD tris (switch distance, m) | Collision | File (MB) |
|---|---|---|---|---|---|
| `crate_wood_a` | `wooden_crate_01` | 6.6k | 1500 / 446 (12) | box | 0.53 |
| `crate_wood_b` | `wooden_crate_02` | 5.2k | 1500 / 444 (12) | box | 0.52 |
| `crate_military` | `wooden_military_crate` | 23k | 4999 / 1524 (25) | box | 0.61 |
| `crate_military_long` | `old_military_crate` (crate a) | 10.5k | 1491 / 1034 (12) | box | 0.55 |
| `ammo_box` | `ammo_box` | 4.4k | 800 / 604 (8) | box | 0.14 |
| `jerrycan` | `metal_jerrycan_green` | 9.6k | 1497 / 474 (12) | box | 0.20 |
| `barrel_metal` | `Barrel_01` | 2.7k | 1500 / 480 (12) | cylinder | 0.55 |
| `barrel_rusty` | `barrel_03` | 1.5k | 1473 / 440 (12) | cylinder | 0.49 |
| `tyre` (lying flat) | `old_tyre` | 2.9k | 1500 / 450 (12) | cylinder | 0.50 |
| `utility_box` | `utility_box_02` | 6.3k | 5000 / 1249 (25) | box | 0.51 |
| `road_barrier` | `concrete_road_barrier_02` | 23.8k | 8000 / 2000 (35) / 480 (110) | convex hull | 0.64 |
| `fence_chainlink` (2.03 m panel + post) | `modular_chainlink_fence` | 4.2k | 4997 / 1247 (25) | box | 0.94 |
| `car_covered` | `covered_car` | 12.6k | 7998 / 1974 (35) / 434 (110) | convex hull | 0.60 |
| `log_fallen` | `dead_tree_trunk_02` | 83k | 7996 / 1994 (35) / 680 (110) | convex hull | 0.76 |
| `tree_stump` | `tree_stump_01` | 41k | 7994 / 1998 (35) / 479 (110) | cylinder | 0.75 |
| `rock_boulder_a`, `_b` | `rock_moss_set_01` rocks 02, 04 | 11k, 10.6k | ~4000 / 998 (30) / 234, 198 (100) | convex hull | 1.11 (shared) |
| `rock_moss_a`, `_b`, `rock_small` | `rock_moss_set_02` rocks 11, 12, 08 | 8k each | 4000 / 1000 (30) / 200 (100) | convex hull | 1.32 (shared) |
| `tree_fir_a` (13.9 m) | `fir_tree_01` tree b | 2.3M | 3399 / 679 (45) / impostor 6 (140) | trunk cylinder | 1.63 |
| `tree_fir_b` (8.7 m), `tree_fir_young` (5.7 m) | `fir_sapling_medium` a, c | 685k, 426k | 1853 / 396 (35) / 6 (110); 1234 / 294 (30) / 6 (90) | trunk cylinder | 1.78 (shared) |
| `tree_broadleaf_a` (7.7 m) | `tree_small_02` ×1.7 | 2.06M | 3331 / 631 (40) / 6 (130) | trunk cylinder | 1.88 |
| `tree_broadleaf_b` (7.4 m) | `island_tree_01` ×1.5 | 1.6M | 3839 / 972 (40) / 6 (130) | trunk cylinder | 1.91 |
| `bush_a`, `bush_b`, `bush_c` (2.0 / 1.4 / 2.3 m) | `searsia_lucida` b, d, a | 89k / 56k / 113k | 180 / 92 (30) / 6 (80); 120 / 60 / 6; 220 / 112 / 6 | none | 0.41 (shared) |
| `fern` | `fern_02` b | 2.4k | 2384 / 834 (25) | none | 0.38 |
| `grass_clump_short`, `_medium`, `_tall` | `grass_medium_01` (5–6 tufts composed per patch, ~0.6 m) | – | 895; 1100 / 459 (20); 918 / 375 (20) | none | 0.57 (shared) |

**Total: 19.3 MB** for 32 props in 24 files (budget 25 MB). Gaps: Poly Haven has no hay bales, wooden fence posts or car wrecks; `car_covered` stands in for a parked wreck.

### Vegetation baking (`foliage.mjs`)

Poly Haven's trees are film assets (0.4–4 M triangles of individual twigs and leaves), so they are rebuilt headless:

1. **Trunk:** the trunk material stays geometry, simplified per level with meshoptimizer.
2. **Cards:** all other triangles (twigs, leaves, small branches) are grouped by area-weighted k-means (450 clusters for the big fir, ~100 for bushes). Each cluster becomes a quad on its best-fit plane (smallest principal axis). A CPU rasterizer renders that cluster's own triangles orthographically into an atlas tile: source textures with alpha, 2× supersampled, depth-shaded and dilated against mip bleeding. LOD1 uses 4–6× fewer clusters with two crossed upright cards each, so no card goes edge-on from the ground.
3. **Impostor:** three vertical quads at 0°/60°/120° through the trunk, each with a baked side view of the whole tree. It's the render-free equivalent of a billboard: no shader or per-frame orientation, and it works with thin instances.

Card vertex normals bend out of the canopy and vertex colors carry a canopy occlusion term (darker toward the trunk and the crown bottom), so the crown shades as a volume. All card and impostor levels of a model share one atlas material (2048², ETC1S; 1024 for bushes) at 118–168 texels/m for LOD0 cards.

## Contract (`propAssets.ts`)

- `PROP_IDS` / `PropId`: the 32 ids above. `PROP_MANIFEST[id]` is always complete. Hand-authored gameplay fields (category, surface, castShadow, cullDistance, scaleRange) merge with the pipeline's measured fields (`url`, `bytes`, `lods[] { url, node, distance, triangles, billboard? }`, `bounds`, `footprintRadius`, `collision`, `source`). Props the pipeline hasn't produced have `ready: false` and a box of the placeholder size.
- **Conventions:** meters, Babylon space, pivot at the ground contact point (rocks, stumps, logs and trees keep their authored embedment, so `bounds.min[1]` can be slightly negative). Collision is prop-local at scale 1: `box { center, size }`, `cylinder { center, radius, height }` (trees: trunk only), `convexHull { points ≤ 32 }` (support points of the LOD0 mesh; an inner approximation), or `none`. `footprintRadius` is the full XZ extent (the crown for trees).
- **Surface:** `wood | metal | concrete | foliage`. Rocks are `concrete`, tyres `wood`. `foliage` has no audio `AcousticSurface` yet.
- **Loading:** `PropLibrary.load(scene, { ids?, headless?, baseUrl?, decoders?, fetch? })`. Each GLB is loaded once. Each level's meshes are unparented with transforms baked (including the glTF handedness flip), disabled, and returned as `template.levels[i].meshes`. `createBatch(id, level, name)` returns enabled clones with unique geometry for thin instancing (Babylon keeps thin-instance buffers on the geometry). `selectPropLod(asset, distance)` picks a level index or −1 beyond `cullDistance`. Cutout materials are alpha-tested, double-sided, with one-sided lighting.

## What to look at

- **`?map=v1`:**
  - terrain: grass tint and tiling at mid-range, rock on the quarry walls and border cliffs, dirt on the Training Yard pad and quarry ramp, the gravel shoulder along the asphalt road;
  - props and trees: once the layout engineer's `PropVisuals` loads the library, look at card crowns up close and at the LOD1 and impostor switches (40–140 m).
- **`/buildings.html`:** plaster houses, the brick two-story house, clay tile roofs, whitewashed-brick barracks and booth, the box-profile warehouse, plank-siding barn, painted containers, and the damaged plaster on the ruin.

## Risks

- **Terrain GLSL not compiled here.** There's no GPU or browser, so the shader was reviewed by hand only. A compile error would show in the console on `?map=v1`.
- **Card trees up close.** LOD0 crowns are flat cards at ~1 cm texels. From under a tree the planes are visible. LOD0 of the saplings reads sparser from the side than LOD1. Raise `cards` in `config.mjs` if needed (+2 triangles per card).
- **Alpha-tested mips.** Foliage thins at distance (ETC1S mips average the alpha; cutoff 0.4). Alpha-to-coverage or a mip-alpha rescale would need encoder or shader support.
- **Leaning trunks.** The trunk cylinder is upright at the trunk base; on `tree_broadleaf_a` the curved trunk drifts from it higher up.
- **Grass clumps are small,** 0.6 m composed patches of 300–1100 triangles. Dense meadows need many instances, or a dedicated grass shader later.
- **Payload.**
  - Terrain and building JPEGs grew from 9.8 MB to 23.8 MB, and props/vegetation add 19.3 MB, all loaded up front today.
  - The UASTC normals dominate the rock files.
  - Candidates for streaming, or for dropping arena-only sets once the arena is retired.
- **Build memory.** A full `props.mjs` run peaks at 1.2 GB; use `--only` per model on a loaded machine.
