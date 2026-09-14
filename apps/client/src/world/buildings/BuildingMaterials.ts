import { Color3, PBRMaterial, Texture, type Scene } from "@babylonjs/core";
import type { BuildingMaterialId } from "@twobullets/shared";
import { TEXTURE_SETS, type TextureSetId, type Vec3 } from "../environmentManifest";
import { ENVIRONMENT_ASSET_ROOT, waitForTexture } from "../materials";
import { SurfaceVariationPlugin, type SurfaceVariationSettings } from "../surfaceVariation";
import { BuildingShadePlugin, type BuildingShadeSettings } from "./buildingShadePlugin";

interface BuildingLook {
  readonly set: TextureSetId;
  /** Linear albedo multiplier. Values above 1 lift the dark scans toward real-world paint and plaster albedo. */
  readonly tint?: Vec3;
  /** Ground-level wall grime strength (0..1). */
  readonly grime?: number;
  /** World-space brightness breakup so repeated instances don't match exactly. */
  readonly breakup?: number;
}

/** Stand-ins until dedicated plaster/brick/roof-tile scans exist (see docs/map/buildings.md). */
const LOOKS = {
  // Board-formed concrete scan lifted and cooled toward off-white render.
  plaster: { set: "concrete_wall_008", tint: [1.75, 1.8, 2.2], grime: 0.4, breakup: 0.3 },
  plasterInterior: { set: "concrete_wall_008", tint: [2.1, 2.15, 2.6], grime: 0.15, breakup: 0.15 },
  concrete: { set: "concrete_floor_worn_001", tint: [1.8, 1.8, 1.8], grime: 0.3, breakup: 0.25 },
  planks: { set: "weathered_planks", tint: [1.9, 1.8, 1.7], grime: 0.25, breakup: 0.3 },
  corrugated: { set: "corrugated_iron_02", tint: [1.6, 1.6, 1.6], grime: 0.35, breakup: 0.35 },
  roofMetal: { set: "rusty_metal_02", tint: [0.5, 0.24, 0.2], breakup: 0.3 },
  asphalt: { set: "asphalt_02", breakup: 0.2 },
  paintedSteel: { set: "rusty_metal_02", tint: [0.34, 0.37, 0.27], grime: 0.2 },
  darkSteel: { set: "rusty_metal_02", tint: [0.2, 0.2, 0.2] },
  containerRed: { set: "corrugated_iron_02", tint: [2.6, 0.85, 0.6], grime: 0.3, breakup: 0.3 },
  containerBlue: { set: "corrugated_iron_02", tint: [0.7, 1.15, 2.3], grime: 0.3, breakup: 0.3 },
} as const satisfies Record<string, BuildingLook>;

export type BuildingLookId = keyof typeof LOOKS;

/** Material slot -> look. Slots sharing a look are merged into one mesh (one draw call). */
export const LOOK_OF_MATERIAL: Readonly<Record<BuildingMaterialId, BuildingLookId>> = {
  plaster: "plaster",
  plasterInterior: "plasterInterior",
  concrete: "concrete",
  woodFloor: "planks",
  woodPlanks: "planks",
  woodTrim: "planks",
  corrugated: "corrugated",
  roofMetal: "roofMetal",
  roofAsphalt: "asphalt",
  paintedSteel: "paintedSteel",
  darkSteel: "darkSteel",
  containerRed: "containerRed",
  containerBlue: "containerBlue",
};

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
    if (look.tint) material.albedoColor = new Color3(...look.tint);
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
