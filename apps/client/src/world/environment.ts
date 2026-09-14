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
import { LevelMaterials } from "./materials";
import { createSkyDome, type SkyColors } from "./sky";

export interface Environment {
  readonly sun: DirectionalLight;
  readonly shadowGenerator: ShadowGenerator;
  /** Applies materials, shadows and other visual-only treatment to built level meshes. */
  decorateLevel(level: BuiltLevel): void;
  /** Registers a dynamic mesh (players, props) to cast and receive sun shadows. */
  addShadowCaster(mesh: AbstractMesh): void;
}

const SKY: SkyColors = {
  zenith: Color3.FromHexString("#2f86e0"),
  horizon: Color3.FromHexString("#bfe4fb"),
  nadir: Color3.FromHexString("#d9eef9"),
};

// Sun comes from the south-west, so the default spawn (SW corner, facing NE) sees lit faces.
const SUN_DIRECTION = new Vector3(0.5, -0.8, 0.35).normalize();

export function createEnvironment(scene: Scene): Environment {
  scene.clearColor = Color4.FromColor3(SKY.horizon, 1);
  scene.fogMode = Scene.FOGMODE_EXP2;
  scene.fogColor = SKY.horizon.clone();
  scene.fogDensity = 0.0045; // ~5% at 50 m, ~18% at 100 m

  const imageProcessing = scene.imageProcessingConfiguration;
  imageProcessing.toneMappingEnabled = true;
  // Neutral tone mapping keeps saturated hues intact, unlike ACES.
  imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
  imageProcessing.exposure = 1.05;
  imageProcessing.contrast = 1.15;

  createSkyDome(scene, SKY);

  const hemi = new HemisphericLight("light_skyFill", new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.6;
  hemi.diffuse = Color3.FromHexString("#e4f1ff");
  hemi.groundColor = Color3.FromHexString("#a09282");
  hemi.specular = Color3.Black();

  const sun = new DirectionalLight("light_sun", SUN_DIRECTION, scene);
  sun.position = SUN_DIRECTION.scale(-80);
  sun.intensity = 0.8;
  sun.diffuse = Color3.FromHexString("#fff3de");
  sun.specular = new Color3(0.4, 0.4, 0.4);

  const shadowGenerator = createSunShadows(sun);
  const materials = new LevelMaterials(scene);

  const addShadowCaster = (mesh: AbstractMesh) => {
    shadowGenerator.addShadowCaster(mesh);
    mesh.receiveShadows = true;
  };

  return {
    sun,
    shadowGenerator,
    addShadowCaster,
    decorateLevel(level) {
      for (const mesh of level.meshes) {
        const kind = level.surfaceOf.get(mesh);
        if (kind) materials.apply(mesh, kind);
        mesh.receiveShadows = true;
        // The ground slab is the lowest thing in the level; it never shadows anything.
        if (kind !== "ground") shadowGenerator.addShadowCaster(mesh);
      }
    },
  };
}

function createSunShadows(sun: DirectionalLight): ShadowGenerator {
  if (!CascadedShadowGenerator.IsSupported) {
    const generator = new ShadowGenerator(2048, sun);
    generator.usePercentageCloserFiltering = true;
    generator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
    generator.bias = 0.001;
    generator.normalBias = 0.02;
    return generator;
  }
  // The camera is resolved from scene.activeCamera each frame, so it may be assigned later.
  const generator = new CascadedShadowGenerator(2048, sun);
  generator.numCascades = 3;
  generator.lambda = 0.8;
  generator.shadowMaxZ = 90;
  generator.stabilizeCascades = true;
  generator.cascadeBlendPercentage = 0.1;
  generator.usePercentageCloserFiltering = true;
  generator.filteringQuality = ShadowGenerator.QUALITY_MEDIUM;
  generator.bias = 0.001;
  generator.normalBias = 0.02;
  return generator;
}
