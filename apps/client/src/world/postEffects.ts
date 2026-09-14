import { DefaultRenderingPipeline, FxaaPostProcess, PassPostProcess, SSAO2RenderingPipeline, type Camera, type PostProcess, type Scene } from "@babylonjs/core";

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

/**
 * Final full-screen pass that takes over anti-aliasing from the canvas:
 * - "msaa": none; the scene draws straight into the canvas's multisampled back buffer.
 * - "fxaa": the scene draws into a single-sample target, then one FXAA pass writes the canvas (only that pass is
 *   multisampled, and a full-screen triangle costs next to nothing per extra sample).
 * - "resolve": same single-sample target with a plain copy, no anti-aliasing (benchmark reference for MSAA's cost).
 */
export type AntiAliasingPass = "msaa" | "fxaa" | "resolve";

const antiAliasingPasses = new WeakMap<Scene, { mode: AntiAliasingPass; postProcess: PostProcess | null }>();

export function setAntiAliasingPass(scene: Scene, mode: AntiAliasingPass): void {
  const current = antiAliasingPasses.get(scene);
  if (current?.mode === mode) return;
  const entry: { mode: AntiAliasingPass; postProcess: PostProcess | null } = { mode, postProcess: null };
  antiAliasingPasses.set(scene, entry);

  const attach = (camera: Camera) => {
    if (antiAliasingPasses.get(scene) !== entry) return;
    current?.postProcess?.dispose(camera);
    if (mode === "fxaa") entry.postProcess = new FxaaPostProcess("fxaa", 1, camera);
    else if (mode === "resolve") entry.postProcess = new PassPostProcess("resolve", 1, camera);
  };
  if (scene.activeCamera) attach(scene.activeCamera);
  else scene.onActiveCameraChanged.addOnce(() => scene.activeCamera && attach(scene.activeCamera));
}
