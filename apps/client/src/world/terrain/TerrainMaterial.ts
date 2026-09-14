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
import { OPTIMIZATIONS } from "../../perf/flags";
import { TEXTURE_SETS, type TextureSetId } from "../environmentManifest";
import { ENVIRONMENT_ASSET_ROOT, waitForTexture } from "../materials";

/**
 * Terrain look: one Poly Haven scan per mask layer. Layers ship albedo plus a packed NXA map (normal XY, AO), so each
 * costs two fetches; roughness is the scan's mean (from the build record) nudged up in cavities.
 */
const LOOK = {
  /** Dense grass blades over soil. The scan is dark olive; `targetAlbedo` sets the linear mean it is tinted to. */
  grass: { set: "sparse_grass", meters: 2.4, targetAlbedo: [0.12, 0.145, 0.042] },
  /** Brown forest soil with pebbles: pads, tracks, quarry floor. */
  dirt: { set: "forest_ground_04", meters: 3.15 },
  /** Weathered rock face, triplanar on cliffs and steep ground. */
  rock: { set: "rock_face_03", meters: 5 },
  /** Asphalt core with a gravel shoulder where the road weight fades out (shares the asphalt NXA). */
  road: { set: "asphalt_02", meters: 4 },
  shoulder: { set: "rocky_trail", meters: 2.5, weight: [0.3, 0.75] },
  macro: { set: "aerial_grass_rock" as TextureSetId, colorMeters: 190, lumaMeters: 47, colorStrength: 0.5, lumaStrength: 0.4 },
  /** Second grass sample at this scale factor and rotation, blended in by macro noise to hide the tile. */
  antiTileScale: 0.37,
  /** Pseudo-height contrast and blend depth for layer transitions. */
  heightBlend: { contrast: 0.6, depth: 0.25 },
  /** Distance band over which texture detail fades toward each layer's mean color, m. */
  detailFade: { start: 35, end: 450 },
  /** With terrainFarSimplify: normal/AO maps and the anti-tile grass sample fade out over this band, m. */
  farDetail: { start: 60, end: 85 },
} as const;

const SAMPLERS = [
  "tsMask",
  "tsGrassAlbedo",
  "tsGrassNxa",
  "tsDirtAlbedo",
  "tsDirtNxa",
  "tsRockAlbedo",
  "tsRockNxa",
  "tsRoadAlbedo",
  "tsRoadNxa",
  "tsShoulderAlbedo",
  "tsMacro",
] as const;
type SamplerName = (typeof SAMPLERS)[number];

// Layer fetches per pixel, excluding PBR/IBL/shadow samplers; mask + macro (3) are always taken.
//                     grass  dirt  rock  road (albedo, NXA, shoulder)
//   legacy              3     2     6     3      all layers present: 17
//   near (< 60 m)       3     2    2–4    3      biplanar takes 2 fetches per projection, 1 or 2 projections
//   far (> 85 m)        1     1    1–2    2      albedo only: no NXA, no anti-tile grass sample
// TS_WEIGHT_SKIP also skips layers whose weight can't survive the height blend, so blend edges rarely pay for all four.
const FRAGMENT_DEFINITIONS = /* glsl */ `
#ifdef TERRAIN_SPLAT
${SAMPLERS.map((s) => `uniform sampler2D ${s};`).join("\n")}
// Written in main before lighting, read inside reflectivityBlock (a separate function).
float tsRoughness;

// Whiteout blend of a tangent normal from an XZ (top) projection onto the surface normal.
vec3 tsTopNormal(vec3 t, vec3 n) { return normalize(vec3(t.x + n.x, abs(t.z) * n.y, t.y + n.z)); }

struct TsSample { vec3 albedo; vec3 normal; float ao; };

TsSample tsEmpty() { TsSample s; s.albedo = vec3(0.0); s.normal = vec3(0.0, 0.0, 1.0); s.ao = 1.0; return s; }

// Albedo, plus the packed normal and AO faded by detail (0 skips the NXA fetch: flat normal, no occlusion).
TsSample tsSampleLayer(sampler2D albedoTex, sampler2D nxaTex, vec2 uv, vec2 ddx, vec2 ddy, float detail) {
  TsSample s = tsEmpty();
  s.albedo = toLinearSpace(textureGrad(albedoTex, uv, ddx, ddy).rgb);
  if (detail > 0.0) {
    vec3 nxa = textureGrad(nxaTex, uv, ddx, ddy).rgb;
    vec2 xy = (nxa.xy * 2.0 - 1.0) * detail;
    s.normal = vec3(xy, sqrt(saturate(1.0 - dot(xy, xy))));
    s.ao = mix(1.0, nxa.b, detail);
  }
  return s;
}

// Rock projected along axis 0 (x), 1 (y) or 2 (z); the normal comes back whiteout-blended in world space (unnormalized).
TsSample tsRockProjection(int axis, vec3 p, vec3 ddxP, vec3 ddyP, vec3 n, float scale, float detail) {
  vec2 uv = axis == 0 ? p.zy : (axis == 1 ? p.xz : p.xy);
  vec2 gx = axis == 0 ? ddxP.zy : (axis == 1 ? ddxP.xz : ddxP.xy);
  vec2 gy = axis == 0 ? ddyP.zy : (axis == 1 ? ddyP.xz : ddyP.xy);
  TsSample r = tsSampleLayer(tsRockAlbedo, tsRockNxa, uv * scale, gx * scale, gy * scale, detail);
  vec3 t = r.normal;
  if (axis == 0) r.normal = vec3(t.xy + n.zy, abs(t.z) * n.x).zyx;
  else if (axis == 1) r.normal = vec3(t.xy + n.xz, abs(t.z) * n.y).xzy;
  else r.normal = vec3(t.xy + n.xy, abs(t.z) * n.z);
  return r;
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
#ifdef TS_FAR_SIMPLE
  // 1 up close, 0 past the band: normal/AO fetches and the anti-tile grass sample fade out, then are skipped.
  float detail = 1.0 - smoothstep(tsDetail.x, tsDetail.y, viewDistance);
#else
  float detail = 1.0;
#endif

  vec4 w = texture2D(tsMask, (p.xz - tsMaskInfo.xy) * tsMaskInfo.z + tsMaskInfo.w);
  // Past the heightfield (horizon mesh) the mask clamps; steep ground still turns to rock.
  w.b = max(w.b, smoothstep(0.8, 0.62, n.y));

  vec3 macroColor = min(toLinearSpace(texture2D(tsMacro, p.xz * tsMacroScale.x).rgb) / tsMacroMean.rgb, vec3(2.5));
  float macroLuma = getLuminance(toLinearSpace(texture2D(tsMacro, p.zx * tsMacroScale.y + 0.37).rgb)) / tsMacroMean.a;

  vec4 present = step(vec4(0.004), w);
#ifdef TS_WEIGHT_SKIP
  // A layer keeps any weight after the height blend only if its weight plus its largest possible height (AO, or rock
  // luminance x 4, times contrast) reaches the strongest weight minus the blend depth. Others are not sampled; the
  // result is identical.
  float wMax = max(max(w.r, w.g), max(w.b, w.a));
  vec4 sampled = present * step(vec4(wMax - tsBlend.y), w + vec4(1.0, 1.0, 4.0, 1.0) * tsBlend.x);
#else
  vec4 sampled = present;
#endif

  // Grass: two top-projected samples at different scales and rotations, mixed by macro noise.
  TsSample grass = tsEmpty();
  if (sampled.r > 0.5) {
    float sg = tsScale.x;
    grass = tsSampleLayer(tsGrassAlbedo, tsGrassNxa, p.xz * sg, dpdx.xz * sg, dpdy.xz * sg, detail);
    if (detail > 0.0) {
      mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
      float sg2 = sg * tsScale2.x;
      vec3 grassAlt = toLinearSpace(textureGrad(tsGrassAlbedo, rot * p.xz * sg2 + 0.5, rot * dpdx.xz * sg2, rot * dpdy.xz * sg2).rgb);
      grass.albedo = mix(grass.albedo, grassAlt, smoothstep(0.75, 1.25, macroLuma) * 0.6 * detail);
    }
    grass.albedo = mix(grass.albedo * tsGrassTint.rgb, tsGrassMean.rgb, fade * 0.5);
  }

  TsSample dirt = tsEmpty();
  if (sampled.g > 0.5) {
    float sd = tsScale.y;
    dirt = tsSampleLayer(tsDirtAlbedo, tsDirtNxa, p.xz * sd, dpdx.xz * sd, dpdy.xz * sd, detail);
    dirt.albedo = mix(dirt.albedo, tsDirtMean.rgb, fade * 0.5);
  }

  TsSample rock = tsEmpty();
  vec3 rockNormalW = n;
  if (sampled.b > 0.5) {
    float sr = tsScale.z;
    vec3 rockNormal;
#ifdef TS_BIPLANAR
    // Biplanar: the axis the normal faces most, plus the better of the other two. Weights start at |n| = 0.577, so an
    // axis has no weight wherever it could swap with the dropped one, and the blend stays continuous.
    vec3 an = abs(n);
    int axisMain = an.x > an.y && an.x > an.z ? 0 : (an.y > an.z ? 1 : 2);
    int sideA = axisMain == 0 ? 1 : 0;
    int sideB = axisMain == 2 ? 1 : 2;
    float facingA = sideA == 0 ? an.x : an.y;
    float facingB = sideB == 1 ? an.y : an.z;
    int axisSide = facingA >= facingB ? sideA : sideB;
    float facingMain = axisMain == 0 ? an.x : (axisMain == 1 ? an.y : an.z);
    float wMain = saturate((facingMain - 0.5773) / 0.4227) + 0.001;
    float wSide = saturate((max(facingA, facingB) - 0.5773) / 0.4227);
    rock = tsRockProjection(axisMain, p, dpdx, dpdy, n, sr, detail);
    rockNormal = rock.normal;
    if (wSide > 0.0) {
      TsSample side = tsRockProjection(axisSide, p, dpdx, dpdy, n, sr, detail);
      float total = wMain + wSide;
      rock.albedo = (rock.albedo * wMain + side.albedo * wSide) / total;
      rock.ao = (rock.ao * wMain + side.ao * wSide) / total;
      rockNormal = rockNormal * wMain + side.normal * wSide;
    }
#else
    // Triplanar so cliffs don't stretch.
    vec3 bw = abs(n); bw *= bw; bw *= bw; bw /= bw.x + bw.y + bw.z;
    TsSample rx = tsRockProjection(0, p, dpdx, dpdy, n, sr, detail);
    TsSample ry = tsRockProjection(1, p, dpdx, dpdy, n, sr, detail);
    TsSample rz = tsRockProjection(2, p, dpdx, dpdy, n, sr, detail);
    rock.albedo = rx.albedo * bw.x + ry.albedo * bw.y + rz.albedo * bw.z;
    rock.ao = rx.ao * bw.x + ry.ao * bw.y + rz.ao * bw.z;
    rockNormal = rx.normal * bw.x + ry.normal * bw.y + rz.normal * bw.z;
#endif
    rock.albedo = mix(rock.albedo, tsRockMean.rgb, fade * 0.5);
    rockNormalW = normalize(mix(n, normalize(rockNormal), 1.0 - fade * 0.7));
  }

  TsSample road = tsEmpty();
  if (sampled.a > 0.5) {
    float sd = tsScale.w;
    road = tsSampleLayer(tsRoadAlbedo, tsRoadNxa, p.xz * sd, dpdx.xz * sd, dpdy.xz * sd, detail);
    // Gravel shoulder where the painted road weight fades out, with a ragged macro-noise edge.
    float ss = tsScale2.y;
    vec3 shoulder = toLinearSpace(textureGrad(tsShoulderAlbedo, p.xz * ss, dpdx.xz * ss, dpdy.xz * ss).rgb);
    float core = smoothstep(tsShoulder.x, tsShoulder.y, w.a + (macroLuma - 1.0) * 0.25);
    road.albedo = mix(mix(shoulder, tsShoulderMean.rgb, fade * 0.5), mix(road.albedo, tsRoadMean.rgb, fade * 0.5), core);
    road.normal.xy *= mix(1.6, 1.0, core);
  }

  // Height-based blend: the layer that "sticks out" (grass tufts, pebbles, rock bumps) wins at transitions.
  vec4 heights = vec4(grass.ao, dirt.ao, getLuminance(rock.albedo) * 4.0, road.ao) * tsBlend.x;
  vec4 hw = w + heights * present;
  float top = max(max(hw.x, hw.y), max(hw.z, hw.w)) - tsBlend.y;
  w = max(hw - top, 0.0) * present;
  w /= max(w.x + w.y + w.z + w.w, 1e-4);

  vec3 albedo = grass.albedo * w.x + dirt.albedo * w.y + rock.albedo * w.z + road.albedo * w.w;
  // The aerial scan is grassland: tint soil layers fully, rock and road lightly.
  albedo *= mix(vec3(1.0), macroColor, tsMacroStrength.x * (w.x + w.y + 0.3 * (w.z + w.w)));
  albedo *= mix(1.0, macroLuma, tsMacroStrength.y);
  float ao = grass.ao * w.x + dirt.ao * w.y + rock.ao * w.z + road.ao * w.w;
  surfaceAlbedo = saturate(albedo * mix(1.0, ao, 0.45));

  tsRoughness = clamp(dot(w, tsLayerRoughness) + (1.0 - ao) * 0.08, 0.35, 1.0);

  // Top-projected layers share a tangent frame, so their normals blend before going to world space.
  vec3 topNormal = grass.normal * w.x + dirt.normal * w.y + road.normal * w.w;
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

function grassTintOf(): [number, number, number] {
  const mean = TEXTURE_SETS[LOOK.grass.set].meanAlbedo;
  const [r, g, b] = LOOK.grass.targetAlbedo;
  return [r / mean[0], g / mean[1], b / mean[2]];
}

/** Splat layers driven by the shared surface mask, injected into PBRMaterial. */
class TerrainSplatPlugin extends MaterialPluginBase {
  constructor(
    material: PBRMaterial,
    private readonly textures: Record<SamplerName, BaseTexture>,
    private readonly maskInfo: readonly [number, number, number, number],
  ) {
    super(material, "TerrainSplat", 200, { TERRAIN_SPLAT: false, TS_WEIGHT_SKIP: false, TS_BIPLANAR: false, TS_FAR_SIMPLE: false }, true, true);
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
    defines["TS_WEIGHT_SKIP"] = OPTIMIZATIONS.terrainWeightSkip;
    defines["TS_BIPLANAR"] = OPTIMIZATIONS.terrainBiplanarRock;
    defines["TS_FAR_SIMPLE"] = OPTIMIZATIONS.terrainFarSimplify;
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
    const names = [
      "tsMaskInfo",
      "tsScale",
      "tsScale2",
      "tsMacroScale",
      "tsMacroMean",
      "tsMacroStrength",
      "tsGrassTint",
      "tsShoulder",
      "tsLayerRoughness",
      "tsBlend",
      "tsFade",
      "tsDetail",
      "tsGrassMean",
      "tsDirtMean",
      "tsRockMean",
      "tsRoadMean",
      "tsShoulderMean",
    ];
    return {
      ubo: names.map((name) => ({ name, size: 4, type: "vec4" })),
      fragment: names.map((name) => `uniform vec4 ${name};`).join("\n"),
    };
  }

  override bindForSubMesh(ubo: UniformBuffer): void {
    const macro = TEXTURE_SETS[LOOK.macro.set];
    const [mr, mg, mb] = macro.meanAlbedo;
    const grassTint = grassTintOf();
    const mean = (set: TextureSetId, tint: readonly number[] = [1, 1, 1]) => TEXTURE_SETS[set].meanAlbedo.map((c, i) => c * tint[i]!) as [number, number, number];
    ubo.updateFloat4("tsMaskInfo", ...this.maskInfo);
    ubo.updateFloat4("tsScale", 1 / LOOK.grass.meters, 1 / LOOK.dirt.meters, 1 / LOOK.rock.meters, 1 / LOOK.road.meters);
    ubo.updateFloat4("tsScale2", LOOK.antiTileScale, 1 / LOOK.shoulder.meters, 0, 0);
    ubo.updateFloat4("tsMacroScale", 1 / LOOK.macro.colorMeters, 1 / LOOK.macro.lumaMeters, 0, 0);
    ubo.updateFloat4("tsMacroMean", mr, mg, mb, 0.2126 * mr + 0.7152 * mg + 0.0722 * mb);
    ubo.updateFloat4("tsMacroStrength", LOOK.macro.colorStrength, LOOK.macro.lumaStrength, 0, 0);
    ubo.updateFloat4("tsGrassTint", ...grassTint, 0);
    ubo.updateFloat4("tsShoulder", ...LOOK.shoulder.weight, 0, 0);
    ubo.updateFloat4("tsLayerRoughness", TEXTURE_SETS[LOOK.grass.set].roughness, TEXTURE_SETS[LOOK.dirt.set].roughness, TEXTURE_SETS[LOOK.rock.set].roughness, TEXTURE_SETS[LOOK.road.set].roughness);
    ubo.updateFloat4("tsBlend", LOOK.heightBlend.contrast, LOOK.heightBlend.depth, 0, 0);
    ubo.updateFloat4("tsFade", LOOK.detailFade.start, LOOK.detailFade.end, 0, 0);
    ubo.updateFloat4("tsDetail", LOOK.farDetail.start, LOOK.farDetail.end, 0, 0);
    ubo.updateFloat4("tsGrassMean", ...mean(LOOK.grass.set, grassTint), 0);
    ubo.updateFloat4("tsDirtMean", ...mean(LOOK.dirt.set), 0);
    ubo.updateFloat4("tsRockMean", ...mean(LOOK.rock.set), 0);
    ubo.updateFloat4("tsRoadMean", ...mean(LOOK.road.set), 0);
    ubo.updateFloat4("tsShoulderMean", ...mean(LOOK.shoulder.set), 0);
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
 * rock, a gravel road shoulder, macro color variation and distance detail fade. Lit by the scene's sun, shadows and IBL
 * like other PBR.
 */
export class TerrainMaterial {
  readonly material: PBRMaterial;
  readonly ready: Promise<void>;
  private readonly plugin: TerrainSplatPlugin;

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
    const [grass, dirt, rock, road] = [TEXTURE_SETS[LOOK.grass.set], TEXTURE_SETS[LOOK.dirt.set], TEXTURE_SETS[LOOK.rock.set], TEXTURE_SETS[LOOK.road.set]];
    const textures: Record<SamplerName, BaseTexture> = {
      tsMask: mask,
      tsGrassAlbedo: layerTexture(grass.albedo, 16),
      tsGrassNxa: layerTexture(grass.nxa, 16),
      tsDirtAlbedo: layerTexture(dirt.albedo, 16),
      tsDirtNxa: layerTexture(dirt.nxa, 16),
      tsRockAlbedo: layerTexture(rock.albedo, 8),
      tsRockNxa: layerTexture(rock.nxa, 8),
      tsRoadAlbedo: layerTexture(road.albedo, 16),
      tsRoadNxa: layerTexture(road.nxa, 16),
      tsShoulderAlbedo: layerTexture(TEXTURE_SETS[LOOK.shoulder.set].albedo, 16),
      tsMacro: layerTexture(TEXTURE_SETS[LOOK.macro.set].albedo, 4),
    };
    // Mask texel centers sit on height samples: uv = ((xz - min) / spacing + 0.5) / resolution.
    const texel = 1 / (field.spacing * field.resolution);
    this.plugin = new TerrainSplatPlugin(material, textures, [field.minX, field.minZ, texel, 0.5 / field.resolution]);

    this.ready = Promise.all(Object.values(textures).filter((t) => t !== mask).map(waitForTexture)).then(() => undefined);
  }

  /** Recompiles with the current terrain* optimization flags. */
  refreshOptimizations(): void {
    this.plugin.markAllDefinesAsDirty();
  }
}
