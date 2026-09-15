/**
 * Rendering optimizations, each behind a flag so the benchmark can A/B them. Defaults are the shipped behavior. In DEV,
 * `?opt=` overrides them at load: `?opt=off` disables every flag, `?opt=shadowCascadeCulling:0,dynamicResolution:1`
 * sets individual ones. Flags marked "runtime" may also be flipped while running (the bench does).
 */
export interface RenderOptimizations {
  /**
   * Runtime. Draw each sun shadow caster only into the cascades whose light frustum contains it. Babylon's cascaded
   * shadow generator otherwise draws every enabled caster into all cascades, in range or not.
   */
  shadowCascadeCulling: boolean;
  /** Props up to 0.5 m tall (crates, small rocks, stumps) cast shadows within 30 m instead of their category's 50 m. */
  smallPropShadowBand: boolean;
  /** Freeze the identity world matrices of thin-instance batches (props, grass, buildings). */
  staticBatchMatrices: boolean;
  /**
   * Buildings bake into one static mesh per 100 m world cell with one SubMesh per look, instead of thin-instanced
   * meshes per prefab per look per 250 m cell (load time).
   */
  buildingCellMerge: boolean;
  /**
   * With buildingCellMerge: each cell casts shadows through a hidden proxy sharing its buffers, one draw per cascade,
   * instead of one draw per look (load time).
   */
  buildingShadowProxy: boolean;
  /**
   * World materials (buildings, terrain, level blocks, props, grass, street signs) are frozen: Babylon skips their
   * readiness checks and uniform uploads on rebinds. Dirty marks (flag toggles, fog, image processing) still recompile
   * (load time).
   */
  freezeStaticMaterials: boolean;
  /**
   * Runtime. Opaque and alpha-tested submeshes sort by their own material (MultiMaterial parts included), so draws of one
   * material run back to back and skip rebinding it.
   */
  sortBySubMeshMaterial: boolean;
  /**
   * Runtime. Dynamic casters (soldiers, anything not marked static) skip the farthest shadow cascade (past ~30 m with 3
   * cascades): distant soldiers cast no shadow. With shadowStaticCache the far cascade then re-renders only when the view
   * leaves its margin.
   */
  dynamicShadowsNearOnly: boolean;
  /** Static level blocks (the arena, the Training Yard) draw as one merged mesh per material instead of one per block. */
  mergeLevelBlocks: boolean;
  /** Grass rewrites a persistent dynamic GPU buffer instead of allocating a new one on every rebuild. */
  grassDynamicBuffers: boolean;
  /** Terrain chunks coarsen only ~18% past the switch distance (refine immediately), so edge chunks don't flicker. */
  terrainLodHysteresis: boolean;
  /** Skip Babylon's pointer-move picking (the game aims with pointer lock and Havok raycasts). */
  skipPointerMovePicking: boolean;
  /** Block material dirty propagation while the map builds (load time only). */
  blockMaterialDirtyOnLoad: boolean;
  /** Adaptive hardware scaling toward the frame-rate target (read at startup; graphics settings can enable it). */
  dynamicResolution: boolean;

  /** Runtime. Terrain skips a layer's samples when its weight can't survive the height blend (same image). */
  terrainWeightSkip: boolean;
  /** Runtime. Terrain rock uses biplanar projection (the two best-facing axes) instead of triplanar. */
  terrainBiplanarRock: boolean;
  /** Runtime. Terrain past 60–85 m samples albedo and macro only: no normal/AO maps, no anti-tile grass sample. */
  terrainFarSimplify: boolean;

  /** Runtime. Sun shadows use 3 cascades split at ~11 and ~30 m instead of 4 at ~4, 10 and 31 m. */
  shadowThreeCascades: boolean;
  /** Runtime. Shadow map 1536² per cascade instead of 2048². */
  shadowMap1536: boolean;
  /** Runtime. 1-tap hardware PCF instead of 4 taps. */
  shadowPcfLow: boolean;
  /**
   * Runtime. The outer cascades render 12% larger than needed and are reused while the view stays inside them, no
   * dynamic caster (soldiers) touches them and no static caster changed; refreshed at least every 30 frames.
   */
  shadowStaticCache: boolean;

  /** Runtime. Prop and vegetation LOD, cull and shadow switches use ±10% hysteresis bands per instance. */
  lodHysteresis: boolean;
  /** Runtime. LOD switches cross-fade with screen-door dithering over 0.4 s instead of popping. */
  lodCrossFade: boolean;
  /** Runtime. Alpha-tested foliage scales cutout alpha by mip level, so leaves keep their coverage at distance. */
  foliageAlphaMipScale: boolean;
  /** Runtime. Crossed-quad impostors turn (≤ 30°) toward the camera when they appear, so no quad shows edge-on. */
  impostorFacing: boolean;
  /** Grass shrinks out by live camera distance on the GPU instead of by the position its buffer was rebuilt at (startup). */
  grassGpuFade: boolean;
}

const DEFAULTS: RenderOptimizations = {
  shadowCascadeCulling: true,
  smallPropShadowBand: true,
  staticBatchMatrices: true,
  buildingCellMerge: true,
  buildingShadowProxy: true,
  freezeStaticMaterials: true,
  sortBySubMeshMaterial: true,
  dynamicShadowsNearOnly: false,
  mergeLevelBlocks: true,
  grassDynamicBuffers: true,
  terrainLodHysteresis: true,
  skipPointerMovePicking: true,
  blockMaterialDirtyOnLoad: true,
  dynamicResolution: false,
  terrainWeightSkip: true,
  terrainBiplanarRock: true,
  terrainFarSimplify: true,
  shadowThreeCascades: true,
  shadowMap1536: false,
  shadowPcfLow: false,
  shadowStaticCache: false,
  lodHysteresis: true,
  lodCrossFade: true,
  foliageAlphaMipScale: true,
  impostorFacing: true,
  grassGpuFade: true,
};

export const OPTIMIZATIONS: RenderOptimizations = { ...DEFAULTS };

/** Applies an `opt` query value (see the module comment). Returns the names it could not parse. */
export function applyOptimizationOverrides(value: string, target: RenderOptimizations = OPTIMIZATIONS): string[] {
  const unknown: string[] = [];
  for (const token of value.split(",").map((t) => t.trim()).filter(Boolean)) {
    if (token === "off" || token === "none") {
      for (const key of optimizationNames()) target[key] = false;
      continue;
    }
    if (token === "default") {
      Object.assign(target, DEFAULTS);
      continue;
    }
    const [name, setting = "1"] = token.split(":");
    if (!isOptimizationName(name)) {
      unknown.push(token);
      continue;
    }
    target[name] = setting !== "0" && setting !== "false" && setting !== "off";
  }
  return unknown;
}

export function optimizationNames(): (keyof RenderOptimizations)[] {
  return Object.keys(DEFAULTS) as (keyof RenderOptimizations)[];
}

function isOptimizationName(name: string | undefined): name is keyof RenderOptimizations {
  return name !== undefined && Object.hasOwn(DEFAULTS, name);
}

/** "name=on" pairs for flags that differ from the defaults, or "defaults". */
export function describeOptimizations(flags: RenderOptimizations = OPTIMIZATIONS): string {
  const changed = optimizationNames().filter((key) => flags[key] !== DEFAULTS[key]);
  return changed.length === 0 ? "defaults" : changed.map((key) => `${key}=${flags[key] ? "on" : "off"}`).join(", ");
}

// Browser DEV builds read overrides once, before the world is built. Headless tools have no location.
if (import.meta.env?.DEV && typeof location !== "undefined") {
  const value = new URLSearchParams(location.search).get("opt");
  if (value) {
    const unknown = applyOptimizationOverrides(value);
    if (unknown.length > 0) console.warn(`[perf] unknown ?opt= entries: ${unknown.join(", ")} (known: ${optimizationNames().join(", ")})`);
    console.info(`[perf] optimizations: ${describeOptimizations()}`);
  }
}
