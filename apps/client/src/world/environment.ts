import {
  CascadedShadowGenerator,
  Color3,
  Constants,
  Color4,
  DirectionalLight,
  HemisphericLight,
  ImageProcessingConfiguration,
  Mesh,
  RenderingGroup,
  RenderingManager,
  Scene,
  ShadowGenerator,
  Vector3,
  type AbstractMesh,
  type SubMesh,
} from "@babylonjs/core";
import type { SurfaceKind } from "@twobullets/shared";
import type { BuiltLevel } from "@twobullets/sim";
import { OPTIMIZATIONS } from "../perf/flags";
import { installGraphics } from "../perf/graphicsSettings";
import { SKY } from "./environmentManifest";
import { LevelMaterials } from "./materials";
import { installPostEffects } from "./postEffects";
import { CascadeCasterCulling, markStaticShadowCaster } from "./shadowCulling";
import { createSkybox, loadImageBasedLighting } from "./sky";

export interface Environment {
  readonly sun: DirectionalLight;
  readonly shadowGenerator: ShadowGenerator;
  /** Per-cascade caster culling and its counts; null when cascaded shadows are unsupported. */
  readonly shadowCulling: CascadeCasterCulling | null;
  /**
   * Hemispheric sky/ground fill for non-PBR materials (StandardMaterial placeholders and debug meshes, FX).
   * PBR meshes are lit by the IBL instead: add them to `skyFill.excludedMeshes` to avoid double ambient.
   */
  readonly skyFill: HemisphericLight;
  /**
   * Resolves once level textures, the skybox and the IBL have loaded. Level surfaces don't draw until
   * their textures are ready, so awaiting this before gameplay avoids a pop-in.
   */
  readonly ready: Promise<void>;
  /** Applies materials, shadows and other visual-only treatment to built level meshes. */
  decorateLevel(level: BuiltLevel): void;
  /** Registers a dynamic mesh (players, props) to cast and receive sun shadows. */
  addShadowCaster(mesh: AbstractMesh): void;
  /** Re-applies the shadow* optimization flags (cascade count, map size, filtering) after they change at runtime. */
  refreshShadowQuality(): void;
}

/** Look tuning. Sun, sky and haze values themselves come from the HDRI calibration in environmentManifest. */
export const LOOK = {
  /** Linear exposure. The panorama is normalized so sunlit ~18% albedo lands near mid-grey at 1.0. */
  exposure: 1.0,
  contrast: 1.08,
  /** EXP2 haze: ~2% at 40 m, ~12% at 100 m. Keeps distant walls from looking pasted on. */
  fogDensity: 0.0035,
  shadows: {
    mapSize: 2048,
    cascades: 4,
    /** Meters from the camera covered by shadow cascades (arena diagonal is ~100 m). */
    distance: 100,
    /** 0 = uniform cascade split, 1 = logarithmic (more resolution near the camera). */
    lambda: 0.85,
    /**
     * Split for 3 cascades (shadowThreeCascades). With a 5 cm near plane and 160 m of shadows: 0–11, 11–30 and 30–160 m,
     * i.e. the 4-cascade split at 4, 10 and 31 m with its two nearest cascades merged. 100 m arena: 0–7, 7–20, 20–100 m.
     */
    threeCascadeLambda: 0.8,
    bias: 0.0015,
    normalBias: 0.015,
  },
  sky: { iblCubeSize: 256, iblFilterSamples: 64 },
  /** Off by default: not yet profiled at 144 Hz. See postEffects.ts for costs. */
  post: { ssao: false, bloom: false },
} as const;

/**
 * View-distance tuning for the 1 km map (`?map=v1`), replacing the arena values in LOOK. Everything else in LOOK
 * applies unchanged.
 */
export const LARGE_WORLD_LOOK = {
  /** EXP2 haze: ~4% at 200 m, ~26% at 500 m, ~70% at 1 km; the horizon mountains at 2–3 km fade out. */
  fogDensity: 0.0011,
  /** Cascades cover 160 m; terrain doesn't cast (the sun is 48° up, so hills barely shadow anything). */
  shadowDistance: 160,
  shadowLambda: 0.9,
} as const;

export interface EnvironmentOptions {
  /** Large outdoor map: longer haze and shadow ranges. Default false (the arena look). */
  readonly largeWorld?: boolean;
}

export function createEnvironment(scene: Scene, options: EnvironmentOptions = {}): Environment {
  // Render scale and anti-aliasing from the saved graphics settings, before anything sizes itself to the canvas.
  installGraphics(scene);

  // Fog and clear colors are specified in gamma space; PBR converts them back to linear.
  const horizon = new Color3(...SKY.horizonColor).toGammaSpace();
  scene.clearColor = Color4.FromColor3(horizon, 1);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = horizon;
  scene.fogDensity = options.largeWorld ? LARGE_WORLD_LOOK.fogDensity : LOOK.fogDensity;

  const imageProcessing = scene.imageProcessingConfiguration;
  imageProcessing.toneMappingEnabled = true;
  imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  imageProcessing.exposure = LOOK.exposure;
  imageProcessing.contrast = LOOK.contrast;
  imageProcessing.ditheringEnabled = true;

  const toSun = new Vector3(...SKY.sunDirection);
  const sun = new DirectionalLight("light_sun", toSun.negate(), scene);
  sun.position = toSun.scale(80);
  sun.intensity = SKY.sunIntensity;
  sun.diffuse = new Color3(...SKY.sunColor);
  sun.specular = sun.diffuse.clone();

  const skyFill = new HemisphericLight("light_skyFill", Vector3.Up(), scene);
  const skyTint = new Color3(...SKY.horizonColor);
  const skyTintMax = Math.max(skyTint.r, skyTint.g, skyTint.b);
  skyFill.intensity = SKY.skyAmbient;
  skyFill.diffuse = skyTint.scale(1 / skyTintMax);
  skyFill.groundColor = new Color3(...SKY.groundRadiance).scale(1 / SKY.skyAmbient);
  skyFill.specular = Color3.Black();

  const shadowSettings: ShadowSettings = options.largeWorld
    ? { ...LOOK.shadows, distance: LARGE_WORLD_LOOK.shadowDistance, lambda: LARGE_WORLD_LOOK.shadowLambda }
    : LOOK.shadows;
  const shadowGenerator = createSunShadows(sun, shadowSettings);
  applyShadowQuality(shadowGenerator, shadowSettings);
  const shadowCulling = shadowGenerator instanceof CascadedShadowGenerator ? new CascadeCasterCulling(shadowGenerator) : null;
  const materials = new LevelMaterials(scene);
  const skybox = createSkybox(scene);
  const ibl = loadImageBasedLighting(scene, LOOK.sky);
  installPostEffects(scene, LOOK.post);
  installMaterialSort(scene);

  const ready = Promise.all([materials.loaded, skybox.ready, ibl]).then(() => {
    skybox.mesh.material?.freeze();
  });
  ready.catch((err: unknown) => console.error("[environment]", err));

  const addShadowCaster = (mesh: AbstractMesh) => {
    shadowGenerator.addShadowCaster(mesh);
    mesh.receiveShadows = true;
  };

  return {
    sun,
    shadowGenerator,
    shadowCulling,
    skyFill,
    ready,
    addShadowCaster,
    refreshShadowQuality() {
      applyShadowQuality(shadowGenerator, shadowSettings);
      shadowCulling?.attach();
    },
    decorateLevel(level) {
      for (const mesh of level.meshes) {
        const kind = level.surfaceOf.get(mesh);
        if (kind) materials.apply(mesh, kind);
      }
      const visuals = OPTIMIZATIONS.mergeLevelBlocks ? mergeByMaterial(level) : level.meshes.map((mesh) => ({ mesh, kind: level.surfaceOf.get(mesh) }));
      for (const { mesh, kind } of visuals) {
        mesh.receiveShadows = true;
        skyFill.excludedMeshes.push(mesh);
        // The ground slab is the lowest thing in the level; it never shadows anything.
        if (kind === "ground") continue;
        shadowGenerator.addShadowCaster(mesh);
        markStaticShadowCaster(mesh);
      }
    },
  };
}

type ShadowSettings = { readonly [K in keyof typeof LOOK.shadows]: number };

/**
 * Level blocks are static boxes, one mesh (and draw call per pass, shadow cascades included) each. Draws one merged
 * copy per material and surface kind instead; the original meshes stay enabled and pickable for physics, raycasts and
 * surface lookups, just invisible.
 */
function mergeByMaterial(level: BuiltLevel): { mesh: Mesh; kind: SurfaceKind | undefined }[] {
  const groups = new Map<string, Mesh[]>();
  for (const mesh of level.meshes) {
    const kind = level.surfaceOf.get(mesh);
    const key = `${kind}|${mesh.material?.uniqueId ?? "none"}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = []));
    group.push(mesh);
  }
  return [...groups.values()].map((group) => {
    const kind = level.surfaceOf.get(group[0]!);
    if (group.length === 1) return { mesh: group[0]!, kind };
    const merged = Mesh.MergeMeshes(group, false, true);
    if (!merged) return { mesh: group[0]!, kind };
    merged.name = `level_merged_${kind ?? "block"}_${group.length}`;
    merged.material = group[0]!.material;
    merged.isPickable = false;
    merged.freezeWorldMatrix();
    for (const mesh of group) mesh.isVisible = false;
    return { mesh: merged, kind };
  });
}

/**
 * Opaque and alpha-tested submeshes draw grouped by their own material. Babylon's default groups by the mesh's material,
 * which for a merged building cell is its MultiMaterial, so equal looks from different cells would interleave and every
 * draw would rebind its material. Sorting is stable, so ties keep dispatch order.
 */
function installMaterialSort(scene: Scene): void {
  const compare = (a: SubMesh, b: SubMesh): number =>
    OPTIMIZATIONS.sortBySubMeshMaterial ? (a.getMaterial()?.uniqueId ?? -1) - (b.getMaterial()?.uniqueId ?? -1) : RenderingGroup.PainterSortCompare(a, b);
  for (let group = RenderingManager.MIN_RENDERINGGROUPS; group < RenderingManager.MAX_RENDERINGGROUPS; group++) scene.setRenderingOrder(group, compare, compare);
}

/** Same as createEnvironment, but resolves once all environment assets are loaded. */
export async function createEnvironmentAsync(scene: Scene, options: EnvironmentOptions = {}): Promise<Environment> {
  const environment = createEnvironment(scene, options);
  await environment.ready;
  return environment;
}

function createSunShadows(sun: DirectionalLight, settings: ShadowSettings): ShadowGenerator {
  if (!CascadedShadowGenerator.IsSupported) {
    const generator = new ShadowGenerator(settings.mapSize, sun);
    generator.usePercentageCloserFiltering = true;
    generator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    generator.bias = settings.bias;
    generator.normalBias = settings.normalBias;
    return generator;
  }
  // The camera is resolved from scene.activeCamera each frame, so it may be assigned later.
  const generator = new CascadedShadowGenerator(settings.mapSize, sun);
  generator.shadowMaxZ = settings.distance;
  // Bounding-sphere cascades don't shimmer as the camera turns, at some cost in texel density.
  generator.stabilizeCascades = true;
  generator.cascadeBlendPercentage = 0.08;
  generator.depthClamp = true;
  generator.usePercentageCloserFiltering = true;
  generator.bias = settings.bias;
  generator.normalBias = settings.normalBias;
  return generator;
}

/** Cascade count and split, map size and PCF taps from the shadow* flags. Changing count or size recreates the map. */
function applyShadowQuality(generator: ShadowGenerator, settings: ShadowSettings): void {
  const mapSize = OPTIMIZATIONS.shadowMap1536 ? 1536 : settings.mapSize;
  if (generator.mapSize !== mapSize) generator.mapSize = mapSize;
  generator.filteringQuality = OPTIMIZATIONS.shadowPcfLow ? ShadowGenerator.QUALITY_LOW : ShadowGenerator.QUALITY_MEDIUM;
  if (!(generator instanceof CascadedShadowGenerator)) return;
  const three = OPTIMIZATIONS.shadowThreeCascades;
  const cascades = three ? 3 : settings.cascades;
  generator.lambda = three ? settings.threeCascadeLambda : settings.lambda;
  if (generator.numCascades === cascades) return;
  generator.numCascades = cascades;
  // Recreating the map doesn't touch receivers, whose shaders are compiled for a cascade count.
  generator.getLight().getScene().markAllMaterialsAsDirty(Constants.MATERIAL_LightDirtyFlag);
}
