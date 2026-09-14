import {
  BackgroundMaterial,
  CreateBox,
  CubeTexture,
  HDRCubeTexture,
  HDRFiltering,
  Logger,
  Texture,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import { SKY } from "./environmentManifest";
import { ENVIRONMENT_ASSET_ROOT, waitForTexture } from "./materials";

export interface SkySettings {
  /** IBL cube face size. Level surfaces are rough, so 256 keeps reflections sharp enough. */
  readonly iblCubeSize: number;
  /** Importance samples per texel for GPU prefiltering (filtered importance sampling keeps 64 clean). */
  readonly iblFilterSamples: number;
}

/**
 * Visible sky: a camera-centered box sampling six LDR faces cut from the 4K HDRI. The faces are stored at
 * 1/skyScale of the panorama, so the material's level restores scene-referred values before tone mapping.
 */
export function createSkybox(scene: Scene): { mesh: Mesh; ready: Promise<void> } {
  const texture = new CubeTexture(
    SKY.faces.join("|"),
    scene,
    null,
    true,
    SKY.faces.map((file) => ENVIRONMENT_ASSET_ROOT + file),
  );
  texture.coordinatesMode = Texture.SKYBOX_MODE;
  texture.level = SKY.skyScale;

  const material = new BackgroundMaterial("mat_sky", scene);
  material.reflectionTexture = texture;
  material.backFaceCulling = false;
  // Dithering hides 8-bit banding in the smooth blue gradient.
  material.enableNoise = true;

  const mesh = CreateBox("skybox", { size: 1000 }, scene);
  mesh.material = material;
  mesh.infiniteDistance = true;
  mesh.applyFog = false;
  mesh.isPickable = false;
  mesh.receiveShadows = false;

  return { mesh, ready: waitForTexture(texture) };
}

/**
 * Image-based lighting from the sun-less panorama: CPU cube conversion and spherical harmonics on load,
 * then a short GPU prefilter pass. The texture is only assigned to the scene once filtered, so materials
 * compile once against the final IBL.
 */
export function loadImageBasedLighting(scene: Scene, settings: SkySettings): Promise<HDRCubeTexture> {
  return new Promise((resolve, reject) => {
    const texture: HDRCubeTexture = new HDRCubeTexture(
      ENVIRONMENT_ASSET_ROOT + SKY.iblPanorama,
      scene,
      settings.iblCubeSize,
      false, // mipmaps
      true, // spherical harmonics for diffuse irradiance
      false, // linear
      false, // prefiltered below with a lower sample count than the built-in 4096
      () => {
        new HDRFiltering(scene.getEngine(), { quality: settings.iblFilterSamples })
          .prefilter(texture)
          .catch((err: unknown) => Logger.Warn(`IBL prefiltering unavailable, using unfiltered reflections: ${String(err)}`))
          .finally(() => {
            scene.environmentTexture = texture;
            resolve(texture);
          });
      },
      (message) => reject(new Error(`Failed to load ${SKY.iblPanorama}: ${message ?? ""}`)),
    );
  });
}
