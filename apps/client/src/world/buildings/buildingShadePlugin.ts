import { MaterialPluginBase, ShaderLanguage, type Material, type MaterialDefines, type Nullable, type UniformBuffer } from "@babylonjs/core";

/** Vertex attribute written by BuildingVisuals: [baked sky visibility 0..1, height above the ground floor in m]. */
export const BUILDING_SHADE_ATTRIBUTE = "buildingShade";

export interface BuildingShadeSettings {
  /** Image-based lighting multiplier at zero sky visibility (a fully enclosed corner). 1 disables the effect. */
  minOcclusion: number;
  /** Visibility curve exponent; < 1 brightens partly open spots such as floors near windows. */
  exponent: number;
  /** Albedo darkening on walls at the ground floor, fading out by `grimeHeight`. */
  grimeStrength: number;
  grimeHeight: number;
}

const VERTEX_DEFINITIONS = /* glsl */ `
attribute vec2 ${BUILDING_SHADE_ATTRIBUTE};
varying vec2 vBuildingShade;
`;

const FRAGMENT_DEFINITIONS = /* glsl */ `
varying vec2 vBuildingShade;
`;

// Grime only on vertical faces: splash and dirt along the base of walls, not on floors.
const FRAGMENT_BEFORE_LIGHTS = /* glsl */ `
surfaceAlbedo *= 1.0 - bsGrime.x * (1.0 - smoothstep(0.0, bsGrime.y, vBuildingShade.y)) * (1.0 - abs(vNormalW.y));
`;

// Occludes only the environment (IBL) terms, so sunlight through windows and doors keeps its full strength and shadows.
const FRAGMENT_BEFORE_COMPOSITION = /* glsl */ `
#if defined(REFLECTION) && !defined(UNLIT)
{
  float bsOcclusion = mix(bsOcclusionParams.x, 1.0, pow(clamp(vBuildingShade.x, 0.0, 1.0), bsOcclusionParams.y));
  finalIrradiance *= bsOcclusion;
  finalRadianceScaled *= bsOcclusion;
}
#endif
`;

/**
 * Baked interior darkening for building meshes. The IBL has no notion of walls, so without this a room lit only by
 * its windows looks as bright as a shaded facade.
 */
export class BuildingShadePlugin extends MaterialPluginBase {
  constructor(
    material: Material,
    private readonly settings: BuildingShadeSettings,
  ) {
    super(material, "BuildingShade", 210, { BUILDING_SHADE: false }, true, true);
  }

  override getClassName(): string {
    return "BuildingShadePlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL;
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["BUILDING_SHADE"] = true;
  }

  override getAttributes(attributes: string[]): void {
    attributes.push(BUILDING_SHADE_ATTRIBUTE);
  }

  override getUniforms() {
    return {
      ubo: [
        { name: "bsOcclusionParams", size: 2, type: "vec2" },
        { name: "bsGrime", size: 2, type: "vec2" },
      ],
      fragment: "uniform vec2 bsOcclusionParams;\nuniform vec2 bsGrime;",
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const s = this.settings;
    uniformBuffer.updateFloat2("bsOcclusionParams", s.minOcclusion, s.exponent);
    uniformBuffer.updateFloat2("bsGrime", s.grimeStrength, s.grimeHeight);
  }

  override getCustomCode(shaderType: string): Nullable<Record<string, string>> {
    if (shaderType === "vertex") {
      return { CUSTOM_VERTEX_DEFINITIONS: VERTEX_DEFINITIONS, CUSTOM_VERTEX_MAIN_END: `vBuildingShade = ${BUILDING_SHADE_ATTRIBUTE};` };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: FRAGMENT_DEFINITIONS,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: FRAGMENT_BEFORE_LIGHTS,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: FRAGMENT_BEFORE_COMPOSITION,
    };
  }
}
