import {
  MaterialPluginBase,
  ShaderLanguage,
  type AbstractEngine,
  type BaseTexture,
  type Material,
  type MaterialDefines,
  type Nullable,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from "@babylonjs/core";
import type { Vec3 } from "./environmentManifest";

export interface SurfaceVariationSettings {
  /** World meters per repeat of the color tint layer; 0 disables it. */
  readonly colorMeters: number;
  /** 0 = no tint, 1 = albedo fully multiplied by the normalized macro color. */
  readonly colorStrength: number;
  /** World meters per repeat of the brightness layer (a second, rotated sample). */
  readonly lumaMeters: number;
  readonly lumaStrength: number;
  /** Albedo darkening at world y = 0 (dirt and splash near the ground), fading out by `grimeHeight`. */
  readonly grimeStrength: number;
  readonly grimeHeight: number;
}

const NO_VARIATION: SurfaceVariationSettings = { colorMeters: 1, colorStrength: 0, lumaMeters: 1, lumaStrength: 0, grimeStrength: 0, grimeHeight: 1 };

const SAMPLER = "surfaceVariationSampler";

const FRAGMENT_DEFINITIONS = /* glsl */ `
#ifdef SURFACE_VARIATION
uniform sampler2D ${SAMPLER};
// World-space planar projection along the dominant axis of the geometric normal; level blocks are flat-shaded.
vec2 svProject(vec3 p, vec3 n) {
  vec3 a = abs(n);
  return a.y >= max(a.x, a.z) ? p.xz : (a.x >= a.z ? p.zy : p.xy);
}
#endif
`;

// surfaceAlbedo is linear here; lighting has not been evaluated yet.
const FRAGMENT_BEFORE_LIGHTS = /* glsl */ `
#ifdef SURFACE_VARIATION
{
  vec2 svUv = svProject(vPositionW, vNormalW);
  // Clamped: channels with a tiny mean (blue in a grass scan) would otherwise spike on rocks.
  vec3 svColor = min(toLinearSpace(texture2D(${SAMPLER}, svUv * svScale.x).rgb) / svMean.rgb, vec3(2.5));
  float svLuma = getLuminance(toLinearSpace(texture2D(${SAMPLER}, svUv.yx * svScale.y + 0.37).rgb)) / svMean.a;
  float svGrime = 1.0 - svStrength.z * (1.0 - smoothstep(0.0, svScale.z, vPositionW.y));
  surfaceAlbedo = saturate(surfaceAlbedo * mix(vec3(1.0), svColor, svStrength.x) * mix(1.0, svLuma, svStrength.y) * svGrime);
}
#endif
`;

/**
 * Breaks up visible tiling on large surfaces by modulating albedo with a low-frequency texture sampled
 * in world space (two scales, one tinting and one brightness-only) plus a height-based grime term.
 */
export class SurfaceVariationPlugin extends MaterialPluginBase {
  private readonly meanLuminance: number;

  constructor(
    material: Material,
    private readonly texture: BaseTexture,
    /** Linear mean albedo of `texture`, so the modulation averages to ~1. */
    private readonly textureMean: Vec3,
    private readonly settings: SurfaceVariationSettings = NO_VARIATION,
  ) {
    super(material, "SurfaceVariation", 200, { SURFACE_VARIATION: false }, true, true);
    this.meanLuminance = 0.2126 * textureMean[0] + 0.7152 * textureMean[1] + 0.0722 * textureMean[2];
  }

  override getClassName(): string {
    return "SurfaceVariationPlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL;
  }

  override isReadyForSubMesh(_defines: MaterialDefines, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): boolean {
    return this.texture.isReady();
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["SURFACE_VARIATION"] = true;
  }

  override getSamplers(samplers: string[]): void {
    samplers.push(SAMPLER);
  }

  override getActiveTextures(activeTextures: BaseTexture[]): void {
    activeTextures.push(this.texture);
  }

  override hasTexture(texture: BaseTexture): boolean {
    return texture === this.texture;
  }

  override getUniforms() {
    return {
      ubo: [
        { name: "svScale", size: 4, type: "vec4" },
        { name: "svStrength", size: 4, type: "vec4" },
        { name: "svMean", size: 4, type: "vec4" },
      ],
      fragment: "uniform vec4 svScale;\nuniform vec4 svStrength;\nuniform vec4 svMean;",
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const s = this.settings;
    const [r, g, b] = this.textureMean;
    uniformBuffer.updateFloat4("svScale", 1 / s.colorMeters, 1 / s.lumaMeters, s.grimeHeight, 0);
    uniformBuffer.updateFloat4("svStrength", s.colorStrength, s.lumaStrength, s.grimeStrength, 0);
    uniformBuffer.updateFloat4("svMean", r, g, b, this.meanLuminance);
    uniformBuffer.setTexture(SAMPLER, this.texture);
  }

  override getCustomCode(shaderType: string): Nullable<Record<string, string>> {
    if (shaderType !== "fragment") return null;
    return { CUSTOM_FRAGMENT_DEFINITIONS: FRAGMENT_DEFINITIONS, CUSTOM_FRAGMENT_BEFORE_LIGHTS: FRAGMENT_BEFORE_LIGHTS };
  }
}
