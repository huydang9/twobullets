# Rendering benchmark

The agent machines have no GPU, so frame-time numbers must come from a visible browser tab on real hardware. The
benchmark is DEV only (the Vite dev server) and needs no pointer lock or input.

## Run it

1. Plug the laptop in and turn Low Power Mode off. Close other heavy tabs and apps.
2. Size the Chrome window the way you play (maximized or full screen): render resolution is window size × device pixel
   ratio.
3. Open **<http://localhost:5173/?bench=v1>** (it loads Map v1 by itself).
4. Keep the tab visible and in front, and leave mouse and keyboard alone for **about 8 minutes**: roughly 30 s to load,
   then 1.5 min for the full pass and 6 min for the A/B passes. A status line at the bottom shows progress and time left.
   If the tab is hidden, the current segment restarts.
5. When the results dialog appears, click **Copy results** and paste the text into the chat. The same report is printed
   to the DevTools console, and `window.__twobulletsBench` holds it as an object.

Quick variant: `?bench=v1&variants=0` runs only the full pass (about 2 minutes with loading).

## What it does

The camera jumps through six fixed Map v1 viewpoints (`apps/client/src/perf/benchViewpoints.ts`), each with a slow
±12° yaw sweep:

| Viewpoint         | Where                                                         |
| ----------------- | ------------------------------------------------------------- |
| Spawn field       | the spawn nearest the Training Yard, facing its 10 soldiers    |
| Town street       | 45 m west of the town square on the main street, looking east |
| Forest clearing   | the forest cabins' clearing, looking toward town              |
| Radar tower top   | the radar watchtower platform, looking over the map to town   |
| Military compound | inside the compound, looking across the container yard        |
| Quarry rim        | the terraced pit's north-west rim, looking into the pit       |

1. **Full pass:** 5 s warmup and 10 s measurement per viewpoint, everything on.
2. **A/B passes:** 1.5 s warmup and 2.5 s measurement per viewpoint for each variant below, with 3 s of extra settling
   after each switch (shader compiles). A short baseline runs first and again at the end, so the variants compare against
   the same pass length, and the second baseline shows thermal drift.

| Variant id         | Change                                                               | Answers                                          |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------ |
| `cascadeCulling`   | flips per-cascade shadow caster culling                              | what the culling optimization saves              |
| `shadowMapsFrozen` | shadow maps stop re-rendering (sampling stays)                       | upper bound for caching or throttling cascades   |
| `shadowsOff`       | `scene.shadowsEnabled = false`                                        | total cost of shadows (maps and PCF sampling)    |
| `grassOff`         | near-player grass hidden                                             | grass cost                                       |
| `propsOff`         | all props, rocks, trees and bushes hidden                            | prop and vegetation cost                         |
| `buildingsOff`     | building meshes hidden                                               | building cost                                    |
| `fogPostOff`       | fog and image processing (ACES, contrast, dithering) off             | fog and tone-mapping cost                        |
| `viewmodelOff`     | first-person arms and weapon hidden                                  | viewmodel cost                                   |
| `soldiersOff`      | soldiers hidden, their animations and per-frame updates paused       | animation, skinning and soldier draw cost        |
| `terrainPlain`     | terrain and horizon drawn with a flat PBR material                   | cost of the splat terrain shader                 |
| `scale125`         | hardware scaling ×1.25 (80% linear resolution)                       | how much of the frame is resolution-bound (GPU)  |

## Reading the report

- **Frame** is the time between frames. It is display-paced: at 120 Hz with vsync it cannot drop below 8.33 ms, so a
  variant that already fits the budget shows ~8.3 ms. p95 and p99 show hitches.
- **CPU** is the render-loop JavaScript per frame. **Update** is game code before `scene.render` (player, combat, FX,
  world LOD and grass). **Render** is `scene.render`, split into **Anim**, **Physics**, **Shadow RTT** (all cascades),
  **Eval** (culling and active mesh selection) and **Draw** (main camera). WebGL submits commands asynchronously, so
  these are CPU costs; GPU time shows up in Frame.
- **GPU** needs `EXT_disjoint_timer_query_webgl2`, which Chrome on macOS normally does not expose; the report says
  `n/a` then.
- **Draw calls** and **Tris** count every pass, shadow cascades included. **Casters/cascade** is the number of shadow
  casters drawn into each cascade.

A frame over budget with low CPU is GPU-bound (fill rate, shaders, resolution); `scale125`, `terrainPlain`, `grassOff`
and `shadowsOff` then say where it goes. High CPU points at draw calls, shadows, animation or physics.

### Optional: uncapped frame rate

Vsync hides headroom above the display rate. For a second run without the cap, quit Chrome and start a separate
instance:

```sh
open -na "Google Chrome" --args --user-data-dir=/tmp/chrome-bench --disable-gpu-vsync --disable-frame-rate-limit "http://localhost:5173/?bench=v1"
```

`&gpusync=1` adds a 1-pixel readback after every frame to wait for the GPU; the report then shows that wait as
`sync` GPU time. It distorts the pipeline, so use it only to see whether the GPU or the CPU is the bottleneck.

## Other switches (DEV)

| Query / key                  | Effect                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `F4` or `?perf=1`            | live stats panel: frame avg/p95/p99, CPU split, GPU, draws, triangles, casters     |
| `?variants=grassOff,scale125` | run only these A/B variants                                                        |
| `?opt=off`                   | disable every rendering optimization flag (compare with a default run)             |
| `?opt=name:0,other:1`        | set individual flags                                                               |
| `?opt=dynamicResolution:1&fps=120` | adaptive resolution toward a frame-rate target (never during a benchmark)    |

Optimization flags (`apps/client/src/perf/flags.ts`, all on unless noted):

| Flag                      | What it does                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `shadowCascadeCulling`    | each shadow caster is drawn only into the cascades whose light-space box it touches                |
| `smallPropShadowBand`     | props up to 0.5 m tall cast shadows within 30 m (their category's band is 50 m)                     |
| `staticBatchMatrices`     | thin-instance batches (props, grass, buildings) freeze their identity world matrices               |
| `mergeLevelBlocks`        | arena and Training Yard blocks draw as one merged mesh per material                                |
| `grassDynamicBuffers`     | grass rewrites persistent GPU buffers and computes batch bounds directly                           |
| `terrainLodHysteresis`    | terrain chunks coarsen only ~18% past the switch distance, so edge chunks don't flicker            |
| `skipPointerMovePicking`  | no Babylon picking on mouse move                                                                   |
| `blockMaterialDirtyOnLoad`| material dirty propagation is blocked while the world builds (load time)                           |
| `dynamicResolution`       | off: adaptive hardware scaling when frames run over budget                                         |

## Headless check

Validates the viewpoints against the terrain and layout and runs the full schedule on a NullEngine with a simulated
clock (no timings):

```sh
node --experimental-transform-types --import ./tools/map/lib/resolve.ts apps/client/src/perf/checkBenchPath.ts
```
