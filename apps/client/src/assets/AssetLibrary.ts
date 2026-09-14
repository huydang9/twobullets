import { type AssetContainer, LoadAssetContainerAsync, type Scene } from "@babylonjs/core";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import type {} from "@babylonjs/loaders/glTF/glTFFileLoader.types";
import { CharacterInstance } from "./CharacterInstance";
import { configureDecoders } from "./decoders";
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

type AssetKey = `weapon:${WeaponId}` | `character:${CharacterId}`;

let loadersRegistered = false;

/** Preloaded templates for every asset in the manifest; instantiate as many copies as needed. */
export class AssetLibrary {
  readonly manifest: AssetManifest;
  readonly scene: Scene;
  private readonly containers: ReadonlyMap<AssetKey, AssetContainer>;

  private constructor(scene: Scene, manifest: AssetManifest, containers: ReadonlyMap<AssetKey, AssetContainer>) {
    this.scene = scene;
    this.manifest = manifest;
    this.containers = containers;
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

    const assets: { key: AssetKey; url: string; hash: string; bytes: number }[] = [
      ...WEAPON_IDS.map((id) => ({ key: `weapon:${id}` as const, ...manifest.weapons[id] })),
      ...CHARACTER_IDS.map((id) => ({ key: `character:${id}` as const, ...manifest.characters[id] })),
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
        loadedAssets++;
        report();
      }),
    );
    return new AssetLibrary(scene, manifest, containers);
  }

  get credits(): readonly Credit[] {
    return this.manifest.credits;
  }

  /** Credits that must be shown (CC-BY and similar). */
  get requiredCredits(): readonly Credit[] {
    return this.manifest.credits.filter((c) => c.attributionRequired);
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
