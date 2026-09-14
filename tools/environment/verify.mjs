#!/usr/bin/env node
// Headless check of the prop/vegetation outputs: every generated prop loads through the real PropLibrary (NullEngine,
// meshopt decoding, materials skipped), level triangle counts and bounds match the manifest, templates are detached,
// and every KTX2 texture transcodes with the hosted Babylon decoder.
// Usage: node --experimental-transform-types tools/environment/verify.mjs   (client sources use TS parameter properties)
import { readFile } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInThisContext } from "node:vm";
setTimeout(() => {
  console.error("aborted after 300 s");
  process.exit(2);
}, 300_000).unref();
// Resolve client sources the way Vite does: extensionless relative imports, Babylon from the client's node_modules.
const REPO = new URL("../../", import.meta.url);
const clientPkg = new URL("apps/client/package.json", REPO).href;
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "@twobullets/shared") return next(${JSON.stringify(new URL("packages/shared/src/index.ts", REPO).href)}, context);
  if (/^(@babylonjs|@gltf-transform|meshoptimizer|sharp)/.test(specifier)) {
    const c = { ...context, parentURL: ${JSON.stringify(clientPkg)} };
    try { return await next(specifier, c); } catch { return next(specifier + ".js", c); }
  }
  if (specifier.startsWith(".") && context.parentURL?.startsWith(${JSON.stringify(REPO.href)}) && !/\\.[cm]?[jt]sx?$|\\.json$/.test(specifier)) {
    try { return await next(specifier + ".ts", context); } catch { return next(specifier + "/index.ts", context); }
  }
  return next(specifier, context);
}`)}`);

const R = REPO.pathname;
const OUT = R + "apps/client/public/assets/";
const errors = [];
const check = (c, m) => { if (!c) errors.push(m); };

const { NullEngine, Scene, MeshoptCompression, Tools, Vector3 } = await import("@babylonjs/core");
const { MeshoptDecoder } = await import("meshoptimizer");
await MeshoptDecoder.ready;
Object.assign(globalThis, { MeshoptDecoder });
Tools.LoadBabylonScriptAsync = async () => {};
MeshoptCompression.prototype.decodeGltfBufferAsync = async (source, count, stride, mode, filter) => {
  const target = new Uint8Array(count * stride);
  MeshoptDecoder.decodeGltfBuffer(target, count, stride, source, mode, filter);
  return target;
};
const { PropLibrary, PROP_MANIFEST, PROP_IDS } = await import(R + "apps/client/src/world/propAssets.ts");
const engine = new NullEngine();
const scene = new Scene(engine);
const fetchFile = async (url) => new Response(await readFile(new URL(url.split("?")[0])));
const lib = await PropLibrary.load(scene, { baseUrl: pathToFileURL(OUT + "environment/"), headless: true, fetch: fetchFile, decoders: { meshopt: "x", ktx2: {} } });
let ready = 0;
for (const id of PROP_IDS) {
  const asset = PROP_MANIFEST[id];
  const t = lib.get(id);
  if (!asset.ready) continue;
  ready++;
  check(t.levels.length === asset.lods.length, `${id}: ${t.levels.length} levels`);
  t.levels.forEach((level, i) => {
    const tris = level.meshes.reduce((n, m) => n + m.getTotalIndices() / 3, 0);
    check(tris === asset.lods[i].triangles, `${id} LOD${i}: ${tris} tris vs manifest ${asset.lods[i].triangles}`);
    const min = new Vector3(Infinity, Infinity, Infinity), max = min.scale(-1);
    for (const m of level.meshes) { const b = m.getBoundingInfo().boundingBox; min.minimizeInPlace(b.minimumWorld); max.maximizeInPlace(b.maximumWorld); }
    const err = Math.max(...[...min.asArray(), ...max.asArray()].map((v, k) => Math.abs(v - [...asset.bounds.min, ...asset.bounds.max][k])));
    if (i === 0) check(err < 0.02, `${id} LOD0 bounds differ by ${err.toFixed(3)} (${min} ${max})`);
    for (const m of level.meshes) check(!m.parent && m.isEnabled() === false, `${id}: template not detached/disabled`);
  });
  const batch = lib.createBatch(id, 0, `test_${id}`);
  check(batch.length > 0 && batch.every((m) => m.isEnabled()), `${id}: createBatch`);
  batch.forEach((m) => m.dispose());
  console.log(`${id.padEnd(20)} ${t.levels.map((l) => l.triangles).join("/")} tris  bounds ${asset.bounds.min.join(",")} .. ${asset.bounds.max.join(",")}  ${asset.collision.kind}`);
}
const leftovers = scene.meshes.filter((m) => m.isEnabled() && !m.name.includes("placeholder"));
check(leftovers.length === 0, `enabled leftovers: ${leftovers.map((m) => m.name).join(",")}`);
lib.dispose();
check(scene.meshes.length === 0, `meshes after dispose: ${scene.meshes.length}`);
engine.dispose();

// KTX2 decode of every texture in every prop GLB with the hosted Babylon decoder (as tools/assets/verify.ts does).
const { createIO } = await import(R + "tools/assets/lib/gltf.ts");
const io = await createIO();
const dir = OUT + "decoders";
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => String(input).startsWith("file:") ? new Response(await readFile(new URL(String(input))), { headers: { "content-type": "application/wasm" } }) : nativeFetch(input, init);
Object.assign(globalThis, { __dirname: dir, __filename: join(dir, "msc_basis_transcoder.js"), require: createRequire(import.meta.url) });
runInThisContext(await readFile(join(dir, "babylon.ktx2Decoder.js"), "utf8"));
runInThisContext(await readFile(join(dir, "msc_basis_transcoder.js"), "utf8"));
const K = globalThis.KTX2DECODER;
K.MSCTranscoder.UseFromWorkerThread = false;
K.MSCTranscoder.JSModule = globalThis.MSC_TRANSCODER;
K.MSCTranscoder.WasmBinary = (await readFile(join(dir, "msc_basis_transcoder.wasm"))).buffer;
K.LiteTranscoder_UASTC_BC7.WasmModuleURL = pathToFileURL(join(dir, "uastc_bc7.wasm")).href;
K.ZSTDDecoder.WasmModuleURL = pathToFileURL(join(dir, "zstddec.wasm")).href;
const decoder = new K.KTX2Decoder();
let decoded = 0;
const files = [...new Set(PROP_IDS.filter((id) => PROP_MANIFEST[id].ready).map((id) => PROP_MANIFEST[id].url))];
for (const url of files) {
  const doc = await io.readBinary(new Uint8Array(await readFile(OUT + "environment/" + url)));
  for (const tex of doc.getRoot().listTextures()) {
    check(tex.getMimeType() === "image/ktx2", `${url}/${tex.getName()}: ${tex.getMimeType()}`);
    try {
      const result = await decoder.decode(tex.getImage(), { bptc: true, s3tc: true }, {});
      check(result.mipmaps.length > 1, `${url}/${tex.getName()}: no mips`);
      check(result.isInGammaSpace === /baseColor$/.test(tex.getName()), `${url}/${tex.getName()}: gamma ${result.isInGammaSpace}`);
      decoded++;
    } catch (e) { errors.push(`${url}/${tex.getName()}: decode failed ${e}`); }
  }
}
globalThis.fetch = nativeFetch;
console.log(`${ready} ready props in ${files.length} files, ${decoded} KTX2 textures decoded`);
if (errors.length) { console.error(errors.map((e) => "  x " + e).join("\n")); process.exit(1); }
console.log("prop checks passed");
