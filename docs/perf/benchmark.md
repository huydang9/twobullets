# Rendering benchmark

The agent machines have no GPU, so frame-time numbers must come from a visible browser tab on real hardware. The
benchmark is DEV only (the Vite dev server) and needs no pointer lock or input.

## Run it

1. Plug the laptop in and turn Low Power Mode off. Close other heavy tabs and apps.
2. Size the Chrome window the way you play (maximized or full screen): render resolution is window size × device pixel
   ratio.
3. Open **<http://localhost:5173/?bench=v1>** (it loads Map v1 by itself).
4. Keep the tab visible and in front, and leave mouse and keyboard alone for **about 10 minutes**: roughly 30 s to load,
   1.5 min for the full pass, then about 8 min of A/B passes. A status line at the bottom shows progress and time left.
   If the tab is hidden, the current segment restarts.
5. When the results dialog appears, click **Copy results** and paste the text into the chat. The same report is printed
   to the DevTools console, and `window.__twobulletsBench` holds it as an object.

The run uses the saved graphics settings (Balanced on DPR ≥ 2 displays unless changed); the report's `graphics` line
says which. Shorter runs: `?bench=v1&variants=0` (full pass only, ~2 min), or a group such as `&variants=terrain`,
`&variants=shadows`, `&variants=resolution`, `&variants=shading`; `&variants=all` adds the scene-content toggles.

## What it does

The camera jumps through six fixed Map v1 viewpoints (`apps/client/src/perf/benchViewpoints.ts`), each with a slow
±12° yaw sweep:

| Viewpoint         | Where                                                          |
| ----------------- | -------------------------------------------------------------- |
| Spawn field       | the spawn nearest the Training Yard, facing its 10 soldiers     |
| Town street       | 45 m west of the town square on the main street, looking east  |
| Forest clearing   | the forest cabins' clearing, looking toward town               |
| Radar tower top   | the radar watchtower platform, looking over the map to town    |
| Military compound | inside the compound, looking across the container yard         |
| Quarry rim        | the terraced pit's north-west rim, looking into the pit        |

1. **Full pass:** 5 s warmup and 10 s measurement per viewpoint, current settings.
2. **A/B passes:** 1.5 s warmup and 2.5 s measurement per viewpoint for each variant, with 3 s of extra settling after
   each switch (shader compiles). A short baseline runs first and again at the end; the second one shows thermal drift.

Default variants (flag variants flip the flag from its current value, so the label says which way):

| Group      | Variant id            | Change                                                              |
| ---------- | --------------------- | ------------------------------------------------------------------- |
| resolution | `preset_high` etc.    | the other quality presets' render scales (1.0 / 0.8 / 0.6)           |
| resolution | `aa_swap`             | FXAA instead of MSAA (or back)                                      |
| resolution | `aa_none`             | single-sample scene target, plain copy: MSAA's cost as a reference  |
| shadows    | `shadowThreeCascades` | 3 vs 4 cascades                                                     |
| shadows    | `shadowMap1536`       | 1536² vs 2048² shadow maps                                          |
| shadows    | `shadowPcfLow`        | 1-tap vs 4-tap PCF                                                  |
| shadows    | `shadowStaticCache`   | outer cascades reused while nothing relevant changed                |
| shadows    | `dynamicShadowsNearOnly` | soldiers (dynamic casters) skip the far cascade                  |
| draws      | `sortBySubMeshMaterial` | opaque/alpha-test draws grouped by submesh material               |
| terrain    | `terrainWeightSkip`   | skip layer samples that can't survive the height blend              |
| terrain    | `terrainBiplanarRock` | biplanar vs triplanar rock                                          |
| terrain    | `terrainFarSimplify`  | albedo + macro only past 60–85 m                                    |
| terrain    | `terrainLegacy`       | all three terrain flags off (the shader before round 2)              |
| shading    | `fogOff`              | fog off                                                             |
| shading    | `imageProcessingOff`  | ACES, contrast and dithering off                                    |
| shading    | `viewmodelOff`        | first-person arms and weapon hidden                                 |

With `&variants=all` (or by id): `shadowCascadeCulling`, `shadowMapsFrozen`, `shadowsOff`, `terrainPlain`, `grassOff`,
`propsOff`, `buildingsOff`, `soldiersOff`.

## Reading the report

- **Frame** is the time between frames. It is display-paced: at 120 Hz with vsync it cannot drop below 8.33 ms, so a
  variant that already fits the budget shows ~8.3 ms. p95 and p99 show hitches.
- **CPU** is the render-loop JavaScript per frame. **Update** is game code before `scene.render` (player, combat, FX,
  world LOD and grass). **Render** is `scene.render`, split into **Anim**, **Physics**, **Shadow RTT** (all cascades),
  **Eval** (culling and active mesh selection) and **Draw** (main camera). WebGL submits commands asynchronously, so
  these are CPU costs; GPU time shows up in Frame.
- **GPU** comes from `EXT_disjoint_timer_query_webgl2` when the browser exposes it (Chrome 152 on the M2 Pro does);
  otherwise the report says `n/a`.
- **Draw calls** and **Tris** count every pass, shadow cascades included. **Casters/cascade** is the number of shadow
  casters drawn into each cascade.

A frame over budget with low CPU is GPU-bound (fill rate, shaders, resolution); the resolution, terrain and shadow
variants then say where it goes. High CPU points at draw calls, shadows, animation or physics.

### Optional: uncapped frame rate

Vsync hides headroom above the display rate. For a second run without the cap, quit Chrome and start a separate
instance:

```sh
open -na "Google Chrome" --args --user-data-dir=/tmp/chrome-bench --disable-gpu-vsync --disable-frame-rate-limit "http://localhost:5173/?bench=v1"
```

`&gpusync=1` adds a 1-pixel readback after every frame to wait for the GPU; the report then shows that wait as
`sync` GPU time. It distorts the pipeline, so use it only to see whether the GPU or the CPU is the bottleneck.

## Graphics settings

`apps/client/src/perf/graphicsSettings.ts`, saved in `localStorage` (`twobullets.graphics.v1`) and applied at startup by
`createEnvironment`:

| Preset      | Render scale | Default on             |
| ----------- | ------------ | ---------------------- |
| High        | 1.0 (native) | DPR < 2 displays       |
| Balanced    | 0.8          | DPR ≥ 2 displays       |
| Performance | 0.6          |                        |

Anti-aliasing is `msaa` (the canvas's multisampling) or `fxaa` (the scene renders into a single-sample target and one
FXAA pass writes the canvas). Dynamic resolution toward 120 FPS is an opt-in that takes effect on the next start. A
settings menu calls `graphicsOf(scene).update({ preset, antiAliasing, dynamicResolution })`; in DEV the console has
`__twobulletsGraphics.update({...})`, and `?quality=high|balanced|performance`, `?aa=msaa|fxaa`, `?dynres=1` override
the saved values for one session.

## Other switches (DEV)

| Query / key                         | Effect                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `F4` or `?perf=1`                   | live stats panel: frame, CPU split, GPU, draws, triangles, casters, cache       |
| `?variants=terrain,shadowPcfLow`    | run only these A/B groups or variants                                          |
| `?opt=off`                          | disable every rendering optimization flag (compare with a default run)         |
| `?opt=name:0,other:1`               | set individual flags                                                           |

Optimization flags (`apps/client/src/perf/flags.ts`):

| Flag                       | Default | What it does                                                                            |
| -------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `shadowCascadeCulling`     | on      | each caster is drawn only into the cascades whose light-space box it touches            |
| `shadowThreeCascades`      | on      | 3 cascades split at ~11 and ~30 m (was 4 at ~4, 10 and 31 m)                             |
| `shadowMap1536`            | off     | 1536² cascades instead of 2048²                                                          |
| `shadowPcfLow`             | off     | 1-tap hardware PCF instead of 4 taps                                                     |
| `shadowStaticCache`        | off     | outer cascades render 12% larger and are reused while the view stays inside them         |
| `terrainWeightSkip`        | on      | skip layer samples whose weight can't survive the height blend (identical image)         |
| `terrainBiplanarRock`      | on      | rock from the two best-facing projections instead of three                               |
| `terrainFarSimplify`       | on      | past 60–85 m: albedo and macro only, no normal/AO maps, no anti-tile grass sample         |
| `smallPropShadowBand`      | on      | props up to 0.5 m tall cast shadows within 30 m (their category's band is 50 m)           |
| `staticBatchMatrices`      | on      | thin-instance batches freeze their identity world matrices                                |
| `buildingCellMerge`        | on      | load: buildings bake into one mesh per 100 m cell, one SubMesh per look (was thin instances per prefab per look per 250 m cell) |
| `buildingShadowProxy`      | on      | load: each merged cell casts through a hidden proxy sharing its buffers, one draw per cascade |
| `freezeStaticMaterials`    | on      | load: world materials are frozen; dirty marks (flag toggles, fog, image processing) still recompile |
| `sortBySubMeshMaterial`    | on      | draws of one material run back to back (Babylon's default groups by the mesh's MultiMaterial) |
| `dynamicShadowsNearOnly`   | off     | soldiers cast only into the two near cascades (≤ ~30 m); with `shadowStaticCache` the far cascade is then cacheable |
| `mergeLevelBlocks`         | on      | arena and Training Yard blocks draw as one merged mesh per material                       |
| `grassDynamicBuffers`      | on      | grass rewrites persistent GPU buffers and computes batch bounds directly                  |
| `terrainLodHysteresis`     | on      | terrain chunks coarsen only ~18% past the switch distance                                 |
| `skipPointerMovePicking`   | on      | no Babylon picking on mouse move                                                          |
| `blockMaterialDirtyOnLoad` | on      | material dirty propagation is blocked while the world builds (load time)                  |
| `dynamicResolution`        | off     | adaptive hardware scaling (also enabled by the graphics setting)                          |

Load-time flags (marked "load") only take effect on reload, e.g. `?bots=1&map=vn-hangxanh&players=20&opt=buildingCellMerge:0`.

## Headless render bench (CPU, no browser)

`node --experimental-transform-types tools/bench/render/world.ts --map=vn-hangxanh [--frames=500] [--opt=...] [--dump=1]`
builds the real map world (terrain, buildings, props as procedural stand-ins, grass, signs) and the sun cascades on a
NullEngine, walks a street-level loop around the map centre and prints meshes, active meshes, draw calls and triangles
(shadow passes separately) and the scene.render split. WebGL calls are no-ops, so its times understate a browser's per-draw
cost; compare runs with each other. Soldiers, viewmodel and loot are not in it. `--cell=` sets the merged building cell
size. `tools/bench/render/analyze.ts <map>` prints building draw and memory estimates per cell size.

Render-side CPU round (2026-09-15), 500 frames, before = `--opt=buildingCellMerge:0,buildingShadowProxy:0,freezeStaticMaterials:0,sortBySubMeshMaterial:0`:

| Map            | Meshes    | Active    | Draws/frame (shadow) | Triangles/frame (shadow) | scene.render |
| -------------- | --------- | --------- | -------------------- | ------------------------ | ------------ |
| Hàng Xanh      | 866 → 357 | 346 → 106 | 1008 (661) → 294 (45) | 2.33M (1.53M) → 1.90M (1.22M) | 4.32 → 0.94 ms |
| Phan Đăng Lưu  | 823 → 341 | 303 → 99  | 907 (604) → 272 (45)  | 2.13M (1.46M) → 1.93M (1.35M) | 3.80 → 0.89 ms |
| Map v1         | 837 → 702 | 235 → 175 | 409 (174) → 274 (55)  | 0.63M (0.18M) → 0.64M (0.19M) | 2.03 → 1.05 ms |

With `shadowStaticCache:1,dynamicShadowsNearOnly:1` Hàng Xanh drops further to 221 draws (6 shadow) and 0.6M triangles
while the view stays inside the cached cascades (the bench has no soldiers). Merged buildings on Hàng Xanh hold ~60 MB of
GPU buffers and no CPU copy (thin-instance batches held ~27 MB on each side).

### Terrain texture fetches

Layer fetches per pixel besides the mask and two macro samples (3, always):

| Distance         | Grass | Dirt | Rock | Road |
| ---------------- | ----- | ---- | ---- | ---- |
| before           | 3     | 2    | 6    | 3    |
| near (< 60 m)    | 3     | 2    | 2–4  | 3    |
| far (> 85 m)     | 1     | 1    | 1–2  | 2    |

Estimated over the terrain pixels of each viewpoint (heightfield ray cast, horizon ring excluded), including the
weight skip: spawn 6.99 → 5.56 (−20%), town 7.16 → 6.10 (−15%), forest 6.10 → 5.19 (−15%), radar 6.88 → 5.03
(−27%), military 6.62 → 4.97 (−25%), quarry 7.63 → 5.37 (−30%). The horizon ring is entirely in the far path.

## Headless check

Validates the viewpoints against the terrain and layout and runs the full schedule on a NullEngine with a simulated
clock (no timings):

```sh
node --experimental-transform-types --import ./tools/map/lib/resolve.ts apps/client/src/perf/checkBenchPath.ts
```
