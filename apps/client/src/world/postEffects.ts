import { DefaultRenderingPipeline, SSAO2RenderingPipeline, type Camera, type Scene } from "@babylonjs/core";

export interface PostEffectSettings {
  /**
   * Screen-space ambient occlusion (half resolution, 16 samples). Adds a geometry buffer pass plus
   * blur, roughly 1.5–3 ms per frame at 1440p on a mid-range desktop GPU. Also darkens the viewmodel
   * where it overlaps world depth.
   */
  readonly ssao: boolean;
  /** HDR bloom on the sun-lit sky and specular highlights. Moves tone mapping into a post-process. */
  readonly bloom: boolean;
}

/**
 * Attaches the enabled post effects to the active camera. The camera is created after the environment,
 * so this waits for it. With both effects off nothing is installed and tone mapping stays in the
 * forward shaders (cheapest path, keeps canvas MSAA).
 */
export function installPostEffects(scene: Scene, settings: PostEffectSettings): void {
  if (!settings.ssao && !settings.bloom) return;

  const attach = (camera: Camera) => {
    if (settings.ssao) {
      const ssao = new SSAO2RenderingPipeline("ssao", scene, { ssaoRatio: 0.5, blurRatio: 1 }, [camera]);
      ssao.radius = 1.2;
      ssao.totalStrength = 1.0;
      ssao.samples = 16;
      ssao.maxZ = 80;
      ssao.expensiveBlur = true;
      ssao.textureSamples = 4;
    }
    if (settings.bloom) {
      const pipeline = new DefaultRenderingPipeline("post", true, scene, [camera]);
      pipeline.samples = 4;
      pipeline.imageProcessingEnabled = true;
      pipeline.bloomEnabled = true;
      pipeline.bloomThreshold = 1.2;
      pipeline.bloomWeight = 0.12;
      pipeline.bloomKernel = 64;
      pipeline.bloomScale = 0.5;
    }
  };

  if (scene.activeCamera) attach(scene.activeCamera);
  else scene.onActiveCameraChanged.addOnce(() => scene.activeCamera && attach(scene.activeCamera));
}
