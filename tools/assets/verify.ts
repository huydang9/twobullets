/**
 * Validates generated assets: `pnpm assets:verify`.
 *  1. File level (glTF Transform): hashes, sizes, one skin, animations/clip tables, node names, texture containers
 *     (KTX2 codec, color space, size, mips), in-place locomotion, and skinned bounds after quantization.
 *  2. Texture decoding: transcodes every KTX2 texture with the hosted decoder bundle + wasm (desktop BC7/BC1 caps).
 *  3. Runtime level (Babylon NullEngine): loads every GLB through the real client AssetLibrary (headless) and runs
 *     the same `runAssetSelfCheck` used in the browser (instancing, clip playback, anchors, skinned bounds, bones,
 *     root motion).
 */
import { readFile } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInThisContext } from "node:vm";
import type { Document } from "@gltf-transform/core";
import type { AssetManifest } from "../../apps/client/src/assets/manifest.ts";
import { CHARACTER, OUT_DIR } from "./config.ts";
import { hashBytes } from "./lib/cache.ts";
import { createIO } from "./lib/gltf.ts";
import { lastKeyTime, poseAt, poseBounds, toBabylonBounds, worldMatrices } from "./lib/pose.ts";

setTimeout(() => {
  console.error("aborted after 300s");
  process.exit(2);
}, 300_000).unref();

const MAX_WEAPON_BYTES = 6_000_000;
const errors: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) errors.push(message);
};

const manifest = JSON.parse(await readFile(join(OUT_DIR, "manifest.json"), "utf8")) as AssetManifest;
const io = await createIO();

async function verifyFile(label: string, asset: { url: string; hash: string; bytes: number }) {
  const bytes = new Uint8Array(await readFile(join(OUT_DIR, asset.url)));
  check(hashBytes(bytes) === asset.hash && bytes.byteLength === asset.bytes, `${label}: file does not match manifest`);
  const doc = await io.readBinary(bytes);
  const root = doc.getRoot();
  check(root.listSkins().length === 1, `${label}: ${root.listSkins().length} skins`);
  const used = root.listExtensionsUsed().map((e) => e.extensionName);
  check(used.includes("EXT_meshopt_compression"), `${label}: not meshopt compressed`);

  for (const texture of root.listTextures()) {
    const image = texture.getImage()!;
    const name = `${label}/${texture.getName()}`;
    if (texture.getMimeType() === "image/ktx2") {
      const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
      const [width, height, levels, supercompression] = [20, 24, 40, 44].map((o) => view.getUint32(o, true)) as number[];
      const dfd = view.getUint32(48, true);
      const colorModel = view.getUint8(dfd + 12);
      const transfer = view.getUint8(dfd + 14);
      const color = /baseColor$/.test(texture.getName());
      check(width! <= 2048 && height! <= 2048 && (width! & (width! - 1)) === 0, `${name}: ${width}x${height}`);
      check(levels! > 1, `${name}: no mipmaps`);
      check(colorModel === 163 || colorModel === 166, `${name}: unexpected color model ${colorModel}`);
      check(supercompression === (colorModel === 163 ? 1 : 2), `${name}: supercompression ${supercompression}`);
      check(transfer === (color ? 2 : 1), `${name}: transfer function ${transfer} (color=${color})`);
    } else {
      check(texture.getMimeType() === "image/webp", `${name}: ${texture.getMimeType()}`);
    }
  }
  return { doc, bytes };
}

const decoded: Document[] = [];

for (const [id, weapon] of Object.entries(manifest.weapons)) {
  const { doc, bytes } = await verifyFile(id, weapon);
  decoded.push(doc);
  check(bytes.byteLength <= MAX_WEAPON_BYTES, `${id}: ${(bytes.byteLength / 1e6).toFixed(2)} MB exceeds budget`);
  const animations = doc.getRoot().listAnimations();
  check(animations.length === 1 && animations[0]!.getName() === weapon.animation, `${id}: animation mismatch`);
  const last = Math.round(lastKeyTime(animations[0]!) * weapon.fps);
  check(last === weapon.lastFrame, `${id}: last frame ${last} vs ${weapon.lastFrame}`);
  const names = doc.getRoot().listNodes().map((n) => n.getName());
  for (const [role, name] of Object.entries(weapon.nodes)) {
    check(names.filter((n) => n === name).length === 1, `${id}: node ${role}="${name}" not unique`);
  }
  // Quantization rewrites positions/inverse binds; skinned bounds must survive it.
  const idle = (weapon.clips.idle?.[0] ?? 0) / weapon.fps;
  const bounds = toBabylonBounds(poseBounds(doc, worldMatrices(doc, poseAt(doc, animations[0], idle))));
  const drift = Math.max(...[...bounds.min, ...bounds.max].map((v, i) => Math.abs(v - [...weapon.bounds.min, ...weapon.bounds.max][i]!)));
  check(drift < 0.002, `${id}: bounds after compression differ by ${drift.toFixed(4)} m`);
}

for (const [id, character] of Object.entries(manifest.characters)) {
  const { doc } = await verifyFile(id, character);
  decoded.push(doc);
  const root = doc.getRoot();
  const skin = root.listSkins()[0]!;
  const joints = new Set(skin.listJoints());
  const animations = new Map(root.listAnimations().map((a) => [a.getName(), a]));
  check(animations.size === Object.keys(character.clips).length, `${id}: ${animations.size} animations`);
  for (const [name, clip] of Object.entries(character.clips)) {
    const animation = animations.get(name);
    if (!animation) {
      errors.push(`${id}: missing animation ${name}`);
      continue;
    }
    check(Math.abs(lastKeyTime(animation) - clip.duration) < 0.002, `${id}/${name}: duration mismatch`);
    check(animation.listChannels().every((c) => joints.has(c.getTargetNode()!)), `${id}/${name}: channel targets a non-joint`);
    const hips = animation.listChannels().find((c) => c.getTargetNode()!.getName() === character.bones.hips && c.getTargetPath() === "translation");
    const values = hips?.getSampler()?.getOutput()?.getArray();
    if (values && CHARACTER.clips[name as keyof typeof CHARACTER.clips].inPlace) {
      const n = values.length;
      const drift = Math.hypot(values[n - 3]! - values[0]!, values[n - 1]! - values[2]!);
      check(drift < 0.001, `${id}/${name}: hips drift ${drift.toFixed(4)} m between first and last key`);
    }
  }
  for (const bone of Object.values(character.bones)) check(root.listNodes().some((n) => n.getName() === bone), `${id}: bone ${bone} missing`);
  const bounds = toBabylonBounds(poseBounds(doc, worldMatrices(doc, poseAt(doc, undefined, 0))));
  check(Math.abs(bounds.max[1] - bounds.min[1] - character.height) < 0.002, `${id}: height after compression ${bounds.max[1] - bounds.min[1]}`);
  check(character.height > 1.6 && character.height < 2, `${id}: height ${character.height}`);
}
console.log(errors.length === 0 ? "file checks passed" : `file checks: ${errors.length} error(s)\n  ${errors.join("\n  ")}`);

await verifyTextureDecoding(decoded);

/** Runs the hosted Babylon KTX2 decoder (as the browser worker would) on every texture, main-thread in Node. */
async function verifyTextureDecoding(docs: Document[]) {
  const dir = resolve(OUT_DIR, "decoders");
  const url = (file: string) => pathToFileURL(join(dir, file)).href;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input).startsWith("file:")
      ? new Response(await readFile(new URL(String(input))), { headers: { "content-type": "application/wasm" } })
      : nativeFetch(input, init)) as typeof fetch;
  // The emscripten MSC transcoder detects Node and expects CommonJS globals.
  Object.assign(globalThis, { __dirname: dir, __filename: join(dir, "msc_basis_transcoder.js"), require: createRequire(import.meta.url) });
  runInThisContext(await readFile(join(dir, "babylon.ktx2Decoder.js"), "utf8"));
  runInThisContext(await readFile(join(dir, "msc_basis_transcoder.js"), "utf8"));
  const K = (globalThis as Record<string, any>).KTX2DECODER;
  const G = globalThis as Record<string, any>;
  K.MSCTranscoder.UseFromWorkerThread = false;
  K.MSCTranscoder.JSModule = G.MSC_TRANSCODER;
  K.MSCTranscoder.WasmBinary = (await readFile(join(dir, "msc_basis_transcoder.wasm"))).buffer;
  K.LiteTranscoder_UASTC_BC7.WasmModuleURL = url("uastc_bc7.wasm");
  K.ZSTDDecoder.WasmModuleURL = url("zstddec.wasm");

  const decoder = new K.KTX2Decoder();
  let count = 0;
  for (const doc of docs) {
    for (const texture of doc.getRoot().listTextures()) {
      if (texture.getMimeType() !== "image/ktx2") continue;
      const name = texture.getName();
      try {
        const result = await decoder.decode(texture.getImage(), { bptc: true, s3tc: true }, {});
        const color = /baseColor$/.test(name);
        check(result.mipmaps.length > 1 && result.mipmaps.every((m: { data: Uint8Array | null }) => m.data?.byteLength), `${name}: empty mip levels`);
        check(result.isInGammaSpace === color, `${name}: decoded gamma space ${result.isInGammaSpace}`);
        count++;
      } catch (error) {
        errors.push(`${name}: KTX2 decode failed: ${String(error)}`);
      }
    }
  }
  globalThis.fetch = nativeFetch;
  console.log(`decoded ${count} KTX2 textures with the hosted decoder`);
}

// Runtime checks through the client code. Client sources use extensionless imports and Babylon lives in the
// client's node_modules, so resolve both the way Vite would.
const clientDir = resolve("apps/client");
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith("@babylonjs/")) {
        const client = { ...context, parentURL: ${JSON.stringify(pathToFileURL(join(clientDir, "package.json")).href)} };
        try {
          return await next(specifier, client);
        } catch {
          return next(specifier + ".js", client);
        }
      }
      if (specifier.startsWith(".") && context.parentURL?.includes("/apps/client/src/") && !/\\.[cm]?[jt]s$/.test(specifier)) {
        return next(specifier + ".ts", context);
      }
      return next(specifier, context);
    }`)}`,
);

const { NullEngine, Scene, MeshoptCompression, Tools } = await import("@babylonjs/core");
const { MeshoptDecoder } = await import("meshoptimizer");
const { AssetLibrary } = await import("../../apps/client/src/assets/AssetLibrary.ts");
const { runAssetSelfCheck } = await import("../../apps/client/src/assets/devCheck.ts");

// Babylon loads the meshopt decoder as a classic script into a worker; decode synchronously in Node instead.
await MeshoptDecoder.ready;
Object.assign(globalThis, { MeshoptDecoder });
Tools.LoadBabylonScriptAsync = async () => {};
MeshoptCompression.prototype.decodeGltfBufferAsync = async (source, count, stride, mode, filter) => {
  const target = new Uint8Array(count * stride);
  MeshoptDecoder.decodeGltfBuffer(target, count, stride, source, mode as never, filter as never);
  return target;
};

const engine = new NullEngine();
const scene = new Scene(engine);
const outRoot = pathToFileURL(`${resolve(OUT_DIR)}/`);
const library = await AssetLibrary.load(scene, undefined, {
  baseUrl: outRoot,
  headless: true,
  fetch: async (url) => new Response(await readFile(new URL(url.split("?")[0]!))),
});
const report = runAssetSelfCheck(library);
for (const line of report.summary) console.log(`  ${line}`);
errors.push(...report.errors);
library.dispose();
engine.dispose();

if (errors.length > 0) {
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exitCode = 1;
} else {
  console.log("runtime checks passed");
}
