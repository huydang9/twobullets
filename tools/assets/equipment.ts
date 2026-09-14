/**
 * Equipment art pipeline: `node tools/assets/equipment.ts [--force] [--only=frag,throw_arms] [--textures=ktx2|webp] [--timeout=900]`
 * Converts the equipment downloads in assets-src/ (throw arms, throwables, consumables, gear) into meshopt + KTX2 GLBs,
 * `equipment/manifest.json` and `equipment/credits.json` under apps/client/public/assets/. Models build one at a time
 * (texture encoding is memory heavy) and are skipped when their source, spec and pipeline code are unchanged.
 * Runs after `pnpm assets` (it reuses that build's decoders and texture cache).
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { EquipmentAsset, EquipmentManifest, EquipmentModelId, ThrowArmsAsset } from "../../apps/client/src/assets/equipmentManifest.ts";
import { EQUIPMENT_MODEL_IDS } from "../../apps/client/src/assets/equipmentManifest.ts";
import { CACHE_DIR, OUT_DIR, SRC_DIR } from "./config.ts";
import { buildThrowArms } from "./equipment/arms.ts";
import { EQUIPMENT_CREDITS, EQUIPMENT_ITEMS, EQUIPMENT_OUT, EQUIPMENT_PIPELINE_VERSION, EQUIPMENT_TEXTURES, THROW_ARMS } from "./equipment/config.ts";
import { buildEquipmentItem } from "./equipment/item.ts";
import { hashBytes, hashFiles, StampStore } from "./lib/cache.ts";
import { createIO } from "./lib/gltf.ts";
import { TextureEncoderPool, type TextureFormat } from "./lib/textures.ts";

const { values: args } = parseArgs({
  options: {
    force: { type: "boolean", default: false },
    only: { type: "string" },
    textures: { type: "string", default: "ktx2" },
    timeout: { type: "string", default: "900" },
  },
});
setTimeout(() => {
  console.error(`equipment: aborted after ${args.timeout}s`);
  process.exit(2);
}, Number(args.timeout) * 1000).unref();
const format = args.textures as TextureFormat;
if (format !== "ktx2" && format !== "webp") throw new Error("--textures must be ktx2 or webp");
const only = args.only ? new Set(args.only.split(",")) : undefined;

const started = performance.now();
const stamps = await StampStore.open(join(CACHE_DIR, "equipment"));
const codeHash = await hashFiles(await pipelineSources());
const jsonKey = (value: unknown) => JSON.stringify(value, (_, v) => (v instanceof RegExp ? v.source : v));

async function cached<T extends { url: string; hash: string }>(id: string, inputKey: string, produce: () => Promise<T>): Promise<T | null> {
  const key = hashBytes(inputKey, codeHash, String(EQUIPMENT_PIPELINE_VERSION), format);
  const previous = stamps.get<T>(id);
  if (only && !only.has(id)) {
    if (previous && (await outputIntact(previous))) return previous;
    console.warn(`- ${id}: skipped (no intact previous build)`);
    return null;
  }
  if (!args.force && stamps.get<T>(id, key) && (await outputIntact(previous!))) {
    console.log(`- ${id}: up to date`);
    return previous!;
  }
  console.log(`- ${id}: building`);
  const value = await produce();
  stamps.set(id, key, value);
  await stamps.save();
  return value;
}

async function outputIntact(asset: { url: string; hash: string }): Promise<boolean> {
  const file = join(OUT_DIR, asset.url);
  return existsSync(file) && hashBytes(await readFile(file)) === asset.hash;
}

const io = await createIO();
// One encoder worker: the 4K sources are decoded and encoded one texture at a time.
const pool = new TextureEncoderPool(CACHE_DIR, 1);
try {
  const items: Partial<Record<EquipmentModelId, EquipmentAsset>> = {};
  for (const spec of EQUIPMENT_ITEMS) {
    const inputs = await hashFiles(await sourceFiles(spec.source));
    const asset = await cached(spec.id, inputs + jsonKey([spec, EQUIPMENT_TEXTURES[spec.textures]]), () => buildEquipmentItem(spec, io, pool, format));
    if (asset) items[spec.id] = asset;
  }
  const armsInputs = await hashFiles([join(SRC_DIR, THROW_ARMS.source)]);
  const arms: ThrowArmsAsset | null = await cached(THROW_ARMS.id, armsInputs + jsonKey([THROW_ARMS, EQUIPMENT_TEXTURES.arms]), () =>
    buildThrowArms(THROW_ARMS, io, pool, format),
  );

  const manifest: EquipmentManifest = {
    version: 1,
    arms,
    items: Object.fromEntries(EQUIPMENT_MODEL_IDS.filter((id) => items[id]).map((id) => [id, items[id]])),
    credits: EQUIPMENT_CREDITS,
  };
  await writeJson(join(OUT_DIR, EQUIPMENT_OUT, "manifest.json"), manifest);
  await writeJson(join(OUT_DIR, EQUIPMENT_OUT, "credits.json"), creditsFile(manifest));

  const total = [arms, ...Object.values(items)].reduce((sum, a) => sum + (a?.bytes ?? 0), 0);
  console.log(`Done in ${((performance.now() - started) / 1000).toFixed(1)}s — ${(total / 1e6).toFixed(2)} MB of equipment models`);
} finally {
  await pool.close();
}

/** Same shape as the other `public/assets/*\/credits.json` files: one source entry per model with its output files. */
function creditsFile(manifest: EquipmentManifest) {
  const outputs = new Map<string, string[]>();
  const add = (credit: string, line: string) => outputs.set(credit, [...(outputs.get(credit) ?? []), line]);
  if (manifest.arms) add(manifest.arms.credit, `${manifest.arms.url} ← ${THROW_ARMS.source}`);
  for (const spec of EQUIPMENT_ITEMS) {
    const asset = manifest.items[spec.id];
    if (asset) add(asset.credit, `${asset.url} ← ${spec.source}`);
  }
  return {
    note: "Equipment models (first-person throw arms, throwables, consumables, gear). CC BY 4.0 models require attribution; the Poly Haven model is CC0.",
    generated: "2026-09-15",
    pipeline: "tools/assets/equipment.ts (baked to item space, metal/rough, meshopt, KTX2)",
    sources: EQUIPMENT_CREDITS.map((credit) => ({
      id: credit.id,
      title: credit.title,
      authors: [credit.author],
      ...(credit.authorUrl ? { authorUrl: credit.authorUrl } : {}),
      license: credit.license,
      ...(credit.licenseUrl ? { licenseUrl: credit.licenseUrl } : {}),
      url: credit.url,
      ...(credit.notes ? { notes: credit.notes } : {}),
      files: outputs.get(credit.id) ?? [],
    })),
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const json = `${JSON.stringify(value, null, 2).replace(/\[\s+([-\d.e,\s]+?)\s+\]/g, (_, items: string) => `[${items.split(/,\s*/).join(", ")}]`)}\n`;
  if (!existsSync(file) || (await readFile(file, "utf8")) !== json) await writeFile(file, json);
}

/** A .gltf source also depends on its .bin and textures. */
async function sourceFiles(source: string): Promise<string[]> {
  const path = join(SRC_DIR, source);
  if (!source.endsWith(".gltf")) return [path];
  const dir = join(path, "..");
  const files = [path, ...(await readdir(dir)).filter((f) => f.endsWith(".bin")).map((f) => join(dir, f))];
  const textures = join(dir, "textures");
  if (existsSync(textures)) files.push(...(await readdir(textures)).map((f) => join(textures, f)));
  return files;
}

async function pipelineSources(): Promise<string[]> {
  const dirs = ["tools/assets/equipment", "tools/assets/lib"];
  const files = (await Promise.all(dirs.map(async (dir) => (await readdir(dir)).filter((f) => f.endsWith(".ts") && f !== "config.ts" && f !== "verify.ts").map((f) => join(dir, f))))).flat();
  return [...files, "tools/assets/equipment.ts", "apps/client/src/assets/equipmentManifest.ts"];
}
