import { Color3, PBRMaterial, Texture, type Scene } from "@babylonjs/core";
import type { BuildingMaterialId, BuildingPrefabId, FacadeColor } from "@twobullets/shared";
import { TEXTURE_SETS, type TextureSetId, type Vec3 } from "../environmentManifest";
import { ENVIRONMENT_ASSET_ROOT, waitForTexture } from "../materials";
import { SurfaceVariationPlugin, type SurfaceVariationSettings } from "../surfaceVariation";
import { BuildingShadePlugin, type BuildingShadeSettings } from "./buildingShadePlugin";

interface BuildingLook {
  readonly set: TextureSetId;
  /**
   * Target mean albedo (linear). The material tint is this divided by the scan's measured mean, so swapping a scan keeps
   * the intended brightness and paint color.
   */
  readonly albedo?: Vec3;
  /** Ground-level wall grime strength (0..1). */
  readonly grime?: number;
  /** World-space brightness breakup so repeated instances don't match exactly. */
  readonly breakup?: number;
}

const LOOKS = {
  // Walls. Real painted render and whitewash sit around 0.5-0.6 albedo; the scans are photographed darker.
  plaster: { set: "white_plaster_02", albedo: [0.5, 0.48, 0.43], grime: 0.4, breakup: 0.3 },
  plasterInterior: { set: "painted_plaster_wall", albedo: [0.56, 0.54, 0.5], grime: 0.15, breakup: 0.15 },
  // Saigon facade pastels (city houses pick one per placement, see FACADE_COLORS).
  plasterYellow: { set: "white_plaster_02", albedo: [0.62, 0.49, 0.24], grime: 0.45, breakup: 0.3 },
  plasterMint: { set: "white_plaster_02", albedo: [0.4, 0.55, 0.46], grime: 0.45, breakup: 0.3 },
  plasterPink: { set: "white_plaster_02", albedo: [0.62, 0.41, 0.41], grime: 0.45, breakup: 0.3 },
  plasterSky: { set: "white_plaster_02", albedo: [0.39, 0.5, 0.6], grime: 0.45, breakup: 0.3 },
  plasterWhite: { set: "white_plaster_02", albedo: [0.62, 0.61, 0.57], grime: 0.45, breakup: 0.3 },
  // Tinted curtain-wall glass stand-in on towers (solid: their upper floors are closed).
  glass: { set: "painted_plaster_wall", albedo: [0.04, 0.055, 0.07], breakup: 0.1 },
  plasterDamaged: { set: "damaged_plaster", albedo: [0.36, 0.3, 0.24], grime: 0.45, breakup: 0.35 },
  brick: { set: "red_brick_03", albedo: [0.19, 0.11, 0.085], grime: 0.3, breakup: 0.25 },
  brickWhitewashed: { set: "whitewashed_brick", albedo: [0.46, 0.44, 0.4], grime: 0.4, breakup: 0.3 },
  concreteWall: { set: "concrete_wall_008", albedo: [0.42, 0.41, 0.38], grime: 0.35, breakup: 0.3 },
  concrete: { set: "concrete_floor_worn_001", albedo: [0.17, 0.17, 0.16], grime: 0.3, breakup: 0.25 },
  // Wood: finished floors, trims and furniture share one look so houses keep a single wood draw.
  woodFloor: { set: "wood_floor_worn", albedo: [0.2, 0.11, 0.05], grime: 0.15, breakup: 0.2 },
  planks: { set: "weathered_planks", albedo: [0.15, 0.11, 0.075], grime: 0.25, breakup: 0.3 },
  plankSiding: { set: "weathered_plank_siding", albedo: [0.14, 0.1, 0.07], grime: 0.25, breakup: 0.3 },
  // Metal and roofs. Desaturated scans (mean 0.35 grey) take their paint color from `albedo`.
  corrugated: { set: "corrugated_iron_02", albedo: [0.16, 0.16, 0.13], grime: 0.35, breakup: 0.35 },
  boxProfile: { set: "box_profile_metal_sheet", albedo: [0.27, 0.3, 0.31], grime: 0.35, breakup: 0.3 },
  roofTiles: { set: "clay_roof_tiles_02", albedo: [0.26, 0.1, 0.05], breakup: 0.3 },
  roofMetal: { set: "rusty_metal_02", albedo: [0.21, 0.07, 0.03], breakup: 0.3 },
  asphalt: { set: "asphalt_02", breakup: 0.2 },
  paintedSteel: { set: "rusty_metal_02", albedo: [0.14, 0.11, 0.037], grime: 0.2 },
  darkSteel: { set: "rusty_metal_02", albedo: [0.083, 0.058, 0.028] },
  containerRed: { set: "container_side", albedo: [0.3, 0.06, 0.04], grime: 0.3, breakup: 0.3 },
  containerBlue: { set: "container_side", albedo: [0.04, 0.12, 0.28], grime: 0.3, breakup: 0.3 },
} as const satisfies Record<string, BuildingLook>;

export type BuildingLookId = keyof typeof LOOKS;

/** Default material slot -> look. Slots sharing a look are merged into one mesh (one draw call). */
export const LOOK_OF_MATERIAL: Readonly<Record<BuildingMaterialId, BuildingLookId>> = {
  plaster: "plaster",
  plasterInterior: "plasterInterior",
  concrete: "concrete",
  woodFloor: "woodFloor",
  woodPlanks: "woodFloor",
  woodTrim: "woodFloor",
  corrugated: "corrugated",
  roofMetal: "roofTiles",
  roofAsphalt: "asphalt",
  paintedSteel: "paintedSteel",
  darkSteel: "darkSteel",
  containerRed: "containerRed",
  containerBlue: "containerBlue",
};

/** Per-prefab variations on the defaults, so the kit's shared slots read as different construction. */
const PREFAB_LOOKS: Partial<Record<BuildingPrefabId, Partial<Record<BuildingMaterialId, BuildingLookId>>>> = {
  house_small_ruined: { plaster: "plasterDamaged" },
  house_two_story: { plaster: "brick" },
  barn: { woodPlanks: "plankSiding", woodTrim: "plankSiding", woodFloor: "plankSiding" },
  warehouse: { corrugated: "boxProfile", woodPlanks: "planks", woodFloor: "planks" },
  barracks: { plaster: "brickWhitewashed" },
  guard_booth: { plaster: "brickWhitewashed" },
  radar_station: { plaster: "concreteWall" },
  watchtower: { corrugated: "boxProfile" },
  pagoda: { plaster: "plasterYellow", woodTrim: "planks" },
  church: { plaster: "plasterPink" },
  school: { plaster: "plasterYellow" },
  petrol_station: { plaster: "plasterWhite" },
  workshop: { plaster: "concreteWall" },
  office_tower: { plaster: "concreteWall", darkSteel: "glass" },
  highrise_apartment: { plaster: "plasterWhite", darkSteel: "glass" },
  construction_site: { roofMetal: "brick" },
  bridge_lane_16: { plaster: "concreteWall" },
  bridge_lane_80: { plaster: "concreteWall" },
  bridge_road_24: { plaster: "concreteWall" },
  bridge_road_40: { plaster: "concreteWall" },
};

const FACADE_LOOKS: Readonly<Record<FacadeColor, BuildingLookId | null>> = {
  plaster: null,
  yellow: "plasterYellow",
  mint: "plasterMint",
  pink: "plasterPink",
  sky: "plasterSky",
  white: "plasterWhite",
};

/** A placement's facade colour applied to a look: only the default exterior plaster changes. */
export function facadeLook(look: BuildingLookId, color: FacadeColor | null): BuildingLookId {
  return color && look === "plaster" ? (FACADE_LOOKS[color] ?? look) : look;
}

/** Look for a material slot of a given prefab. */
export function lookOf(prefabId: string, slot: BuildingMaterialId): BuildingLookId {
  return PREFAB_LOOKS[prefabId as BuildingPrefabId]?.[slot] ?? LOOK_OF_MATERIAL[slot];
}

const MACRO_SET: TextureSetId = "aerial_grass_rock";

/** Interior darkening defaults; tuned by eye against the arena IBL. */
export const DEFAULT_SHADE: Omit<BuildingShadeSettings, "grimeStrength"> = { minOcclusion: 0.22, exponent: 0.6, grimeHeight: 1.2 };

/** PBR materials for building looks, created lazily. Textures are shared with the level materials via Babylon's cache. */
export class BuildingMaterials {
  private readonly materials = new Map<BuildingLookId, PBRMaterial>();
  private readonly shade: BuildingShadeSettings[] = [];
  private readonly pending: Promise<void>[] = [];
  private occlusionEnabled = true;

  constructor(private readonly scene: Scene) {}

  get(look: BuildingLookId): PBRMaterial {
    let material = this.materials.get(look);
    if (!material) this.materials.set(look, (material = this.create(look)));
    return material;
  }

  /** Resolves once every texture of the materials created so far has loaded. */
  whenLoaded(): Promise<void> {
    return Promise.all(this.pending).then(() => undefined);
  }

  /** Debug toggle: compare baked interior occlusion against plain IBL. */
  setOcclusionEnabled(enabled: boolean): void {
    this.occlusionEnabled = enabled;
    for (const s of this.shade) s.minOcclusion = enabled ? DEFAULT_SHADE.minOcclusion : 1;
  }

  get isOcclusionEnabled(): boolean {
    return this.occlusionEnabled;
  }

  dispose(): void {
    this.materials.forEach((m) => m.dispose());
    this.materials.clear();
  }

  private create(id: BuildingLookId): PBRMaterial {
    const look: BuildingLook = LOOKS[id];
    const set = TEXTURE_SETS[look.set];
    const material = new PBRMaterial(`mat_building_${id}`, this.scene);
    material.albedoTexture = this.texture(set.albedo, set.meters);
    if (look.albedo) material.albedoColor = new Color3(...look.albedo.map((target, i) => target / set.meanAlbedo[i]!));
    if ("normal" in set) material.bumpTexture = this.texture(set.normal, set.meters);
    if ("arm" in set) {
      material.metallicTexture = this.texture(set.arm, set.meters);
      material.useAmbientOcclusionFromMetallicTextureRed = true;
      material.useRoughnessFromMetallicTextureGreen = true;
      material.useRoughnessFromMetallicTextureAlpha = false;
      material.useMetallnessFromMetallicTextureBlue = true;
    }
    material.metallic = 1;
    material.roughness = 1;
    material.enableSpecularAntiAliasing = true;

    const macro = TEXTURE_SETS[MACRO_SET];
    const variation: SurfaceVariationSettings = {
      colorMeters: 1,
      colorStrength: 0,
      lumaMeters: 9,
      lumaStrength: look.breakup ?? 0,
      grimeStrength: 0, // world-height grime is wrong on terrain; BuildingShadePlugin grimes by height above the floor
      grimeHeight: 1,
    };
    new SurfaceVariationPlugin(material, this.texture(macro.albedo, 1), macro.meanAlbedo, variation);
    const shade: BuildingShadeSettings = { ...DEFAULT_SHADE, minOcclusion: this.occlusionEnabled ? DEFAULT_SHADE.minOcclusion : 1, grimeStrength: look.grime ?? 0 };
    this.shade.push(shade);
    new BuildingShadePlugin(material, shade);
    return material;
  }

  private texture(file: string, meters: number): Texture {
    const texture = new Texture(ENVIRONMENT_ASSET_ROOT + file, this.scene, { samplingMode: Texture.TRILINEAR_SAMPLINGMODE });
    texture.uScale = 1 / meters;
    texture.vScale = 1 / meters;
    texture.anisotropicFilteringLevel = 8;
    this.pending.push(waitForTexture(texture));
    return texture;
  }
}
