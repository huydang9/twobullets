import { Color3, PBRMaterial, Texture, type BaseTexture, type Mesh, type Scene } from "@babylonjs/core";
import type { SurfaceKind } from "@twobullets/shared";
import { TEXTURE_SETS, type TextureSetId, type Vec3 } from "./environmentManifest";
import { freezeStaticMaterial } from "./materialFreeze";
import { SurfaceVariationPlugin, type SurfaceVariationSettings } from "./surfaceVariation";

export const ENVIRONMENT_ASSET_ROOT = `${import.meta.env?.BASE_URL ?? "/"}assets/environment/`;

interface SurfaceLook {
  readonly set: TextureSetId;
  /** Linear albedo multiplier, e.g. a paint color over a bare metal scan. */
  readonly tint?: Vec3;
  readonly anisotropy?: number;
  readonly variation?: SurfaceVariationSettings;
}

/** Low-frequency layer shared by every look with `variation`: an aerial grass/rock scan. */
const MACRO_SET: TextureSetId = "aerial_grass_rock";

const LOOKS = {
  // Grass/leaf-litter ground, tinted in 23 m patches so the 2 m tile doesn't read as a grid.
  ground: {
    set: "forrest_ground_01",
    anisotropy: 16,
    variation: { colorMeters: 23, colorStrength: 0.55, lumaMeters: 7.3, lumaStrength: 0.35, grimeStrength: 0, grimeHeight: 1 },
  },
  // Board-formed concrete; blotchy weathering plus dirt splash along the base.
  concreteWall: {
    set: "concrete_wall_008",
    anisotropy: 8,
    variation: { colorMeters: 1, colorStrength: 0, lumaMeters: 11, lumaStrength: 0.3, grimeStrength: 0.35, grimeHeight: 1.4 },
  },
  concreteFloor: {
    set: "concrete_floor_worn_001",
    anisotropy: 8,
    variation: { colorMeters: 1, colorStrength: 0, lumaMeters: 9, lumaStrength: 0.25, grimeStrength: 0.25, grimeHeight: 0.8 },
  },
  asphalt: { set: "asphalt_02", anisotropy: 8 },
  planks: { set: "weathered_planks" },
  corrugatedIron: { set: "corrugated_iron_02" },
  // rusty_metal_02 is white paint over rust; the tint turns the paint olive drab and keeps the rust dark.
  paintedSteel: { set: "rusty_metal_02", tint: [0.34, 0.37, 0.27] },
  darkSteel: { set: "rusty_metal_02", tint: [0.2, 0.2, 0.2] },
} as const satisfies Record<string, SurfaceLook>;

type LookId = keyof typeof LOOKS;

/**
 * Material per surface kind. Rules are tested in order against the mesh name (`level_<block name>`);
 * the last rule of each kind has no pattern and acts as the default.
 */
const SURFACE_RULES: Record<SurfaceKind, readonly { readonly match?: RegExp; readonly look: LookId }[]> = {
  ground: [{ look: "ground" }],
  wall: [{ look: "concreteWall" }],
  platform: [{ match: /catwalk/i, look: "paintedSteel" }, { look: "concreteFloor" }],
  ramp: [{ match: /stairs/i, look: "concreteFloor" }, { look: "asphalt" }],
  cover: [
    { match: /barrier/i, look: "corrugatedIron" },
    { match: /lowWall/i, look: "concreteWall" },
    { match: /stack/i, look: "paintedSteel" },
    { look: "planks" },
  ],
  accent: [{ match: /wallCap/i, look: "concreteFloor" }, { look: "darkSteel" }],
};

/**
 * Shared PBR materials for level geometry, one per look. All looks are created up front so their
 * textures start downloading immediately and `loaded` covers everything a level can use.
 */
export class LevelMaterials {
  readonly loaded: Promise<void>;
  private readonly materials = new Map<LookId, PBRMaterial>();
  private readonly textures: BaseTexture[] = [];
  private macro: Texture | null = null;

  constructor(private readonly scene: Scene) {
    for (const id of Object.keys(LOOKS) as LookId[]) this.materials.set(id, this.createMaterial(id));
    this.loaded = Promise.all(this.textures.map(waitForTexture)).then(() => undefined);
  }

  apply(mesh: Mesh, kind: SurfaceKind): void {
    const rule = SURFACE_RULES[kind].find((r) => !r.match || r.match.test(mesh.name));
    if (rule) mesh.material = this.materials.get(rule.look) ?? null;
  }

  private createMaterial(id: LookId): PBRMaterial {
    const look: SurfaceLook = LOOKS[id];
    const set = TEXTURE_SETS[look.set];
    const anisotropy = look.anisotropy ?? 4;
    const material = new PBRMaterial(`mat_${id}`, this.scene);

    material.albedoTexture = this.texture(set.albedo, set.meters, anisotropy);
    if (look.tint) material.albedoColor = new Color3(...look.tint);
    if ("normal" in set) material.bumpTexture = this.texture(set.normal, set.meters, anisotropy);
    if ("arm" in set) {
      material.metallicTexture = this.texture(set.arm, set.meters, anisotropy);
      material.useAmbientOcclusionFromMetallicTextureRed = true;
      material.useRoughnessFromMetallicTextureGreen = true;
      material.useRoughnessFromMetallicTextureAlpha = false;
      material.useMetallnessFromMetallicTextureBlue = true;
    }
    // Scalars multiply the packed channels, so 1 means "use the texture as authored".
    material.metallic = 1;
    material.roughness = 1;
    // Filters normal-map specular aliasing (sparkle) at grazing angles and distance.
    material.enableSpecularAntiAliasing = true;

    if (look.variation) {
      const macro = (this.macro ??= this.texture(TEXTURE_SETS[MACRO_SET].albedo, 1, 1));
      new SurfaceVariationPlugin(material, macro, TEXTURE_SETS[MACRO_SET].meanAlbedo, look.variation);
    }

    freezeStaticMaterial(material);
    return material;
  }

  /** UVs from buildLevel are in meters, so the scale sets real-world texel density. */
  private texture(file: string, meters: number, anisotropy: number): Texture {
    const texture = new Texture(ENVIRONMENT_ASSET_ROOT + file, this.scene, { samplingMode: Texture.TRILINEAR_SAMPLINGMODE });
    texture.uScale = 1 / meters;
    texture.vScale = 1 / meters;
    texture.anisotropicFilteringLevel = anisotropy;
    this.textures.push(texture);
    return texture;
  }
}

export function waitForTexture(texture: BaseTexture): Promise<void> {
  return new Promise((resolve, reject) => {
    if (texture.isReady()) return resolve();
    const internal = texture.getInternalTexture();
    if (!internal) return reject(new Error(`Texture ${texture.name} has no internal texture`));
    internal.onLoadedObservable.addOnce(() => resolve());
    internal.onErrorObservable.addOnce((err) => reject(new Error(`Failed to load ${texture.name}: ${err.message ?? ""}`)));
  });
}
