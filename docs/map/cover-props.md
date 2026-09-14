# Cover props and big trees (placement proposal, Map v1)

User feedback: add big-trunk trees to hide behind, big rocks and realistic cover, all from real models. The models are processed into the prop library (`tools/environment`, `world/propAssets.ts`) and the gameplay catalog (`map/layout/props.ts`). **Nothing is placed yet**: the Map v1 layout checksum is unchanged (`22ab0987`). The lead runs placement after the bots team finishes navigation on the current layout.

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
