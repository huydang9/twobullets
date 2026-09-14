#!/usr/bin/env node
// Builds prop and vegetation GLBs from the Poly Haven models fetched by fetch.mjs:
//   props/<model>.glb   one file per source model, holding a `<propId>_LOD<n>` root node per prop and level;
//                       KTX2 textures (ETC1S color/ORM, UASTC normals), meshopt-compressed geometry.
// Then records measured bounds, collision and LODs in build.json and regenerates environmentManifest.ts.
// Usage: node tools/environment/props.mjs [--only=model,model]   (one model at a time, one texture worker)
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { optimize, createIO } from "../assets/lib/gltf.ts";
import { TextureEncoderPool, compressTextures } from "../assets/lib/textures.ts";
import { CACHE_DIR, MODEL_TEXTURES, MODELS, OUT_DIR, PROPS, PROPS_OUT_DIR, SRC_DIR } from "./config.mjs";
import {
  babylonBounds,
  bounds,
  collisionOf,
  extractParts,
  footprintRadius,
  mat4,
  simplifierReady,
  simplifyPart,
  thinComponents,
  transformPart,
  triangleCount,
  writeNode,
} from "./geometry.mjs";
import { buildFoliage, writePreview } from "./foliage.mjs";
import { readBuildRecord, reportSizes, writeBuildRecord, writeManifest } from "./manifest.mjs";

setTimeout(() => {
  console.error("aborted after 1500 s");
  process.exit(2);
}, 1_500_000).unref();

const DEFAULT_TEXTURES = { baseColor: 1024, normal: 512, orm: 512 };

async function main() {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  await simplifierReady();
  await mkdir(PROPS_OUT_DIR, { recursive: true });
  const io = await createIO();
  const pool = new TextureEncoderPool(CACHE_DIR, 1);
  const credits = JSON.parse(await readFile(path.join(OUT_DIR, "credits.json"), "utf8")).assets;
  const record = await readBuildRecord();
  record.props ??= {};
  try {
    for (const model of MODELS) {
      const props = PROPS.filter((p) => p.model === model.id);
      if (props.length === 0 || (only && !only.includes(model.id))) continue;
      const started = performance.now();
      const entries = await buildModel(io, pool, model, props, credits.find((c) => c.id === model.id));
      Object.assign(record.props, entries);
      await writeBuildRecord(record);
      console.log(`${model.id}: ${((performance.now() - started) / 1000).toFixed(1)} s, rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
    }
  } finally {
    await pool.close();
  }
  await writeManifest(record);
  await reportSizes();
}

async function buildModel(io, pool, model, props, credit) {
  const dir = path.join(SRC_DIR, "models", model.id);
  const doc = await io.read(path.join(dir, model.meshes ? `${model.id}.subset.gltf` : `${model.id}.gltf`));
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const sourceNodes = root.listNodes();
  await mergeAlphaMaps(doc, model, dir);

  const entries = {};
  const url = `props/${model.id}.glb`;
  const built = [];
  const foliage = [];
  for (const prop of props) {
    const parts = extractParts(doc, prop.nodes);
    placeParts(parts, prop);
    if (prop.foliage) foliage.push({ prop, parts });
    else built.push({ prop, levels: buildLevels(parts, prop.lods) });
  }
  if (foliage.length > 0) {
    const result = await buildFoliage(doc, model.id, foliage, model.atlas ?? 2048);
    for (const { prop } of foliage) {
      const { levels, trunk } = result.get(prop.id);
      built.push({ prop, levels, trunk });
      await mkdir(path.join(CACHE_DIR, "previews"), { recursive: true });
      await writePreview(levels, path.join(CACHE_DIR, "previews", `${prop.id}.png`));
    }
  }
  for (const { prop, levels, trunk } of built) {
    const lodSpecs = prop.foliage?.lods ?? prop.lods;
    const lods = levels.map((levelParts, i) => {
      const name = `${prop.id}_LOD${i}`;
      writeNode(doc, scene, name, levelParts);
      const lod = { url, node: name, distance: lodSpecs[i].distance, triangles: triangleCount(levelParts) };
      return lodSpecs[i].impostor ? { ...lod, billboard: true } : lod;
    });
    entries[prop.id] = {
      url,
      bytes: 0,
      lods,
      bounds: babylonBounds(levels[0]),
      footprintRadius: footprintRadius(levels[0]),
      collision: collisionOf(prop.collision, levels[0], { trunk: prop.collision === "cylinder" ? trunk : undefined }),
      source: sourceOf(model.id, credit),
    };
    console.log(`  ${prop.id.padEnd(20)} ${lods.map((l) => l.triangles).join(" / ")} tris`);
  }

  for (const node of sourceNodes) node.dispose();
  for (const material of root.listMaterials()) {
    // Poly Haven marks everything double-sided; only cutouts need it.
    material.setDoubleSided(material.getAlphaMode() !== "OPAQUE");
  }
  const limits = { ...DEFAULT_TEXTURES, ...MODEL_TEXTURES[model.id] };
  const rules = [
    { slot: "baseColor", maxSize: limits.baseColor, codec: "etc1s" },
    { slot: "normal", maxSize: limits.normal, codec: "uastc" },
    { slot: "orm", maxSize: limits.orm, codec: "etc1s" },
  ];
  await compressTextures(doc, rules, "ktx2", pool);
  await optimize(doc);
  const file = path.join(OUT_DIR, url);
  await writeFile(file, await io.writeBinary(doc));
  const bytes = (await stat(file)).size;
  console.log(`  -> ${url} ${(bytes / 1e6).toFixed(2)} MB`);
  for (const entry of Object.values(entries)) entry.bytes = bytes;
  return entries;
}

/** Applies the prop's rotate/scale, then centers XZ on the origin and grounds it. */
export function placeParts(parts, { rotate, scale, ground = "min" }) {
  if (rotate || scale) {
    const m = mat4.multiply(mat4.scale(scale ?? 1), mat4.rotation(rotate ?? [0, 0, 0]));
    for (const part of parts) transformPart(part, m);
  }
  const { min, max } = bounds(parts);
  const offset = mat4.translation([-(min[0] + max[0]) / 2, ground === "min" ? -min[1] : 0, -(min[2] + max[2]) / 2]);
  for (const part of parts) transformPart(part, offset);
}

/** LOD0 is capped at `maxTriangles` by simplification, or for `thin` levels (grass) by dropping whole blades. */
function buildLevels(parts, lods) {
  const reduce = (source, ratio, lod) =>
    source.map((p) => (lod.thin ? thinComponents(p, ratio) : simplifyPart(p, ratio, lod.error ?? 0.01, ratio < 0.1 ? ["Prune"] : [])));
  const [first, ...rest] = lods;
  const total = triangleCount(parts);
  const lod0 = total > first.maxTriangles ? reduce(parts, first.maxTriangles / total, first) : parts;
  return [lod0, ...rest.map((lod) => reduce(lod0, lod.ratio, lod))];
}

/** Joins the separate Poly Haven opacity map into the base color alpha and switches the material to alpha test. */
async function mergeAlphaMaps(doc, model, dir) {
  for (const [materialName, key] of Object.entries(model.alpha ?? {})) {
    const material = doc.getRoot().listMaterials().find((m) => m.getName() === materialName);
    const texture = material?.getBaseColorTexture();
    if (!texture) throw new Error(`${model.id}: material ${materialName} has no base color texture`);
    // Decode to raw first: sharp applies removeAlpha() after joinChannel() in one pipeline, which silently dropped the
    // merged opacity (cutouts shipped as opaque RGB KTX2s).
    const { data: rgb, info } = await sharp(texture.getImage()).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const alpha = await sharp(await readFile(path.join(dir, "textures", `${model.id}_${key}_1k.jpg`)))
      .resize(width, height)
      .extractChannel(0)
      .raw()
      .toBuffer();
    const rgba = bleedUnderCutout(rgb, alpha, width * height);
    const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const channels = (await sharp(png).metadata()).channels;
    if (channels !== 4) throw new Error(`${model.id}: merged ${materialName} texture has ${channels} channels`);
    // Several materials can share one albedo image: give each merged texture its own URI so they don't collide.
    texture.setImage(new Uint8Array(png)).setMimeType("image/png").setURI(`${materialName}_alpha.png`);
    material.setAlphaMode("MASK").setAlphaCutoff(0.5);
  }
}

/**
 * RGBA from RGB + alpha, with texels below the cutoff recolored to the mean color of the kept ones. Poly Haven paints
 * the holes black, so mips averaged thin wire or leaves toward black at distance.
 */
function bleedUnderCutout(rgb, alpha, pixels) {
  const sum = [0, 0, 0];
  let kept = 0;
  for (let i = 0; i < pixels; i++) {
    if (alpha[i] < 128) continue;
    for (let c = 0; c < 3; c++) sum[c] += rgb[i * 3 + c];
    kept++;
  }
  const mean = sum.map((s) => Math.round(s / Math.max(1, kept)));
  const rgba = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const hole = alpha[i] < 128;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = hole ? mean[c] : rgb[i * 3 + c];
    rgba[i * 4 + 3] = alpha[i];
  }
  return rgba;
}

function sourceOf(id, credit) {
  return {
    id,
    name: credit?.name ?? id,
    url: `https://polyhaven.com/a/${id}`,
    license: "CC0",
    authors: (credit?.authors ?? []).map((a) => a.name),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
