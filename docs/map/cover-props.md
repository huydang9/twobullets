# Cover props and big trees (Map v1)

User feedback: add big-trunk trees to hide behind, big rocks and realistic cover, all from real models. The models are processed into the prop library (`tools/environment`, `world/propAssets.ts`) and the gameplay catalog (`map/layout/props.ts`).

**Placed** on Map v1 (layout `88a2a717`, was `22ab0987`): 432 new instances. See [What was placed](#what-was-placed) at the end; the sections before it are the original proposal.

**Preview:** `http://localhost:5173/props.html` (DEV only; Vite doesn't build it). It shows every new prop on flat ground in three rows (LOD0, LOD1, LOD2), with catalog colliders as static bodies (K shows them as wireframes) and 1.8 m and 1.1 m player markers (M). F toggles walk and fly, `[` and `]` select a prop, T goes to it.

## The props

| Id | Source (license) | Size (m, W × D × H) | Tris per LOD (switch m) | Textures | Catalog collider |
|---|---|---|---|---|---|
| `tree_oak_large` | Oak tree, massive-graphisme (CC BY) | 13.5 × 13.8 × 12 | 7,112 / 1,517 (45) / 156 trunk + impostor (150) | bark 1K, source leaf cards 1K, atlas 2K (shared) | cylinder r 0.62, h 3.5 |
| `tree_oak_fungi` | Large oak with parasitic fungi, ZiemniaQ; crown from the oak above (CC BY) | 8 × 8.1 × 11.5 | 14,860 / 3,239 (45) / 206 (150) | scan bark 2K + normal 1K | cylinder r 0.36, h 5.8 |
| `rock_face_large` | Poly Haven `rock_face_02` ×1.6 (CC0) | 4.3 × 3.4 × 4.0 | 11,998 / 2,997 (40) / 599 (130) | 2K color, 1K normal | box 3.8 × 2.6 × 3.2 |
| `rock_boulder_large` | Poly Haven `namaqualand_boulder_04` (CC0) | 2.5 × 2.5 × 1.9 | 8,000 / 2,000 (40) / 400 (130) | 1K | box 2.1 × 2.1 × 1.75 |
| `stump_boubin` | Boubín Stump, 3dhdscan (CC BY) | 3.9 × 3.8 × 1.6 (incl. roots and ground) | 7,992 / 1,997 (35) / 476 (110) | 1K | cylinder r 0.95, h 1.05 |
| `log_mossy` | Mossy old tree log, Julian Malik (CC BY) ×2.3 | 3.0 × 0.95 × 1.0 | 8,000 / 2,000 (35) / 478 (110) | 1K, normal 512 | box 2.7 × 0.7 × 0.8 |
| `car_wreck` | Destroyed Car 03, Renafox (CC BY) | 2.7 × 5.2 × 1.6 | 7,998 / 1,958 (50) / 464 (110) | 1K | box 1.9 × 5 × 1.3 |
| `pipe_stack` | Concrete Pipes_12_MB, Mehdi Shahsavan (CC BY) | 5.0 × 2.1 × 2.0 | 8,000 / 1,999 (35) / 480 (110) | 1K, normal 512 | box 5 × 1.9 × 1.37 |
| `sandbag_barrier` | Sandbag Barrier, G4AGamingLabs (CC BY) | 4.6 × 0.74 × 1.0 | 7,999 / 1,997 (35) / 478 (110) | 1K, normal 512 | box 4.5 × 0.7 × 1.0 |
| `hay_bale_wall` | Hay bales, Zbrojmistrz (CC BY): 9 small bales | 2.9 × 0.47 × 1.16 | 8,000 / 2,000 (30) / 480 (100) | 1K cutout (shared) | box 2.9 × 0.47 × 1.16 |
| `hay_bale_stack` | same file: 6 bales, middle layer crosswise | 0.94 × 0.94 × 1.16 | 8,000 / 2,000 (30) / 480 (100) | shared | box 0.94 × 0.94 × 1.16 |
| `cable_spool` | Cable Spool, wolfgar74 (CC BY), scaled to a 1.4 m drum | 1.4 × 1.4 × 1.4 | 1,664 / 498 (25) / 198 (90) | 1K, normal 512 | cylinder r 0.7, h 1.4 |

- Every catalog entry has `cover: true`. Each collider also blocks and is taller than 0.5 m, so the client's `isCover` already keeps them drawn map-wide at their last level.
- **Payload:** 13.7 MB in 10 GLBs (the oak file is 3.5 MB). Credits are in `public/assets/environment/credits.json`.
- **Scale range for scatters:** trees 0.85–1.15; rocks 0.7–1.4 (the boulder reads well up to 1.6); cover props 1.0.

**Known limits:**
- `rock_face_02` is an open scanned surface with no back. Place it with its back into a slope of 25° or more, or against a cliff, facing downhill. Don't place it free-standing.
- The concrete-pipes model is a stack of 22 pipes 0.3 m wide, not a culvert. It is solid cover; you can't walk through it, so it has no half-shell colliders. A walk-through pipe needs a different model.
- `tree_oak_fungi` is a composite. You can see the joint at about 5.6 m where the scan trunk meets the oak limbs, and both barks are tinted to the same mean color.
- The impostor level of both oaks keeps a real trunk mesh. `PropVisuals.impostorPlanes` then returns null (the level isn't only quads), so these impostors don't turn toward the camera. Three planes 60° apart never all go edge-on.
- The hay props are small square bales (0.93 × 0.39 × 0.47 m, real size) stacked to crouch height. They differ from the round-bale `hay_bale` stand-in.

## Placement per POI

Existing stand-ins with a real model now: `sandbags` → `sandbag_barrier` (4.5 m instead of 2.4 m, so one replaces about two), and `hay_bale` / `hay_stack` → `hay_bale_stack` / `hay_bale_wall`. Swapping ids changes the layout checksum and the nav grid, so do it in the placement pass.

| POI | Trees | Rocks | Cover props | Count |
|---|---|---|---|---|
| Central Town (0, 20) | 3 `tree_oak_large` in back gardens and the square corner, ≥ 25 m apart | – | 5 `car_wreck` on the streets (angled across a lane, ≥ 30 m apart); checkpoint: 4 `sandbag_barrier` + 2 `cable_spool` + 1 `pipe_stack` | 15 |
| Farm (300, 290) | 4 `tree_oak_large` around the yard and field edges, 1 in the paddock | – | Meadow: 8 `hay_bale_wall` in broken rows 12–18 m apart; yard: 10 `hay_bale_stack` in groups of 2–3; 1 `car_wreck` by the barn | 24 |
| Military Compound (320, −270) | – | – | 12 `sandbag_barrier` (gate, container-yard lanes, tower bases, the south breach), 4 `cable_spool`, 2 `pipe_stack` along the inner wall | 18 |
| Radar Hill (−300, 255) | 4 `tree_oak_fungi` on the lee slope | 8 `rock_boulder_large` on the crest approaches, 6 `rock_face_large` on the steep north flank | 4 `sandbag_barrier` at the pad edge facing the switchbacks | 22 |
| Quarry (−60, −340) | – | 14 `rock_face_large` against the terrace walls, one per 20–25 m of wall; 10 `rock_boulder_large` on the floor and ramps | 3 `pipe_stack` and 4 `cable_spool` by the warehouse; 2 `car_wreck` on the ramps | 33 |
| Forest Cabins (−340, −120) | 10 `tree_oak_fungi` ringing the clearing edge | – | 6 `stump_boubin` and 6 `log_mossy` inside the clearing, 8–12 m from the cabins | 22 |
| Training Yard (340, 10) | – | – | none (arena stays as is) | 0 |

## Open ground between POIs

**Rule of thumb:** any straight crossing between two POIs should pass within 25 m of hard cover at least every 40–60 m. A few meadows stay riskier, as they are today.

| Where | What | Count, spacing |
|---|---|---|
| Western forest (`forest_west`) | `tree_oak_fungi` mixed into the fir forest (replace about 1 in 20 `tree_fir_a`); `stump_boubin` and `log_mossy` on the floor | 30 oaks ≥ 12 m apart; 19 stumps and 20 logs ≥ 15 m apart |
| Ridge and east woods | `tree_oak_fungi` at the wood edges | 16, ≥ 15 m apart |
| River valley (`valley_trees`) | `tree_oak_large` as solitary oaks in the grass | 12, ≥ 30 m apart |
| Open fields (`field_cover`) | Add `rock_boulder_large` (weight 3), `log_mossy` (2) and `hay_bale_stack` (1, only near the farm and town) to the cluster palette; a cluster anchor is one large piece plus existing small rocks and bushes | about 60 boulders, 14 logs, 8 stacks; clusters stay about 50 m apart |
| `slope_rocks` (slopes 18–35°) | `rock_boulder_large` scaled 0.9–1.6; `rock_face_large` only on slopes ≥ 25°, yaw facing downhill | 25 boulders, 10 faces |
| Road shoulders | `car_wreck` on the highway and farm-road shoulders, with the south-highway roadblock getting 2 wrecks + 4 `sandbag_barrier` | 6 wrecks ≥ 80 m apart |

**Total: about 360 new instances** (POIs plus open ground):

| Prop | Count | Prop | Count |
|---|---|---|---|
| `rock_boulder_large` | 103 | `sandbag_barrier` | 24 |
| `tree_oak_fungi` | 60 | `tree_oak_large` | 20 |
| `log_mossy` | 40 | `hay_bale_stack` | 18 |
| `rock_face_large` | 30 | `car_wreck` | 16 |
| `stump_boubin` | 25 | `cable_spool` | 10 |
| `hay_bale_wall` | 8 | `pipe_stack` | 6 |

**Clearances:**
- Footprints in `props.ts` keep instances off roads and pads as the scatter does today.
- Keep new collidable props ≥ 2 m from spawns and from building doors.
- Keep ≥ 1.5 m between a sandbag or hay wall and a building wall or fence, so neither players nor the nav grid get pinched corridors.

## Budget estimate

**Triangles.**
- **Worst case, every instance at its last level:** about 140k triangles map-wide. Boulders are 41k, logs 19k and rock faces 18k of that. Cover never culls, so this adds to the existing ≈ 290k worst case; about a third is in the frustum.
- **Typical in-view, standing at a POI edge:**

  | Band | Instances | Triangles |
  |---|---|---|
  | LOD0 (< 35–50 m) | ~10 × ~8k | ~80k |
  | LOD1 (to 110–150 m) | ~30 × ~2k | ~60k |
  | Far levels | ~120 × ~0.4k | ~50k |
  | **Total** | | **≈ 190k** |

  The military compound (12 sandbags close together) is the heaviest spot. If `?bench=v1` shows vertex cost, first pull the sandbag and hay LOD0 switch in from 35/30 m to 20 m; that's a manifest distance change only.

**Draw calls.**
- **Batching:** batches are per prop × 250 m cell × level × shadow bucket, times materials. Materials per level:
  - one for most props;
  - `tree_oak_large`: 2 at every level;
  - `tree_oak_fungi`: 3 at LOD0 and LOD1, 2 at the impostor.
- **Estimate:** about 12 new prop types × 2–3 visible cells × about 2 active buckets gives **+60 to +90 main-pass draw calls**, plus about 15–25 in the shadow pass (50 m band for props, 70 m for trees).
- **Keeping it down:**
  - Keep each POI to the 3–5 prop types in the table above.
  - Keep hay props near the farm and town and pipes and spools in the quarry, town and compound, so most cells have only 2–4 new types.

**Memory.**
- 13.7 MB download.
- GPU textures: about 3 × 2K + 25 × 1K/512 maps, roughly 40 MB transcoded with mips.

## Before placing (for the lead)

- **Bots:** `buildNavGrid` reads the catalog colliders, so placement changes the nav grid. Rebuild nav after the pass.
- **Cover flag:** `isCover` (`world/props/PropInstances.ts`) could also honor `def.cover`. It makes no difference for these props; it would only matter for a future low cover prop.
- **Rock faces:** the scatter needs a per-rule "yaw faces downhill" option for `rock_face_large`. Until then, place them explicitly (quarry walls, radar flank).
- **Build:** run `node --experimental-transform-types tools/map/build.ts`, then update the checksums and the counts in `layout.md`.

## What was placed

432 instances (proposal: about 360): 132 explicit placements in `mapV1.ts` and 300 from scatter rules. The terrain bake is unchanged (`5e374718-c9aae53e`); nothing was flattened.

**Per POI** (instances within the POI radius + 15 m, scatter included):

| POI | Placed |
|---|---|
| Central Town | 3 `tree_oak_large` (two back gardens, off the square's SW corner); 5 `car_wreck` on the street edges, off the carriageway; checkpoint of 4 `sandbag_barrier` (one replaces `sandbags`), 2 `cable_spool`, 1 `pipe_stack`; `hay_bale` → `hay_bale_stack` |
| Farm | 5 `tree_oak_large` (1 in the paddock); 8 `hay_bale_wall` in three broken N–S rows 16 m apart (replace the 12 round bales); 10 `hay_bale_stack` in 4 yard groups (replace `hay_stack` ×2 and `hay_bale`); 1 `car_wreck` west of the barn |
| Military Compound | 12 `sandbag_barrier` (replace the 4 `sandbags`): gate, tower bases, container-yard lane ends, courtyard, both sides of the south breach; 4 `cable_spool`; 2 `pipe_stack` along the south and east walls. The `utility_box` moved out of the gate |
| Radar Hill | 4 `tree_oak_fungi` below the pad; 8 `rock_boulder_large` on the crest approaches; 6 `rock_face_large` on the north flank (`radar_faces`); 4 `sandbag_barrier` on the pad edge above the switchbacks (replace `sandbags` ×2) |
| Quarry | 14 `rock_face_large` against the three terrace walls (`quarry_faces`); 10 `rock_boulder_large` on the floor and beside the ramps; 3 `pipe_stack` + 4 `cable_spool` round the warehouse; 2 `car_wreck` at the ramp feet |
| Forest Cabins | 10 `tree_oak_fungi` ringing the clearing; 6 `stump_boubin` + 6 `log_mossy` between and behind the cabins; `hay_bale` → `hay_bale_stack` |
| Training Yard | none (2 gap-filler boulders outside the pad) |

**Open ground:**

| Rule or placement | Placed |
|---|---|
| `forest_west_oaks` (≥ 12 m apart, forest mask), `forest_west_floor` (≥ 15 m) | 31 oaks; 18 stumps + 23 logs |
| `ridge_edge_oaks`, `east_edge_oaks` (within 25 m of the wood outline, ≥ 30 m apart) | 10 + 12 |
| `valley_oaks` (≥ 30 m apart) | 12 `tree_oak_large` |
| `field_cover` anchors (one cluster in ten) | 19 boulders, 11 logs |
| `field_hay_farm`, `field_hay_town` (≥ 60 m apart) | 6 + 5 stacks |
| `slope_boulders` (18–35°, ≥ 25 m) / `slope_faces` (25–45°, ≥ 40 m, not on Radar Hill) | 17 / 6 |
| `cover_fill`: a boulder wherever there is no hard cover within 25 m (outside the dense woods) | 110 |
| Road shoulders (`shoulder()` in `mapV1.ts`) | 6 wrecks ≥ 80 m apart (east highway, south highway, farm road, west road) |
| South-highway roadblock | 4 `sandbag_barrier` on the shoulders + 2 angled wrecks (replace `sandbags`) |
| Hay north of town | the 4 `hay_bale` → `hay_bale_wall` |

**Totals:** `rock_boulder_large` 164, `tree_oak_fungi` 67, `log_mossy` 40, `rock_face_large` 26, `stump_boubin` 24, `sandbag_barrier` 24, `hay_bale_stack` 23, `tree_oak_large` 20, `car_wreck` 16, `hay_bale_wall` 12, `cable_spool` 10, `pipe_stack` 6. No `sandbags`, `hay_bale` or `hay_stack` stand-ins are left on Map v1.

**Why more boulders than proposed.** The proposal's field anchors land where clusters already give cover. `cover_fill` places boulders only in the gaps instead. Measured on straight lines between every pair of POIs (hard cover = trunks ≥ 0.2 m radius, bulletproof boxes ≥ 0.9 m tall and wide, buildings, within 25 m):
- longest stretch without cover: 216 m before, 58 m after (7 crossings still have a 44–58 m stretch, all along roads);
- open ground with no hard cover within 25 m: 36.8 % before, 9.9 % after (10 m sample grid, slopes under 35°).

**Scatter options added** (`ScatterRule`, all optional): `spots` (hand-picked candidates), `faceDownhill` (front down the fall line, seated half a footprint downhill so the back sinks into the slope), `minDistance`, `bareRadius` (with `isHardCover`), `edgeBand`, and `cluster.anchor`. Every collidable scatter instance also keeps 1.5 m (beyond its collider) from building entrances, and cluster members now honour `exclude`.

**Clearances, validated** (`validateMapLayout`, asserted in `layout/mapV1.test.ts`):
- `prop-at-entrance`: no collidable prop within 1.5 m of an entrance;
- `prop-in-opening`: no collidable prop within half the gap width + 1.5 m of the 17 fence gates and wall breaches (`MAP_V1_OPENINGS`); every non-detail scatter rule also excludes the gaps widened by 3 m.

**Rock faces:** all 26 sit on slopes of 27–64° facing downhill; the ground 1.7 m in front is 0–0.4 m above their base, and their backs are buried 1.9–3.1 m (hills) or 4.4–6.9 m (quarry walls). Check the look in the browser.

### Budget, measured

Triangle counts use the LOD table above; frustum is a 100° cone from the viewpoint.

| | Proposal | Placed |
|---|---|---|
| Worst case, all at the last level | ≈ 140k | **169k** (boulders 66k, logs 19k, oaks 17k, faces 16k) |
| Standing in a POI (town cross street, compound) | ≈ 190k | 70–77k (2–3 at LOD0, 7–9 at LOD1, ~100 far) |
| Radar pad / forest clearing (long views over the map) | – | 114k / 143k |
| Main-pass batches in view (before shadow buckets) | +60 to +90 | 40–46 in POIs, 73–76 at the radar pad and forest clearing |
| Distinct prop × 250 m cell pairs, map-wide | – | 80 |

Cover never culls, so most of the cost is the far level of the 164 boulders (400 triangles each). If `?bench=v1` shows it, the cheapest lever is a lighter last level for `rock_boulder_large` (manifest only), then a lower `cover_fill` density.

### Bots

- The nav grid rebuilds from the catalog colliders: checksum `34f6ddee` (was `fe5a4958`); 45 components (46 before), same 245 cleared islands.
- Everything stays reachable from the town square: 7/7 POIs, 14/14 spawns, 66/66 entrances, 86/86 ground rooms, 31/31 upper rooms (the radar roof is fixed, see below), 1,024/1,024 loot spots.

### Radar station roof

The exterior stair's first tread was 0.30 m above the stair pad, but the pad ended where the tread began. Snapped floors sit 0.1 m above the ground, so stepping on from the terrain was 0.40 m, over the 0.35 m limit. The stair pad (`radarStation`, `prefabs/industrial.ts`) now runs 0.6 m past the first tread: terrain → pad 0.1 m → tread 0.3 m. The base footprint and the building height don't change, and neither does the terrain.
