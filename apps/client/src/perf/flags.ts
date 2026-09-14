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
  /** Runtime. Adaptive hardware scaling when frames run over budget. Off by default. */
  dynamicResolution: boolean;
}

const DEFAULTS: RenderOptimizations = {
  shadowCascadeCulling: true,
  smallPropShadowBand: true,
  staticBatchMatrices: true,
  mergeLevelBlocks: true,
  grassDynamicBuffers: true,
  terrainLodHysteresis: true,
  skipPointerMovePicking: true,
  blockMaterialDirtyOnLoad: true,
  dynamicResolution: false,
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
