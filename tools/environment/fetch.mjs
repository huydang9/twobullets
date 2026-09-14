#!/usr/bin/env node
// Downloads the CC0 Poly Haven textures, HDRI and models listed in config.mjs into assets-src/environment/,
// verifying MD5s, and writes credits.json next to the web-ready outputs. Downloads run one at a time.
// Usage: node tools/environment/fetch.mjs
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { DERIVED_MAPS, HDRI, MODELS, OUT_DIR, POLY_HAVEN_API, SRC_DIR, TEXTURE_MAPS, TEXTURES } from "./config.mjs";

setTimeout(() => {
  console.error("aborted after 1800 s");
  process.exit(2);
}, 1_800_000).unref();

const USER_AGENT = "twobullets-environment-pipeline";
/** Refuse single downloads above this; big multi-tree .bin files are fetched by byte range instead. */
const MAX_DOWNLOAD_BYTES = 120e6;

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.json();
}

async function md5Of(file) {
  try {
    return createHash("md5").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

async function download(url, file, md5, size) {
  if ((await md5Of(file)) === md5) {
    console.log(`  cached  ${path.relative(SRC_DIR, file)}`);
    return;
  }
  if (size > MAX_DOWNLOAD_BYTES) throw new Error(`${url} is ${(size / 1e6).toFixed(0)} MB; use byte ranges (MODELS[].meshes)`);
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_DOWNLOAD_BYTES) throw new Error(`${url} is ${(length / 1e6).toFixed(0)} MB`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash("md5").update(bytes).digest("hex");
  if (actual !== md5) throw new Error(`MD5 mismatch for ${url}: expected ${md5}, got ${actual}`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  console.log(`  fetched ${path.relative(SRC_DIR, file)} (${(bytes.length / 1e6).toFixed(2)} MB)`);
}

async function main() {
  const credits = [];

  for (const { id, sizes } of TEXTURES) {
    console.log(id);
    const [info, files] = await Promise.all([getJson(`${POLY_HAVEN_API}/info/${id}`), getJson(`${POLY_HAVEN_API}/files/${id}`)]);
    const needed = new Set(Object.keys(sizes).flatMap((map) => DERIVED_MAPS[map] ?? [map]));
    const downloaded = [];
    for (const [key, suffix] of Object.entries(TEXTURE_MAPS).filter(([, suffix]) => needed.has(suffix))) {
      const entry = files[key]?.["2k"]?.jpg;
      if (!entry) throw new Error(`${id} has no 2k jpg for ${key}`);
      await download(entry.url, path.join(SRC_DIR, id, `${id}_${suffix}_2k.jpg`), entry.md5, entry.size);
      downloaded.push(entry.url);
    }
    credits.push(creditEntry(id, info, "texture", downloaded));
  }

  console.log(HDRI.id);
  const [info, files] = await Promise.all([getJson(`${POLY_HAVEN_API}/info/${HDRI.id}`), getJson(`${POLY_HAVEN_API}/files/${HDRI.id}`)]);
  const entry = files.hdri?.[HDRI.resolution]?.hdr;
  if (!entry) throw new Error(`${HDRI.id} has no ${HDRI.resolution} hdr`);
  await download(entry.url, path.join(SRC_DIR, HDRI.id, `${HDRI.id}_${HDRI.resolution}.hdr`), entry.md5, entry.size);
  credits.push(creditEntry(HDRI.id, info, "hdri", [entry.url]));

  for (const model of MODELS) {
    console.log(model.id);
    const [info, files] = await Promise.all([getJson(`${POLY_HAVEN_API}/info/${model.id}`), getJson(`${POLY_HAVEN_API}/files/${model.id}`)]);
    const gltf = files.gltf?.["1k"]?.gltf;
    if (!gltf) throw new Error(`${model.id} has no 1k glTF`);
    const dir = path.join(SRC_DIR, "models", model.id);
    const gltfFile = path.join(dir, `${model.id}.gltf`);
    await download(gltf.url, gltfFile, gltf.md5, gltf.size);
    const sourceFiles = [gltf.url];
    const json = JSON.parse(await readFile(gltfFile, "utf8"));
    const subset = model.meshes ? subsetGltf(json, model.meshes) : null;
    const images = new Set((subset?.json ?? json).images.map((i) => i.uri));
    for (const [rel, entry] of Object.entries(gltf.include)) {
      if (rel.endsWith(".bin") ? subset : !images.has(rel)) continue;
      await download(entry.url, path.join(dir, rel), entry.md5, entry.size);
      sourceFiles.push(entry.url);
    }
    if (subset) {
      const [rel, entry] = Object.entries(gltf.include).find(([rel]) => rel.endsWith(".bin"));
      await downloadSubset(entry.url, subset, path.join(dir, `${model.id}.subset.gltf`), path.basename(rel).replace(".bin", ".subset.bin"));
      sourceFiles.push(entry.url);
    }
    for (const [material, key] of Object.entries(model.alpha ?? {})) {
      const entry = files[key]?.["1k"]?.jpg;
      if (!entry) throw new Error(`${model.id} has no 1k jpg for ${key} (${material})`);
      await download(entry.url, path.join(dir, "textures", `${model.id}_${key}_1k.jpg`), entry.md5, entry.size);
      sourceFiles.push(entry.url);
    }
    credits.push(creditEntry(model.id, info, "model", sourceFiles));
  }

  await mkdir(OUT_DIR, { recursive: true });
  const creditsFile = path.join(OUT_DIR, "credits.json");
  const body = {
    source: "Poly Haven (https://polyhaven.com)",
    license: "CC0 1.0 Universal (public domain). Attribution is not required but given here.",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    retrieved: new Date().toISOString().slice(0, 10),
    assets: credits,
  };
  await writeFile(creditsFile, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), creditsFile)} (${(await stat(creditsFile)).size} B)`);
}

/**
 * Rewrites a glTF to only the given meshes (and their nodes, materials, textures), with buffer views packed into one
 * new buffer. Returns the JSON plus the byte ranges of the original .bin to copy, in order.
 */
function subsetGltf(json, meshIndices) {
  const out = { asset: json.asset, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], materials: [], textures: [], images: [], samplers: json.samplers ?? [] };
  const ranges = [];
  let offset = 0;
  const viewMap = new Map();
  const view = (i) => {
    if (!viewMap.has(i)) {
      const v = json.bufferViews[i];
      const padding = (4 - (offset % 4)) % 4;
      offset += padding;
      ranges.push({ start: v.byteOffset ?? 0, length: v.byteLength, padding });
      out.bufferViews.push({ ...v, buffer: 0, byteOffset: offset });
      offset += v.byteLength;
      viewMap.set(i, out.bufferViews.length - 1);
    }
    return viewMap.get(i);
  };
  const accessorMap = new Map();
  const accessor = (i) => {
    if (!accessorMap.has(i)) {
      out.accessors.push({ ...json.accessors[i], bufferView: view(json.accessors[i].bufferView) });
      accessorMap.set(i, out.accessors.length - 1);
    }
    return accessorMap.get(i);
  };
  const imageMap = new Map();
  const textureMap = new Map();
  const texture = (i) => {
    if (!textureMap.has(i)) {
      const t = json.textures[i];
      if (!imageMap.has(t.source)) {
        out.images.push(json.images[t.source]);
        imageMap.set(t.source, out.images.length - 1);
      }
      out.textures.push({ ...t, source: imageMap.get(t.source) });
      textureMap.set(i, out.textures.length - 1);
    }
    return textureMap.get(i);
  };
  const materialMap = new Map();
  const material = (i) => {
    if (!materialMap.has(i)) {
      const m = structuredClone(json.materials[i]);
      const pbr = m.pbrMetallicRoughness ?? {};
      for (const slot of [m.normalTexture, m.occlusionTexture, m.emissiveTexture, pbr.baseColorTexture, pbr.metallicRoughnessTexture]) {
        if (slot) slot.index = texture(slot.index);
      }
      out.materials.push(m);
      materialMap.set(i, out.materials.length - 1);
    }
    return materialMap.get(i);
  };
  for (const node of json.nodes) {
    if (!meshIndices.includes(node.mesh)) continue;
    const mesh = json.meshes[node.mesh];
    out.meshes.push({
      ...mesh,
      primitives: mesh.primitives.map((p) => ({
        ...p,
        attributes: Object.fromEntries(Object.entries(p.attributes).map(([k, a]) => [k, accessor(a)])),
        indices: p.indices === undefined ? undefined : accessor(p.indices),
        material: p.material === undefined ? undefined : material(p.material),
      })),
    });
    out.nodes.push({ ...node, mesh: out.meshes.length - 1, children: undefined });
    out.scenes[0].nodes.push(out.nodes.length - 1);
  }
  return { json: out, ranges, byteLength: offset };
}

async function downloadSubset(url, subset, gltfFile, binName) {
  const binFile = path.join(path.dirname(gltfFile), binName);
  subset.json.buffers = [{ uri: binName, byteLength: subset.byteLength }];
  try {
    if ((await stat(binFile)).size === subset.byteLength) {
      console.log(`  cached  ${path.relative(SRC_DIR, binFile)}`);
      await writeFile(gltfFile, JSON.stringify(subset.json));
      return;
    }
  } catch {}
  const out = Buffer.alloc(subset.byteLength);
  let offset = 0;
  // Merge views that are contiguous in the source (and unpadded in the output) into single range requests.
  const spans = [];
  for (const r of subset.ranges) {
    offset += r.padding;
    const last = spans.at(-1);
    if (last && r.padding === 0 && last.start + last.length === r.start) last.length += r.length;
    else spans.push({ start: r.start, length: r.length, outOffset: offset });
    offset += r.length;
  }
  for (const span of spans) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Range: `bytes=${span.start}-${span.start + span.length - 1}` } });
    if (res.status !== 206) throw new Error(`Range GET ${url}: ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length !== span.length) throw new Error(`Range GET ${url}: got ${bytes.length} of ${span.length} bytes`);
    bytes.copy(out, span.outOffset);
  }
  await writeFile(binFile, out);
  await writeFile(gltfFile, JSON.stringify(subset.json));
  console.log(`  fetched ${path.relative(SRC_DIR, binFile)} (${(out.length / 1e6).toFixed(2)} MB in ${spans.length} ranges)`);
}

function creditEntry(id, info, type, files) {
  return {
    id,
    name: info.name,
    type,
    authors: Object.entries(info.authors ?? {}).map(([name, role]) => ({ name: name.trim(), role: role.trim() })),
    license: "CC0",
    url: `https://polyhaven.com/a/${id}`,
    sourceFiles: files,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
