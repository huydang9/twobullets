import type { Scene } from "@babylonjs/core";
import { setAntiAliasingPass } from "../world/postEffects";
import { OPTIMIZATIONS } from "./flags";

export type QualityPreset = "high" | "balanced" | "performance";
/** "msaa": the canvas's multisampling. "fxaa": single-sample scene target plus one FXAA pass (postEffects.ts). */
export type AntiAliasing = "msaa" | "fxaa";

export interface GraphicsSettings {
  readonly preset: QualityPreset;
  readonly antiAliasing: AntiAliasing;
  /** Adaptive resolution (below the preset's scale) toward 120 FPS; takes effect on the next start. */
  readonly dynamicResolution: boolean;
}

/** Linear render scale per preset, relative to the display's native pixels. */
export const RENDER_SCALE: Readonly<Record<QualityPreset, number>> = { high: 1, balanced: 0.8, performance: 0.6 };

const PRESETS: readonly QualityPreset[] = ["high", "balanced", "performance"];
const ANTI_ALIASING: readonly AntiAliasing[] = ["msaa", "fxaa"];
const STORAGE_KEY = "twobullets.graphics.v1";

/** Balanced on high-density (DPR ≥ 2) displays, where native resolution is the dominant GPU cost; High elsewhere. */
export function defaultGraphicsSettings(devicePixelRatio: number = globalThis.devicePixelRatio ?? 1): GraphicsSettings {
  return { preset: devicePixelRatio >= 2 ? "balanced" : "high", antiAliasing: "msaa", dynamicResolution: false };
}

/** Saved settings, falling back to the defaults field by field. */
export function loadGraphicsSettings(): GraphicsSettings {
  const defaults = defaultGraphicsSettings();
  let saved: Partial<Record<keyof GraphicsSettings, unknown>> = {};
  try {
    saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "{}") as typeof saved;
  } catch {
    // Unavailable storage or a corrupt entry: defaults.
  }
  return {
    preset: PRESETS.find((p) => p === saved.preset) ?? defaults.preset,
    antiAliasing: ANTI_ALIASING.find((a) => a === saved.antiAliasing) ?? defaults.antiAliasing,
    dynamicResolution: typeof saved.dynamicResolution === "boolean" ? saved.dynamicResolution : defaults.dynamicResolution,
  };
}

export function saveGraphicsSettings(settings: GraphicsSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: the settings still apply for this session.
  }
}

/**
 * Applies graphics settings to a scene's engine: hardware scaling for the render scale and the anti-aliasing pass.
 * Created once per scene at startup (createEnvironment); a settings menu calls `update`.
 */
export class GraphicsController {
  /** Hardware scaling level of the engine's native resolution (1 / devicePixelRatio with adaptToDeviceRatio). */
  private readonly nativeLevel: number;
  private settings: GraphicsSettings;
  private scale = 1;

  constructor(
    private readonly scene: Scene,
    settings: GraphicsSettings,
  ) {
    this.nativeLevel = scene.getEngine().getHardwareScalingLevel();
    this.settings = settings;
    this.apply();
    // Game reads this flag after the environment exists, when it decides whether to create the controller.
    if (settings.dynamicResolution) OPTIMIZATIONS.dynamicResolution = true;
  }

  get current(): GraphicsSettings {
    return this.settings;
  }

  /** Linear render scale in use, relative to native. */
  get renderScale(): number {
    return this.scale;
  }

  /** Applies a change now and saves it (dynamic resolution takes effect on the next start). */
  update(change: Partial<GraphicsSettings>, save = true): void {
    this.settings = { ...this.settings, ...change };
    if (save) saveGraphicsSettings(this.settings);
    this.apply();
  }

  /** Temporary render scale (benchmark variants); `update` or `apply` restores the preset. */
  setRenderScale(scale: number): void {
    this.scale = scale;
    this.scene.getEngine().setHardwareScalingLevel(this.nativeLevel / scale);
  }

  apply(): void {
    this.setRenderScale(RENDER_SCALE[this.settings.preset]);
    setAntiAliasingPass(this.scene, this.settings.antiAliasing);
  }
}

const controllers = new WeakMap<Scene, GraphicsController>();

/**
 * Installs the saved graphics settings on a scene. In DEV, `?quality=high|balanced|performance`, `?aa=msaa|fxaa` and
 * `?dynres=1` override them for the session without saving.
 */
export function installGraphics(scene: Scene): GraphicsController {
  let settings = loadGraphicsSettings();
  if (import.meta.env?.DEV && typeof location !== "undefined") {
    const params = new URLSearchParams(location.search);
    const preset = PRESETS.find((p) => p === params.get("quality"));
    const antiAliasing = ANTI_ALIASING.find((a) => a === params.get("aa"));
    const dynres = params.get("dynres");
    settings = { ...settings, ...(preset ? { preset } : {}), ...(antiAliasing ? { antiAliasing } : {}), ...(dynres ? { dynamicResolution: dynres === "1" } : {}) };
  }
  const controller = new GraphicsController(scene, settings);
  controllers.set(scene, controller);
  if (import.meta.env?.DEV && typeof window !== "undefined") Object.assign(window, { __twobulletsGraphics: controller });
  return controller;
}

export function graphicsOf(scene: Scene): GraphicsController | undefined {
  return controllers.get(scene);
}
