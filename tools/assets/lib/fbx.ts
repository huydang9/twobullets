import { resolveObjectURL } from "node:buffer";
import { readFile } from "node:fs/promises";
import { type Bone, type Group, LoadingManager, type Loader, Texture } from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

export interface FbxImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface FbxScene {
  readonly group: Group;
  /** Embedded image for each texture the loader created. */
  readonly images: Map<Texture, FbxImage>;
}

/**
 * Parses a binary FBX with three.js's FBXLoader in Node. The loader would normally decode embedded
 * images through the DOM; instead we hand it placeholder textures and keep the raw embedded bytes.
 */
export async function loadFbx(path: string): Promise<FbxScene> {
  const urls = new Map<Texture, string>();
  const textureStub = {
    path: "",
    setPath(p: string) {
      this.path = p;
      return this;
    },
    load(url: string) {
      const texture = new Texture();
      urls.set(texture, url);
      return texture;
    },
  };
  const manager = new LoadingManager();
  manager.addHandler(/\.(png|jpe?g|tga|tiff?|bmp|webp)$/i, textureStub as unknown as Loader);

  const file = await readFile(path);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const warn = console.warn;
  // Mixamo animation FBXs declare Z-up; the loader only rotates its root group, which we ignore.
  console.warn = (...args: unknown[]) => {
    if (!String(args[0]).includes("Z-UP")) warn(...args);
  };
  let group: Group;
  try {
    group = new FBXLoader(manager).parse(buffer as ArrayBuffer, "");
  } finally {
    console.warn = warn;
  }

  const images = new Map<Texture, FbxImage>();
  for (const [texture, url] of urls) {
    const blob = resolveObjectURL(url);
    if (!blob) continue;
    images.set(texture, { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type });
    URL.revokeObjectURL(url);
  }
  return { group, images };
}

/** FBX bone name before three.js sanitized it (e.g. "mixamorig:Hips"). */
export function originalName(bone: Bone): string {
  return (bone.userData as { originalName?: string }).originalName ?? bone.name;
}

/**
 * FBXLoader duplicates a bone (as a zero-offset child with the same FBX id) when several skins share it.
 * Returns the outermost copy.
 */
export function canonicalBone(bone: Bone): Bone {
  let current = bone;
  const id = (b: Bone) => (b as Bone & { ID?: number }).ID;
  while (current.parent && (current.parent as Bone).isBone && id(current.parent as Bone) === id(current)) {
    current = current.parent as Bone;
  }
  return current;
}
