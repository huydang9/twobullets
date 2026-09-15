# Vietnamese street assets (Saigon maps)

Free, license-verified 3D models for the Hàng Xanh and Phú Nhuận maps: what was found, what is built, what needs the owner's Sketchfab login, what was rejected, and how the map runtime should use it. **Nothing here is placed in a map yet**; `apps/client/src/world/**` and `packages/shared/src/map/**` belong to the map work.

**Status (2026-09-15):** 66 props built from 51 source models (Poly Haven CC0, OpenGameArt Yughues/Nobiax CC0 and CC-BY, ambientCG CC0), **16.5 MB** in `public/assets/environment/vn/` (51 GLBs). The realistic Vietnam-specific models (Honda Cub-style motorbikes, bánh mì cart, blue plastic stools, tangled-cable poles, lanterns, nón lá, flame trees) exist only on Sketchfab, whose downloads need a login: see [Needs the owner's login](#needs-the-owners-login).

## Pipeline

| Where | What |
|---|---|
| `tools/environment/vn/config.mjs` | Models (`VN_MODELS`) and props (`VN_PROPS`): same spec as `../config.mjs` plus `group`, `use`, `surface`, `cullDistance`, `nodePrefix`, `collisionOverride` |
| `tools/environment/vn/fetch.mjs` | Poly Haven 1K glTFs into `assets-src/environment/vn/models/` (MD5-checked), credits upserted with `set: "vn"` |
| `tools/environment/vn/obj.mjs` | OBJ + TGA/JPG packs → GLB in `assets-src` (TGA decoder, group → material rules, opaque-trunk split for palm atlases) |
| `tools/environment/vn/build.mjs` | Runs `props.mjs` `buildModel` per model into `vn/<model>.glb` (KTX2, meshopt, LODs, foliage cards and impostors), writes `vn/build.json` and the generated `apps/client/src/assets/vnPropsManifest.ts` |
| `tools/environment/vn/verify.mjs` | Headless load of every prop (NullEngine), node/triangle/bounds checks against the manifest, credits present, KTX2 decode of all 191 textures |
| `apps/client/vn-props.html` + `src/dev/vnPropsPreview.ts` | DEV preview: one row per group, LOD0 in front and far levels behind, `[ ]` select, `T` go to, `K` colliders, `M` scale markers |

```sh
node tools/environment/vn/fetch.mjs                                   # Poly Haven sources (OGA/ambientCG archives: see DOWNLOADS-VN-2026-09-15.md)
node tools/environment/vn/obj.mjs                                     # OBJ packs → GLB in assets-src
node tools/environment/vn/build.mjs [--only=model,...]                # → public/assets/environment/vn + vnPropsManifest.ts
node --experimental-transform-types tools/environment/vn/verify.mjs
# http://localhost:5173/vn-props.html
```

Shared-pipeline changes (additive): `props.mjs` exports `buildModel` (optional `{ modelsDir, urlDir }`, `model.textures`, `model.preview`) and `upsertCredits`; `fetch.mjs` exports its helpers, runs only as a script, and keeps credits entries that carry a `set` when it rewrites `credits.json`. Debug side views of every level are in `assets-src/environment/.cache/previews/vn_*.png`.

Conventions match `propAssets.ts`: meters, pivot at the ground contact point, `<propId>_LOD<n>` root nodes, vegetation keeps its authored embedment (up to 0.22 m below ground). Budgets used: small props ≤ 2k triangles LOD0, medium 4k, large/cover 8k, poles 6–7k, pot plants ~5k, trees are Yughues cards (≤ 2.8k) with baked card LOD1 and impostors. Textures: 512 color / 256 normal and ORM for small props, 1K color for shutters, gates, poles and palms.

## Built props

| Prop | Group | Source (author, license) | Size W × H × D (m) | LOD tris (switch m) | Collision | File (MB) | Use |
|---|---|---|---|---|---|---|---|
| `vn_chair_plastic` | sidewalk | [Plastic Monobloc Chair 01](https://polyhaven.com/a/plastic_monobloc_chair_01) (Kuutti Siitonen, CC0) | 0.64 × 0.88 × 0.63 | 2000 / 652 (12) | box | plastic_monobloc_chair_01.glb 0.20 | quán cà phê / trà đá sidewalk chair |
| `vn_power_pole_transformer` | utility | [Modular Electricity Poles](https://polyhaven.com/a/modular_electricity_poles) (James Ray Cock, CC0) | 1.74 × 8.89 × 2.82 | 5997 / 2582 (40) / 1616 (120) | cylinder | modular_electricity_poles.glb 1.48 | 8.7 m pole with crossarm, fuses and transformer (cột điện); hang cable bundles between poles |
| `vn_power_pole` | utility | [Modular Electricity Poles](https://polyhaven.com/a/modular_electricity_poles) (James Ray Cock, CC0) | 1.74 × 8.89 × 1.24 | 5935 / 2713 (40) / 1318 (120) | cylinder | modular_electricity_poles.glb 1.48 | 8.7 m distribution pole with crossarms |
| `vn_power_pole_fuse` | utility | [Modular Electricity Poles](https://polyhaven.com/a/modular_electricity_poles) (James Ray Cock, CC0) | 1.86 × 8.89 × 1.24 | 7081 / 3095 (40) / 1331 (120) | cylinder | modular_electricity_poles.glb 1.48 | 8.7 m pole with offset crossarm, fuse and transformer |
| `vn_stool_wood_low` | sidewalk | [Chinese Stool](https://polyhaven.com/a/chinese_stool) (Kirill Sannikov, CC0) | 0.60 × 0.63 × 0.51 | 1090 / 327 (12) | box | chinese_stool.glb 0.17 | low wooden stool at tea stalls, shop doors |
| `vn_tea_table_low` | sidewalk | [Chinese Tea Table](https://polyhaven.com/a/chinese_tea_table) (Kirill Sannikov, CC0) | 0.84 × 0.50 × 0.84 | 2000 / 600 (12) | box | chinese_tea_table.glb 0.17 | low tea table (bàn trà) with stools |
| `vn_stool_metal` | sidewalk | [Metal Stool 02](https://polyhaven.com/a/metal_stool_02) (Ulan Cabanilla, CC0) | 0.45 × 0.46 × 0.47 | 1999 / 599 (12) | box | metal_stool_02.glb 0.20 | street food stall stool |
| `vn_stool_folding` | sidewalk | [Folding Wooden Stool](https://polyhaven.com/a/folding_wooden_stool) (Ulan Cabanilla, CC0) | 0.53 × 0.44 × 0.55 | 2000 / 584 (12) | box | folding_wooden_stool.glb 0.20 | vendor's folding stool |
| `vn_stool_wood` | sidewalk | [Wooden Stool 01](https://polyhaven.com/a/wooden_stool_01) (Kuutti Siitonen, CC0) | 0.42 × 0.44 × 0.44 | 1998 / 596 (12) | box | wooden_stool_01.glb 0.20 | shop stool |
| `vn_cafe_set` | sidewalk | [Outdoor Table Chair Set 01](https://polyhaven.com/a/outdoor_table_chair_set_01) (James Ray Cock, CC0) | 0.74 × 0.86 × 1.72 | 3997 / 2125 (25) | box | outdoor_table_chair_set_01.glb 0.35 | café table with two chairs |
| `vn_shutter_door` | shopfront | [Rollershutter Door](https://polyhaven.com/a/rollershutter_door) (MP, CC0) | 1.08 × 2.40 × 0.30 | 552 / 165 (30) | box | rollershutter_door.glb 0.31 | closed rolling shutter, narrow shop / garage |
| `vn_shutter_wide` | shopfront | [Rollershutter Window 01](https://polyhaven.com/a/rollershutter_window_01) (MP, CC0) | 2.10 × 1.85 × 0.30 | 552 / 164 (30) | box | rollershutter_window_01.glb 0.29 | closed shutter over a tube-house shopfront (nhà ống ground floor) |
| `vn_shutter_window_a` | shopfront | [Rollershutter Window 02](https://polyhaven.com/a/rollershutter_window_02) (MP, CC0) | 1.60 × 1.56 × 0.17 | 560 / 168 (30) | box | rollershutter_window_02.glb 0.27 | shuttered window / kiosk |
| `vn_shutter_window_b` | shopfront | [Rollershutter Window 03](https://polyhaven.com/a/rollershutter_window_03) (MP, CC0) | 0.98 × 1.55 × 0.15 | 560 / 168 (30) | box | rollershutter_window_03.glb 0.30 | shuttered window / kiosk |
| `vn_shelves_steel` | shopfront | [Steel Frame Shelves 01](https://polyhaven.com/a/steel_frame_shelves_01) (James Ray Cock, CC0) | 1.10 × 2.14 × 0.50 | 2000 / 600 (12) | box | steel_frame_shelves_01.glb 0.16 | shop shelves at open shopfronts, tạp hóa |
| `vn_gate_iron` | shopfront | [Large Iron Gate](https://polyhaven.com/a/large_iron_gate) (Josh Dean, CC0) | 2.95 × 2.93 × 0.10 | 8000 / 1995 (35) / 458 (110) | box | large_iron_gate.glb 0.54 | double iron gate of a house or alley (cổng sắt) |
| `vn_ac_unit` | wall | [Exterior Aircon Unit](https://polyhaven.com/a/exterior_aircon_unit) (Monsta3D, CC0) | 0.80 × 0.93 × 0.37 | 2011 / 660 (12) | box | exterior_aircon_unit.glb 0.58 | AC outdoor unit on facades, balconies, rooftops |
| `vn_ac_unit_rusted` | wall | [Exterior Aircon Unit](https://polyhaven.com/a/exterior_aircon_unit) (Monsta3D, CC0) | 0.80 × 0.93 × 0.37 | 2011 / 646 (12) | box | exterior_aircon_unit.glb 0.58 | weathered AC unit |
| `vn_security_camera` | wall | [Security Camera 01](https://polyhaven.com/a/security_camera_01) (Alexander Otterbeck, Yann Kervran, CC0) | 0.17 × 0.28 × 0.55 | 900 / 657 (8) | none | security_camera_01.glb 0.17 | camera over shop doors |
| `vn_utility_box` | utility | [Utility Box 01](https://polyhaven.com/a/utility_box_01) (James Ray Cock, CC0) | 0.52 × 1.12 × 0.43 | 1999 / 599 (12) | box | utility_box_01.glb 0.18 | telecom / electric cabinet on sidewalks |
| `vn_street_lamp` | utility | [Street Lamp 01](https://polyhaven.com/a/street_lamp_01) (Josh Dean, CC0) | 0.70 × 3.87 × 0.39 | 4192 / 1141 (25) | cylinder | street_lamp_01.glb 0.16 | 3.9 m park / alley lamp post |
| `vn_wall_lamp` | wall | [Street Lamp 02](https://polyhaven.com/a/street_lamp_02) (Josh Dean, CC0) | 0.39 × 1.67 × 0.81 | 2199 / 786 (12) | none | street_lamp_02.glb 0.15 | wall-mounted lamp over gates and alleys |
| `vn_manhole` | utility | [Water Manhole Cover](https://polyhaven.com/a/water_manhole_cover) (Raunox, CC0) | 0.69 × 0.07 × 0.69 | 1033 / 897 (8) | none | water_manhole_cover.glb 0.20 | manhole cover on roads and sidewalks |
| `vn_fire_hydrant` | utility | [Fire Hydrant](https://polyhaven.com/a/fire_hydrant) (Gonçalo Felício, CC0) | 0.27 × 0.80 × 0.32 | 1986 / 778 (12) | cylinder | fire_hydrant.glb 0.21 | hydrant at street corners |
| `vn_road_divider` | utility | [Concrete Road Barrier](https://polyhaven.com/a/concrete_road_barrier) (Amal Kumar, CC0) | 1.54 × 0.83 × 0.64 | 8000 / 2000 (35) / 480 (110) | convexHull | concrete_road_barrier.glb 0.59 | concrete median divider on main roads (Điện Biên Phủ, Xô Viết Nghệ Tĩnh) |
| `vn_gas_cylinder` | sidewalk | [Small Lpg Tank](https://polyhaven.com/a/small_lpg_tank) (Ulan Cabanilla, CC0) | 0.41 × 0.64 × 0.41 | 1998 / 590 (12) | cylinder | small_lpg_tank.glb 0.21 | 12 kg LPG cylinder (bình gas) at food stalls and shop doors |
| `vn_gas_cylinder_small` | sidewalk | [Propane Tank](https://polyhaven.com/a/propane_tank) (Slinc, CC0) | 0.34 × 0.55 × 0.34 | 2000 / 888 (12) | cylinder | propane_tank.glb 0.19 | small gas cylinder |
| `vn_trash_can` | sidewalk | [Metal Trash Can](https://polyhaven.com/a/metal_trash_can) (GurJas Studios, CC0) | 0.77 × 0.91 × 0.55 | 1997 / 596 (12) | box | metal_trash_can.glb 0.22 | trash can; rotate lid side to the wall |
| `vn_trashbag` | sidewalk | [Trashbag](https://polyhaven.com/a/trashbag) (Benny Weimer, CC0) | 0.53 × 0.57 × 0.46 | 2000 / 600 (12) | none | trashbag.glb 0.18 | trash bags piled at the curb at night |
| `vn_cardboard_box` | market | [Cardboard Box 01](https://polyhaven.com/a/cardboard_box_01) (Rahul Chaudhary, CC0) | 0.39 × 0.34 × 0.52 | 800 / 280 (8) | box | cardboard_box_01.glb 0.17 | boxes at shop doors and market stalls |
| `vn_crate_plastic_b` | market | [Plastic Crate 02](https://polyhaven.com/a/plastic_crate_02) (Fabi_G, CC0) | 0.51 × 0.25 × 0.41 | 2000 / 1140 (12) | box | plastic_crate_02.glb 0.41 | open plastic crate (sọt nhựa) |
| `vn_crate_stack` | market | [Plastic Crate 02](https://polyhaven.com/a/plastic_crate_02) (Fabi_G, CC0) | 1.03 × 0.75 × 0.83 | 8104 / 7648 (25) | box | plastic_crate_02.glb 0.41 | stack of market crates at a chợ stall or behind a quán nhậu: low cover |
| `vn_basket_lidded` | market | [Wicker Basket 02](https://polyhaven.com/a/wicker_basket_02) (Kuutti Siitonen, CC0) | 0.35 × 0.20 × 0.25 | 2000 / 600 (12) | none | wicker_basket_02.glb 0.22 | lidded basket |
| `vn_bananas` | market | [Bananas](https://polyhaven.com/a/bananas) (Alexander Shulha, CC0) | 0.13 × 0.18 × 0.22 | 2000 / 600 (12) | none | bananas.glb 0.17 | bananas on fruit stalls and altars |
| `vn_water_jug` | market | [Plastic Bottle Gallon](https://polyhaven.com/a/plastic_bottle_gallon) (Rahul Chaudhary, CC0) | 0.17 × 0.27 × 0.13 | 800 / 280 (8) | none | plastic_bottle_gallon.glb 0.12 | water jug |
| `vn_water_barrel` | rooftop | [Barrel 02](https://polyhaven.com/a/Barrel_02) (Jorge Camacho, CC0) | 0.49 × 0.88 × 0.48 | 2000 / 600 (12) | cylinder | Barrel_02.glb 0.13 | blue plastic water barrel on rooftops and yards |
| `vn_jerrycan_plastic` | sidewalk | [Plastic Jerrycan](https://polyhaven.com/a/plastic_jerrycan) (Ulan Cabanilla, CC0) | 0.27 × 0.32 × 0.34 | 800 / 408 (8) | box | plastic_jerrycan.glb 0.19 | fuel/fish-sauce can at shops |
| `vn_cement_bag` | construction | [Cement Bag](https://polyhaven.com/a/cement_bag) (PierreB3D, CC0) | 0.46 × 0.18 × 0.70 | 800 / 280 (8) | box | cement_bag.glb 0.14 | cement bags at house renovations (very common in Saigon alleys) |
| `vn_hand_truck` | market | [Hand Truck](https://polyhaven.com/a/hand_truck) (Mutanzom3D, CC0) | 0.59 × 1.40 × 0.69 | 2000 / 600 (12) | box | hand_truck.glb 0.21 | delivery hand truck (xe đẩy hàng) |
| `vn_potted_plant_large` | plants | [Potted Plant 01](https://polyhaven.com/a/potted_plant_01) (Rico Cilliers, CC0) | 0.59 × 1.34 × 0.63 | 4914 / 1473 (15) / 392 (45) | cylinder | potted_plant_01.glb 0.44 | large pot plant at shop doors and balconies |
| `vn_potted_plant` | plants | [Potted Plant 02](https://polyhaven.com/a/potted_plant_02) (Rico Cilliers, CC0) | 0.70 × 0.84 × 0.66 | 6295 / 1884 (15) / 514 (45) | cylinder | potted_plant_02.glb 0.42 | pot plant on steps, balconies, rooftops |
| `vn_potted_succulent` | plants | [Potted Plant 04](https://polyhaven.com/a/potted_plant_04) (James Ray Cock, CC0) | 0.17 × 0.27 × 0.18 | 1864 / 648 (8) | none | potted_plant_04.glb 0.20 | small pot on windowsills and stalls |
| `vn_pot_clay` | plants | [Planter Pot Clay](https://polyhaven.com/a/planter_pot_clay) (Amal Kumar, CC0) | 0.27 × 0.22 × 0.26 | 798 / 278 (8) | none | planter_pot_clay.glb 0.16 | empty clay pot |
| `vn_pot_ceramic` | plants | [Ceramic Pot](https://polyhaven.com/a/ceramic_pot) (Aron Łyczek, CC0) | 0.66 × 0.37 × 0.50 | 2000 / 600 (12) | cylinder | ceramic_pot.glb 0.17 | large glazed pot (chậu sứ) at house fronts |
| `vn_money_tree` | plants | [Pachira Aquatica 01](https://polyhaven.com/a/pachira_aquatica_01) (Rob Tuytel, Rico Cilliers, CC0) | 1.05 × 1.90 × 1.00 | 4804 / 1438 (15) / 378 (45) | cylinder | pachira_aquatica_01.glb 1.00 | 1.65 m potted money tree (cây kim ngân) at shop doors |
| `vn_money_tree_small` | plants | [Pachira Aquatica 01](https://polyhaven.com/a/pachira_aquatica_01) (Rob Tuytel, Rico Cilliers, CC0) | 0.97 × 1.15 × 0.92 | 4927 / 1475 (15) / 392 (45) | none | pachira_aquatica_01.glb 1.00 | 1 m money tree |
| `vn_plant_calathea` | plants | [Calathea Orbifolia 01](https://polyhaven.com/a/calathea_orbifolia_01) (Rob Tuytel, Rico Cilliers, CC0) | 0.60 × 0.42 × 0.53 | 1999 / 590 (12) | none | calathea_orbifolia_01.glb 0.19 | tropical ground plant |
| `vn_plant_anthurium` | plants | [Anthurium Botany 01](https://polyhaven.com/a/anthurium_botany_01) (Rob Tuytel, Rico Cilliers, CC0) | 0.90 × 0.50 × 1.14 | 5000 / 1499 (15) / 400 (45) | none | anthurium_botany_01.glb 0.20 | tropical leafy plant for planters and yards |
| `vn_planter_box` | plants | [Planter Box 01](https://polyhaven.com/a/planter_box_01) (James Ray Cock, CC0) | 0.91 × 0.42 × 0.41 | 2000 / 600 (12) | box | planter_box_01.glb 0.20 | planter box on balconies and rooftops |
| `vn_palm_coconut` | trees | [Free palm treeZ v3](https://opengameart.org/content/free-palm-treez-v3) (Yughues (Nobiax), CC0) | 4.45 × 8.98 × 4.39 | 940 / 460 (50) / impostor (160) | cylinder | vn_palms.glb 1.15 | coconut palm (dừa): canals, riverside, parks, villa gardens |
| `vn_palm_coconut_bent` | trees | [Free palm treeZ v3](https://opengameart.org/content/free-palm-treez-v3) (Yughues (Nobiax), CC0) | 5.99 × 7.20 × 4.18 | 940 / 460 (50) / impostor (160) | cylinder | vn_palms.glb 1.15 | coconut palm (dừa): canals, riverside, parks, villa gardens |
| `vn_palm_coconut_pair` | trees | [Free palm treeZ v3](https://opengameart.org/content/free-palm-treez-v3) (Yughues (Nobiax), CC0) | 4.85 × 8.51 × 4.63 | 1880 / 920 (50) / impostor (160) | cylinder | vn_palms.glb 1.15 | coconut palm (dừa): canals, riverside, parks, villa gardens |
| `vn_palm_coconut_trio` | trees | [Free palm treeZ v3](https://opengameart.org/content/free-palm-treez-v3) (Yughues (Nobiax), CC0) | 7.42 × 8.26 × 7.65 | 2820 / 1380 (50) / impostor (160) | cylinder | vn_palms.glb 1.15 | coconut palm (dừa): canals, riverside, parks, villa gardens |
| `vn_bamboo_clump` | trees | [Free Bamboo v1](https://opengameart.org/content/free-bamboo-v1) (Yughues (Nobiax), CC0) | 1.84 × 4.09 × 1.71 | 1440 / 200 (35) / impostor (100) | none | vn_bamboo.glb 0.43 | young bamboo clump (tre): alley ends, temple yards, riverbanks |
| `vn_banana_plant` | plants | [Free Palm Plant](https://opengameart.org/content/free-palm-plant) (Yughues (Nobiax), CC-BY-4.0) | 1.50 × 3.00 × 1.51 | 3312 / impostor (60) | none | vn_palm_plant.glb 0.19 | 2.9 m broad-leaf plant (young banana / bird-of-paradise look, no fruit) in yards, alleys, empty lots |
| `vn_monstera` | plants | [Tropical plant 02](https://opengameart.org/content/tropical-plant-02-0) (Yughues (Nobiax), CC0) | 1.55 × 0.89 × 1.50 | 1152 / impostor (35) | none | vn_tropical_plant.glb 0.54 | big-leaf tropical ground plant in yards and planters |
| `vn_tropical_shrub_1` | plants | [Tropical shrubs](https://opengameart.org/content/tropical-shrubs) (Yughues (Nobiax), CC0) | 2.48 × 1.68 × 2.58 | 508 / impostor (35) | none | vn_tropical_shrubs.glb 0.59 | tropical shrub (bromeliad, dracaena, fern palm) for yards, medians, parks |
| `vn_tropical_shrub_2` | plants | [Tropical shrubs](https://opengameart.org/content/tropical-shrubs) (Yughues (Nobiax), CC0) | 1.38 × 0.85 × 1.45 | 704 / impostor (35) | none | vn_tropical_shrubs.glb 0.59 | tropical shrub (bromeliad, dracaena, fern palm) for yards, medians, parks |
| `vn_tropical_shrub_3` | plants | [Tropical shrubs](https://opengameart.org/content/tropical-shrubs) (Yughues (Nobiax), CC0) | 1.82 × 1.94 × 1.69 | 1443 / impostor (35) | none | vn_tropical_shrubs.glb 0.59 | tropical shrub (bromeliad, dracaena, fern palm) for yards, medians, parks |
| `vn_tropical_shrub_4` | plants | [Tropical shrubs](https://opengameart.org/content/tropical-shrubs) (Yughues (Nobiax), CC0) | 1.38 × 1.75 × 1.84 | 472 / impostor (35) | none | vn_tropical_shrubs.glb 0.59 | tropical shrub (bromeliad, dracaena, fern palm) for yards, medians, parks |
| `vn_tropical_shrub_5` | plants | [Tropical shrubs](https://opengameart.org/content/tropical-shrubs) (Yughues (Nobiax), CC0) | 1.93 × 1.17 × 1.93 | 608 / impostor (35) | none | vn_tropical_shrubs.glb 0.59 | tropical shrub (bromeliad, dracaena, fern palm) for yards, medians, parks |
| `vn_planter_square_palm` | plants | [Free houseplants](https://opengameart.org/content/free-houseplants) (Yughues (Nobiax), CC0) | 0.60 × 1.57 × 0.61 | 654 / impostor (50) | cylinder | vn_houseplants.glb 0.79 | tall concrete planter with a plant at shopfronts, office and hotel entrances |
| `vn_planter_cylinder_bamboo` | plants | [Free houseplants](https://opengameart.org/content/free-houseplants) (Yughues (Nobiax), CC0) | 0.32 × 1.47 × 0.35 | 876 / impostor (50) | cylinder | vn_houseplants.glb 0.79 | tall concrete planter with a plant at shopfronts, office and hotel entrances |
| `vn_planter_square_shrub` | plants | [Free houseplants](https://opengameart.org/content/free-houseplants) (Yughues (Nobiax), CC0) | 0.61 × 1.35 × 0.61 | 380 / impostor (50) | cylinder | vn_houseplants.glb 0.79 | tall concrete planter with a plant at shopfronts, office and hotel entrances |
| `vn_planter_sphere_palm` | plants | [Free houseplants](https://opengameart.org/content/free-houseplants) (Yughues (Nobiax), CC0) | 0.60 × 1.57 × 0.61 | 1426 / impostor (50) | cylinder | vn_houseplants.glb 0.79 | tall concrete planter with a plant at shopfronts, office and hotel entrances |
| `vn_mango_pile` | market | [Mango 001](https://ambientcg.com/a/3DMango001) (ambientCG (Lennart Demes), CC0) | 0.37 × 0.25 × 0.35 | 1498 / 374 (10) | none | vn_mango.glb 0.14 | mango pile on a fruit stall tray (sạp trái cây) |

`bytes` in the manifest is the whole shared file. Material notes: Poly Haven cutouts (AC grille, crate sides, plant leaves) get their opacity maps merged into the base color (alpha test); lamp and camera glass stay alpha-blended; Yughues specular maps are dropped (constant roughness).

### Downloaded, not built

| Source | Why not |
|---|---|
| Poly Haven `modular_electric_cables` (wall conduit kit, 49 pieces), `modular_metal_gutter` (downpipe kit) | Kits to assemble along facades; worth doing when the building prefabs want wall detail |
| Poly Haven `shrub_03` | 0.3–0.4 m tufts; the Yughues shrubs cover it |
| Poly Haven `plastic_crate_01` | "GALLER" brand label baked into the albedo |
| Poly Haven `plastic_crate_03` | Moulded lattice stays at 9k triangles after simplification |
| Poly Haven `wicker_basket_01` | Thin woven strips fall apart below ~8k triangles |
| ambientCG `3DBread011` | Tried as bánh mì loaves; the simplified scan looked crumpled |
| Poly Haven `jacaranda_tree` (not downloaded) | 215 MB source; a flame-tree look-alike, but PlantCatalog's royal poinciana (Sketchfab) is the real thing |

## Direct-download sources (no login)

Checked: OpenGameArt, Poly Pizza, Smithsonian Open Access, ambientCG, Wikimedia Commons, Kenney/Quaternius, 3dassets.dev, GitHub. Realistic Vietnam-specific models don't exist outside Sketchfab; what exists is realistic generic tropical vegetation and street clutter. Poly Haven's full model list (`api.polyhaven.com/assets?t=models`) was screened separately: 50 models downloaded, 44 used.

| Source | Item | Model | Author | License | Tris | Size (MB) | Realism | Status |
|---|---|---|---|---|---|---|---|---|
| OpenGameArt | coconut palm | [Free palm treeZ v3](https://opengameart.org/content/free-palm-treez-v3) | Yughues | CC0 | ? | 19.71 | 4 | built |
| OpenGameArt | coconut palm | [Palm tree v2](https://opengameart.org/content/palm-tree-v2) | Yughues | CC0 | ~940-2820 (solo/duo/trio per preview) | 3.02 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | banana tree (stand-in) | [Free Palm Plant](https://opengameart.org/content/free-palm-plant) | Yughues | CC-BY 4.0 / CC-BY 3.0 | ? | 2.61 | 3 | built |
| OpenGameArt | tropical broadleaf plant | [Tropical plant 02](https://opengameart.org/content/tropical-plant-02-0) | Yughues | CC0 | ? | 5.11 | 3 | built |
| OpenGameArt | tropical plant | [Free Tropical Plant 02](https://opengameart.org/content/free-tropical-plant-02) | Yughues | CC-BY 4.0 / CC-BY 3.0 | ? | 3.1 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | bamboo | [Free Bamboo v1](https://opengameart.org/content/free-bamboo-v1) | Yughues | CC0 | 1440 | 1.36 | 3 | built |
| OpenGameArt | tropical shrubs | [Tropical shrubs](https://opengameart.org/content/tropical-shrubs) | Yughues | CC0 | 200-1440 per variant | 4.59 | 3 | built |
| OpenGameArt | bushes | [Bushes](https://opengameart.org/content/bushes) | Yughues | CC0 | 300-2044 | 13.16 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | potted plants | [Free houseplants](https://opengameart.org/content/free-houseplants) | Yughues | CC0 | ? | 8.74 | 3 | built |
| OpenGameArt | tropical pack (palms, bushes, coconuts) | [3TD Tropical Environment Pack v2.0](https://opengameart.org/content/3td-tropical-environment-pack-v20) | Ron Kapaun(Submitted by hreikin) | CC0 | ? | 135.82 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | broadleaf trees | [Free  Realistic Tree 9 [Rainbow Tree]](https://opengameart.org/content/free-realistic-tree-9-rainbow-tree) | Rakshi Games | CC-BY 3.0 | ? | 15.9 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | dracaena / tropical tree | [Realistic Tree 16 [Dracaena]](https://opengameart.org/content/realistic-tree-16-dracaena) | Rakshi Games | CC-BY 3.0 | ? | 32.92 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | gas cylinder | [Gas Cylinder](https://opengameart.org/content/gas-cylinder) | Jhan Gutierrez | CC0 | ? | 30.73 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | gas tanks | [Gaz Tank Pack](https://opengameart.org/content/gaz-tank-pack) | Yughues | CC0 | ? | 5.87 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | plastic water barrels / jerrycans | [Plastic Barrel Pack](https://opengameart.org/content/plastic-barrel-pack) | Yughues | CC0 | ~350 | 3.41 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | metal drums / fuel cans | [Fuel/oil tank Pack](https://opengameart.org/content/fueloil-tank-pack) | Yughues | CC0 | ? | 6.09 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | trash bins | [Free Trashes](https://opengameart.org/content/free-trashes) | Yughues | CC0 | 92-324 per bin | 24.73 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | cardboard boxes | [Cardboards Pack](https://opengameart.org/content/cardboards-pack) | Yughues | CC0 | ? | 3.01 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | wood pallets | [Wood Pallet v1 Pack](https://opengameart.org/content/wood-pallet-v1-pack) | Yughues | CC0 | ~656 | 3.05 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | concrete barriers / pipes | [Concrete barriers](https://opengameart.org/content/concrete-barriers) | Yughues | CC0 | 172-464 | 62.52 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | standing electric fan | [Rusty old Fan](https://opengameart.org/content/rusty-old-fan) | yethiel | CC0 | ? | 2.99 | 2 | not used: realism 2 |
| OpenGameArt | chain-link fence kit | [Chainlink Fence Modular Kit](https://opengameart.org/content/chainlink-fence-modular-kit) | loafbrr_1 | CC0 | ? | 100.32 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | old metal spiked fence | [Old metal fence](https://opengameart.org/content/old-metal-fence) | Paul Wortmann | CC0 | ? | 5.18 | 2 | not used: realism 2 |
| OpenGameArt | pole-mounted transformers | [Utilility Pole Transformer](https://opengameart.org/content/utilility-pole-transformer) | Scott Hsu-Storaker(Submitted by qubodup) | CC-BY 3.0 | ? | 0.38 | 2 | not used: realism 2 |
| OpenGameArt | wooden pole with box | [telephone pole](https://opengameart.org/content/telephone-pole) | carlosjorgereis | CC0 | ? | 0.29 | 2 | not used: realism 2 |
| OpenGameArt | street light + cable pole | [Street lights](https://opengameart.org/content/street-lights) | DREAM_SEARCH_REPEAT | CC0 | ? | 1.21 | 2 | not used: realism 2 |
| OpenGameArt | conical hat (non la) | [Vertex Painted Rice Picking Hat](https://opengameart.org/content/vertex-painted-rice-picking-hat) | Ouren | CC-BY 3.0 | ? | 0.47 | 2 | not used: realism 2 |
| OpenGameArt | street food cart | [Chinese Food Cart](https://opengameart.org/content/chinese-food-cart) | Ouren | CC-BY 3.0 | ? | 0.93 | 2 | not used: realism 2 |
| OpenGameArt | hatchback/coupe car | [Car VW Corradon](https://opengameart.org/content/car-vw-corradon) | rohezal | CC0 | ? | 4.19 | 2 | not used: realism 2 |
| OpenGameArt | coach bus | [3D Bus](https://opengameart.org/content/3d-bus) | ajanhallinta | CC0 | ? | 0.78 | 2 | not used: realism 2 |
| OpenGameArt | old apartment block | [Soviet Panel Apartment House 3D](https://opengameart.org/content/soviet-panel-apartment-house-3d) | GGBotNet | CC0 | 786 | 4.08 | 2 | not used: realism 2 |
| OpenGameArt | modular building kit | [Modular building asset](https://opengameart.org/content/modular-building-asset-0) | Yughues | CC0 | ? | 70.49 | 3 | not downloaded: Poly Haven set already covers it (or low priority) |
| OpenGameArt | coconut | [Coconut 3D](https://opengameart.org/content/coconut-3d) | GGBotNet | CC0 | 48/224 | 0.39 | 2 | not used: realism 2 |
| Smithsonian Open Access 3D | blue-and-white porcelain vase | [Baluster vase, from a five-piece garniture (F1980.191a-c)](https://asia.si.edu/object/F1980.191a-c/) | Smithsonian National Museum of Asian Art (Freer Gallery) | CC0 | 100000 | 0.95 | 5 | not used yet: Draco GLB (pipeline has no Draco decoder); 100k tris |
| ambientCG | mango | [3DMango001](https://ambientcg.com/a/3DMango001) | ambientCG (Lennart Demes) | CC0 | ? | 3.68 | 5 | built |
| ambientCG | baguette (banh mi) | [3DBread011](https://ambientcg.com/a/3DBread011) | ambientCG (Lennart Demes) | CC0 | ? | 5.52 | 5 | downloaded, not built (simplified scan looked crumpled) |
| ambientCG | tree stump | [3DTreeStump001](https://ambientcg.com/a/3DTreeStump001) | ambientCG (Lennart Demes) | CC0 | ? | 5.69 | 5 | not downloaded: Poly Haven set already covers it (or low priority) |
| 3dassets.dev | step-through scooter (Cub/Wave-like) | [Scooter on its stand (Car Park and Road Vehicle Fleet)](https://3dassets.dev/assets/car-park-and-road-vehicle-fleet-scooter-2e680ced) | 3dassets (site team account) | CC0 1.0 | 7784 | 0.24 | 2 | not used: provenance unclear (site-seeded bulk kit, creation method undisclosed; untextured) |
| 3dassets.dev | motorbike | [Motorbike on its stand (Car Park and Road Vehicle Fleet)](https://3dassets.dev/assets/car-park-and-road-vehicle-fleet-motorbike-8abc1635) | 3dassets (site team account) | CC0 1.0 | 7744 | 0.21 | 2 | not used: provenance unclear (site-seeded bulk kit, creation method undisclosed; untextured) |
| 3dassets.dev | utility pole with transformer | [Utility Pole with Transformer (Indian Bazaar Street and Temple)](https://3dassets.dev/assets/indian-bazaar-street-and-temple-utility-pole-with-tran-a6bc304e) | 3dassets (site team account) | CC0 1.0 | 1700 | 0.14 | 2 | not used: provenance unclear (site-seeded bulk kit, creation method undisclosed; untextured) |
| 3dassets.dev | shopfront with roller shutter | [Shopfront Bay, Closed Shutter (Japanese School and City Street)](https://3dassets.dev/assets/japanese-school-and-city-street-shopfront-shutter-730e18d0) | 3dassets (site team account) | CC0 1.0 | 3280 | 0.24 | 2 | not used: provenance unclear (site-seeded bulk kit, creation method undisclosed; untextured) |
| 3dassets.dev | bamboo clump | [Bamboo clump, 3.4 m (Botanical Glasshouse and Palm House)](https://3dassets.dev/assets/botanical-glasshouse-and-palm-house-botanical-glasshou-5298b114) | 3dassets (site team account) | CC0 1.0 | 8008 | 0.32 | 2 | not used: provenance unclear (site-seeded bulk kit, creation method undisclosed; untextured) |
| 3dassets.dev | five-door hatchback | [Five-door hatchback (Car Park and Road Vehicle Fleet)](https://3dassets.dev/assets/car-park-and-road-vehicle-fleet-five-door-hatchback-18f81884) | 3dassets (site team account) | CC0 1.0 | 30524 | 0.97 | 2 | not used: provenance unclear (site-seeded bulk kit, creation method undisclosed; untextured) |
| 3dassets.dev | taxi saloon | [Licensed taxi saloon (Car Park and Road Vehicle Fleet)](https://3dassets.dev/assets/car-park-and-road-vehicle-fleet-taxi-ae3c8ca0) | 3dassets (site team account) | CC0 1.0 | 30464 | 0.96 | 2 | not used: provenance unclear (site-seeded bulk kit, creation method undisclosed; untextured) |
| 3dassets.dev | 16-seat minibus | [Sixteen-seat minibus (Car Park and Road Vehicle Fleet)](https://3dassets.dev/assets/car-park-and-road-vehicle-fleet-minibus-296d6f1e) | 3dassets (site team account) | CC0 1.0 | 28096 | 0.95 | 2 | not used: provenance unclear (site-seeded bulk kit, creation method undisclosed; untextured) |
| 3dassets.dev | box truck | [Box truck with a roller shutter (Car Park and Road Vehicle Fleet)](https://3dassets.dev/assets/car-park-and-road-vehicle-fleet-box-truck-4574c765) | 3dassets (site team account) | CC0 1.0 | 25972 | 0.58 | 2 | not used: provenance unclear (site-seeded bulk kit, creation method undisclosed; untextured) |
| 3dassets.dev | bus shelter | [Bus Shelter (Battle Royale Town and Airfield)](https://3dassets.dev/assets/battle-royale-town-and-airfield-bus-shelter-df1a4894) | 3dassets (site team account) | CC0 1.0 | 2268 | 0.28 | 2 | not used: provenance unclear (site-seeded bulk kit, creation method undisclosed; untextured) |
| Poly Pizza | moped scooter | [Scooter](https://poly.pizza/m/9RqkkBOPNtd) | Poly by Google | CC-BY 3.0 | 2116 | 0.302 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | moped scooter | [Scooter](https://poly.pizza/m/fPLXByG4Vx5) | Poly by Google | CC-BY 3.0 | 2674 | 0.122 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | Vespa | [Vespa](https://poly.pizza/m/blGLclvvdEM) | Jasmine Roberts | CC-BY 3.0 | 1667 | 0.09 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | scooter street-vendor cart | [Street Vendor Cart](https://poly.pizza/m/f_LuAcP2_Yh) | Alan Zimmerman | CC-BY 3.0 | 3272 | 0.696 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | coconut palm | [Coconut palm tree](https://poly.pizza/m/bXUTyfiwqBb) | Poly by Google | CC-BY 3.0 | 2784 | 2.384 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | banana tree with fruit | [Banana Tree](https://poly.pizza/m/3VR5B-a5v21) | Sean Tarrant | CC-BY 3.0 | 12016 | 0.795 | 2 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | banana tree | [Banana Tree](https://poly.pizza/m/d0WJSiuOz6o) | Poly by Google | CC-BY 3.0 | 2138 | 1.916 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | bamboo | [Bamboo](https://poly.pizza/m/auVD_m-ugF0) | Poly by Google | CC-BY 3.0 | 1574 | 0.345 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | telephone poles with wires | [Telephone pole](https://poly.pizza/m/7YIloiV4cAt) | Poly by Google | CC-BY 3.0 | 6528 | 0.248 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | AC outdoor unit | [Air Conditioner](https://poly.pizza/m/amFuyE3IF6) | Quaternius | CC0 1.0 | 946 | 0.039 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | propane tank | [Propane Tank](https://poly.pizza/m/Fsk9PE6o74) | CreativeTrio | CC0 1.0 | 1008 | 0.08 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | bird cage | [Bird Cage](https://poly.pizza/m/0d4ExMmqXUV) | Poly by Google | CC-BY 3.0 | 7532 | 0.431 | 2 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | bonsai | [Bonsai](https://poly.pizza/m/1BtyNc_gX5a) | Poly by Google | CC-BY 3.0 | 751 | 0.252 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | red lantern | [red lantern](https://poly.pizza/m/7PZhxLFiGc2) | Sophie Kim | CC-BY 3.0 | 354 | 0.03 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | city bus | [Bus](https://poly.pizza/m/4CPpvEmrMoF) | Poly by Google | CC-BY 3.0 | 2226 | 0.046 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | hatchback | [Car Hatchback](https://poly.pizza/m/BG0KAhmGDt) | Kay Lousberg | CC0 1.0 | 1194 | 0.082 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Poly Pizza | trash can | [Trashcan Large](https://poly.pizza/m/eYNKnGlhon) | Quaternius | CC0 1.0 | 646 | 0.021 | 1 | not used: low-poly (realism 1–2); last-resort fallback |
| Kenney | car kit (sedan, taxi, van, truck, police etc.) | [Car Kit](https://kenney.nl/assets/car-kit) | Kenney | CC0 | ? | 4.81 | 1 | not used: low-poly (realism 1–2); last-resort fallback |

## Needs the owner's login

Sketchfab downloads need an account, so none of these were downloaded. Every row was checked through the public API (`api.sketchfab.com/v3/models/<uid>`: `isDownloadable: true`, license label) and most thumbnails were reviewed for realism (1 cartoon … 5 photoreal). Re-check the license in the download dialog. Prefer the **glTF/GLB 2K** option; put files in `assets-src/environment/vn/sketchfab/<slug>/` and add a `files` model plus `credits` (CC-BY: title, author, link) to `vn/config.mjs`.

### Recommended first batch (≈ 210 MB of source GLBs; they shrink to ~0.2–2 MB each after the pipeline)

| Priority | Item | Model (URL) | Author | License | Tris | GLB (MB) | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Motorbike (Cub/Wave silhouette) | [Honda Super Cub](https://sketchfab.com/3d-models/honda-super-cub-9ce554228fc746c89f6d02b995f43c41) | Aleksandr Sagidullin | CC-BY-4.0 | 334k | 31 | Decimate to ≤ 8k; paint over the Honda badge. Nothing realistic exists for Wave/Dream/Vision/Sirius |
| 1 | Bánh mì cart | [BanhMi Cart](https://sketchfab.com/3d-models/banhmi-cart-f45b8dfd3a874779ac18323399a10258) | Khoa Nguyen (ngdkh) | CC-BY-4.0 | 7.1k | 1.2 | Real "Xôi nóng – Bánh mì" signage |
| 1 | Plastic stool/table | [Vietnamese Plastic Chair](https://sketchfab.com/3d-models/vietnamese-plastic-chair-25c585737c014827bfa3b56c2b680581) | kiim | CC-BY-4.0 | 3.9k | 14.7 | The low blue square stool |
| 1 | Pole with tangled cables | [Electric Pole](https://sketchfab.com/3d-models/electric-pole-862dec14911845679e3dd0298efbeec3) | Khoa Nguyen (ngdkh) | CC-BY-4.0 | 7.7k | 7.4 | The Saigon cable mess; replaces the Poly Haven wooden poles on main streets |
| 1 | AC units | [Air conditioner pack](https://sketchfab.com/3d-models/air-conditioner-pack-3b930497c77f47269847e75b9ee85b20) | Khoa Nguyen (ngdkh) | CC-BY-4.0 | 1.5k | 2.5 | Lighter than the Poly Haven unit for facade scatter |
| 1 | Shopfront shutter (scan) | [Commercial Front With Garage Door, Philippines](https://sketchfab.com/3d-models/commercial-front-with-garage-door-philippines-a1ecd9e87c95444dbff19cfb82c4020b) | Alben Tan | CC-BY-4.0 | 70k | 12.8 | Nhà phố ground floor; decimate |
| 1 | Trash bin (scan) | [Garbage Disposal Bin - 3D scan](https://sketchfab.com/3d-models/garbage-disposal-bin-3d-scan-a8751db2d94647ddac226d9d6886164c) | Alben Tan | CC-BY-4.0 | 22k | 5.4 | VN 240 L wheelie-bin look |
| 1 | Flame tree (phượng) | [Realistic HD Royal poinciana (26/40)](https://sketchfab.com/3d-models/realistic-hd-royal-poinciana-26-40-bced4895a46642c9a2279d195ceb7dec) | PlantCatalog | CC-BY-4.0 | 86k | 15.1 | Through foliage.mjs (cards + impostor) |
| 1 | Street tree (bàng/me stand-in) | [Chinese Banyan (Ficus Microcarpa)](https://sketchfab.com/3d-models/chinese-banyan-ficus-microcarpa-2a0dbcdf8f5d48f5ad79987c7a8170ce) | Valery.Li | CC-BY-4.0 | 111k | 13.2 | Through foliage.mjs |
| 2 | Banana tree | [Banana tree](https://sketchfab.com/3d-models/banana-tree-3b658ecad29f4d9a9606dbf8fea7c9bb) | 1Quad | CC-BY-4.0 | 48k | 7.4 | With trunk and fruit (the built `vn_banana_plant` has neither) |
| 2 | Conical hat (nón lá) | [Asian conical hat](https://sketchfab.com/3d-models/asian-conical-hat-d407409ab62543669aac4a30dcb744b5) | Oneironauticus | CC-BY-4.0 | 2.7k | 9.9 | Stall and cyclo dressing |
| 2 | Lanterns | [Oriental Lanterns](https://sketchfab.com/3d-models/oriental-lanterns-3283e1cc6bfa47c5a620ddfcd251db6f) | SierraChase | CC-BY-4.0 | 30k | 14.1 | Hội An style; pagoda streets, Tết |
| 2 | Sidewalk umbrella | [White outdoor Umbrella](https://sketchfab.com/3d-models/white-outdoor-umbrella-d6c9705a4f8e421ea473196ab9910088) | Ngo.Phuoc.Truong | CC-BY-4.0 | 1.7k | 2.4 | Vietnamese author |
| 2 | Market stall | [Vietnamese Meat Market stall](https://sketchfab.com/3d-models/vietnamese-meat-market-stall-0cd04f3c727347d9899b52b9b88be871) | Khoa Nguyen (ngdkh) | CC-BY-4.0 | 3.7k | 1.9 | Chợ interiors |
| 2 | Shop clutter (scan) | [Crates and boxes at the back of an Asian store](https://sketchfab.com/3d-models/crates-and-boxes-at-the-back-of-an-asian-store-26f01d69ac8c49b2a4c34e21b68c656f) | Alben Tan | CC-BY-4.0 | 45k | 8 | Alley cover |
| 2 | Laundry line | [Laundry Clothesline](https://sketchfab.com/3d-models/laundry-clothesline-6f13cc3c463f43888fb5db634cc603aa) | Khoa Nguyen (ngdkh) | CC-BY-4.0 | 8.7k | 3.3 | Balconies and alleys |
| 2 | Solar water heater | [Solar Water Heater- Anil](https://sketchfab.com/3d-models/solar-water-heater-anil-7cef30aeac9c49e6867f4fad18488026) | aniljaco | CC-BY-4.0 | 129k | 5.1 | Untextured: assign steel/glass materials; rooftops |
| 2 | Tube-house facade kit | [ModularKit Vietnam](https://sketchfab.com/3d-models/modularkit-vietnam-40c57d9e7d944ee5a0524f0677349c04) | Khoa Nguyen (ngdkh) | CC-BY-4.0 | 24k | 15.7 | Reference/trim for the procedural nhà ống prefabs |
| 3 | Covered sedan (scan) | [Sedan car covered with a gray car cloth](https://sketchfab.com/3d-models/sedan-car-covered-with-a-gray-car-cloth-3d-scan-5818270ead0649498ab6120604b19f7f) | Alben Tan | CC-BY-4.0 | 36k | 6 | Brand-free parked car |
| 3 | Bus | [City Bus - rigged / РоАЗ-5236](https://sketchfab.com/3d-models/city-bus-rigged-5236-36646fcf41da498ca24a02f4b6fb1d95) | Yo.Ri | CC-BY-4.0 | 5.6k | 3.9 | Repaint green/white like Saigon buses |
| 3 | Box truck | [LCT 3000 '95](https://sketchfab.com/3d-models/lct-3000-95-low-poly-model-663a0953c038434a918cb85725c88ffa) | Daniel Zhabotinsky | CC-BY-4.0 | 19k | 11.5 | Author allows any use |
| 3 | Bird cage | [Bird Cage](https://sketchfab.com/3d-models/bird-cage-d90064290e61493a9ed1e5884a40e3f1) | Ziplock Waffles | CC-BY-4.0 | 86k | 19 | Metal, 8K texture: downsize and decimate |

### Full accepted Sketchfab catalog (112)

| # | Category / item | Model | Author | License | Tris | GLB (MB) | Max tex | Realism | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | street-props / motorbike | [Honda Super cub](https://sketchfab.com/3d-models/honda-super-cub-9ce554228fc746c89f6d02b995f43c41) | Aleksandr Sagidullin | CC-BY-4.0 | 333676 | 31 | 4096 | 4 | 333k source tris - heavy decimation; Honda badge on model |
| 2 | street-props / motorbike | [HONDA Super Cub](https://sketchfab.com/3d-models/honda-super-cub-8eec38e887ed42c58dd659dc1343ac8d) | Jingbari | CC-BY-4.0 | 146498 | 21.1 | 4096 | 4 | Scan incl. ground patch + basket; needs cleanup/retopo |
| 3 | street-props / motorbike | [Vino](https://sketchfab.com/3d-models/vino-2205f4e69bc64df3aab03c71ab9d7492) | minghauLoh | CC-BY-4.0 | 95599 | 129.7 | 4096 | 4 | Original ArtStation work; 19 textures up to 4K, 130MB GLB - downsize textures; Yamaha name |
| 4 | street-props / motorbike | [Old Scooter](https://sketchfab.com/3d-models/old-scooter-5e9b5072b2224ba982366490ad5f31d9) | Nadia Ribitis | CC-BY-4.0 | 1793 | 13.6 | 2048 | 4 | Tagged quixel - textures may derive from Megascans; low tri count |
| 5 | street-props / motorbike | [1970 Vespa Scooter (Non-Printable)](https://sketchfab.com/3d-models/1970-vespa-scooter-non-printable-bf97a3f919ed4228b3e76fd61f071e01) | Kristian LaGrange | CC-BY-4.0 | 331590 | 40 | 4096 | 4 | 331k tris |
| 6 | street-props / food cart | [BanhMi Cart](https://sketchfab.com/3d-models/banhmi-cart-f45b8dfd3a874779ac18323399a10258) | Khoa Nguyen | CC-BY-4.0 | 7130 | 1.2 | 1024 | 4 | By Vietnamese author ngdkh; very light |
| 7 | street-props / food cart | [煎饼车/Gerobak Lumpia](https://sketchfab.com/3d-models/gerobak-lumpia-bca4551289cb456dbf2de4ed91e4acfc) | billionlioe | CC-BY-4.0 | 10822 | 6.7 | 1024 | 4 | Indonesian gerobak; Chinese text signage |
| 8 | street-props / food cart | [Avika Street Food Cart](https://sketchfab.com/3d-models/avika-street-food-cart-d54005c378fa45c3a06090d65a53fb23) | AVIKA | CC-BY-4.0 | 36653 | 9.1 | 1024 | 4 | English "Sausages $1" signage - retexture |
| 9 | street-props / food cart | [Low poly bánh mì cart](https://sketchfab.com/3d-models/low-poly-ba-nh-mi-cart-e451f91d7d10403c98205cfa1abd3f71) | €r!c | CC-BY-4.0 | 3666 | 9.2 | 2048 | 3 | Simpler shading |
| 10 | street-props / plastic stool/table | [Vietnamese Plastic Chair](https://sketchfab.com/3d-models/vietnamese-plastic-chair-25c585737c014827bfa3b56c2b680581) | kiim | CC-BY-4.0 | 3940 | 14.7 | 4096 | 4 | Name says chair but model is the square low stool/table; 4K textures |
| 11 | street-props / plastic stool/table | [Vietnamese Plastic Chair](https://sketchfab.com/3d-models/vietnamese-plastic-chair-efa69b6b78cc48248f758aec21369447) | kiim | CC-BY-4.0 | 1651408 | 71.4 | 2048 | 5 | 1.65M tris - must decimate/bake |
| 12 | street-props / plastic stool/table | [Dirty Plastic Chairs & Tables (For Unity)](https://sketchfab.com/3d-models/dirty-plastic-chairs-tables-for-unity-0a6eafb63018479b98d29456dc3f6fc8) | CHEESE ARG 3D | CC-BY-4.0 | 3500 | 18.1 | 2048 | 4 | Dirty variants; 15 textures |
| 13 | street-props / plastic stool/table | [Classic Plastic Chairs](https://sketchfab.com/3d-models/classic-plastic-chairs-6d139742099d48f195e6774514ccb7ef) | Francesco Coldesina | CC-BY-4.0 | 58464 | 8.9 | 2048 | 5 | Good for sidewalk cafe clutter |
| 14 | street-props / plastic stool/table | [Plastic Set - Pluta_Table_Set](https://sketchfab.com/3d-models/plastic-set-pluta_table_set-c340c44f36034b9298534484464de3c7) | Francesco Coldesina | CC-BY-4.0 | 149124 | 27.4 | 4096 | 4 | 149k tris |
| 15 | street-props / umbrella | [White outdoor Umbrella](https://sketchfab.com/3d-models/white-outdoor-umbrella-d6c9705a4f8e421ea473196ab9910088) | Ngo.Phuoc.Truong | CC-BY-4.0 | 1650 | 2.4 | 1024 | 4 | Vietnamese author |
| 16 | street-props / umbrella | [Outdoor umbrella](https://sketchfab.com/3d-models/outdoor-umbrella-258d0f6f96274a06b806e6f0ca399a8c) | Khoa Nguyen | CC-BY-4.0 | 758 | 1.1 | 1024 | 3 | ngdkh; simple |
| 17 | street-props / market stall | [Vietnamese Meat Market stall](https://sketchfab.com/3d-models/vietnamese-meat-market-stall-0cd04f3c727347d9899b52b9b88be871) | Khoa Nguyen | CC-BY-4.0 | 3689 | 1.9 | 1024 | 4 | ngdkh |
| 18 | street-props / market stall | [Vietnamese Vegetable Market](https://sketchfab.com/3d-models/vietnamese-vegetable-market-a3c935d758624c8f866bc27776f86712) | Khoa Nguyen | CC-BY-4.0 | 6733 | 2 | 1024 | 3 | ngdkh; stylized-ish shading |
| 19 | street-props / market stall | [Asian Wet Market barbecue street food stall scan](https://sketchfab.com/3d-models/asian-wet-market-barbecue-street-food-stall-scan-89ba4f01b0e048a7b60282c9c4f5a74a) | Alben Tan | CC-BY-4.0 | 89151 | 5.2 | 4096 | 4 | Flat tabletop scan |
| 20 | street-props / market stall | [Crates and boxes at the back of an Asian store](https://sketchfab.com/3d-models/crates-and-boxes-at-the-back-of-an-asian-store-26f01d69ac8c49b2a4c34e21b68c656f) | Alben Tan | CC-BY-4.0 | 45221 | 8 | 4096 | 5 | Great alley/shop clutter |
| 21 | street-props / conical hat | [Asian conical hat](https://sketchfab.com/3d-models/asian-conical-hat-d407409ab62543669aac4a30dcb744b5) | Samuel F. Angrick-Johanns (Oneironauticus) | CC-BY-4.0 | 2680 | 9.9 | 2048 | 4 | Generic Asian conical hat, close to nón lá |
| 22 | street-props / conical hat | [Asian Conical Hat](https://sketchfab.com/3d-models/asian-conical-hat-4eed68df8fb84284a91f42a6c6e4569c) | MushyDay | CC-BY-4.0 | 3234 | 7.3 | 2048 | 4 | Wider brim, 6 textures |
| 23 | street-props / lantern | [Oriental Lanterns](https://sketchfab.com/3d-models/oriental-lanterns-3283e1cc6bfa47c5a620ddfcd251db6f) | SierraChase | CC-BY-4.0 | 30174 | 14.1 | 2048 | 4 | Good for pagoda/old-town streets |
| 24 | street-props / lantern | [Chinese \ Japanese paper lantern chochin](https://sketchfab.com/3d-models/chinese-japanese-paper-lantern-chochin-20bcc5d20f2847f88aef3a267275d16c) | DeepDown | CC-BY-4.0 | 2750 | 9.2 | 2048 | 4 | Japanese/Chinese style |
| 25 | street-props / lantern | [Vietnamese Lantern](https://sketchfab.com/3d-models/vietnamese-lantern-e08d22e1d8364603a1cd10337d5f9da8) | Khoa Nguyen | CC-BY-4.0 | 4161 | 4 | 1024 | 3 | ngdkh |
| 26 | street-props / signboard | [Wooden Signage Sugar Cane Juice Store - 3D scan](https://sketchfab.com/3d-models/wooden-signage-sugar-cane-juice-store-3d-scan-1b69b527480c4382bf9a81a4083d228f) | Alben Tan | CC-BY-4.0 | 50221 | 6.4 | 4096 | 4 | English text |
| 27 | street-props / signboard | [Hong Kong signs pack](https://sketchfab.com/3d-models/hong-kong-signs-pack-a1c8002815b244099bcc3b6034f29866) | Pasha | CC-BY-4.0 | 21716 | 7.2 | 2048 | 3 | Contains McDonald's logo and HK brand names - crop/replace; Chinese text |
| 28 | street-props / rolling shutter | [Commercial Front With Garage Door, Philippines](https://sketchfab.com/3d-models/commercial-front-with-garage-door-philippines-a1ecd9e87c95444dbff19cfb82c4020b) | Alben Tan | CC-BY-4.0 | 70347 | 12.8 | 4096 | 5 | "For rent" sign; perfect nhà phố ground-floor |
| 29 | street-props / rolling shutter | [Rolling Shutter](https://sketchfab.com/3d-models/rolling-shutter-bd01deecf45d4b429e97c0cb23116f06) | Origicube | CC-BY-4.0 | 8358 | 8.7 | 2048 | 4 | Game-ready |
| 30 | street-props / water tank | [Overhead Water tank](https://sketchfab.com/3d-models/overhead-water-tank-1745c92e50b441c6bf6588e11cdba538) | Nodeaxis Interactive | CC-BY-4.0 | 508 | 44.8 | 4096 | 4 | No stainless bồn inox found; retint to steel as fallback |
| 31 | street-props / solar water heater | [Solar Water Heater- Anil](https://sketchfab.com/3d-models/solar-water-heater-anil-7cef30aeac9c49e6867f4fad18488026) | aniljaco | CC-BY-4.0 | 128718 | 5.1 | none | 4 | No textures (materials only); 129k tris |
| 32 | street-props / solar water heater | [360Lts High Pressure Solar Water Heater](https://sketchfab.com/3d-models/360lts-high-pressure-solar-water-heater-675705c3f29940fa95dd92f2ffe651b4) | Sofo Soler | CC-BY-4.0 | 455588 | 16.4 | none | 4 | Uploaded by manufacturer Sofosolerltd; no textures; 456k tris |
| 33 | street-props / ac unit | [Air conditioner pack](https://sketchfab.com/3d-models/air-conditioner-pack-3b930497c77f47269847e75b9ee85b20) | Khoa Nguyen | CC-BY-4.0 | 1462 | 2.5 | 1024 | 4 | ngdkh; very light; 587 likes |
| 34 | street-props / ac unit | [AC Unit and Trash bags 1 - 3D scan](https://sketchfab.com/3d-models/ac-unit-and-trash-bags-1-3d-scan-b56f9ca565874c57bf732f943c18f3a1) | Alben Tan | CC-BY-4.0 | 30602 | 20 | 8192 | 5 | Includes ground patch |
| 35 | street-props / ac unit | [AC Units](https://sketchfab.com/3d-models/ac-units-aa3a54a4a56b4878a8fc7d4e56ab7fc3) | Udon-San | CC-BY-4.0 | 42554 | 39.4 | 2048 | 4 | Clean |
| 36 | street-props / ac unit | [Mitsubishi AC unit](https://sketchfab.com/3d-models/mitsubishi-ac-unit-2ee631cfd24542b4b47eb6d88b34d4a8) | ZobboZ | CC-BY-4.0 | 2148 | 0.1 | 256 | 4 | Mitsubishi logo; ultra light |
| 37 | street-props / electric pole | [Electric Pole](https://sketchfab.com/3d-models/electric-pole-862dec14911845679e3dd0298efbeec3) | Khoa Nguyen | CC-BY-4.0 | 7690 | 7.4 | 1024 | 4 | ngdkh; 7.7k tris; best VN cable-mess look |
| 38 | street-props / electric pole | [Vietnam Electric Pole](https://sketchfab.com/3d-models/vietnam-electric-pole-838358343f2a4a7e82cff10326207902) | Khoa Nguyen | CC-BY-4.0 | 1826 | 17.6 | 4096 | 3 | ngdkh; tagged saigon; 4K textures |
| 39 | street-props / electric pole | [Japanese Electric Pole](https://sketchfab.com/3d-models/japanese-electric-pole-f3dc37ced5d548ef98c7ee8bd2ad5491) | LiliumLetifer | CC-BY-4.0 | 84988 | 20.3 | 2048 | 4 | Japanese; 85k tris |
| 40 | street-props / electric pole | [Street light](https://sketchfab.com/3d-models/street-light-77b0a1e448f14b47b9dc62881a241850) | Mehdi Shahsavan | CC-BY-4.0 | 23272 | 25.9 | 2048 | 4 | Also covers lamp posts |
| 41 | street-props / electric pole | [Power Line Pack](https://sketchfab.com/3d-models/power-line-pack-9dd9b47ae5d347cfbba1e36217cc3d07) | CGMeller | CC-BY-4.0 | 45116 | 48.3 | 4096 | 4 | Wooden poles, 15 textures |
| 42 | street-props / electric pole | [Electric Meters And Panels 1](https://sketchfab.com/3d-models/electric-meters-and-panels-1-ec17e89b49a5436b8b329b5c05e905c4) | Alben Tan | CC-BY-4.0 | 96638 | 13.8 | 4096 | 5 | Alley wall detail |
| 43 | street-props / trash bin | [Garbage Disposal Bin - 3D scan](https://sketchfab.com/3d-models/garbage-disposal-bin-3d-scan-a8751db2d94647ddac226d9d6886164c) | Alben Tan | CC-BY-4.0 | 22505 | 5.4 | 4096 | 5 | Best match for VN green/grey 240L bins |
| 44 | street-props / trash bin | [Trash Bins](https://sketchfab.com/3d-models/trash-bins-41adbcf80c4e4bcebc99e29b9c4a2f6f) | Khoa Nguyen | CC-BY-4.0 | 6988 | 2.7 | 1024 | 3 | ngdkh |
| 45 | street-props / potted plant/bonsai | [Vietnamese bonsai](https://sketchfab.com/3d-models/vietnamese-bonsai-d2edb3e196494af48f516ba7466414c9) | Khoa Nguyen | CC-BY-4.0 | 5026 | 3.2 | 1024 | 3 | ngdkh |
| 46 | street-props / potted plant/bonsai | [[FREE] Pothos Potted Plant - Money Plant](https://sketchfab.com/3d-models/free-pothos-potted-plant-money-plant-e9832f38484f4f85b3f9081b51fa3799) | AllQuad | CC-BY-4.0 | 15744 | 3.9 | 1024 | 4 | Balcony/shop deco |
| 47 | street-props / bird cage | [Bird Cage](https://sketchfab.com/3d-models/bird-cage-d90064290e61493a9ed1e5884a40e3f1) | Ziplock Waffles | CC-BY-4.0 | 85581 | 19 | 8192 | 4 | Metal, not bamboo; 8K texture - downsize |
| 48 | street-props / cargo cart/tricycle | [wheelbarrow / Xe kéo hàng rong](https://sketchfab.com/3d-models/wheelbarrow-xe-ke-o-ha-ng-rong-11c458635b224128ba6e490bbbb436ad) | NGUYENNGHIAKK | CC-BY-4.0 | 12044 | 34.5 | 4096 | 3 | Vietnamese author nguyennghiakk; 4K textures 34MB |
| 49 | street-props / cargo cart/tricycle | [Bicycle](https://sketchfab.com/3d-models/bicycle-25aa85eeba944baea33ce5cde985ca49) | Lyskilde | CC-BY-4.0 | 20864 | 12.2 | 2048 | 4 | Named "Bicycle" but is a trike |
| 50 | street-props / bicycle | [Old Bicycle](https://sketchfab.com/3d-models/old-bicycle-17ab00cb733443a2b552a2b620a68087) | Tidominer | CC-BY-4.0 | 55320 | 4 | none | 4 | No textures (materials) |
| 51 | street-props / bicycle | [Vintage Bicycle](https://sketchfab.com/3d-models/vintage-bicycle-1795f6e907634afda88fdaf45f67b279) | VladNeko | CC-BY-4.0 | 49587 | 35.6 | 2048 | 4 | 14 textures |
| 52 | street-props / gas cylinder | [LPG Gas Cylinder](https://sketchfab.com/3d-models/lpg-gas-cylinder-18ca9f4949fa4682a530af2fa29f6191) | lord_hypersonic | CC-BY-4.0 | 16816 | 14.8 | 2048 | 4 | Clean |
| 53 | street-props / gas cylinder | [OLD LPG](https://sketchfab.com/3d-models/old-lpg-8ec8302a7f024547bfdc44dc8cc152ed) | Kwon_Hyuk | CC-BY-4.0 | 1722 | 11.9 | 2048 | 4 | Korean text |
| 54 | street-props / fruit basket | [Bamboo baskets contain fruits.](https://sketchfab.com/3d-models/bamboo-baskets-contain-fruits-08998be762954bc1a051100d5241ac5d) | xinige | CC-BY-4.0 | 44761 | 7.3 | 4096 | 4 | Single 4K texture |
| 55 | street-props / altar | [Vietnamese altar](https://sketchfab.com/3d-models/vietnamese-altar-5d65b1d0919c4394808727f461773c11) | Khoa Nguyen | CC-BY-4.0 | 1881 | 2.3 | 1024 | 3 | ngdkh; red emissive look |
| 56 | street-props / altar | [Chinese Incense Burner-LowPory-Material test](https://sketchfab.com/3d-models/chinese-incense-burner-lowpory-material-test-69dbb96caea84dcab6ac8fa83af78ff9) | chiwei | CC-BY-4.0 | 11545 | 52.5 | 4096 | 4 | Pagoda courtyard / altar; 52MB 4K |
| 57 | street-props / gate/grille | [Rusty Gate With Graffiti in Philippines](https://sketchfab.com/3d-models/rusty-gate-with-graffiti-in-philippines-2d536a69cf98419381b63f0a939274b6) | Alben Tan | CC-BY-4.0 | 102825 | 4.8 | 4096 | 5 | Philippines alley |
| 58 | street-props / gate/grille | [Rusty old gate](https://sketchfab.com/3d-models/rusty-old-gate-59a45c1917aa4d1c9cc5d8f9ae01c58b) | Ret.ouchs | CC-BY-4.0 | 10980 | 55.6 | 4096 | 4 | Villa gate |
| 59 | street-props / gate/grille | [Fences](https://sketchfab.com/3d-models/fences-8e4d9e0ad9224158a79a3ef0a76b3b31) | Khoa Nguyen | CC-BY-4.0 | 2008 | 1.9 | 1024 | 3 | ngdkh |
| 60 | street-props / railing | [Metal Railing Modular - 2048px²](https://sketchfab.com/3d-models/metal-railing-modular-2048px2-fe569b1c83ba4daab50787c9e4bb181f) | Mark Peters | CC-BY-4.0 | 14028 | 5.4 | 2048 | 3 | Simple |
| 61 | street-props / laundry | [Laundry Clothesline](https://sketchfab.com/3d-models/laundry-clothesline-6f13cc3c463f43888fb5db634cc603aa) | Khoa Nguyen | CC-BY-4.0 | 8693 | 3.3 | 2048 | 4 | ngdkh; 450 likes |
| 62 | buildings / tube house | [ModularKit Vietnam](https://sketchfab.com/3d-models/modularkit-vietnam-40c57d9e7d944ee5a0524f0677349c04) | Khoa Nguyen | CC-BY-4.0 | 24179 | 15.7 | 2048 | 3 | ngdkh; best base for nhà ống facades |
| 63 | buildings / tube house | [Procedural Hong Kong building](https://sketchfab.com/3d-models/procedural-hong-kong-building-528a732e84c44fd49c4726f341014a23) | uday | CC-BY-4.0 | 197097 | 34.3 | 2048 | 4 | Blender geo-nodes original; 197k tris; very Saigon-like |
| 64 | buildings / tube house | [Hong Kong buildings Alley-2k+ followers:)](https://sketchfab.com/3d-models/hong-kong-buildings-alley-2k-followers-8192b1cd4a8144c88163c43a3a6abb3f) | Pasha | CC-BY-4.0 | 57448 | 5.8 | 1024 | 4 | Chinese signage |
| 65 | buildings / tube house | [Asia Building](https://sketchfab.com/3d-models/asia-building-a3f45195b01f48ff9f687d3ceac52b82) | Solarliu | CC-BY-4.0 | 14337 | 3 | 1024 | 3 | Stylized texture; 14k tris |
| 66 | buildings / tube house | [Vietnamese House in 2000s](https://sketchfab.com/3d-models/vietnamese-house-in-2000s-582936c8eac641a885343e91766e71b1) | Khoa Nguyen | CC-BY-4.0 | 8490 | 5.5 | 1024 | 3 | Interior only |
| 67 | buildings / tube house | [Vietnam's Old Town](https://sketchfab.com/3d-models/vietnam-s-old-town-c1251dd5edfb4f73ab6ac98ca3e3a188) | NGUYENNGHIAKK | CC-BY-4.0 | 2206797 | 161.3 | 2048 | 4 | 2.2M tris 161MB; contains flags/political banners - strip or reference only |
| 68 | buildings / tube house | [Hoi An house - Nhà Hội An](https://sketchfab.com/3d-models/hoi-an-house-nha-ho-i-an-2f2c7d59ede94b42bfc0d451c208ea8d) | NGUYENNGHIAKK | CC-BY-4.0 | 355424 | 219.8 | 4096 | 4 | 355k tris, 220MB GLB - heavy |
| 69 | buildings / colonial | [臺大醫院舊館 The Old Building of NTU Hospital](https://sketchfab.com/3d-models/the-old-building-of-ntu-hospital-84ec6f95ed14479cbed972f8708f8ee2) | areong | CC-BY-4.0 | 2273314 | 132.2 | 8192 | 5 | Taipei building, style close to Saigon French colonial; 2.2M tris |
| 70 | buildings / pagoda | [Chinese pagoda](https://sketchfab.com/3d-models/chinese-pagoda-9368be07f47949e2b6eaa962ea9c58ad) | SibeYu | CC-BY-4.0 | 541810 | 46.7 | 8192 | 4 | Chinese style scan; 542k tris |
| 71 | buildings / pagoda | [Chinese Pagoda in Taipei, Taiwan](https://sketchfab.com/3d-models/chinese-pagoda-in-taipei-taiwan-520c3273706d48a5af13e0133e4a3e5e) | dlfitch | CC-BY-4.0 | 2374645 | 86.7 | 2048 | 4 | 2.4M tris |
| 72 | buildings / apartment | [LOW POLY - ASIAN TOWER BLOCK](https://sketchfab.com/3d-models/low-poly-asian-tower-block-694adf5094fa41f99a245ed822293f47) | Colin.Greenall | CC-BY-4.0 | 3148 | 37.2 | 4096 | 4 | 3k tris, 4K textures |
| 73 | buildings / apartment | [LOW POLY - SOVIET  APARTMENT BUILDING 8K](https://sketchfab.com/3d-models/low-poly-soviet-apartment-building-8k-05229ac1d1f94e6c8cacaad91110c602) | Colin.Greenall | CC-BY-4.0 | 10392 | 165.9 | 8192 | 4 | 8K textures 166MB - downsize |
| 74 | buildings / apartment | [Old Residential Building [4k]](https://sketchfab.com/3d-models/old-residential-building-4k-dd400ed693cf416e940c5b8e3107205e) | Andrej Grave | CC-BY-4.0 | 276689 | 137.4 | 4096 | 4 | 277k tris 137MB |
| 75 | buildings / kiosk | [Simple 90's Kiosk](https://sketchfab.com/3d-models/simple-90-s-kiosk-a04e69a838054f7cb39a635943ab9b0d) | Vagabondare | CC-BY-4.0 | 1668 | 3.4 | 1024 | 3 | Light |
| 76 | buildings / bus stop | [Standard Bus Stop](https://sketchfab.com/3d-models/standard-bus-stop-32cc4c5f6aa147acabdb173e2d2373fa) | Pukka Films | CC-BY-4.0 | 11616 | 23.7 | 2048 | 4 | Close to HCMC shelters |
| 77 | buildings / bus stop | [Bus Stop](https://sketchfab.com/3d-models/bus-stop-367bdb5ca8c745978410c6e3ffd9b910) | bloooob | CC-BY-4.0 | 8254 | 69.2 | 4096 | 4 | 15 textures |
| 78 | buildings / pedestrian bridge | [Footbridge](https://sketchfab.com/3d-models/footbridge-c522e5e8badd475f9820d27f06d6153b) | finaltouch_1a | CC-BY-4.0 | 28348 | 1.4 | none | 3 | No textures |
| 79 | buildings / lamp post | [Modern Chinese Street Lamp](https://sketchfab.com/3d-models/modern-chinese-street-lamp-ce9d029fe1c14d01b9193b2c31f7c484) | Cyrus_JS | CC-BY-4.0 | 1866 | 2.9 | 1024 | 3 | 1.9k tris |
| 80 | buildings / road sign | [Chinese Road Signs (32 road signs and more)](https://sketchfab.com/3d-models/chinese-road-signs-32-road-signs-and-more-241ed4fd2fc145259ff9b51bd6f04877) | Yanis | CC-BY-4.0 | 217334 | 33.9 | 4096 | 4 | Chinese text on some - retexture to VN |
| 81 | buildings / traffic light | [Japanese Traffic Light](https://sketchfab.com/3d-models/japanese-traffic-light-3e35c76a6ee24d759e39edc2f90677e1) | AFX/CGMotion 3DModel Maker | CC-BY-4.0 | 8654 | 9.8 | 2048 | 4 | Japanese |
| 82 | nature / banana tree | [Banana tree](https://sketchfab.com/3d-models/banana-tree-3b658ecad29f4d9a9606dbf8fea7c9bb) | 1Quad | CC-BY-4.0 | 48232 | 7.4 | 4096 | 4 | 48k tris |
| 83 | nature / banana tree | [Dwarf Cavendish Banana (Polycam iPad Pro LIDAR)](https://sketchfab.com/3d-models/dwarf-cavendish-banana-polycam-ipad-pro-lidar-18925e7161164f6fa4398cc8ab1b716e) | JFN | CC-BY-4.0 | 51676 | 3.3 | 4096 | 4 | Includes grass patch |
| 84 | nature / banana tree | [Tropical Plants Pack M02P](https://sketchfab.com/3d-models/tropical-plants-pack-m02p-2f093afb792742438f0f7ba7eaab90f0) | MozzarellaARC | CC-BY-4.0 | 46575 | 27 | 2048 | 3 | Staff pick; semi-stylized |
| 85 | nature / coconut palm | [Coconut Palm](https://sketchfab.com/3d-models/coconut-palm-26e787f2ff2e4c0fb004c3b0210805a3) | evolveduk | CC-BY-4.0 | 7432 | 11.8 | 1024 | 4 | 7k tris |
| 86 | nature / coconut palm | [Coconut Tree](https://sketchfab.com/3d-models/coconut-tree-2f3162bb723c4fe49af74465eae1629d) | local.yany | CC-BY-4.0 | 20260 | 14.8 | 4096 | 4 | 20k tris |
| 87 | nature / coconut palm | [Palm Trees](https://sketchfab.com/3d-models/palm-trees-20f8a8d5054b4191afb7cf3270dbd586) | ElectroNick | CC-BY-4.0 | 24119 | 14.6 | 2048 | 4 | 24k tris |
| 88 | nature / areca/ornamental palm | [Realistic HD Butterfly palm (57/62)](https://sketchfab.com/3d-models/realistic-hd-butterfly-palm-57-62-bcc6fd7704e449f8b903b800196d655a) | PlantCatalog | CC-BY-4.0 | 99021 | 13.9 | 8192 | 4 | PlantCatalog vendor sample; 8K textures |
| 89 | nature / areca/ornamental palm | [Realistic HD Alexander palm (2/30)](https://sketchfab.com/3d-models/realistic-hd-alexander-palm-2-30-e38fa47bdc654accb3e205ed90eb719b) | PlantCatalog | CC-BY-4.0 | 71231 | 11.9 | 8192 | 4 | PlantCatalog; 8K textures |
| 90 | nature / bamboo | [Free Bamboo Set](https://sketchfab.com/3d-models/free-bamboo-set-e9f9fa5397814f81bf85ad06acf5bf30) | JonhGillessen | CC-BY-4.0 | 37834 | 26.8 | 4096 | 4 | 15 textures |
| 91 | nature / bamboo | [bamboo](https://sketchfab.com/3d-models/bamboo-a02bf0e3ffe44617ad49daf3cd94fe59) | evolveduk | CC-BY-4.0 | 2180 | 4.5 | 1024 | 4 | 2k tris |
| 92 | nature / flame tree | [Realistic HD Royal poinciana (26/40)](https://sketchfab.com/3d-models/realistic-hd-royal-poinciana-26-40-bced4895a46642c9a2279d195ceb7dec) | PlantCatalog | CC-BY-4.0 | 86465 | 15.1 | 4096 | 4 | PlantCatalog; pick larger variant for streets |
| 93 | nature / flame tree | [Realistic HD Royal poinciana (17/40)](https://sketchfab.com/3d-models/realistic-hd-royal-poinciana-17-40-066ca51810ad483aa34ef738c0b7ae6a) | PlantCatalog | CC-BY-4.0 | 323555 | 28.9 | 4096 | 4 | PlantCatalog vendor sample; 324k tris - LOD needed |
| 94 | nature / street tree (substitute) | [Chinese Banyan (Ficus Microcarpa)](https://sketchfab.com/3d-models/chinese-banyan-ficus-microcarpa-2a0dbcdf8f5d48f5ad79987c7a8170ce) | Valery.Li | CC-BY-4.0 | 111392 | 13.2 | 1024 | 4 | Substitute for bàng/me |
| 95 | nature / street tree (substitute) | [Realistic HD Frangipani tree (37/50)](https://sketchfab.com/3d-models/realistic-hd-frangipani-tree-37-50-ebf5a55ab24e4b9eb3156d37a2ec8aa1) | PlantCatalog | CC-BY-4.0 | 30639 | 9.1 | 2048 | 4 | PlantCatalog |
| 96 | nature / rice paddy | [CC0 イネ 稲 コメ 米 アジアイネ Rice, Oryza sativa](https://sketchfab.com/3d-models/cc0-rice-oryza-sativa-c6715ec94cee4abfb6edbfaaa4390bea) | ffish.asia / floraZia.com | CC0 | 95704 | 14.6 | 4096 | 4 | CC0; single stalk not a field; 96k tris |
| 97 | nature / water plant (substitute) | [CC0 ハス Indian Lotus, Nelumbo nucifera](https://sketchfab.com/3d-models/cc0-indian-lotus-nelumbo-nucifera-d69e1be5895f40e484f0db472a721c2f) | ffish.asia / floraZia.com | CC0 | 1495742 | 94.5 | 4096 | 4 | CC0; separate parts; 1.5M tris - heavy; no water hyacinth found |
| 98 | vehicles / car (static) | [Sedan car covered with a gray car cloth 3D scan](https://sketchfab.com/3d-models/sedan-car-covered-with-a-gray-car-cloth-3d-scan-5818270ead0649498ab6120604b19f7f) | Alben Tan | CC-BY-4.0 | 36313 | 6 | 4096 | 5 | Ideal for BR |
| 99 | vehicles / car (static) | [Car Covered With Gray Cloth 2](https://sketchfab.com/3d-models/car-covered-with-gray-cloth-2-a6663b2e7d264f6898738706901914cc) | Alben Tan | CC-BY-4.0 | 19383 | 5.1 | 4096 | 5 | Brand-free |
| 100 | vehicles / car (static) | [Honda City 2017](https://sketchfab.com/3d-models/honda-city-2017-75671276d4da476294202a5dc050a99e) | dewa | CC-BY-4.0 | 13886 | 1.9 | 1024 | 4 | Honda badges; no description/provenance note; 14k tris |
| 101 | vehicles / car (static) | [2014 Toyota Corolla E180 EU (with interior)](https://sketchfab.com/3d-models/2014-toyota-corolla-e180-eu-with-interior-36f95efb0585464cae43a25a3b3392e8) | Armored Wave | CC-BY-4.0 | 84408 | 78.6 | 4096 | 4 | Author-made, "free to use"; Toyota badges; 78MB |
| 102 | vehicles / car (static) | [Suzuki Carry Minivan](https://sketchfab.com/3d-models/suzuki-carry-minivan-5c0007c0c6ed4d298b8c80646efa09d2) | ProPolyModels | CC-BY-4.0 | 152924 | 6.9 | 2048 | 4 | Freebie from ProPolyModels; Suzuki badge |
| 103 | vehicles / car (static) | [Toyota Pickup truck](https://sketchfab.com/3d-models/toyota-pickup-truck-cad83751a295463bbb8b823c11a181ea) | alban | CC-BY-4.0 | 68877 | 8.1 | 4096 | 4 | Toyota badge |
| 104 | vehicles / car (static) | [Toyota Kijang Innova Zenix 2023 (highpoly)](https://sketchfab.com/3d-models/toyota-kijang-innova-zenix-2023-highpoly-c8e1bbc9292b4e198dba839c32f02fa9) | 3DShowroom | CC-BY-4.0 | 871781 | 31.3 | 2048 | 4 | 872k tris; badges |
| 105 | vehicles / car (static) | [Abandoned Generic Sedan 1 - Game Ready](https://sketchfab.com/3d-models/abandoned-generic-sedan-1-game-ready-6a2169dafc254f399387a679305bb1bf) | Rashad Ibrahimli | CC-BY-4.0 | 9597 | 11.6 | 2048 | 4 | Brand-free |
| 106 | vehicles / car (static) | [Generic passenger car pack](https://sketchfab.com/3d-models/generic-passenger-car-pack-20f9af9b8a404d5cb022ac6fe87f21f5) | Comrade1280 | CC-BY-4.0 | 69312 | 26.7 | 2048 | 3 | Brand-free, staff pick |
| 107 | vehicles / bus | [City Bus - rigged / РоАЗ-5236](https://sketchfab.com/3d-models/city-bus-rigged-5236-36646fcf41da498ca24a02f4b6fb1d95) | Yo.Ri | CC-BY-4.0 | 5564 | 3.9 | 1024 | 4 | 5.6k tris |
| 108 | vehicles / bus | [destroyed Bus 01](https://sketchfab.com/3d-models/destroyed-bus-01-fdf39ca893a64368af45f82a6b6d68a4) | o0ozexo0o | CC-BY-4.0 | 41134 | 80.2 | 2048 | 4 | BR wreck |
| 109 | vehicles / bus | [Generic Town Bus](https://sketchfab.com/3d-models/generic-town-bus-14fe03d792914d51b6c6250b393c44fd) | own.guest | CC-BY-4.0 | 55542 | 4 | 1024 | 3 | Phone-made, simple |
| 110 | vehicles / truck | [LCT 3000 '95 - Low poly model](https://sketchfab.com/3d-models/lct-3000-95-low-poly-model-663a0953c038434a918cb85725c88ffa) | Daniel Zhabotinsky | CC-BY-4.0 | 18947 | 11.5 | 2048 | 4 | Generic, explicit free use |
| 111 | vehicles / truck | [LCT 3000 '07- Low poly model](https://sketchfab.com/3d-models/lct-3000-07-low-poly-model-3be03b6a43aa41898c9ca806b8787052) | Daniel Zhabotinsky | CC-BY-4.0 | 15846 | 11.3 | 2048 | 4 | Same author |
| 112 | vehicles / truck | [Abandoned car / vehicle (Multicab) 3D Scan](https://sketchfab.com/3d-models/abandoned-car-vehicle-multicab-3d-scan-5ed2b4a8b5564c6d98efa76ce62df505) | Alben Tan | CC-BY-4.0 | 10097 | 8.8 | 4096 | 5 | Abandoned look |

## Rejected

Not downloaded or not used, with the reason. Notable only.

| Source | Item | License | Reason |
|---|---|---|---|
| 3dassets.dev | Scooter, motorbike, utility pole, shopfront, cars, minibus, bus shelter (CC0 as labeled) | CC0 (claimed) | Provenance unclear: bulk "kits" from the site's own account, creation method undisclosed, mostly untextured (realism 2). Owner decision if a stand-in scooter is wanted before the Sketchfab one |
| Poly Pizza / Kenney / Quaternius | Scooters, banana/coconut trees, lantern, bus, AC, bird cage | CC-BY 3.0 / CC0 | Low-poly (realism 1–2); fallback only |
| OpenGameArt | Brylie re-uploads (UAZ truck, PBR building) | CC-BY 4.0 (stated) | Copies of Sketchfab models; license must be checked at the source |
| Smithsonian | F1980.191 blue-and-white vase | CC0 | Accepted, not used yet: Draco-compressed GLB (no Draco decoder in the pipeline), 100k triangles |
| Sketchfab | [Toyota Fortuner 2021 (Asadawut.Kaewma)](https://sketchfab.com/3d-models/a70b997f11b7482e9affbf318a508f85) | CC Attribution | Description says "Model from Toyota India website" - extracted from OEM configurator; not author-made |
| Sketchfab | [Toyota Hilux Revo Prerunner 2021 (Asadawut.Kaewma)](https://sketchfab.com/3d-models/04ae6d8e07e84f55a9e1d7e3261be171) | CC Attribution | Same: "Model from Toyota India Website" - ripped OEM asset |
| Sketchfab | [BHP3D car catalog (e.g. 2022 Suzuki Ertiga, 2022 Toyota Hilux, Suzuki Ciaz)](https://sketchfab.com/3d-models/4f14afac3ac44ec4a2fb153e18452f8b) | CC Attribution | Uploader also posts BeamNG.drive cars ("Ibishu Covet", "Etk 800") - likely game/mod rips; avoid entire account |
| Sketchfab | [Tu Duc's Tomb - Stele Building (CyArk Dataset)](https://sketchfab.com/3d-models/b5d78ecd5e62483192d7ccd193bc063b) | CC Attribution | Re-upload of CyArk/Open Heritage 3D data, which is distributed CC BY-NC-SA; CC-BY label on Sketchfab likely wrong. Realism 5 Hue landmark - needs owner decision/original source check |
| Sketchfab | [arnedecoster Bangkok Cityscene props (Lowpoly Fruit Seller Set, Airco Set, Bangkok City Scene)](https://sketchfab.com/3d-models/3020e2e3f8b442c6b34cc93a1d8a51e3) | CC Attribution | Uploader also posts Alice: Madness Returns and Star Citizen game rips under CC-BY - provenance doubtful; also low realism |
| Sketchfab | [sohyalebret Vision GT / concept cars (Toyota FT-1, Mazda RX-Vision)](https://sketchfab.com/3d-models/e6b7292bcd974a2d929f2d06465e6cdb) | CC Attribution | Gran Turismo-style assets, likely game rips |
| Sketchfab | [Market stall / Sleeping Dogs Universe](https://sketchfab.com/3d-models/8c18d26983f2457b9377ebbe66a4c8aa) | CC Attribution | Named after commercial game (Sleeping Dogs) - possible rip |
| Sketchfab | [Call of Duty BO2 - Tranzit Bus](https://sketchfab.com/3d-models/d2cc17f8df9f4ab69ca96073a0eceeae) | CC Attribution | Commercial game rip |
| Sketchfab | [Taxi Cab - Left 4 Dead](https://sketchfab.com/3d-models/66bd2476a59346f6b367377b7e9eedab) | CC Attribution | Commercial game rip |
| Sketchfab | [Black Myth: Wukong statics (hakudragons)](https://sketchfab.com/3d-models/6216783d0d7440cb9b7fd8b6f5a069fe) | CC Attribution | Commercial game rip |
| Sketchfab | [Halo Reach civilian truck (42manako)](https://sketchfab.com/3d-models/396d832a8c8c4ad48a02d8d32ba0b468) | CC Attribution | Commercial game rip |
| Sketchfab | [Vietnamese streets (nguyennghiakk)](https://sketchfab.com/3d-models/e2ce91e4d7d349c7912a0ad065ceec56) | CC Attribution | Sketchfab file is a placeholder; real file on Google Drive (off-platform, unverifiable); scene shows communist flags/political banners |
| Sketchfab | [kryik1023 NC items (1978 Sedan, Old Truck, Old Car Wreck, Post-Apoc Civilian Cars)](https://sketchfab.com/3d-models/c2c00ad1e8ed4e67ba9dd3f719f0b4ca) | CC Attribution-NonCommercial | NonCommercial license |
| Sketchfab | [City hall of Puteaux (HoangHiepVu)](https://sketchfab.com/3d-models/a91d5b3db7334cac9c6448611decd5c3) | CC Attribution-NonCommercial | NonCommercial license |
| Sketchfab | [Road Signs (FrodoUndead)](https://sketchfab.com/3d-models/c39bf97110494b5db3de84165211f592) | CC Attribution | License fine but US MUTCD signs - wrong for Vietnam |
| Sketchfab | [hoclaixe / lambangnhanh / baoxinvieccom "xe máy" uploads](https://sketchfab.com/3d-models/2e47ec5ca78e48cfa56fcc2e7c8a117c) | CC Attribution | SEO spam uploads (driving-school ads), not real motorbike models |
| Sketchfab | [Toyota GR Supra / Supra (saitoyang, thelightning) ~1.44M tris](https://sketchfab.com/3d-models/b7616ec43ecf4ffd8ed810d94f15eea6) | CC Attribution | Identical 1,443,8xx tri counts from two uploaders - likely same ripped source; also not VN-relevant |
| Other | [Industrial objects pack v1.0 (AC blowers, antennas)](https://opengameart.org/content/industrial-objects-pack-v10) | CC-BY-SA 3.0 | Share-alike; needs owner decision (only OGA source with realistic AC/antenna units). |
| Other | [Dumpster (3 cubic yard capacity)](https://opengameart.org/content/dumpster-3-cubic-yard-capacity) | CC-BY-SA 3.0 | Share-alike; needs owner decision. Realism 3, Western dumpster. |
| Other | [Umbrella/Parasol](https://opengameart.org/content/umbrellaparasol) | CC-BY-SA 3.0 | Share-alike; needs owner decision. |
| Other | [Willow Basket with Handle](https://opengameart.org/content/willow-basket-with-handle) | CC-BY-SA 3.0 | Share-alike; needs owner decision. |
| Other | [Broken, rusty Volvo car](https://opengameart.org/content/broken-rusty-volvo-car) | CC-BY-SA 3.0 | Share-alike; post-apocalyptic, missing textures. |
| Other | [Broken car and broken truck](https://opengameart.org/content/broken-car-and-broken-truck) | CC-BY-SA 3.0 | Share-alike; snow-buried look. |
| Other | [pick-up Truck](https://opengameart.org/content/pick-up-truck) | CC-BY-SA 3.0 | Share-alike; very low detail. |
| Other | [Building with a shop](https://opengameart.org/content/building-with-a-shop) | CC-BY-SA 4.0/3.0, GPL 2.0/3.0 | Share-alike/GPL only; needs owner decision; European style. |
| Other | [5 palm shrub variations with 7 growth stages](https://opengameart.org/content/5-palm-shrub-variations-with-7-growth-stages-each-high-poly) | GPL 2.0 | GPL-only 3D model; needs owner decision; untextured .3ds. |
| Other | [Solar Panel](https://opengameart.org/content/solar-panel) | CC-BY 4.0 / GPL 3.0 | Not rejected on license (CC-BY 4.0 option OK) but it is a flat PV panel array, not a VN rooftop solar water heater; low priority. |
| Other | [Uaz truck / PBR Textured Building (brylie re-uploads)](https://opengameart.org/content/uaz-truck) | CC-BY 4.0 (as stated on OGA) | Re-uploads of Sketchfab models; licence must be verified on the Sketchfab source (covered by the Sketchfab team). Not Vietnamese. |
| Other | [Custom Harley Davidson FLH 1972](https://opengameart.org/content/custom-harley-davidson-flh-1972) | CC0 | License OK, realism 3, but 86 MB and a US cruiser; wrong style for Saigon traffic; brand trade dress. |
| Other | [Water Tank (zerberros)](https://opengameart.org/content/water-tank) | CC0 | License OK but untextured black tower tank, not a VN stainless rooftop tank. |
| Other | [Bicycle (Clint Bellanger)](https://opengameart.org/content/bicycle) | CC-BY 3.0 | License OK but toon-style kids BMX; realism 1. |
| Other | [Smithsonian: incense burner (xianglu record F1947.15a-b / boshanlu package ce850625)](https://asia.si.edu/object/F1947.15a-b/) | CC0 | License OK, photoreal, but a Han-dynasty tabletop boshanlu censer (not a VN pagoda bronze urn), and 3D file names do not match the record title; verify before use. |
| Other | [Smithsonian 3D search for vietnam/lantern/hat/bicycle/motorcycle/pagoda/altar](https://3d-api.si.edu/api/v1.0/content/file/search?q=vietnam) | CC0 | Only primate skulls and shells for "vietnam"; nothing relevant for other terms. |
| Other | [thanhmati/saigonrush (banana_tree.glb, coconut_tree.glb, motorbike.glb, bus.glb)](https://github.com/thanhmati/saigonrush) | none (no LICENSE file) | No license; asset provenance unknown. |
| Other | [Meshy.ai "CC0" scooter/Honda/bike galleries](https://www.meshy.ai/tags/scooter) | claimed CC0 | AI-generated models; download requires account; provenance of likenesses unclear. |
| Other | [CGTrader / TurboSquid / Free3D / 3dmodels.org free models (e.g. Honda Super Cub C125)](https://www.cgtrader.com/3d-models/vietnam) | Royalty-free store EULA | Not CC; login required; redistribution in extractable web builds unclear; brand-name vehicles. |
| Other | [Wikimedia Commons 3D (STL)](https://commons.wikimedia.org/wiki/Category:3D_models) | various | No relevant hits for vietnam/pagoda/lantern/scooter; untextured STL; search API throttled. |
| Other | [ambientCG 3D models (other 31)](https://ambientcg.com/list?type=3DModel) | CC0 | All bread/pastry/apple/pear/etc.; irrelevant to the map. |
| Other | [Poly Pizza "bamboo hat" (Republic Clone) / "hat" (Minh Nguyen Tri)](https://poly.pizza/m/9xm5jS34YV8) | CC-BY 3.0 | 22-tri flat cone / a bowler-style hat; unusable as non la. |
| Other | [Poly Pizza Pagoda / Torii / Shrine models](https://poly.pizza/m/eHOI2VgW1ol) | CC-BY 3.0 | Chinese/Japanese cartoon pagodas; wrong style and realism 1. |

## Gaps (nothing realistic with a usable license)

Honda Wave/Dream/Vision, Yamaha Sirius, PCX/NMAX; cyclo (xích lô) and xe ba gác; stainless rooftop water tank (bồn nước inox; build procedurally: a horizontal steel cylinder on a frame is ~300 triangles); Tết decorations; bàng and tamarind trees; water hyacinth; rice paddy (only a CC0 single rice stalk scan); Vietnamese road signs (build from textures: the sign faces are flat); Bến Thành-style market hall; Saigon-style church; bàn thờ ông địa (ngdkh's "Vietnamese altar" is low realism). Good Sketchfab authors to browse when logged in: ngdkh (Khoa Nguyen, ~40 Vietnamese props), hongan3dart, nguyennghiakk, albentan2012 (photoreal SE-Asian alley scans).

## Integration plan (for the map agent)

The generated `VN_PROP_MANIFEST` has the same measured fields as `PROP_MANIFEST_GENERATED` (`GeneratedPropAsset`) plus the hand-set `category`, `surface`, `castShadow`, `cullDistance`, `scaleRange`, `group` and `use`, so wiring is additive:

1. **Contract:** append the `VN_PROP_IDS` to `PROP_IDS` (or a second `PropLibrary` id space) and merge `VN_PROP_MANIFEST` into `PROP_MANIFEST` after the generated entries; `SPECS` placeholders come from the same hints. Mirror the collision into `packages/shared/src/map/layout/props.ts` (`getMapProp`) for the server: box and cylinder shapes as-is; `vn_road_divider` hull as a box `1.54 × 0.83 × 0.64`.
2. **Load per map:** only the real-world VN maps (`vn-hangxanh`, `vn-phandangluu`, `vn-camthanh`) load the `vn/` files; Map v1 doesn't. All 66 props are 16.5 MB, but a street set of ~25 props is ~7 MB.
3. **Placement rules** (seeded, per OSM way/building; everything thin-instanced per prop × LOD × world cell as `PropInstances` already does):

| Where | Props | Rule of thumb | Collision / gameplay |
|---|---|---|---|
| Tube-house ground floors (facing the street) | `vn_shutter_wide` (2.1 m), `vn_shutter_door` (1.08 m), `vn_shutter_window_a/b`, `vn_gate_iron` | One per frontage bay at the facade line; 60 % closed shutters, 25 % open shops (`vn_shelves_steel`, `vn_crate_plastic_b`, `vn_cardboard_box`, `vn_gas_cylinder`), 15 % gates | Shutters and gates are **walls, not doors**: box collision, bulletproof; don't put them where the prefab has an enterable door |
| Sidewalk in front of shops (1.5–3 m strip) | `vn_chair_plastic`, `vn_stool_*`, `vn_tea_table_low`, `vn_cafe_set`, `vn_potted_plant*`, `vn_pot_ceramic`, `vn_money_tree`, `vn_planter_*`, `vn_trash_can`, `vn_trashbag` | Clusters of 3–6 (table + stools) every 15–30 m; pots flanking doors | Seating: movement-only boxes (not bulletproof); pots: cylinder; bags/plants: none |
| Street edge (curb line) | `vn_power_pole*` every 30–40 m on one side, `vn_utility_box` near poles, `vn_street_lamp` in parks/alleys, `vn_fire_hydrant` at corners, `vn_manhole` on roads | Poles alternate `_transformer` / plain / `_fuse`; later add cable catenaries between pole tops (a thin-instanced tube strip, not a prop) | Pole: 0.12 m cylinder, bulletproof; hydrant/box: cylinder/box |
| Main-road medians (Điện Biên Phủ, Xô Viết Nghệ Tĩnh, Phan Đăng Lưu) | `vn_road_divider` chains (1.54 m pitch), `vn_tropical_shrub_*`, `vn_palm_coconut` | Divider every 1.55 m with gaps at U-turns; shrubs in planted medians | Divider: cover (0.83 m, crouch height) |
| Facades (upper floors) | `vn_ac_unit`, `vn_ac_unit_rusted`, `vn_wall_lamp`, `vn_security_camera` | 1–2 AC units per floor per bay, on the facade or balcony rail, yaw to face out | No collision for units above 2.5 m (skip Havok bodies), cull 150 m |
| Rooftops | `vn_water_barrel`, `vn_planter_box`, `vn_potted_plant`, `vn_ac_unit*` (+ Sketchfab solar heater, procedural bồn inox) | 1 tank or barrel per roof, 0–3 pots | Cylinder/box so rooftop fights have small cover |
| Markets (chợ) and alley stalls | `vn_crate_stack` (cover), `vn_crate_plastic_b`, `vn_basket_lidded`, `vn_bananas`, `vn_mango_pile`, `vn_water_jug`, `vn_hand_truck`, `vn_cement_bag`, `vn_jerrycan_plastic` (+ Sketchfab stalls, bánh mì cart, umbrellas) | Stalls along market building footprints and alley mouths; small goods sit on stall tops (tables), not the ground | Crate stack: box cover 0.75 m; small goods: none, cull 30–50 m, no shadows |
| Yards, alleys, parks, canals (Nhiêu Lộc) | `vn_palm_coconut*` along canals and villa gardens, `vn_bamboo_clump` at alley ends/temples, `vn_banana_plant`, `vn_monstera`, `vn_tropical_shrub_1..5` | Poisson scatter in green OSM areas (parks, gardens, `landuse=grass`), canal banks every 8–15 m | Palms: trunk cylinder (pair/trio use one approximate cylinder); plants: none (walk-through, visual cover only) |

4. **Instancing notes:** most props are one draw per level (one material); `vn_ac_unit*` 2, poles 2, potted plants 2–3, planters 3. Group by file so cells share textures. Palms and shrubs have impostor last levels (`billboard`: no shadows). For the hundreds of sidewalk props, cull at the given `cullDistance` and skip shadow casting beyond ~40 m.
5. **Colliders:** everything the player can stand behind (`vn_crate_stack`, `vn_road_divider`, `vn_gate_iron`, shutters, poles, `vn_utility_box`, `vn_trash_can`, `vn_water_barrel`, `vn_gas_cylinder`) should be bulletproof; stools, chairs, tables and café sets movement-only; plants, bags and small goods none.
6. **Credits:** already in `public/assets/environment/credits.json` (entries tagged `"set": "vn"`); remove an entry only if its prop is removed.
