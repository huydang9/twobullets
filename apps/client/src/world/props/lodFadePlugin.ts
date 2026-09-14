import {
  MaterialPluginBase,
  PBRMaterial,
  ShaderLanguage,
  type AbstractMesh,
  type Material,
  type MaterialDefines,
  type Nullable,
  type Scene,
  type UniformBuffer,
} from "@babylonjs/core";
import { OPTIMIZATIONS } from "../../perf/flags";

/** Per-thin-instance float written by PropInstances; see InstanceBatch.fades for the encoding. */
export const LOD_FADE_ATTRIBUTE = "lodFade";

/** Alpha multiplier added per mip level below the base texture (Golus' "alpha to coverage mip scale"). */
const ALPHA_MIP_SCALE = 0.25;

const distanceFadeMeshes = new WeakSet<AbstractMesh>();
const distanceFade = { inner: 0, outer: 0 };
const plugins = new WeakMap<Material, LodFadePlugin>();

const VERTEX_DEFINITIONS = /* glsl */ `
#ifdef LOD_FADE
attribute float ${LOD_FADE_ATTRIBUTE};
varying float vLodFade;
#endif
`;

const VERTEX_MAIN_END = /* glsl */ `
#ifdef LOD_FADE
vLodFade = ${LOD_FADE_ATTRIBUTE};
#endif
`;

// Shrinks each instance about its pivot toward the edge of the camera radius: the fade follows the live camera instead
// of the position the buffer was built at.
const VERTEX_UPDATE_WORLDPOS = /* glsl */ `
#ifdef LOD_DISTANCE_FADE
{
  vec3 lodPivot = finalWorld[3].xyz;
  float lodScale = 1.0 - smoothstep(lodDistanceFade.x, lodDistanceFade.y, distance(lodPivot.xz, vEyePosition.xz));
  worldPos.xyz = lodPivot + (worldPos.xyz - lodPivot) * lodScale;
  vPositionW = worldPos.xyz;
}
#endif
`;

const FRAGMENT_DEFINITIONS = /* glsl */ `
#ifdef LOD_FADE
varying float vLodFade;
#endif
float lodAlphaScale = 1.0;
`;

// Screen-door cross-fade with interleaved gradient noise, which is stable in screen space: a fading-in copy (fade p)
// keeps the pixels whose noise is below p and its fading-out partner (1 + p) exactly the others. Then the mip coverage
// term: cutout alpha averages down in smaller mips, so leaves thin out and crawl with distance unless alpha is scaled up.
const FRAGMENT_MAIN_BEGIN = /* glsl */ `
#ifdef LOD_FADE
if (abs(vLodFade - 1.0) > 0.001) {
  float lodNoise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (vLodFade < 1.0 ? lodNoise >= vLodFade : lodNoise < vLodFade - 1.0) discard;
}
#endif
#if defined(LOD_ALPHA_MIP) && defined(ALBEDO)
{
  vec2 lodTexel = vAlbedoUV * lodAlphaMip.xy;
  vec2 lodDx = dFdx(lodTexel);
  vec2 lodDy = dFdy(lodTexel);
  lodAlphaScale = 1.0 + max(0.0, 0.5 * log2(max(dot(lodDx, lodDx), dot(lodDy, lodDy)))) * lodAlphaMip.z;
}
#endif
`;

/**
 * Vegetation and prop stability features for PBR materials of thin-instanced batches:
 * - LOD_FADE: dithered LOD cross-fade from the per-instance `lodFade` attribute (meshes that have it);
 * - LOD_ALPHA_MIP: alpha-tested materials scale cutout alpha by mip level so foliage keeps its coverage at distance;
 * - LOD_DISTANCE_FADE: meshes registered with `enableDistanceFade` shrink out over a camera distance band (grass).
 * The shadow depth pass uses Babylon's own shader, so shadows switch without dithering.
 */
export class LodFadePlugin extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, "LodFade", 220, { LOD_FADE: false, LOD_ALPHA_MIP: false, LOD_DISTANCE_FADE: false }, true, true);
  }

  override getClassName(): string {
    return "LodFadePlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL;
  }

  override prepareDefines(defines: MaterialDefines, _scene: Scene, mesh: AbstractMesh): void {
    const material = this._material as PBRMaterial;
    defines["LOD_FADE"] = mesh.isVerticesDataPresent(LOD_FADE_ATTRIBUTE);
    defines["LOD_DISTANCE_FADE"] = distanceFadeMeshes.has(mesh);
    defines["LOD_ALPHA_MIP"] = material.transparencyMode === PBRMaterial.MATERIAL_ALPHATEST && material.albedoTexture !== null;
  }

  override getAttributes(attributes: string[], _scene: Scene, mesh: AbstractMesh): void {
    if (mesh.isVerticesDataPresent(LOD_FADE_ATTRIBUTE)) attributes.push(LOD_FADE_ATTRIBUTE);
  }

  override getUniforms() {
    return {
      ubo: [
        { name: "lodAlphaMip", size: 3, type: "vec3" },
        { name: "lodDistanceFade", size: 2, type: "vec2" },
      ],
      vertex: "uniform vec2 lodDistanceFade;",
      fragment: "uniform vec3 lodAlphaMip;",
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    const size = (this._material as PBRMaterial).albedoTexture?.getSize();
    uniformBuffer.updateFloat3("lodAlphaMip", size?.width ?? 0, size?.height ?? 0, OPTIMIZATIONS.foliageAlphaMipScale ? ALPHA_MIP_SCALE : 0);
    uniformBuffer.updateFloat2("lodDistanceFade", distanceFade.inner, distanceFade.outer);
  }

  override getCustomCode(shaderType: string): Nullable<Record<string, string>> {
    if (shaderType === "vertex") {
      return { CUSTOM_VERTEX_DEFINITIONS: VERTEX_DEFINITIONS, CUSTOM_VERTEX_UPDATE_WORLDPOS: VERTEX_UPDATE_WORLDPOS, CUSTOM_VERTEX_MAIN_END: VERTEX_MAIN_END };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: FRAGMENT_DEFINITIONS,
      CUSTOM_FRAGMENT_MAIN_BEGIN: FRAGMENT_MAIN_BEGIN,
      // The cutout test runs inside pbrBlockAlbedoOpacity, before any custom point, so the scale goes into its alpha term.
      "!alpha\\*=albedoTexture\\.a;": "alpha*=albedoTexture.a*lodAlphaScale;",
    };
  }
}

/** Adds the plugin to a PBR material once; other material types are left alone. */
export function attachLodFade(material: Material | null): void {
  if (!(material instanceof PBRMaterial) || plugins.has(material)) return;
  plugins.set(material, new LodFadePlugin(material));
}

/** Registers a mesh for the vertex distance fade (before its first render). The band is shared by all such meshes, m. */
export function enableDistanceFade(mesh: AbstractMesh, inner: number, outer: number): void {
  attachLodFade(mesh.material);
  distanceFadeMeshes.add(mesh);
  distanceFade.inner = inner;
  distanceFade.outer = outer;
}
