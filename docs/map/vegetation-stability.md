# Vegetation stability

User report: "the tree is not stable when move". Trees and bushes changed or flickered while walking or turning on `?map=v1`. This page covers what caused it, what changed, and how to check it.

| Where | What |
|---|---|
| `apps/client/src/world/props/lodBands.ts` | LOD, cull and shadow thresholds with hysteresis; `lodZoom` |
| `apps/client/src/world/props/LodCell.ts` | Per-instance level state, cross-fades, `InstanceBatch` (swap-remove slots) |
| `apps/client/src/world/props/PropInstances.ts` | Babylon side: batches, incremental uploads, bounds, cover cull distance |
| `apps/client/src/world/props/lodFadePlugin.ts` | Material plugin: dithered fade, alpha mip coverage, grass distance fade |
| `apps/client/src/world/props/impostor.ts` | Crossed-quad plane detection and camera facing |
| `apps/client/src/world/vegetation/GrassField.ts` | Grass buffers (GPU fade margin) |
| `apps/client/src/world/vegetation/checkVegetationStability.ts` | Headless walk simulation and checks |

```sh
node --experimental-transform-types --import ./tools/map/lib/resolve.ts apps/client/src/world/vegetation/checkVegetationStability.ts
```

The check runs in about a minute and exits with code 1 on the first failure.

## Diagnosis

A headless walk replays four camera paths at 60 Hz on the Map v1 layout, with the manifest's LOD distances. It compares the previous scheme with the new one. The paths were re-routed onto the 500 × 500 m map on 2026-09-16 (town → west road → Forest Cabins, a sprint loop of r 45 m around (−190, 105), the strafe at (−218, 152)); the table below was measured on the 1 km layout (5,960 prop instances in 247 prop cells), and the harness still passes, with the strafe's switches dropping 396 → 8.

**Previous scheme:**
- Each instance was re-bucketed every 4 m of camera movement.
- Switch distances were exact (no hysteresis).
- A batch rebuilt its whole buffer whenever its membership changed, creating a new static GPU buffer and refreshing its bounds over every instance.

| Path | Before: switches/s | Before: reversals ¹ | Before: buffer re-creations/s | After: switches/s | After: reversals | After: re-creations/s |
|---|---|---|---|---|---|---|
| Forest walk (town → west road → cabins → loop, 78 s) | 63.7 (up to 78 in one frame) | 147 | 45.8 | 50.5 (≤ 13 per frame) | 16 ² | 3.9 |
| Forest sprint loop (30 s) | 130.3 | 124 | 88.7 | 103.8 | 28 ² | 3.8 |
| Forest A/D strafe, ±2 m (20 s) | 104.0 | 2,016 | 53.8 | 1.7 | 0 | 0.1 |
| Town walk (65 s) | 13.6 | 49 | 25.7 | 9.9 | 3 ² | 2.7 |

¹ A reversal is a switch back to the previous level within 3 s.
² None of these is inside the hysteresis band: the camera really moved that far back.

**Dominant causes, in order:**

1. **Pops with no transition, in bursts.** Every LOD, impostor and cull change was an instant swap between very different-looking levels: cards, then crossed cards, then three-quad impostors. The 4 m quantization grouped them, so up to 78 instances swapped in one frame.
2. **Flip-flop at switch distances.** With no hysteresis, strafing or peeking near a switch distance flipped the same trees back and forth: 2,016 reversals in 20 s of A/D strafing, and 147 even on a plain walk.
3. **Alpha-test coverage loss in mips.** Leaf cards have 132–168 texels/m at LOD0, 65–78 at LOD1 and 47–72 on impostors. At Balanced 1440p (about 1,024/d px per meter at 90° FOV), LOD0 samples mip ≈ 2.2 at its 35 m switch while LOD1 samples mip ≈ 1.1. With a 0.4 cutoff, averaged alpha drops out, so:
   - LOD0 looks sparser than LOD1 right at the switch. This is the "young firs look sparser at LOD0" effect.
   - Distant crowns thin out and crawl when the camera turns. This is the only instability that turning alone causes; LOD selection is by distance.
4. **Buffer re-creation.** 26–89 new GPU buffers per second, each with a CPU copy and a bounds refresh over the whole batch. This isn't visual flicker, but it adds frame-time jitter while moving.
5. **Shadow pops at the 70 m tree band.** 6–35 shadow toggles per second on the paths, with no hysteresis.
6. **Grass edge steps.** Clump sizes were frozen at the last rebuild point, every 8 m of travel. At each rebuild, a clump in the 12 m fade band could jump by up to 100% of its size.

**Not causes:**
- **Wind:** there is no wind animation.
- **The static shadow cache:** it is off by default. It is invalidated only on shadow-batch membership changes, never on fade-only updates.
- **Grass re-seeding:** detail expansion is deterministic per region, and `layout.test.ts` covers that tiling expands identically.

## Fixes and flags

All flags are in `perf/flags.ts`, on by default, and accept `?opt=name:0`. Every flag except `grassGpuFade` can be flipped at runtime. `lodCrossFade`, `lodHysteresis` and `foliageAlphaMipScale` are bench variants in the `vegetation` group (`&variants=vegetation`, not in the default run).

| Flag | Change |
|---|---|
| `lodHysteresis` | Per instance, a coarser level is picked only past `switch × 1.1` and a finer one only inside `switch × 0.9`. The same applies to the cull distance and the shadow band. Narrow neighbouring bands shrink their margin instead of overlapping. |
| `lodCrossFade` | A level change adds the instance to the new level's batch fading in, and keeps a fade-out copy in the old level's shadowless batch for 0.4 s. The `lodFade` per-instance attribute drives screen-door dithering with interleaved gradient noise. The two copies use complementary pixel sets, so the tree never shows holes or double density. Culling fades out the same way. Teleports (> 30 m) and `force` switch instantly. |
| `foliageAlphaMipScale` | Alpha-tested PBR materials multiply cutout alpha by `1 + 0.25 × mip` (derivatives of the albedo UV times the texture size). Leaves keep their coverage at distance, and LOD0 and LOD1 match at the switch. |
| `impostorFacing` | When an instance enters a crossed-quad impostor level, it turns ≤ 30° about its pivot so a plane faces the camera. No plane is then closer than 30° to edge-on; before, one could be exactly edge-on. Plane layouts are detected from the impostor geometry at load, so any count of evenly spaced vertical quads works. |
| `grassGpuFade` | Grass buffers hold full-size clumps out to 45 m + 11.3 m (the most the camera drifts before the next rebuild). The vertex shader shrinks each clump about its pivot by live camera distance over 33–45 m. Clump size now changes by ≤ 2% per frame instead of jumping at rebuilds. |

**Always on (no flag):**
- **Incremental batches.** Per (cell, level, shadow) batches keep persistent dynamic buffers that grow by doubling. Membership changes swap-remove single slots and upload only the dirty slot range of the matrices and fades. Bounds are recomputed from member pivots. Buffer re-creations dropped from 26–89/s to 0.1–3.9/s, and those that remain are first use or growth.
- **Selection gating.** Levels are re-selected after 0.5 m of movement or a zoom change; fades advance every frame. A cell whose whole bounding box stays inside its current band is skipped without per-instance work.
- **Zoom-aware LOD.** Distances are divided by `lodZoom(activeCamera.fov)`: the magnification against the unzoomed FOV, rounded down to 1/2/4/8.
  - Sprint FOV and iron sights (62–75°) stay at 1.
  - The K-98 scope (27°) uses 4×, so a fir 300 m away draws at LOD1 instead of as an impostor.
- **Cover never culls in the map.** Props that block movement and bullets and are taller than 0.5 m keep a cull distance of at least 720 m (`COVER_CULL_DISTANCE`; the 500 m square's diagonal is ~707 m) and fall back to their cheapest level instead: walls, fences, rocks, cars, logs, hay bales, sandbags and tree trunks. `rock_small`, stumps, small crates and bushes still cull (bushes by their zoomed distance).

**Shadows.** The shadow band has hysteresis. During a cross-fade, only the incoming level casts. Shadows themselves still switch without dithering, because Babylon's shadow depth shader doesn't run material plugins. A dithered shadow fade would need `ShadowDepthWrapper` (the full PBR shader in the depth pass), which isn't worth its cost yet.

### CPU cost

Headless, with 5,000 instances within 150 m of a moving camera (8 cells, 3 levels, shadow band):

| Case | Mean | p99 |
|---|---|---|
| Re-select every frame (vehicle-speed worst case) | 0.080 ms | 0.115 ms |
| Re-select every 0.5 m (walking at 120 Hz) | 0.012 ms | 0.088 ms |

- No per-frame allocations: 0 young-generation GCs over 50,000 frames.
- The full `PropInstances.update` along the map paths, including NullEngine upload calls, averages 0.008–0.019 ms.
- **GPU uploads:** cross-fades add small partial `lodFade` uploads, about 20–35 `bufferSubData` calls per frame while walking through the forest. Each call covers a few floats in one mesh.

## What to look at in the browser

Walk and sprint through the western forest on `?map=v1`: west road → Forest Cabins (−190, 105) → loop. Then strafe (A/D) near trees 30–45 m away, and scope with the K-98.

**What good looks like:**
- Trees 30–45 m (LOD0 ↔ LOD1) and 90–140 m (LOD1 ↔ impostor) away never swap in one frame. For about 0.4 s a tree shows a fine noise pattern where both levels mix, then it settles. Nothing blinks back and forth while strafing.
- Crowns at 50–150 m keep their density and don't sparkle or thin out while turning. Young firs look equally dense on both sides of their 30 m switch.
- Impostors never show as a thin vertical line.
- The grass edge (about 45 m) grows and shrinks smoothly as you walk; clumps don't jump in size every few steps.
- Through a scope, distant trees are cards, not flat impostors. Walls, fences, rocks and cars never disappear at any range.
- Frame time is flat while walking: no spikes every few meters on the F4 perf panel.

**A/B checks:** `?opt=lodCrossFade:0`, `?opt=lodHysteresis:0`, `?opt=foliageAlphaMipScale:0`, `?opt=grassGpuFade:0`, or `?opt=impostorFacing:0` bring back each old behavior.

**If a shader fails to compile** (props render black or invisible), `?opt=lodCrossFade:0,foliageAlphaMipScale:0,grassGpuFade:0` doesn't remove the plugin. Report the console error.

## Future tree and boulder models

Nothing in the new code is specific to the current assets:
- **Levels:** it works for any number of LOD levels and switch distances from `PropAsset.lods`, and any cull distance.
- **Materials:** the fade and mip coverage terms apply to any PBR material on a batch. Opaque bark and rock get the dither; alpha-tested leaves also get mip coverage.
- **Impostors:** plane detection accepts any evenly spaced crossed quads. Other impostor kinds (octahedral, mesh) are left unturned and still cross-fade.
- **Big-trunk trees and boulders** are cover: the collision height rule keeps them drawn map-wide at their far level. Give them a cheap last LOD, a few hundred triangles or an impostor for trees; boulders need a real mesh LOD, since impostors aren't cover.
- **Tuning:** only runtime numbers. The switch distances in the manifest set the hysteresis ±10% around them, and `PropInstancesOptions` sets `hysteresis`, `fadeSeconds` and `selectDistance`.

## Risks

- **Shader code can't be compiled headless.** The injection was checked against Babylon 9.26's PBR sources through NullEngine: defines, attributes, the alpha regex and the injection points all land. A GLSL typo would show only in the browser, so check the console on first load.
- **Dither pattern.** During the 0.4 s fades, the pattern is visible at 80% render scale and MSAA doesn't smooth it (there is no TAA). Many trees fade at once when a scope zooms in.
- **Opaque discard.** Opaque bark and rock materials now contain a `discard`, which disables early-depth for those draws.
- **Zoom cost.** A scoped view selects nearer levels for everything in range, capped at 8×. With the K-98 (4×) over the forest, expect more triangles while scoped.
- **Cover draw distance.** Cover now draws map-wide. The worst case, if every cover instance were in view at its far level, was about 290k triangles on the 1 km layout (rocks are most of it); the 500 m map carries about a sixth of the instances.
- **Memory.** Batches grow to their high-water mark. The worst case is one copy per instance per level, and it usually stays far below that.
- **Grass vertex work.** Grass draws about 1.6× as many (partly zero-size) clumps within the extended gather radius. They cost vertex work only.
