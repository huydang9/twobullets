# Map v1 terrain

Map v1 terrain covers 1280 × 1280 m: a 1 km playable square plus a 140 m out-of-bounds mountain border. The same data builds the ground everywhere:

- **Client:** renders it and runs player physics on it.
- **Server:** builds it headless (Node, Havok, no rendering) from the same `MapData`.

| Part | Where | Depends on |
|---|---|---|
| MapData contract | `packages/shared/src/map/types.ts` | nothing |
| Generation, flattening, surface mask, queries | `packages/shared/src/map/terrain/` | nothing (pure, deterministic, **no Babylon**) |
| Havok heightfield body | `packages/shared/src/map/physics/` | Babylon deep imports + Havok, no rendering |
| Draft map used by the dev mode | `packages/shared/src/map/draftMapV1.ts` | the above |
| Chunked LOD meshes, splat material, horizon | `apps/client/src/world/terrain/` | Babylon |

## Try it

Open `http://localhost:5173/?map=v1` (DEV builds only; without the query you get the arena as before).

- You spawn just south-west of the future town, facing the **Training Yard**: the arena on a dirt pad about 120 m away (south-west), with a gate cut into its north wall. An asphalt road leads to the gate, and the soldier range works inside.
- **Landmarks:**
  - radar ridge: north-west;
  - quarry pit with a dirt ramp down: south (-60, -330);
  - shallow valley: north-south, east of the center;
  - mountains: all around the edge, fading into haze.
- **What to check:**
  - distant hills pop when LOD switches (threshold 3 px);
  - no cracks between chunks;
  - how rock, dirt and road transitions look;
  - tiling at mid-range;
  - shadows from the arena onto the terrain;
  - fog on the horizon.
- The console prints build timings and the terrain checksum. `window.__twobullets.world` exposes `terrain`, `renderer` (`renderer.getStats()`) and `level`.

## MapData contract

`MapData` is plain, serializable data. Conventions: meters, Y up, +X east, +Z north, yaw 0 faces +Z and π/2 faces +X, map centered on the origin, absolute heights.

| Field | Meaning |
|---|---|
| `terrain: TerrainSpec` | `seed`, `size`, `resolution`, `playableHalfExtent`, `relief` (noise layers), `border` (mountain ring), `features` (hill / ridge / valley / basin) |
| `flatten: FlattenRegion[]` | POI pads and roads, applied in order after generation |
| `bounds: MapBounds` | out-of-bounds grace time, `killY`, `landingAltitude`. The playable square is `terrain.playableHalfExtent` (single source) |
| `pois: PointOfInterest[]` | `id`, `name`, `kind`, `center`, `radius`, `lootTier` |
| `buildings: MapBuilding[]` | a `BuildingPlacement` from the buildings kit plus `id`, `prefab`, `snapToTerrain?`, `poi?` |
| `props: PropPlacement[]` | single props: `prop`, `position`, `yaw`, `scale?`, `alignToTerrain?`, `snapToTerrain?` |
| `scatters: PropScatter[]` | seeded fill rules: polygon `area`, `density` per 100 m², `maxSlopeDegrees`, `excludeSurfaces`, `scaleRange` |
| `spawns: MapSpawn[]` | fixed `[x, z]` + yaw, used until the landing phase exists (Y comes from the terrain) |

Placing a building: flatten its footprint with a `rect` region (a few meters of `falloff`, `heightOffset` about -0.2 so the terrain hides under the floor slab), then place the prefab at that height. The Training Yard in `draftMapV1.ts` is a worked example.

## Terrain parameters (`TERRAIN_V1`)

| Parameter | Value | Why |
|---|---|---|
| Size | 1280 m, centered | 1000 m playable + 140 m border each side |
| Resolution | 1025 × 1025 samples (2^10 + 1) | chunks and a 2× physics downsample line up exactly |
| Spacing | 1.25 m | see below |
| Heights | `Float32Array`, 4.2 MB | row-major `heights[iz * 1025 + ix]`; can view a `SharedArrayBuffer` (`Heightfield.fromBuffer`) |
| Surface mask | `Uint8Array` RGBA = grass, dirt, rock, road, 4.2 MB | each sample sums to 255 |
| Height range | playable ≈ 0.5–67 m (quarry floor to radar ridge), border up to ≈ 150 m | |
| Slopes (playable) | 96.3% of cells < 25°, 99.4% < 50° | steeper cells are quarry walls and foothills at the edge |
| Slopes (border) | 17% of cells > 50° | |

**Why 1.25 m spacing.**

- **Texture detail:** the splat textures carry the sub-meter detail (forest ground is 1024 px/m, asphalt 340 px/m). Mesh vertices only need to resolve landforms. At 1.25 m, features down to about 2.5 m survive: ditches, road shoulders, flatten falloffs of 4 m or more, 3 m terrace walls.
- **Surface mask:** one mask texel per sample gives 1.25 m layer edges. The shader breaks them up with height-based blending.
- **Physics:** Havok ray cost barely depends on resolution (measured 1.5–3 µs). Creating the 1025² shape took 12 ms, versus 10 ms at 513².
- **Memory:** the JS copy is 4.2 MB. The server can pass `{ stride: 2 }` to `createTerrainBody` for a 513² collision surface (a quarter of the Havok memory), at the cost of up to a few cm of mismatch with the rendered surface on curved ground.

Generation is deterministic: integer-hash gradient noise, polynomial `sinCos`, and no `Math.random`, `sin`, `exp`, `pow`, `hypot` or `**`. `determinism.test.ts` enforces this over the folder's source. A golden checksum test catches accidental changes; bump `TerrainSpec.version` when generation changes on purpose. `terrain.checksum()` hashes heights and mask, so client and server can compare.

Build time on an M-series Mac in Node: heights ≈ 0.69 s, flatten 0.02 s, mask 0.27 s (≈ 1 s total). In the browser it's similar on the main thread at load; see Risks.

## API (pure, `@twobullets/shared`)

```ts
const terrain = buildTerrain(map.terrain, map.flatten, { heightBuffer?: SharedArrayBuffer });
terrain.sampleHeight(x, z);          // exactly what a Havok ray hits (same triangle split)
terrain.sampleNormal(x, z, out);     // smooth normal (central differences, bilinear)
terrain.slopeTanAt(x, z);            // rise/run; use for simulation thresholds
terrain.slopeAt(x, z);               // degrees, tooling/UI only (uses Math.atan)
terrain.surfaceAt(x, z);             // "grass" | "dirt" | "rock" | "road" (footsteps, impacts)
terrain.surfaceWeightsAt(x, z, out); // bilinear weights 0..1
terrain.isPlayable(x, z);
terrain.flatten(regions);            // more regions later (full mask rebuild; rebuild meshes/body yourself)
terrain.checksum();
terrain.relief(x, z);                // unflattened height function, valid beyond the grid
```

Lower level: `generateHeightfield`, `flattenHeightfield(field, regions, paint?)`, `computeSurfaceMask`, `Heightfield`, `SurfaceMask`, and the seeded noise `hash2 / fbm / ridged / gradientNoise / subSeed` (for scatter placement).

### Flatten regions

Every region has these fields:

- `height`: a number or `"auto"`.
- `falloff`: blend width outside the shape, m.
- `mode`: `set` (cut and fill), `cut` (only lowers) or `fill` (only raises).
- `surface` and `surfaceFalloff`: surface to paint and its soft edge.
- `heightOffset`.

| Shape | Fields | `"auto"` height |
|---|---|---|
| `circle` | `center`, `radius` | mean terrain height inside the shape |
| `rect` | `center`, `halfExtents`, `yaw?` | mean terrain height inside the shape |
| `polyline` | `points: [x, z]` or `[x, z, y]`, `width`, `profile?` | `follow` (default): terrain height along the path, smoothed over about 40 m. `linear`: straight grade between points (a point without y takes the terrain height there) |

Regions apply in array order and later ones win, both for height and paint. Put POI pads first, then roads.

## Physics

`createTerrainBody(scene, terrain.field, { stride?, friction?, membershipMask?, shape? })` creates a static `PhysicsShapeHeightField` body. Pass `shape` to share one heightfield between bodies in the same Havok instance.

Babylon's Havok plugin reads `data[(n-1-a)*n + b]` as world (x = -size/2 + b·step, z = -size/2 + a·step), centered on the body, and splits each cell along the (ix+1, iz)–(ix, iz+1) diagonal. Both facts were verified with raycasts. `heightfieldToHavokOrder` does the row flip, and `Heightfield.sampleHeight` and the render meshes use the same diagonal.

Headless validation (NullEngine + Havok, the real `CharacterBody`, 60 Hz):

| Check | Result |
|---|---|
| 20 000 vertical rays over the whole map | 0 misses, max \|hit.y − sampleHeight\| = 0.23 mm (float32) |
| 20 000 bullet-like rays (eye height, 0.5–15° down, 300 m) | 19 817 Havok hits = 19 817 reference-march hits, max hit-height error 0.37 mm |
| Planar slopes, walking uphill 3 s along +X and along the grid diagonal | 15–49°: 19.1–19.25 m walked, 99–100% grounded, 0.00 m drift when idle. 52° and 60°: slides down 13–25 m while pushing uphill, 86–94 m when idle |
| Grid-edge snagging: sprint along grid lines, diagonals and 26.6° over rolling ground with 3 cm ridges on every other grid line | speed 9.42–9.50 m/s (target 9.5), max feet-to-ground gap 3.5 mm |
| 24 walkers sprinting 20 s each with random turns on V1 | 98.8% grounded, 0 ticks below ground, 0 unexplained slowdowns (13 stops were at walls > 48°), 31 µs per tick |
| Quarry | sprinting into a terrace wall from the floor stops at its foot; the dirt ramp climbs from the floor to the rim |
| Training Yard | spawn settles at exactly the terrain height; walking in through the north gate works (0.2 m lip); range rays reach all 10 soldiers without touching the terrain |

On slopes the capsule's rounded bottom rests r·(1/cos θ − 1) above the ground under its axis: 3.6 cm at 25°, 14.5 cm at 45°. The arena ramps behave the same way.

## Rendering

**Chunks.** 8 × 8 chunks of 128 cells (160 m). Each chunk is one mesh and one draw call, with a shared vertex buffer (position + normal, 17 157 vertices) and one index range per LOD. LOD n steps 2^n samples, so the levels are 1.25 / 2.5 / 5 / 10 / 20 m.

| LOD | Triangles per chunk (incl. skirts) |
|---|---|
| 0 | 34 816 |
| 1 | 9 216 |
| 2 | 2 560 |
| 3 | 768 |
| 4 | 256 |

- **LOD choice.** Each frame, just before active-mesh evaluation, every chunk picks the coarsest LOD whose precomputed max height error projects under 3 px. The projection uses viewport height and the camera's current FOV, so the scope zoom refines automatically. Switching swaps `mesh.subMeshes`, with no buffer uploads.
- **Cracks.** Skirts hang 2–17 m below chunk edges, with both windings.
- **Culling and matrices.** World matrices are frozen and culling is standard box culling.
- **Shadows.** Terrain receives shadows but doesn't cast them. The sun is 48° up, so hills rarely shadow anything, and casting would put 64 large meshes into every cascade.
- **Horizon.** One mesh of 6 144 vertices and 11 264 triangles: square rings out to 2.8 km whose heights continue the border ridges and sink toward the far edge, where fog takes over. Its inner ring reuses the heightfield edge samples.

**Budget.** Measured headless (NullEngine, `TerrainRenderer.getStats()`, horizontal FOV 90°, 8 headings per spot):

| Viewpoint | 2560×1440: chunks / triangles (max) | 1920×1080: max triangles |
|---|---|---|
| Spawn, eye height | 28 / 362k | 265k |
| Training Yard gate | 31 / 390k | 253k |
| Radar ridge top | 37 / 327k | 291k |
| Quarry floor | 40 / 390k | 281k |
| East playable edge | 52 / 442k | 306k |
| Gliding 300 m above center | 27 / 278k | 178k |

- **Draw calls.** Terrain costs at most 52 chunks + 1 horizon draws, plus 0 in shadow passes.
- **GPU memory.** Buffers take 44.6 MB (26 MB vertices, 18 MB indices). The mask texture takes 5.6 MB with mips.
- **Pixel-error tradeoff.** At 1.5 px, triangles rise to 540–760k; at 6 px they fall to 165–260k.
- **CPU per frame.** The LOD pass is 64 box-distance checks (well under 0.1 ms).
- **GPU cost.** Without a GPU, frame time can't be measured here. The fragment shader dominates: about 11 texture fetches per pixel on grass, and up to 20 where rock (triplanar) and road overlap. 144 Hz (6.9 ms) needs a real profile at 1440p; see Risks.

**Material** (`TerrainMaterial.ts`). The base is a `PBRMaterial`, with a `MaterialPluginBase` injecting GLSL at `CUSTOM_FRAGMENT_DEFINITIONS`, `CUSTOM_FRAGMENT_BEFORE_LIGHTS` (albedo, normal, AO) and `CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS` (roughness). Lighting is the scene's sun, cascaded shadows, IBL and fog, unchanged.

- **Samplers.** 11 in total: the mask, grass / rock / road × (albedo, normal, ARM), and the aerial macro texture. Plus the PBR IBL and shadow samplers, that stays within the 16 WebGL2 guarantees.
- **Layers.** All reuse existing Poly Haven sets:

  | Layer | Texture set | Projection and tile | Notes |
  |---|---|---|---|
  | grass | `forrest_ground_01` | top, 2.4 m | second rotated sample at 6.5 m blended by macro noise; slight green tint |
  | dirt | the grass sample | same | desaturated and tinted brown, rougher, flatter normals |
  | rock | `concrete_floor_worn_001` | triplanar, 5 m | brightened and warmed; also forced on normals steeper than about 37–52° (covers the horizon, which is beyond the mask) |
  | road | `asphalt_02` | top, 4 m | |

- **Transitions.** Height-aware: pseudo-height from AO and luminance, 0.25 blend depth.
- **Macro variation.** The aerial grass/rock scan, sampled at 190 m (color) and 47 m (brightness).
- **Distance fade.** Beyond 35–450 m, detail fades toward each layer's mean albedo and normals flatten.
- **Branching.** Rock and road use `textureGrad` with explicit derivatives, so their fetches can be skipped where their weight is zero.

## Dev map mode wiring

- `Game.ts`: `?map=v1` (DEV only) does the following:
  1. `createEnvironment(scene, { largeWorld: true })`: EXP2 fog 0.0011 (about 26% at 500 m, 70% at 1 km) and a 160 m shadow distance.
  2. `createDevMapV1` builds the terrain, physics body, chunks, horizon and Training Yard level.
  3. The player camera's `maxZ` is set to 4000 m.
- The arena default path is unchanged: same environment values, level, spawns and combat.

## Risks and follow-ups

- **Frame time is unmeasured on a GPU.** If the terrain shader is too expensive at 1440p:
  - drop triplanar to biplanar for rock;
  - skip the second grass sample beyond about 60 m;
  - move to texture arrays (needs same-size textures from the asset pipeline);
  - let the performance engineer add a depth pre-pass decision.
- **Texture sets are stand-ins.** There's no real dirt, gravel or rock scan: dirt is re-tinted forest ground and rock is worn concrete. Suggested Poly Haven CC0 additions through the world asset pipeline: `brown_mud_leaves_01` or `forest_leaves_02` for dirt, `rocky_terrain_02` or `aerial_rocks_02` for rock, `gravel_road` for dirt roads, and a proper grass or meadow set.
- **Main-thread build of about 1 s at load** (generation + mask), plus 0.2 s for chunk meshes. Move it to a worker, which can hand over the `SharedArrayBuffer` heights, or ship a baked heights+mask binary verified by `terrain.checksum()`.
- **Depth precision.** The near plane stays 0.05 m for the viewmodel, and the far plane is 4 km. Precision is about 1.2 m at 1 km, which is fine for terrain and could cause z-fighting between building bases and terrain at long range. Options: reverse-Z, or a larger near plane in map mode (the viewmodel has its own rendering group).
- **LOD pops without geomorphing.** A 128-cell chunk near the camera is always LOD 0 (35k triangles). A quadtree with 64-cell leaves near the camera would cut about 40% of triangles.
- **`packages/shared/src/index.ts` re-exports the physics folder,** like `buildLevel`, so the barrel still pulls Babylon. The planned pure/sim split should move `map/physics` to `packages/sim`; it already uses deep imports only.
- **Border.** Outside the playable square the mountains are walkable in places (83% of border cells are under 50°). The out-of-bounds timer or kill volume must do the enforcement.
- **Terrain edge.** Havok rays exactly on the +X/+Z edge (640 m) miss. That's far outside the playable area.
