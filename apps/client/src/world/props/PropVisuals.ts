import { Color3, PBRMaterial, type Mesh, type Scene } from "@babylonjs/core";
import { PROP_MANIFEST, PropLibrary, isPropId, type PropId, type PropLibraryOptions } from "../propAssets";
import { buildStandIn, standInSpec } from "./standInMeshes";

export interface PropVisualLevel {
  /** Camera distance from which this level is used, m. */
  readonly distance: number;
  /** Impostors never cast shadows. */
  readonly billboard: boolean;
  /** Fresh meshes for one batch (unique geometry, shared materials), enabled. */
  create(name: string): Mesh[];
}

export interface PropVisual {
  readonly prop: string;
  readonly levels: readonly PropVisualLevel[];
  readonly cullDistance: number;
  readonly castShadow: boolean;
  /** Real environment asset (true) or procedural stand-in. */
  readonly asset: boolean;
}

/**
 * Looks for map props: environment assets from the PropLibrary (propAssets.ts) where the pipeline marked them ready,
 * procedural stand-ins for everything else (manifest placeholders and map-only props such as fences and walls).
 */
export class PropVisuals {
  private readonly visuals = new Map<string, PropVisual>();

  private constructor(
    private readonly scene: Scene,
    private readonly library: PropLibrary | null,
    private readonly standInMaterial: PBRMaterial,
  ) {}

  /** `library` false skips environment assets entirely (stand-ins only), e.g. for headless checks. */
  static async load(scene: Scene, props: readonly string[], library: Omit<PropLibraryOptions, "ids"> | false = {}): Promise<PropVisuals> {
    const ready = props.filter((id): id is PropId => isPropId(id) && PROP_MANIFEST[id].ready);
    let loaded: PropLibrary | null = null;
    if (library && ready.length > 0) {
      try {
        loaded = await PropLibrary.load(scene, { ...library, ids: ready });
      } catch (error) {
        console.warn("[props] environment assets failed to load; using stand-ins", error);
      }
    }
    const material = new PBRMaterial("mat_prop_standin", scene);
    material.albedoColor = Color3.White();
    material.metallic = 0;
    material.roughness = 0.92;
    material.backFaceCulling = false;
    material.twoSidedLighting = true;
    return new PropVisuals(scene, loaded, material);
  }

  get(prop: string): PropVisual {
    let visual = this.visuals.get(prop);
    if (!visual) this.visuals.set(prop, (visual = this.resolve(prop)));
    return visual;
  }

  dispose(): void {
    this.library?.dispose();
    this.standInMaterial.dispose();
  }

  private resolve(prop: string): PropVisual {
    const library = this.library;
    if (library && isPropId(prop) && library.has(prop) && PROP_MANIFEST[prop].ready) {
      const template = library.get(prop);
      return {
        prop,
        asset: true,
        cullDistance: template.asset.cullDistance,
        castShadow: template.asset.castShadow,
        levels: template.levels.map((level, index) => ({ distance: level.distance, billboard: level.billboard, create: (name: string) => library.createBatch(prop, index, name) })),
      };
    }
    const spec = standInSpec(prop);
    const cullDistance = isPropId(prop) ? Math.max(PROP_MANIFEST[prop].cullDistance, spec.cullDistance) : spec.cullDistance;
    return {
      prop,
      asset: false,
      cullDistance,
      castShadow: spec.castShadow,
      levels: spec.levels.map((level, index) => ({ distance: level.distance, billboard: false, create: (name: string) => [buildStandIn(this.scene, prop, index, name, this.standInMaterial)] })),
    };
  }
}
