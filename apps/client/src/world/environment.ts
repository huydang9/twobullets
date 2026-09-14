import {
  CascadedShadowGenerator,
  Color3,
  Color4,
  DirectionalLight,
  HemisphericLight,
  ImageProcessingConfiguration,
  Scene,
  ShadowGenerator,
  Vector3,
  type AbstractMesh,
} from "@babylonjs/core";
import type { BuiltLevel } from "@twobullets/shared";
import { SKY } from "./environmentManifest";
import { LevelMaterials } from "./materials";
import { installPostEffects } from "./postEffects";
import { createSkybox, loadImageBasedLighting } from "./sky";

export interface Environment {
  readonly sun: DirectionalLight;
  readonly shadowGenerator: ShadowGenerator;
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

  const shadowGenerator = createSunShadows(
    sun,
    options.largeWorld ? { ...LOOK.shadows, distance: LARGE_WORLD_LOOK.shadowDistance, lambda: LARGE_WORLD_LOOK.shadowLambda } : LOOK.shadows,
  );
  const materials = new LevelMaterials(scene);
  const skybox = createSkybox(scene);
  const ibl = loadImageBasedLighting(scene, LOOK.sky);
  installPostEffects(scene, LOOK.post);

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
    skyFill,
    ready,
    addShadowCaster,
    decorateLevel(level) {
      for (const mesh of level.meshes) {
        const kind = level.surfaceOf.get(mesh);
        if (kind) materials.apply(mesh, kind);
        mesh.receiveShadows = true;
        skyFill.excludedMeshes.push(mesh);
        // The ground slab is the lowest thing in the level; it never shadows anything.
        if (kind !== "ground") shadowGenerator.addShadowCaster(mesh);
      }
    },
  };
}

type ShadowSettings = { readonly [K in keyof typeof LOOK.shadows]: number };

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
  generator.numCascades = settings.cascades;
  generator.lambda = settings.lambda;
  generator.shadowMaxZ = settings.distance;
  // Bounding-sphere cascades don't shimmer as the camera turns, at some cost in texel density.
  generator.stabilizeCascades = true;
  generator.cascadeBlendPercentage = 0.08;
  generator.depthClamp = true;
  generator.usePercentageCloserFiltering = true;
  generator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  generator.bias = settings.bias;
  generator.normalBias = settings.normalBias;
  return generator;
}
