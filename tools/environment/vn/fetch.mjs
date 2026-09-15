#!/usr/bin/env node
// Downloads the CC0 Poly Haven models of the Vietnamese street set (vn/config.mjs, models without `files`) as 1K glTF
// into assets-src/environment/vn/models/<id>/, verifying MD5s, and upserts their credits (`set: "vn"`) into
// public/assets/environment/credits.json. External models (`files`) are downloaded by hand; see docs/assets-vietnam.md.
// Usage: node tools/environment/vn/fetch.mjs [--only=id,id]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OUT_DIR, POLY_HAVEN_API } from "../config.mjs";
import { creditEntry, download, getJson } from "../fetch.mjs";
import { upsertCredits } from "../props.mjs";
import { VN_MODELS, VN_MODELS_DIR } from "./config.mjs";

setTimeout(() => {
  console.error("aborted after 1500 s");
  process.exit(2);
}, 1_500_000).unref();

async function main() {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const creditsFile = path.join(OUT_DIR, "credits.json");
  const body = JSON.parse(await readFile(creditsFile, "utf8"));
  const entries = [];
  for (const model of VN_MODELS) {
    if (only && !only.includes(model.id)) continue;
    if (model.skip) continue;
    if (model.files) {
      entries.push(...model.credits.map((c) => ({ ...c, set: "vn" })));
      continue;
    }
    console.log(model.id);
    const [info, files] = await Promise.all([getJson(`${POLY_HAVEN_API}/info/${model.id}`), getJson(`${POLY_HAVEN_API}/files/${model.id}`)]);
    const gltf = files.gltf?.["1k"]?.gltf;
    if (!gltf) throw new Error(`${model.id} has no 1k glTF`);
    const dir = path.join(VN_MODELS_DIR, model.id);
    await mkdir(dir, { recursive: true });
    await download(gltf.url, path.join(dir, `${model.id}.gltf`), gltf.md5, gltf.size);
    const sourceFiles = [gltf.url];
    for (const [rel, entry] of Object.entries(gltf.include)) {
      await download(entry.url, path.join(dir, rel), entry.md5, entry.size);
      sourceFiles.push(entry.url);
    }
    for (const [material, key] of Object.entries(model.alpha ?? {})) {
      const entry = files[key]?.["1k"]?.jpg ?? files[key]?.["1k"]?.png;
      if (!entry) throw new Error(`${model.id} has no 1k jpg for ${key} (${material})`);
      await download(entry.url, path.join(dir, "textures", `${model.id}_${key}_1k.jpg`), entry.md5, entry.size);
      sourceFiles.push(entry.url);
    }
    entries.push({ ...creditEntry(model.id, info, "model", sourceFiles), set: "vn" });
  }
  if (upsertCredits(body.assets, entries)) {
    await writeFile(creditsFile, `${JSON.stringify(body, null, 2)}\n`);
    console.log(`credits.json: ${entries.length} vn entries upserted`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
