import { Color3, Vector3, type DirectionalLight, type HemisphericLight, type Scene } from "@babylonjs/core";

/**
 * Scene lighting as the unlit FX shaders need it. The FX write after tone mapping, so lit smoke, dust and decals are
 * converted here the way the PBR output looks: linear radiance × exposure → ACES fit → sRGB gamma. Refreshed once per
 * frame by the smoke renderer (it owns the environment reference); defaults are a neutral daylight.
 */
export class VfxLighting {
  /** Unit vector toward the sun. */
  readonly toSun = new Vector3(0.4, 0.8, 0.4).normalize();
  /** Linear irradiance (diffuse × intensity). */
  readonly sun = new Color3(2.4, 2.3, 2.1);
  readonly sky = new Color3(0.55, 0.62, 0.75);
  readonly ground = new Color3(0.25, 0.22, 0.18);
  exposure = 1;

  /** Display colors of a white diffuse surface: sun side, shade side, underside (ground bounce). */
  readonly lit = new Color3(0.9, 0.9, 0.88);
  readonly shade = new Color3(0.55, 0.58, 0.62);
  readonly under = new Color3(0.45, 0.43, 0.4);

  refresh(sun: DirectionalLight, skyFill: HemisphericLight, scene: Scene): void {
    this.toSun.copyFrom(sun.direction).scaleInPlace(-1).normalize();
    this.sun.copyFrom(sun.diffuse).scaleInPlace(sun.intensity);
    this.sky.copyFrom(skyFill.diffuse).scaleInPlace(skyFill.intensity);
    this.ground.copyFrom(skyFill.groundColor).scaleInPlace(skyFill.intensity);
    this.exposure = scene.imageProcessingConfiguration.exposure;
    this.displayToRef(1, 1, 1, 0.85, 1, 0, this.lit);
    this.displayToRef(1, 1, 1, 0.12, 1, 0, this.shade);
    this.displayToRef(1, 1, 1, 0, 0.6, 0.35, this.under);
  }

  /** Display color of a diffuse surface with linear albedo (r, g, b) under sunAmount × sun + skyAmount × sky + groundAmount × ground. */
  displayToRef(r: number, g: number, b: number, sunAmount: number, skyAmount: number, groundAmount: number, result: Color3): Color3 {
    const e = this.exposure;
    const s = this.sun;
    const k = this.sky;
    const d = this.ground;
    result.r = aces(r * e * (s.r * sunAmount + k.r * skyAmount + d.r * groundAmount));
    result.g = aces(g * e * (s.g * sunAmount + k.g * skyAmount + d.g * groundAmount));
    result.b = aces(b * e * (s.b * sunAmount + k.b * skyAmount + d.b * groundAmount));
    return result;
  }
}

/** ACES filmic fit plus sRGB gamma, per channel. */
export function aces(x: number): number {
  const mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return Math.pow(Math.min(1, Math.max(0, mapped)), 1 / 2.2);
}
