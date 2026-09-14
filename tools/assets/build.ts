/**
 * Asset pipeline: `pnpm assets [--force] [--only=rifle,swat] [--textures=ktx2|webp] [--workers=1] [--timeout=600]`
 * Converts raw sources in assets-src/ into web-ready GLBs + manifest.json under apps/client/public/assets/.
 * Each output is skipped when its sources, spec and pipeline code are unchanged and the output file is intact.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type {
  AssetManifest,
  CharacterAsset,
  CharacterId,
  WeaponAsset,
  WeaponId,
} from "../../apps/client/src/assets/manifest.ts";
import { CHARACTER_IDS, WEAPON_IDS } from "../../apps/client/src/assets/manifest.ts";
import {
  CACHE_DIR,
  CHARACTER,
  CHARACTER_TEXTURES,
  characterClipPath,
  CREDITS,
  OUT_DIR,
  PIPELINE_VERSION,
  SRC_DIR,
  WEAPON_TEXTURES,
  WEAPONS,
} from "./config.ts";
import { hashBytes, hashFiles, StampStore } from "./lib/cache.ts";
import { buildCharacter } from "./lib/character.ts";
import { buildDecoders, DECODER_URLS, decoderVersions } from "./lib/decoders.ts";
import { createIO } from "./lib/gltf.ts";
import { TextureEncoderPool, type TextureFormat } from "./lib/textures.ts";
import { buildWeapon } from "./lib/weapon.ts";

const { values: args } = parseArgs({
  options: {
    force: { type: "boolean", default: false },
    only: { type: "string" },
    textures: { type: "string", default: "ktx2" },
    workers: { type: "string", default: "1" },
    timeout: { type: "string", default: "600" },
  },
});
// Hard stop so a stuck encoder can never hang CI or a shared machine.
setTimeout(() => {
  console.error(`assets: aborted after ${args.timeout}s`);
  process.exit(2);
}, Number(args.timeout) * 1000).unref();
const format = args.textures as TextureFormat;
if (format !== "ktx2" && format !== "webp") throw new Error(`--textures must be ktx2 or webp`);
const only = args.only ? new Set(args.only.split(",")) : undefined;

const started = performance.now();
const stamps = await StampStore.open(CACHE_DIR);
const codeHash = await hashFiles(await pipelineSources());
const jsonKey = (value: unknown) => JSON.stringify(value, (_, v) => (v instanceof RegExp ? v.source : v));

/** Runs `produce` unless the stamp for `id` matches `inputKey` and the recorded output still exists unchanged. */
async function cached<T extends { url: string; hash: string }>(
  id: string,
  inputKey: string,
  produce: () => Promise<T>,
): Promise<T> {
  const key = hashBytes(inputKey, codeHash, String(PIPELINE_VERSION), format);
  if (only && !only.has(id)) {
    const last = stamps.get<T>(id);
    if (last && (await outputIntact(last))) return last;
    throw new Error(`${id} has no intact previous build; run without --only first`);
  }
  const previous = stamps.get<T>(id, key);
  if (previous && !args.force && (await outputIntact(previous))) {
    console.log(`- ${id}: up to date`);
    return previous;
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
const pool = new TextureEncoderPool(CACHE_DIR, Math.max(1, Number(args.workers)));
try {
  const decoderKey = await decoderVersions();
  await cached("decoders", decoderKey, async () => {
    await buildDecoders();
    const url = DECODER_URLS.ktx2.jsDecoderModule;
    return { url, hash: hashBytes(await readFile(join(OUT_DIR, url))) };
  });

  const weapons = {} as Record<WeaponId, WeaponAsset>;
  const characters = {} as Record<CharacterId, CharacterAsset>;
  const weaponBuilds = WEAPONS.map(async (spec) => {
    const inputs = await hashFiles([join(SRC_DIR, spec.source)]);
    weapons[spec.id] = await cached(spec.id, inputs + jsonKey([spec, WEAPON_TEXTURES]), () =>
      buildWeapon(spec, io, pool, format),
    );
  });
  const characterBuild = (async () => {
    const animFiles = Object.values(CHARACTER.clips).map((clip) => join(SRC_DIR, characterClipPath(CHARACTER, clip)));
    const inputs = await hashFiles([join(SRC_DIR, CHARACTER.mesh), ...animFiles]);
    characters[CHARACTER.id] = await cached(CHARACTER.id, inputs + jsonKey([CHARACTER, CHARACTER_TEXTURES]), () =>
      buildCharacter(CHARACTER, io, pool, format),
    );
  })();
  await Promise.all([...weaponBuilds, characterBuild]);

  const manifest: AssetManifest = {
    version: 1,
    weapons: Object.fromEntries(WEAPON_IDS.map((id) => [id, weapons[id]])) as Record<WeaponId, WeaponAsset>,
    characters: Object.fromEntries(CHARACTER_IDS.map((id) => [id, characters[id]])) as Record<CharacterId, CharacterAsset>,
    credits: CREDITS,
    decoders: DECODER_URLS,
  };
  const manifestFile = join(OUT_DIR, "manifest.json");
  // Keep numeric tuples on one line.
  const json = `${JSON.stringify(manifest, null, 2).replace(/\[\s+([-\d.e,\s]+?)\s+\]/g, (_, items: string) => `[${items.split(/,\s*/).join(", ")}]`)}\n`;
  if (!existsSync(manifestFile) || (await readFile(manifestFile, "utf8")) !== json) await writeFile(manifestFile, json);

  const total = [...Object.values(manifest.weapons), ...Object.values(manifest.characters)].reduce((sum, a) => sum + a.bytes, 0);
  console.log(`Done in ${((performance.now() - started) / 1000).toFixed(1)}s — ${(total / 1e6).toFixed(2)} MB of models`);
} finally {
  await pool.close();
}

/** Pipeline code (everything except config.ts, whose relevant parts are hashed per asset). */
async function pipelineSources(): Promise<string[]> {
  const dir = "tools/assets/lib";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f));
  return [...files, "tools/assets/build.ts", "apps/client/src/assets/manifest.ts"];
}
