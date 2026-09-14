import {
  Color3,
  LoadAssetContainerAsync,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  type AbstractMesh,
  type AssetContainer,
  type Material,
  type Scene,
} from "@babylonjs/core";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import type {} from "@babylonjs/loaders/glTF/glTFFileLoader.types";
import { configureDecoders } from "../assets/decoders";
import type { AssetManifest, DecoderUrls } from "../assets/manifest";
import { PROP_MANIFEST_GENERATED } from "./environmentManifest";
import { ENVIRONMENT_ASSET_ROOT } from "./materials";
import { ditherCutoutCoverage } from "./props/lodFadePlugin";

/*
 * Props and vegetation contract between the environment asset pipeline (tools/environment) and the map runtime.
 *
 * Conventions: meters, Y up, Babylon left-handed space. Every GLB is authored with its pivot at the ground contact
 * point (bottom center), facing +Z, at real-world scale. Collision and bounds are prop-local at scale 1: multiply by
 * `PropPlacement.scale` and rotate by `yaw` like buildings.
 */

export const PROP_IDS = [
  // Props
  "crate_wood_a",
  "crate_wood_b",
  "crate_military",
  "crate_military_long",
  "ammo_box",
  "jerrycan",
  "barrel_metal",
  "barrel_rusty",
  "tyre",
  "utility_box",
  "road_barrier",
  "fence_chainlink",
  "car_covered",
  "log_fallen",
  "tree_stump",
  // Rocks
  "rock_boulder_a",
  "rock_boulder_b",
  "rock_moss_a",
  "rock_moss_b",
  "rock_small",
  // Trees
  "tree_fir_a",
  "tree_fir_b",
  "tree_fir_young",
  "tree_broadleaf_a",
  "tree_broadleaf_b",
  // Bushes and ground cover
  "bush_a",
  "bush_b",
  "bush_c",
  "fern",
  // Grass clumps
  "grass_clump_short",
  "grass_clump_medium",
  "grass_clump_tall",
] as const;

export type PropId = (typeof PROP_IDS)[number];
export type PropCategory = "prop" | "rock" | "tree" | "bush" | "grass";
/** Impact/footstep family. Rocks use "concrete"; rubber (tyres) uses "wood". Maps onto audio's AcousticSurface. */
export type PropSurface = "wood" | "metal" | "concrete" | "foliage";

export type Vec3 = readonly [x: number, y: number, z: number];

/** Static collision, prop-local. `none` for walk-through vegetation (bushes, grass). */
export type PropCollision =
  | { readonly kind: "none" }
  | { readonly kind: "box"; readonly center: Vec3; readonly size: Vec3 }
  /** Upright cylinder; trees use one for the trunk only, so the canopy doesn't block. */
  | { readonly kind: "cylinder"; readonly center: Vec3; readonly radius: number; readonly height: number }
  /** Simplified hull, at most 32 points, for rocks and irregular props. */
  | { readonly kind: "convexHull"; readonly points: readonly Vec3[] };

export interface PropLod {
  /** GLB path relative to the environment asset root. Several props and levels can share one file (and its textures). */
  readonly url: string;
  /** Root node of this level inside the GLB; absent means the whole file. */
  readonly node?: string;
  /** Camera distance from which this level is used, m (the first level is 0). */
  readonly distance: number;
  readonly triangles: number;
  /** Impostor (crossed quads with baked views): draw without shadows, cheap alpha test. */
  readonly billboard?: boolean;
}

export interface PropSource {
  /** Upstream asset id, e.g. a Poly Haven slug. */
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly license: "CC0" | "CC-BY-4.0";
  readonly authors: readonly string[];
}

export interface PropAsset {
  readonly id: PropId;
  readonly category: PropCategory;
  /** False while the asset is a placeholder: the library draws a grey box of `bounds`. */
  readonly ready: boolean;
  /** LOD0 GLB path (same as `lods[0].url`), relative to the environment asset root. */
  readonly url: string;
  /** Download size of the distinct files this prop needs (shared files count fully for each prop). */
  readonly bytes: number;
  /** Ascending by distance; the last level may be a billboard. */
  readonly lods: readonly PropLod[];
  /** Beyond this camera distance the prop isn't drawn, m. */
  readonly cullDistance: number;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  /** XZ radius around the pivot that the prop occupies; use for scatter spacing and overlap rejection, m. */
  readonly footprintRadius: number;
  readonly collision: PropCollision;
  readonly surface: PropSurface;
  readonly castShadow: boolean;
  /** Suggested `scaleRange` for scatters. */
  readonly scaleRange: readonly [min: number, max: number];
  readonly source?: PropSource;
}

/** Measured part of an asset, written by tools/environment/props.mjs into environmentManifest.ts. */
export type GeneratedPropAsset = Pick<PropAsset, "url" | "bytes" | "lods" | "bounds" | "footprintRadius" | "collision" | "source">;

type PropSpec = Pick<PropAsset, "category" | "surface" | "castShadow" | "cullDistance" | "scaleRange"> & {
  /** Placeholder box size [x, y, z] until the real asset exists. */
  readonly size: Vec3;
  readonly collision: PropCollision["kind"];
};

const prop = (size: Vec3, surface: PropSurface, collision: PropCollision["kind"] = "box", cullDistance = 250): PropSpec => ({
  category: "prop",
  surface,
  castShadow: true,
  cullDistance,
  scaleRange: [1, 1],
  size,
  collision,
});
const rock = (size: Vec3, cullDistance: number): PropSpec => ({ ...prop(size, "concrete", "convexHull", cullDistance), category: "rock", scaleRange: [0.7, 1.4] });
const tree = (size: Vec3): PropSpec => ({ ...prop(size, "wood", "cylinder", 1200), category: "tree", scaleRange: [0.8, 1.25] });
const bush = (size: Vec3): PropSpec => ({ ...prop(size, "foliage", "none", 180), category: "bush", scaleRange: [0.7, 1.3] });
const grass = (size: Vec3): PropSpec => ({ category: "grass", surface: "foliage", castShadow: false, cullDistance: 60, scaleRange: [0.8, 1.3], size, collision: "none" });

/** Hand-authored gameplay metadata and placeholder sizes; the pipeline supplies files, LODs, bounds and collision. */
const SPECS: Readonly<Record<PropId, PropSpec>> = {
  crate_wood_a: prop([0.83, 0.35, 0.41], "wood", "box", 120),
  crate_wood_b: prop([1.17, 0.46, 0.53], "wood", "box", 150),
  crate_military: prop([1.24, 0.47, 0.52], "wood", "box", 150),
  crate_military_long: prop([1.82, 0.3, 0.98], "wood", "box", 150),
  ammo_box: prop([0.26, 0.18, 0.09], "metal", "box", 60),
  jerrycan: prop([0.17, 0.5, 0.37], "metal", "box", 80),
  barrel_metal: prop([0.56, 0.88, 0.56], "metal", "cylinder", 180),
  barrel_rusty: prop([0.64, 0.93, 0.64], "metal", "cylinder", 180),
  tyre: prop([0.6, 0.6, 0.17], "wood", "cylinder", 100),
  utility_box: prop([0.92, 1.12, 0.43], "metal", "box", 200),
  road_barrier: prop([1.57, 1.11, 0.44], "concrete", "box", 300),
  fence_chainlink: prop([2.5, 2.5, 0.1], "metal", "box", 200),
  car_covered: prop([1.79, 1.41, 4.38], "metal", "box", 500),
  log_fallen: prop([4.05, 1.0, 1.06], "wood", "cylinder", 300),
  tree_stump: prop([1.43, 0.57, 1.59], "wood", "cylinder", 200),
  rock_boulder_a: rock([1.27, 1.0, 1.83], 500),
  rock_boulder_b: rock([2.5, 1.9, 2.5], 700),
  rock_moss_a: rock([2.5, 1.4, 2.5], 500),
  rock_moss_b: rock([1.5, 0.9, 1.5], 400),
  rock_small: rock([0.5, 0.3, 0.5], 120),
  tree_fir_a: tree([6, 19, 6]),
  tree_fir_b: tree([5, 15, 5]),
  tree_fir_young: tree([3, 8, 3]),
  tree_broadleaf_a: tree([7, 9, 7]),
  tree_broadleaf_b: tree([4.5, 5.5, 4.5]),
  bush_a: bush([1.3, 1.5, 1.3]),
  bush_b: bush([1.3, 1.2, 1.3]),
  bush_c: bush([1.6, 2.0, 1.6]),
  fern: { ...bush([1.0, 0.45, 1.0]), cullDistance: 100 },
  grass_clump_short: grass([0.4, 0.2, 0.4]),
  grass_clump_medium: grass([0.7, 0.45, 0.7]),
  grass_clump_tall: grass([0.8, 0.9, 0.8]),
};

function stubAsset(id: PropId): PropAsset {
  const { size, collision, ...spec } = SPECS[id];
  const [x, y, z] = size;
  const center: Vec3 = [0, y / 2, 0];
  return {
    id,
    ...spec,
    ready: false,
    url: "",
    bytes: 0,
    lods: [],
    bounds: { min: [-x / 2, 0, -z / 2], max: [x / 2, y, z / 2] },
    footprintRadius: Math.hypot(x, z) / 2,
    collision:
      collision === "none"
        ? { kind: "none" }
        : collision === "cylinder"
          ? { kind: "cylinder", center, radius: spec.category === "tree" ? 0.25 : Math.max(x, z) / 2, height: y }
          : { kind: "box", center, size },
  };
}

/** Every prop: measured data where the pipeline has produced it, placeholders otherwise. */
export const PROP_MANIFEST: Readonly<Record<PropId, PropAsset>> = Object.fromEntries(
  PROP_IDS.map((id) => {
    const generated = PROP_MANIFEST_GENERATED[id];
    return [id, generated ? { ...stubAsset(id), ...generated, ready: true } : stubAsset(id)];
  }),
) as Record<PropId, PropAsset>;

export function isPropId(value: string): value is PropId {
  return (PROP_IDS as readonly string[]).includes(value);
}

/** Index into `asset.lods` for a camera distance, or -1 when culled. */
export function selectPropLod(asset: PropAsset, distance: number): number {
  if (distance > asset.cullDistance) return -1;
  let level = 0;
  for (let i = 1; i < asset.lods.length; i++) if (distance >= asset.lods[i]!.distance) level = i;
  return level;
}

// ---------------------------------------------------------------------------------------------
// Runtime library

export interface PropLevel {
  readonly distance: number;
  readonly triangles: number;
  readonly billboard: boolean;
  /**
   * Template meshes (one per material), disabled and at identity: the GLB's node transforms and the glTF
   * handedness flip are baked into the vertices, so a thin-instance matrix is exactly the world placement.
   */
  readonly meshes: readonly Mesh[];
}

export interface PropTemplate {
  readonly asset: PropAsset;
  /** Same order as `asset.lods`; a placeholder has one level with a box. */
  readonly levels: readonly PropLevel[];
}

export interface PropLibraryOptions {
  /** Subset to load; default all. */
  readonly ids?: readonly PropId[];
  /** Directory the manifest paths are relative to. Default: the environment asset root. */
  readonly baseUrl?: string | URL;
  /** Decoder locations; default read from `<base>assets/manifest.json` (the character/weapon manifest). */
  readonly decoders?: DecoderUrls;
  /** Replaceable for headless use (Node checks). */
  readonly fetch?: (url: string) => Promise<Response>;
  /** Skip materials and textures (server or Node). */
  readonly headless?: boolean;
}

let loadersRegistered = false;

/**
 * Loads prop GLBs once per scene and hands out template meshes. The map runtime owns placement: it should batch
 * instances per prop per level (and per world cell, since thin instances cull as one batch), and move instances
 * between level batches with `selectPropLod` as the camera moves. `createBatch` gives each batch its own geometry,
 * because Babylon keeps thin-instance buffers on the geometry.
 */
export class PropLibrary {
  private constructor(
    readonly scene: Scene,
    private readonly templates: ReadonlyMap<PropId, PropTemplate>,
    private readonly containers: readonly AssetContainer[],
    private readonly ownedMaterials: readonly Material[],
  ) {}

  static async load(scene: Scene, options: PropLibraryOptions = {}): Promise<PropLibrary> {
    const fetchFn = options.fetch ?? ((url: string) => fetch(url));
    const base = new URL(options.baseUrl ?? ENVIRONMENT_ASSET_ROOT, globalThis.location?.href);
    const ids = options.ids ?? PROP_IDS;
    const assets = ids.map((id) => PROP_MANIFEST[id]);

    if (assets.some((a) => a.ready)) {
      if (!loadersRegistered) {
        registerBuiltInLoaders();
        loadersRegistered = true;
      }
      const assetsRoot = new URL("../", base);
      const decoders = options.decoders ?? ((await (await fetchFn(new URL("manifest.json", assetsRoot).href)).json()) as AssetManifest).decoders;
      configureDecoders(decoders, assetsRoot);
    }

    const files = new Map<string, Promise<AssetContainer>>();
    const loadFile = (url: string): Promise<AssetContainer> => {
      let file = files.get(url);
      if (!file) {
        file = (async () => {
          const response = await fetchFn(new URL(url, base).href);
          if (!response.ok) throw new Error(`Prop file ${url}: HTTP ${response.status}`);
          const container = await LoadAssetContainerAsync(new Uint8Array(await response.arrayBuffer()), scene, {
            name: url,
            pluginExtension: ".glb",
            pluginOptions: { gltf: { skipMaterials: options.headless ?? false } },
          });
          container.addAllToScene();
          return container;
        })();
        files.set(url, file);
      }
      return file;
    };

    const ownedMaterials: Material[] = [];
    let placeholder: PBRMaterial | null = null;
    const templates = new Map<PropId, PropTemplate>();

    await Promise.all(
      assets.map(async (asset) => {
        if (!asset.ready) {
          placeholder ??= createPlaceholderMaterial(scene, ownedMaterials);
          templates.set(asset.id, { asset, levels: [{ distance: 0, triangles: 12, billboard: false, meshes: [placeholderBox(scene, asset, placeholder)] }] });
          return;
        }
        const levels = await Promise.all(
          asset.lods.map(async (lod, index) => {
            const container = await loadFile(lod.url);
            const billboard = lod.billboard ?? false;
            const meshes = extractLevel(container, lod.node, `prop_${asset.id}_lod${index}`);
            return { distance: lod.distance, triangles: lod.triangles, billboard, meshes };
          }),
        );
        templates.set(asset.id, { asset, levels });
      }),
    );
    const containers = await Promise.all(files.values());
    // Level meshes are unparented and baked; drop the glTF __root__, empty nodes and anything no level uses.
    const used = new Set<AbstractMesh>([...templates.values()].flatMap((t) => t.levels.flatMap((l) => l.meshes)));
    for (const container of containers) {
      for (const node of [...container.transformNodes, ...container.meshes.filter((m) => !used.has(m))]) node.dispose(true, false);
    }
    return new PropLibrary(scene, templates, containers, ownedMaterials);
  }

  get(id: PropId): PropTemplate {
    const template = this.templates.get(id);
    if (!template) throw new Error(`Prop ${id} is not loaded`);
    return template;
  }

  has(id: PropId): boolean {
    return this.templates.has(id);
  }

  /** Fresh enabled meshes for one level (unique geometry, shared materials), ready for `thinInstanceSetBuffer`. */
  createBatch(id: PropId, level: number, name: string): Mesh[] {
    const template = this.get(id).levels[level];
    if (!template) throw new Error(`Prop ${id} has no LOD ${level}`);
    return template.meshes.map((source, i) => {
      const mesh = source.clone(`${name}_${i}`, null, true, false);
      mesh.makeGeometryUnique();
      mesh.setEnabled(true);
      return mesh;
    });
  }

  dispose(): void {
    for (const template of this.templates.values()) for (const level of template.levels) level.meshes.forEach((m) => m.dispose());
    this.containers.forEach((c) => c.dispose());
    this.ownedMaterials.forEach((m) => m.dispose());
  }
}

function extractLevel(container: AssetContainer, nodeName: string | undefined, name: string): Mesh[] {
  let meshes: AbstractMesh[] = container.meshes;
  if (nodeName !== undefined) {
    const root = [...container.transformNodes, ...container.meshes].find((n) => n.name === nodeName);
    if (!root) throw new Error(`${name}: node ${nodeName} not found`);
    meshes = [...(root instanceof Mesh ? [root] : []), ...root.getChildMeshes(false)];
  }
  const levelMeshes = meshes.filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
  if (levelMeshes.length === 0) throw new Error(`${name}: no geometry`);
  return levelMeshes.map((mesh, i) => {
    mesh.setParent(null);
    mesh.bakeCurrentTransformIntoVertices();
    mesh.name = `${name}_${i}`;
    mesh.isPickable = false;
    mesh.setEnabled(false);
    mesh.refreshBoundingInfo();
    if (mesh.material instanceof PBRMaterial) configureMaterial(mesh.material);
    return mesh;
  });
}

/** Cutouts with low true coverage (thin wire): they dither to their averaged alpha at distance instead of vanishing. */
const SPARSE_CUTOUT_MATERIALS = new Set(["modular_chainlink_fence_wire"]);

/**
 * Cutouts (foliage, cards, impostors, fence wire) arrive as glTF MASK, i.e. alpha test with their cutoff. Both faces use
 * the same normal: card normals are authored to point out of the canopy, so flipping them would darken back faces.
 */
function configureMaterial(material: PBRMaterial): void {
  if (material.transparencyMode === PBRMaterial.MATERIAL_ALPHATEST) {
    material.backFaceCulling = false;
    material.twoSidedLighting = false;
    if (SPARSE_CUTOUT_MATERIALS.has(material.name)) ditherCutoutCoverage(material);
  }
  material.enableSpecularAntiAliasing = true;
}

function createPlaceholderMaterial(scene: Scene, owned: Material[]): PBRMaterial {
  const material = new PBRMaterial("mat_prop_placeholder", scene);
  material.albedoColor = new Color3(0.35, 0.35, 0.33);
  material.metallic = 0;
  material.roughness = 0.9;
  owned.push(material);
  return material;
}

function placeholderBox(scene: Scene, asset: PropAsset, material: Material): Mesh {
  const { min, max } = asset.bounds;
  const box = MeshBuilder.CreateBox(`prop_${asset.id}_placeholder`, { width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] }, scene);
  box.bakeTransformIntoVertices(Matrix.Translation((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2));
  box.material = material;
  box.isPickable = false;
  box.setEnabled(false);
  return box;
}
