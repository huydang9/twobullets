import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Document, NodeIO } from "@gltf-transform/core";
import type { EquipmentManifest } from "../../../apps/client/src/assets/equipmentManifest.ts";
import { OUT_DIR } from "../config.ts";
import { hashBytes } from "../lib/cache.ts";
import { countGeometry } from "../lib/gltf.ts";
import { lastKeyTime } from "../lib/pose.ts";
import { EQUIPMENT_CREDITS, EQUIPMENT_ITEMS, EQUIPMENT_OUT, EQUIPMENT_TEXTURES, THROW_ARMS } from "./config.ts";

const MAX_ITEM_BYTES = 2_500_000;

/**
 * File-level checks of `equipment/`: manifest ↔ files, meshopt, triangle and texture budgets (per tier), KTX2 containers,
 * part nodes, the arms' skin/clip/grip, and credits. Returns the decoded documents for the KTX2 decode pass, or [] when
 * the equipment art isn't built (it is optional).
 */
export async function verifyEquipmentFiles(io: NodeIO, check: (condition: boolean, message: string) => void): Promise<Document[]> {
  const manifestFile = join(OUT_DIR, EQUIPMENT_OUT, "manifest.json");
  if (!existsSync(manifestFile)) {
    console.log("equipment: not built, skipped");
    return [];
  }
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as EquipmentManifest;
  const docs: Document[] = [];
  const credits = new Set(manifest.credits.map((c) => c.id));
  check(EQUIPMENT_CREDITS.every((c) => credits.has(c.id)), "equipment: manifest credits incomplete");
  const creditsJson = JSON.parse(await readFile(join(OUT_DIR, EQUIPMENT_OUT, "credits.json"), "utf8")) as { sources: { id: string; url: string; license: string }[] };
  check(EQUIPMENT_CREDITS.every((c) => creditsJson.sources.some((s) => s.id === c.id && s.url && s.license)), "equipment: credits.json incomplete");

  const load = async (label: string, asset: { url: string; hash: string; bytes: number; credit: string }, maxTextureSize: number) => {
    const bytes = new Uint8Array(await readFile(join(OUT_DIR, asset.url)));
    check(hashBytes(bytes) === asset.hash && bytes.byteLength === asset.bytes, `${label}: file does not match manifest`);
    check(credits.has(asset.credit), `${label}: unknown credit ${asset.credit}`);
    const doc = await io.readBinary(bytes);
    const root = doc.getRoot();
    check(root.listExtensionsUsed().some((e) => e.extensionName === "EXT_meshopt_compression"), `${label}: not meshopt compressed`);
    for (const texture of root.listTextures()) {
      const name = `${label}/${texture.getName()}`;
      if (texture.getMimeType() !== "image/ktx2") {
        check(texture.getMimeType() === "image/webp", `${name}: ${texture.getMimeType()}`);
        continue;
      }
      const image = texture.getImage()!;
      const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
      const [width, height, levels] = [20, 24, 40].map((o) => view.getUint32(o, true)) as [number, number, number];
      check(width <= maxTextureSize && height <= maxTextureSize && (width & (width - 1)) === 0, `${name}: ${width}x${height} (max ${maxTextureSize})`);
      check(levels > 1, `${name}: no mipmaps`);
    }
    for (const material of root.listMaterials()) {
      const extensions = material.listExtensions().map((e) => e.extensionName);
      check(!extensions.includes("KHR_materials_pbrSpecularGlossiness") && !extensions.includes("KHR_materials_specular"), `${label}: material ${material.getName()} is not metal/rough`);
    }
    docs.push(doc);
    return doc;
  };
  const maxSize = (tier: keyof typeof EQUIPMENT_TEXTURES) => Math.max(...EQUIPMENT_TEXTURES[tier].map((r) => r.maxSize));

  for (const spec of EQUIPMENT_ITEMS) {
    const asset = manifest.items[spec.id];
    if (!asset) {
      check(false, `equipment/${spec.id}: missing from the manifest`);
      continue;
    }
    const label = `equipment/${spec.id}`;
    const doc = await load(label, asset, maxSize(spec.textures));
    const root = doc.getRoot();
    check(asset.bytes <= MAX_ITEM_BYTES, `${label}: ${(asset.bytes / 1e6).toFixed(2)} MB exceeds budget`);
    check(root.listSkins().length === 0 && root.listAnimations().length === 0, `${label}: static models carry no skin or animation`);
    const { triangles } = countGeometry(doc);
    check(triangles <= spec.maxTriangles && triangles === asset.stats.triangles, `${label}: ${triangles} triangles (budget ${spec.maxTriangles})`);
    const names = root.listNodes().map((n) => n.getName());
    for (const [role, name] of Object.entries(asset.nodes)) check(names.filter((n) => n === name).length === 1, `${label}: node ${role}="${name}" not unique`);
    for (const role of Object.keys(spec.parts ?? {})) check(role in asset.nodes, `${label}: part ${role} missing`);
    const size = asset.bounds.max.map((v, i) => v - asset.bounds.min[i]!);
    const axis = spec.size.axis === "max" ? Math.max(...size) : size["xyz".indexOf(spec.size.axis)]!;
    check(Math.abs(axis - spec.size.meters) < 0.002, `${label}: size ${axis.toFixed(3)} m, spec ${spec.size.meters} m`);
  }

  const arms = manifest.arms;
  if (!arms) {
    check(false, "equipment/throw_arms: missing from the manifest");
  } else {
    const label = "equipment/throw_arms";
    const doc = await load(label, arms, maxSize("arms"));
    const root = doc.getRoot();
    check(root.listSkins().length === 1, `${label}: ${root.listSkins().length} skins`);
    const animations = root.listAnimations();
    check(animations.length === 1 && animations[0]!.getName() === arms.animation, `${label}: animation mismatch`);
    if (animations[0]) check(Math.round(lastKeyTime(animations[0]) * arms.fps) === arms.lastFrame, `${label}: last frame`);
    check(countGeometry(doc).triangles <= THROW_ARMS.maxTriangles, `${label}: triangle budget`);
    const names = root.listNodes().map((n) => n.getName());
    for (const [role, name] of Object.entries(arms.nodes)) check(names.filter((n) => n === name).length === 1, `${label}: node ${role}="${name}" not unique`);
    check(!names.some((n) => /_(Pole|Goal)$/.test(n)), `${label}: IK helpers left in`);
    const ordered = [arms.clips.ready, arms.clips.windup, arms.clips.throw, arms.clips.follow, arms.clips.recover];
    check(ordered.every(([start, end], i) => start <= end && end <= arms.lastFrame && (i === 0 || start === ordered[i - 1]![1] || i === 1)), `${label}: clip ranges not contiguous`);
    check(arms.releaseFrame > arms.clips.throw[0] && arms.releaseFrame <= arms.clips.throw[1], `${label}: release frame outside the throw clip`);
  }
  const total = docs.length;
  console.log(`equipment: ${total} files checked`);
  return docs;
}
