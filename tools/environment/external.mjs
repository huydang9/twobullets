// Models that don't come from fetch.mjs's 1K Poly Haven glTFs: Sketchfab GLBs (CC BY 4.0) and manually fetched Poly
// Haven 2K glTFs. They are loaded from `model.files` (several files merge into one document, e.g. a trunk scan plus
// another tree's crown), and their materials are normalized to what the prop pipeline expects: metal-rough PBR,
// no KHR_materials_specular, no emissive, source images at most 2K, optional albedo tint to a target mean.
import path from "node:path";
import sharp from "sharp";
import { mergeDocuments, unpartition } from "@gltf-transform/functions";
import { SRC_DIR } from "./config.mjs";

const MAX_SOURCE_IMAGE = 2048;

/** Reads and merges `model.files` into one document with a single scene holding every source root. */
export async function readExternalModel(io, model) {
  const [first, ...rest] = model.files;
  const doc = await io.read(path.join(SRC_DIR, first));
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  for (const file of rest) {
    const other = await io.read(path.join(SRC_DIR, file));
    const map = mergeDocuments(doc, other);
    for (const otherScene of other.getRoot().listScenes()) {
      const merged = map.get(otherScene);
      for (const child of merged.listChildren()) scene.addChild(child);
      merged.dispose();
    }
  }
  await doc.transform(unpartition());
  return doc;
}

/** Renames, converts and tints materials per `model.materials` (keyed by source material name). */
export async function prepareExternalMaterials(doc, model) {
  const root = doc.getRoot();
  await downscaleImages(doc);
  for (const material of root.listMaterials()) {
    const sourceName = material.getName();
    const options = model.materials?.[sourceName] ?? {};
    convertSpecularGlossiness(material);
    await roughnessFromGlossTexture(material);
    material.getExtension("KHR_materials_specular")?.dispose();
    material.getExtension("KHR_materials_ior")?.dispose();
    material.setEmissiveTexture(null).setEmissiveFactor([0, 0, 0]);
    if (options.name) material.setName(options.name);
    if (options.alpha === "opaque") material.setAlphaMode("OPAQUE");
    if (options.alpha === "mask") material.setAlphaMode("MASK").setAlphaCutoff(options.alphaCutoff ?? 0.5);
    if (options.roughness !== undefined) material.setRoughnessFactor(options.roughness);
    if (options.tint) await tintBaseColor(material, options.tint);
    for (const info of [material.getBaseColorTextureInfo(), material.getNormalTextureInfo(), material.getMetallicRoughnessTextureInfo(), material.getOcclusionTextureInfo()]) {
      if (info && info.getTexCoord() > 1) throw new Error(`${model.id}/${sourceName}: texCoord ${info.getTexCoord()} is not kept by the pipeline`);
    }
  }
  for (const extension of root.listExtensionsUsed()) {
    if (["KHR_materials_pbrSpecularGlossiness", "KHR_materials_specular", "KHR_materials_ior"].includes(extension.extensionName)) extension.dispose();
  }
  // Emissive and gloss images are no longer referenced.
  for (const texture of root.listTextures()) if (texture.listParents().every((p) => p === root)) texture.dispose();
}

/** KHR_materials_pbrSpecularGlossiness → metal-rough: diffuse becomes base color, dielectric, roughness 1 − gloss. */
function convertSpecularGlossiness(material) {
  const sg = material.getExtension("KHR_materials_pbrSpecularGlossiness");
  if (!sg) return;
  const diffuse = sg.getDiffuseTexture();
  if (diffuse) {
    material.setBaseColorTexture(diffuse);
    const info = sg.getDiffuseTextureInfo();
    if (info) material.getBaseColorTextureInfo().setTexCoord(info.getTexCoord());
  }
  material.setBaseColorFactor(sg.getDiffuseFactor()).setMetallicFactor(0).setRoughnessFactor(1 - sg.getGlossinessFactor());
  // The gloss image is measured by roughnessFromGlossTexture, then dropped with the extension.
  pendingGloss.set(material, { texture: sg.getSpecularGlossinessTexture(), factor: sg.getGlossinessFactor() });
  sg.dispose();
}

const pendingGloss = new WeakMap();

/** A gloss map (alpha) becomes a constant roughness factor: its mean. Saves an ORM texture for bark and leaves. */
async function roughnessFromGlossTexture(material) {
  const pending = pendingGloss.get(material);
  if (!pending?.texture) return;
  const { channels } = await sharp(pending.texture.getImage()).ensureAlpha().stats();
  const gloss = (channels[channels.length - 1].mean / 255) * pending.factor;
  material.setRoughnessFactor(Number((1 - gloss).toFixed(3)));
}

async function downscaleImages(doc) {
  for (const texture of doc.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    const { width = 0, height = 0 } = await sharp(image).metadata();
    if (Math.max(width, height) <= MAX_SOURCE_IMAGE) continue;
    const png = await sharp(image).resize(MAX_SOURCE_IMAGE, MAX_SOURCE_IMAGE, { fit: "inside", kernel: "lanczos3" }).png().toBuffer();
    texture.setImage(new Uint8Array(png)).setMimeType("image/png");
  }
}

const srgbToLinear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const linearToSrgb8 = (c) => Math.max(0, Math.min(255, Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055))));

/**
 * Scales the base color (linear, per channel, over texels with alpha ≥ 0.5) so its mean matches `target`. Scans of
 * different sources then sit together (a photogrammetry trunk under a hand-painted crown) and match the existing props.
 */
async function tintBaseColor(material, target) {
  const texture = material.getBaseColorTexture();
  if (!texture) throw new Error(`${material.getName()}: tint needs a base color texture`);
  const { data, info } = await sharp(texture.getImage()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const lut = Float32Array.from({ length: 256 }, (_, i) => srgbToLinear(i));
  const sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    for (let c = 0; c < 3; c++) sum[c] += lut[data[i + c]];
    count++;
  }
  const gain = sum.map((s, c) => target[c] / Math.max(1e-4, s / Math.max(1, count)));
  const out = Buffer.from(data);
  for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] = linearToSrgb8(lut[data[i + c]] * gain[c]);
  const png = await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  // A shared image would be tinted for every user; give this material its own texture.
  const tinted = texture.listParents().filter((p) => p.propertyType === "Material").length > 1 ? texture.clone() : texture;
  tinted.setImage(new Uint8Array(png)).setMimeType("image/png");
  material.setBaseColorTexture(tinted);
  console.log(`  tint ${material.getName()}: gain ${gain.map((g) => g.toFixed(2)).join(", ")}`);
}

/** Credit entries (credits.json format) of an external model, and the manifest `source` of its first credit. */
export function externalSource(model) {
  const [main, ...more] = model.credits;
  return {
    id: main.id,
    name: [main.name, ...more.map((c) => c.name)].join(" + "),
    url: main.url,
    license: main.license,
    authors: [...new Set(model.credits.flatMap((c) => c.authors.map((a) => a.name)))],
  };
}
