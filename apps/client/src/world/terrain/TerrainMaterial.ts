import {
  Constants,
  MaterialPluginBase,
  PBRMaterial,
  RawTexture,
  ShaderLanguage,
  Texture,
  type AbstractEngine,
  type BaseTexture,
  type MaterialDefines,
  type Nullable,
  type Scene,
  type SubMesh,
  type UniformBuffer,
} from "@babylonjs/core";
import type { Terrain } from "@twobullets/shared";
import { TEXTURE_SETS, type TextureSetId, type Vec3 } from "../environmentManifest";
import { ENVIRONMENT_ASSET_ROOT, waitForTexture } from "../materials";

/**
 * Terrain look. Layers reuse the Poly Haven scans already shipped for the arena:
 * grass = forest ground, dirt = the same scan desaturated and tinted, rock = worn concrete (triplanar), road = asphalt.
 */
const LOOK = {
  /** The forest-floor scan is leaf-litter brown; a slight green lift reads more like open grassland. */
  grass: { set: "forrest_ground_01", meters: 2.4, tint: [0.92, 1.04, 0.82] as Vec3 },
  /** Worn concrete is darker than weathered rock (mean albedo ~0.09); brighten and warm it. */
  rock: { set: "concrete_floor_worn_001", meters: 5, tint: [2.3, 2.15, 1.9] as Vec3 },
  road: { set: "asphalt_02", meters: 4 },
  /** Linear multiplier on the desaturated grass scan. */
  dirtTint: [1.05, 0.82, 0.58] as Vec3,
  macro: { set: "aerial_grass_rock" as TextureSetId, colorMeters: 190, lumaMeters: 47, colorStrength: 0.5, lumaStrength: 0.4 },
  /** Second grass sample at this scale factor and rotation, blended in by macro noise to hide the tile. */
  antiTileScale: 0.37,
  /** Pseudo-height contrast and blend depth for layer transitions. */
  heightBlend: { contrast: 0.6, depth: 0.25 },
  /** Distance band over which texture detail fades toward each layer's mean color, m. */
  detailFade: { start: 35, end: 450 },
} as const;

const SAMPLERS = [
  "tsMask",
  "tsGrassAlbedo",
  "tsGrassNormal",
  "tsGrassArm",
  "tsRockAlbedo",
  "tsRockNormal",
  "tsRockArm",
  "tsRoadAlbedo",
  "tsRoadNormal",
  "tsRoadArm",
  "tsMacro",
] as const;
type SamplerName = (typeof SAMPLERS)[number];

const FRAGMENT_DEFINITIONS = /* glsl */ `
#ifdef TERRAIN_SPLAT
${SAMPLERS.map((s) => `uniform sampler2D ${s};`).join("\n")}
// Written in main before lighting, read inside reflectivityBlock (a separate function).
float tsRoughness;

vec3 tsUnpackNormal(vec4 t) { return t.xyz * 2.0 - 1.0; }

// Whiteout blend of a tangent normal from an XZ (top) projection onto the surface normal.
vec3 tsTopNormal(vec3 t, vec3 n) { return normalize(vec3(t.x + n.x, abs(t.z) * n.y, t.y + n.z)); }

struct TsSample { vec3 albedo; vec3 normal; vec3 arm; };

TsSample tsSampleGrad(sampler2D albedoTex, sampler2D normalTex, sampler2D armTex, vec2 uv, vec2 ddx, vec2 ddy) {
  TsSample s;
  s.albedo = toLinearSpace(textureGrad(albedoTex, uv, ddx, ddy).rgb);
  s.normal = tsUnpackNormal(textureGrad(normalTex, uv, ddx, ddy));
  s.arm = textureGrad(armTex, uv, ddx, ddy).rgb;
  return s;
}
#endif
`;

const FRAGMENT_BEFORE_LIGHTS = /* glsl */ `
#ifdef TERRAIN_SPLAT
{
  vec3 p = vPositionW;
  vec3 n = normalize(vNormalW);
  vec3 dpdx = dFdx(p);
  vec3 dpdy = dFdy(p);
  float viewDistance = length(vEyePosition.xyz - p);
  float fade = smoothstep(tsFade.x, tsFade.y, viewDistance);

  vec4 w = texture2D(tsMask, (p.xz - tsMaskInfo.xy) * tsMaskInfo.z + tsMaskInfo.w);
  // Past the heightfield (horizon mesh) the mask clamps; steep ground still turns to rock.
  w.b = max(w.b, smoothstep(0.8, 0.62, n.y));

  vec3 macroColor = min(toLinearSpace(texture2D(tsMacro, p.xz * tsMacroScale.x).rgb) / tsMacroMean.rgb, vec3(2.5));
  float macroLuma = getLuminance(toLinearSpace(texture2D(tsMacro, p.zx * tsMacroScale.y + 0.37).rgb)) / tsMacroMean.a;

  // Grass (and dirt): two top-projected samples at different scales and rotations, mixed by macro noise.
  float sg = tsScale.x;
  TsSample grass = tsSampleGrad(tsGrassAlbedo, tsGrassNormal, tsGrassArm, p.xz * sg, dpdx.xz * sg, dpdy.xz * sg);
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  float sg2 = sg * tsScale.w;
  vec3 grassAlt = toLinearSpace(textureGrad(tsGrassAlbedo, rot * p.xz * sg2 + 0.5, rot * dpdx.xz * sg2, rot * dpdy.xz * sg2).rgb);
  grass.albedo = mix(grass.albedo, grassAlt, smoothstep(0.75, 1.25, macroLuma) * 0.6);
  vec3 dirtAlbedo = mix(vec3(getLuminance(grass.albedo)), grass.albedo, 0.3) * tsDirtTint.rgb;
  grass.albedo *= tsGrassTint.rgb;
  grass.albedo = mix(grass.albedo, tsGrassMean.rgb, fade * 0.5);

  TsSample rock;
  rock.albedo = vec3(0.0); rock.normal = vec3(0.0, 0.0, 1.0); rock.arm = vec3(1.0);
  vec3 rockNormalW = n;
  if (w.b > 0.004) {
    // Triplanar so cliffs don't stretch.
    vec3 bw = abs(n); bw *= bw; bw *= bw; bw /= bw.x + bw.y + bw.z;
    float sr = tsScale.y;
    TsSample rx = tsSampleGrad(tsRockAlbedo, tsRockNormal, tsRockArm, p.zy * sr, dpdx.zy * sr, dpdy.zy * sr);
    TsSample ry = tsSampleGrad(tsRockAlbedo, tsRockNormal, tsRockArm, p.xz * sr, dpdx.xz * sr, dpdy.xz * sr);
    TsSample rz = tsSampleGrad(tsRockAlbedo, tsRockNormal, tsRockArm, p.xy * sr, dpdx.xy * sr, dpdy.xy * sr);
    rock.albedo = (rx.albedo * bw.x + ry.albedo * bw.y + rz.albedo * bw.z) * tsRockTint.rgb;
    rock.albedo = mix(rock.albedo, tsRockMean.rgb, fade * 0.5);
    rock.arm = rx.arm * bw.x + ry.arm * bw.y + rz.arm * bw.z;
    vec3 nx = vec3(rx.normal.xy + n.zy, abs(rx.normal.z) * n.x);
    vec3 ny = vec3(ry.normal.xy + n.xz, abs(ry.normal.z) * n.y);
    vec3 nz = vec3(rz.normal.xy + n.xy, abs(rz.normal.z) * n.z);
    rockNormalW = normalize(mix(n, normalize(nx.zyx * bw.x + ny.xzy * bw.y + nz.xyz * bw.z), 1.0 - fade * 0.7));
  }

  TsSample road;
  road.albedo = vec3(0.0); road.normal = vec3(0.0, 0.0, 1.0); road.arm = vec3(1.0);
  if (w.a > 0.004) {
    float sd = tsScale.z;
    road = tsSampleGrad(tsRoadAlbedo, tsRoadNormal, tsRoadArm, p.xz * sd, dpdx.xz * sd, dpdy.xz * sd);
    road.albedo = mix(road.albedo, tsRoadMean.rgb, fade * 0.5);
  }

  // Height-based blend: the layer that "sticks out" (bright grit, rock bumps) wins at transitions.
  vec4 present = step(vec4(0.004), w);
  vec4 heights = vec4(grass.arm.r, 1.0 - grass.arm.r, getLuminance(rock.albedo) * 4.0, road.arm.r) * tsBlend.x;
  vec4 hw = w + heights * present;
  float top = max(max(hw.x, hw.y), max(hw.z, hw.w)) - tsBlend.y;
  w = max(hw - top, 0.0) * present;
  w /= max(w.x + w.y + w.z + w.w, 1e-4);

  vec3 albedo = grass.albedo * w.x + dirtAlbedo * w.y + rock.albedo * w.z + road.albedo * w.w;
  // The aerial scan is grassland: tint soil layers fully, rock and road lightly.
  albedo *= mix(vec3(1.0), macroColor, tsMacroStrength.x * (w.x + w.y + 0.3 * (w.z + w.w)));
  albedo *= mix(1.0, macroLuma, tsMacroStrength.y);
  float ao = grass.arm.r * (w.x + w.y) + rock.arm.r * w.z + road.arm.r * w.w;
  surfaceAlbedo = saturate(albedo * mix(1.0, ao, 0.45));

  tsRoughness = clamp(grass.arm.g * w.x + min(grass.arm.g + 0.1, 1.0) * w.y + rock.arm.g * w.z + road.arm.g * w.w, 0.35, 1.0);

  // Top-projected layers share a tangent frame, so their normals blend before going to world space.
  vec3 topNormal = grass.normal * (w.x + w.y * tsDirtTint.a) + road.normal * w.w;
  topNormal.xy *= 1.0 - fade * 0.7;
  topNormal.z = max(topNormal.z, 1e-3);
  vec3 topNormalW = tsTopNormal(normalize(topNormal + vec3(0.0, 0.0, 1e-4)), n);
  normalW = normalize(mix(topNormalW, rockNormalW, w.z));
}
#endif
`;

const FRAGMENT_UPDATE_METALLICROUGHNESS = /* glsl */ `
#ifdef TERRAIN_SPLAT
metallicRoughness.r = 0.0;
metallicRoughness.g = tsRoughness;
#endif
`;

/** Splat layers driven by the shared surface mask, injected into PBRMaterial. */
class TerrainSplatPlugin extends MaterialPluginBase {
  constructor(
    material: PBRMaterial,
    private readonly textures: Record<SamplerName, BaseTexture>,
    private readonly maskInfo: readonly [number, number, number, number],
  ) {
    super(material, "TerrainSplat", 200, { TERRAIN_SPLAT: false }, true, true);
  }

  override getClassName(): string {
    return "TerrainSplatPlugin";
  }

  override isCompatible(shaderLanguage: ShaderLanguage): boolean {
    return shaderLanguage === ShaderLanguage.GLSL;
  }

  override isReadyForSubMesh(_defines: MaterialDefines, _scene: Scene, _engine: AbstractEngine, _subMesh: SubMesh): boolean {
    return SAMPLERS.every((name) => this.textures[name].isReady());
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["TERRAIN_SPLAT"] = true;
  }

  override getSamplers(samplers: string[]): void {
    samplers.push(...SAMPLERS);
  }

  override getActiveTextures(activeTextures: BaseTexture[]): void {
    activeTextures.push(...Object.values(this.textures));
  }

  override hasTexture(texture: BaseTexture): boolean {
    return Object.values(this.textures).includes(texture);
  }

  override getUniforms() {
    const names = ["tsMaskInfo", "tsScale", "tsMacroScale", "tsMacroMean", "tsMacroStrength", "tsGrassTint", "tsDirtTint", "tsRockTint", "tsBlend", "tsFade", "tsGrassMean", "tsRockMean", "tsRoadMean"];
    return {
      ubo: names.map((name) => ({ name, size: 4, type: "vec4" })),
      fragment: names.map((name) => `uniform vec4 ${name};`).join("\n"),
    };
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    const macro = TEXTURE_SETS[LOOK.macro.set];
    const [mr, mg, mb] = macro.meanAlbedo;
    const mean = (set: TextureSetId, tint: Vec3 = [1, 1, 1]) => TEXTURE_SETS[set].meanAlbedo.map((c, i) => c * tint[i]!) as [number, number, number];
    ubo.updateFloat4("tsMaskInfo", ...this.maskInfo);
    ubo.updateFloat4("tsScale", 1 / LOOK.grass.meters, 1 / LOOK.rock.meters, 1 / LOOK.road.meters, LOOK.antiTileScale);
    ubo.updateFloat4("tsMacroScale", 1 / LOOK.macro.colorMeters, 1 / LOOK.macro.lumaMeters, 0, 0);
    ubo.updateFloat4("tsMacroMean", mr, mg, mb, 0.2126 * mr + 0.7152 * mg + 0.0722 * mb);
    ubo.updateFloat4("tsMacroStrength", LOOK.macro.colorStrength, LOOK.macro.lumaStrength, 0, 0);
    // Dirt normal strength rides in alpha.
    ubo.updateFloat4("tsDirtTint", ...LOOK.dirtTint, 0.6);
    ubo.updateFloat4("tsGrassTint", ...LOOK.grass.tint, 0);
    ubo.updateFloat4("tsRockTint", ...LOOK.rock.tint, 0);
    ubo.updateFloat4("tsBlend", LOOK.heightBlend.contrast, LOOK.heightBlend.depth, 0, 0);
    ubo.updateFloat4("tsFade", LOOK.detailFade.start, LOOK.detailFade.end, 0, 0);
    ubo.updateFloat4("tsGrassMean", ...mean(LOOK.grass.set, LOOK.grass.tint), 0);
    ubo.updateFloat4("tsRockMean", ...mean(LOOK.rock.set, LOOK.rock.tint), 0);
    ubo.updateFloat4("tsRoadMean", ...mean(LOOK.road.set), 0);
    for (const name of SAMPLERS) ubo.setTexture(name, this.textures[name]);
  }

  override getCustomCode(shaderType: string): Nullable<Record<string, string>> {
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: FRAGMENT_DEFINITIONS,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: FRAGMENT_BEFORE_LIGHTS,
      CUSTOM_FRAGMENT_UPDATE_METALLICROUGHNESS: FRAGMENT_UPDATE_METALLICROUGHNESS,
    };
  }
}

/**
 * PBR terrain material: one shader for every chunk and the horizon. Blends grass/dirt/rock/road from the terrain's
 * surface mask (uploaded as an RGBA texture, one texel per height sample) with height-aware transitions, triplanar
 * rock, macro color variation and distance detail fade. Lit by the scene's sun, shadows and IBL like other PBR.
 */
export class TerrainMaterial {
  readonly material: PBRMaterial;
  readonly ready: Promise<void>;

  constructor(scene: Scene, terrain: Terrain) {
    const { field } = terrain;
    const material = new PBRMaterial("mat_terrain", scene);
    material.metallic = 0;
    material.roughness = 1;
    material.enableSpecularAntiAliasing = true;
    this.material = material;

    const mask = RawTexture.CreateRGBATexture(terrain.surface.weights, field.resolution, field.resolution, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE);
    mask.name = "terrain_surfaceMask";
    mask.wrapU = Texture.CLAMP_ADDRESSMODE;
    mask.wrapV = Texture.CLAMP_ADDRESSMODE;

    const layerTexture = (file: string, anisotropy: number) => {
      const texture = new Texture(ENVIRONMENT_ASSET_ROOT + file, scene, { samplingMode: Texture.TRILINEAR_SAMPLINGMODE });
      texture.anisotropicFilteringLevel = anisotropy;
      return texture;
    };
    const grass = TEXTURE_SETS[LOOK.grass.set];
    const rock = TEXTURE_SETS[LOOK.rock.set];
    const road = TEXTURE_SETS[LOOK.road.set];
    const textures: Record<SamplerName, BaseTexture> = {
      tsMask: mask,
      tsGrassAlbedo: layerTexture(grass.albedo, 16),
      tsGrassNormal: layerTexture(grass.normal, 16),
      tsGrassArm: layerTexture(grass.arm, 8),
      tsRockAlbedo: layerTexture(rock.albedo, 8),
      tsRockNormal: layerTexture(rock.normal, 8),
      tsRockArm: layerTexture(rock.arm, 4),
      tsRoadAlbedo: layerTexture(road.albedo, 16),
      tsRoadNormal: layerTexture(road.normal, 16),
      tsRoadArm: layerTexture(road.arm, 8),
      tsMacro: layerTexture(TEXTURE_SETS[LOOK.macro.set].albedo, 4),
    };
    // Mask texel centers sit on height samples: uv = ((xz - min) / spacing + 0.5) / resolution.
    const texel = 1 / (field.spacing * field.resolution);
    new TerrainSplatPlugin(material, textures, [field.minX, field.minZ, texel, 0.5 / field.resolution]);

    this.ready = Promise.all(Object.values(textures).filter((t) => t !== mask).map(waitForTexture)).then(() => undefined);
  }
}
