import { type AssetContainer, LoadAssetContainerAsync, type Mesh, type Scene } from "@babylonjs/core";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import type {} from "@babylonjs/loaders/glTF/glTFFileLoader.types";
import { CharacterInstance } from "./CharacterInstance";
import { configureDecoders } from "./decoders";
import { bakeStaticMesh, computeWorldMatrices, EquipmentModelInstance, ThrowArmsInstance } from "./EquipmentInstance";
import { EQUIPMENT_MODEL_IDS, type EquipmentManifest, type EquipmentModelId, type EquipmentPartRole } from "./equipmentManifest";
import {
  type AssetManifest,
  CHARACTER_IDS,
  type CharacterId,
  type Credit,
  WEAPON_IDS,
  type WeaponId,
} from "./manifest";
import { WeaponInstance } from "./WeaponInstance";

export interface AssetLoadProgress {
  /** 0..1 across download (by bytes) and parsing. */
  readonly progress: number;
  readonly loadedBytes: number;
  readonly totalBytes: number;
  readonly loadedAssets: number;
  readonly totalAssets: number;
}

export interface AssetLibraryOptions {
  /** Directory containing manifest.json. Default: `<vite base>assets/`. */
  readonly baseUrl?: string | URL;
  /** Replaceable for headless use (tests, Node). Default: global fetch. */
  readonly fetch?: (url: string) => Promise<Response>;
  /** Skip materials and textures, e.g. for server-side hitboxes or Node checks. */
  readonly headless?: boolean;
}

type AssetKey = `weapon:${WeaponId}` | `character:${CharacterId}` | `equipment:${EquipmentModelId | "throw_arms"}`;

let loadersRegistered = false;

const libraries = new WeakMap<Scene, AssetLibrary>();

/**
 * Preloaded templates for every asset in the manifest; instantiate as many copies as needed. Equipment models
 * (`equipment/manifest.json`) are optional: a missing manifest or a model that fails to load only logs a warning, and
 * callers fall back to procedural meshes (`hasEquipment`).
 */
export class AssetLibrary {
  readonly manifest: AssetManifest;
  /** Null when the equipment art isn't built or its manifest failed to load. */
  readonly equipment: EquipmentManifest | null;
  readonly scene: Scene;
  private readonly containers: ReadonlyMap<AssetKey, AssetContainer>;

  private constructor(scene: Scene, manifest: AssetManifest, equipment: EquipmentManifest | null, containers: ReadonlyMap<AssetKey, AssetContainer>) {
    this.scene = scene;
    this.manifest = manifest;
    this.equipment = equipment;
    this.containers = containers;
    libraries.set(scene, this);
  }

  /** The library most recently loaded for `scene`, for systems constructed without one. */
  static forScene(scene: Scene): AssetLibrary | null {
    return libraries.get(scene) ?? null;
  }

  static async load(
    scene: Scene,
    onProgress?: (progress: AssetLoadProgress) => void,
    options: AssetLibraryOptions = {},
  ): Promise<AssetLibrary> {
    const fetchFn = options.fetch ?? ((url: string) => fetch(url));
    const baseUrl = new URL(options.baseUrl ?? `${import.meta.env?.BASE_URL ?? "/"}assets/`, globalThis.location?.href);
    const manifestResponse = await fetchFn(new URL("manifest.json", baseUrl).href);
    if (!manifestResponse.ok) throw new Error(`Asset manifest: HTTP ${manifestResponse.status}`);
    const manifest = (await manifestResponse.json()) as AssetManifest;

    if (!loadersRegistered) {
      registerBuiltInLoaders();
      loadersRegistered = true;
    }
    configureDecoders(manifest.decoders, baseUrl);

    const equipment = await loadEquipmentManifest(fetchFn, baseUrl);
    const assets: { key: AssetKey; url: string; hash: string; bytes: number; optional?: boolean }[] = [
      ...WEAPON_IDS.map((id) => ({ key: `weapon:${id}` as const, ...manifest.weapons[id] })),
      ...CHARACTER_IDS.map((id) => ({ key: `character:${id}` as const, ...manifest.characters[id] })),
      ...(equipment?.arms ? [{ key: "equipment:throw_arms" as const, ...equipment.arms, optional: true }] : []),
      ...EQUIPMENT_MODEL_IDS.flatMap((id) => {
        const item = equipment?.items[id];
        return item ? [{ key: `equipment:${id}` as const, ...item, optional: true }] : [];
      }),
    ];
    const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
    const received = new Map<AssetKey, number>();
    let loadedAssets = 0;
    const report = () => {
      const loadedBytes = [...received.values()].reduce((sum, n) => sum + n, 0);
      onProgress?.({
        progress: 0.85 * (loadedBytes / totalBytes) + 0.15 * (loadedAssets / assets.length),
        loadedBytes,
        totalBytes,
        loadedAssets,
        totalAssets: assets.length,
      });
    };
    report();

    const containers = new Map<AssetKey, AssetContainer>();
    await Promise.all(
      assets.map(async (asset) => {
        try {
          const url = new URL(`${asset.url}?v=${asset.hash}`, baseUrl).href;
          const data = await download(fetchFn, url, (bytes) => {
            received.set(asset.key, bytes);
            report();
          });
          const container = await LoadAssetContainerAsync(data, scene, {
            name: asset.key,
            pluginExtension: ".glb",
            pluginOptions: { gltf: { animationStartMode: 0, skipMaterials: options.headless ?? false } },
          });
          containers.set(asset.key, container);
        } catch (error) {
          if (!asset.optional) throw error;
          console.warn(`[assets] ${asset.key} failed to load; using the procedural stand-in`, error);
          received.set(asset.key, asset.bytes);
        }
        loadedAssets++;
        report();
      }),
    );
    return new AssetLibrary(scene, manifest, equipment, containers);
  }

  /** Weapon/character credits plus the equipment models'. */
  get credits(): readonly Credit[] {
    return this.equipment ? [...this.manifest.credits, ...this.equipment.credits] : this.manifest.credits;
  }

  /** Credits that must be shown (CC-BY and similar). */
  get requiredCredits(): readonly Credit[] {
    return this.credits.filter((c) => c.attributionRequired);
  }

  /** True when the real model for `id` loaded. */
  hasEquipment(id: EquipmentModelId): boolean {
    return this.containers.has(`equipment:${id}`) && this.equipment?.items[id] !== undefined;
  }

  get hasThrowArms(): boolean {
    return this.containers.has("equipment:throw_arms") && this.equipment?.arms != null;
  }

  /** A new instance of an equipment model, or null when it isn't loaded. */
  instantiateEquipment(id: EquipmentModelId): EquipmentModelInstance | null {
    const asset = this.equipment?.items[id];
    const container = this.containers.get(`equipment:${id}`);
    return asset && container ? new EquipmentModelInstance(id, asset, container) : null;
  }

  instantiateThrowArms(): ThrowArmsInstance | null {
    const asset = this.equipment?.arms;
    const container = this.containers.get("equipment:throw_arms");
    return asset && container ? new ThrowArmsInstance(asset, container) : null;
  }

  /**
   * A static copy of an equipment model in item space (meters, +Y up, origin at the body centre) sharing the template's
   * materials: all parts, or only `parts`. Null when the model isn't loaded. The caller owns the mesh.
   */
  createEquipmentMesh(id: EquipmentModelId, name: string, parts?: readonly EquipmentPartRole[]): Mesh | null {
    const instance = this.instantiateEquipment(id);
    if (!instance) return null;
    try {
      computeWorldMatrices(instance.root);
      const roles = parts ?? (["body", "spoon", "ring"] as const);
      return bakeStaticMesh(roles.flatMap((role) => instance.partMeshes(role)), name, this.scene);
    } finally {
      instance.dispose();
    }
  }

  instantiateWeapon(id: WeaponId): WeaponInstance {
    return new WeaponInstance(id, this.manifest.weapons[id], this.container(`weapon:${id}`));
  }

  instantiateCharacter(id: CharacterId): CharacterInstance {
    return new CharacterInstance(id, this.manifest.characters[id], this.container(`character:${id}`), this.scene);
  }

  /** Disposes the templates (shared geometry/materials); dispose all instances first. */
  dispose(): void {
    for (const container of this.containers.values()) container.dispose();
  }

  private container(key: AssetKey): AssetContainer {
    const container = this.containers.get(key);
    if (!container) throw new Error(`Asset ${key} is not loaded`);
    return container;
  }
}

/** The optional equipment manifest next to the main one; null (with a warning) when it can't be read. */
async function loadEquipmentManifest(fetchFn: (url: string) => Promise<Response>, baseUrl: URL): Promise<EquipmentManifest | null> {
  try {
    const response = await fetchFn(new URL("equipment/manifest.json", baseUrl).href);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = (await response.json()) as EquipmentManifest;
    return manifest.version === 1 ? manifest : null;
  } catch (error) {
    console.warn("[assets] no equipment models (equipment/manifest.json); equipment uses procedural meshes", error);
    return null;
  }
}

async function download(
  fetchFn: (url: string) => Promise<Response>,
  url: string,
  onBytes: (bytes: number) => void,
): Promise<Uint8Array> {
  const response = await fetchFn(url);
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
    onBytes(length);
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}
