import { Color3, PBRMaterial, VertexBuffer, type Mesh, type Scene } from "@babylonjs/core";
import { PROP_MANIFEST, PropLibrary, isPropId, type PropId, type PropLevel, type PropLibraryOptions } from "../propAssets";
import { detectImpostorPlanes, type ImpostorPlanes } from "./impostor";
import { buildStandIn, standInSpec, type StandInMaterials } from "./standInMeshes";

export interface PropVisualLevel {
  /** Camera distance from which this level is used, m. */
  readonly distance: number;
  /** Impostors never cast shadows. */
  readonly billboard: boolean;
  /** Plane layout of a crossed-quad impostor level, turned toward the camera when it appears. */
  readonly impostor: ImpostorPlanes | null;
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
  private glassMaterial: PBRMaterial | null = null;
  private readonly standInMaterials: StandInMaterials;

  private constructor(
    private readonly scene: Scene,
    private readonly library: PropLibrary | null,
    private readonly standInMaterial: PBRMaterial,
  ) {
    this.standInMaterials = { solid: standInMaterial, glass: () => (this.glassMaterial ??= createGlassMaterial(this.scene)) };
  }

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
    this.glassMaterial?.dispose();
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
        levels: template.levels.map((level, index) => ({
          distance: level.distance,
          billboard: level.billboard,
          impostor: level.billboard ? impostorPlanes(level) : null,
          create: (name: string) => library.createBatch(prop, index, name),
        })),
      };
    }
    const spec = standInSpec(prop);
    const cullDistance = isPropId(prop) ? Math.max(PROP_MANIFEST[prop].cullDistance, spec.cullDistance) : spec.cullDistance;
    return {
      prop,
      asset: false,
      cullDistance,
      castShadow: spec.castShadow,
      levels: spec.levels.map((level, index) => ({ distance: level.distance, billboard: false, impostor: null, create: (name: string) => buildStandIn(this.scene, prop, index, name, this.standInMaterials) })),
    };
  }
}

/**
 * Shared material for glazed stand-in parts (`wall_glass`): a tinted, near-mirror-smooth pane that picks up the sky
 * from the scene's IBL, so it reads as glass instead of an invisible wall. Back faces are culled and depth writes are
 * off, so a closed pane box blends exactly once from either side and everything behind it — including more panes —
 * still shows through. One flat tint blends to the same result in any order, so hundreds of panes need no sorting.
 */
function createGlassMaterial(scene: Scene): PBRMaterial {
  const material = new PBRMaterial("mat_prop_glass", scene);
  material.albedoColor = new Color3(0.36, 0.47, 0.45);
  material.metallic = 0;
  material.roughness = 0.04;
  material.alpha = 0.3;
  material.transparencyMode = PBRMaterial.MATERIAL_ALPHABLEND;
  material.disableDepthWrite = true;
  material.enableSpecularAntiAliasing = true;
  return material;
}

/** Shared plane layout of every mesh of an impostor level, or null. */
function impostorPlanes(level: PropLevel): ImpostorPlanes | null {
  let planes: ImpostorPlanes | null = null;
  for (const mesh of level.meshes) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    const indices = mesh.getIndices();
    const found = positions && indices ? detectImpostorPlanes(positions, indices) : null;
    if (!found || (planes && (planes.spacing !== found.spacing || Math.abs(planes.offset - found.offset) > 1e-3))) return null;
    planes = found;
  }
  return planes;
}
