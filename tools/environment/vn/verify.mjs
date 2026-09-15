#!/usr/bin/env node
// Headless check of the Vietnamese street set (vn/build.mjs outputs): every prop in vnPropsManifest.ts loads with Babylon
// (NullEngine, meshopt decoding, materials skipped), level nodes exist, triangle counts and LOD0 bounds match the
// manifest, and every KTX2 texture transcodes with the hosted Babylon decoder. Same harness as ../verify.mjs.
// Usage: node --experimental-transform-types tools/environment/vn/verify.mjs
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
const REPO = new URL("../../../", import.meta.url);
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
const { LoadAssetContainerAsync, Mesh } = await import("@babylonjs/core");
await import("@babylonjs/loaders/glTF/index.js");
const { VN_PROP_MANIFEST, VN_PROP_IDS } = await import(R + "apps/client/src/assets/vnPropsManifest.ts");
const credits = JSON.parse(await readFile(OUT + "environment/credits.json", "utf8")).assets;
const engine = new NullEngine();
const scene = new Scene(engine);
const containers = new Map();
for (const id of VN_PROP_IDS) {
  const asset = VN_PROP_MANIFEST[id];
  check(asset.source && credits.some((c) => c.url === asset.source.url), `${id}: source ${asset.source?.url} missing from credits.json`);
  const sizes = [];
  for (const [i, lod] of asset.lods.entries()) {
    if (!containers.has(lod.url)) {
      const bytes = new Uint8Array(await readFile(OUT + "environment/" + lod.url));
      containers.set(lod.url, await LoadAssetContainerAsync(bytes, scene, { name: lod.url, pluginExtension: ".glb", pluginOptions: { gltf: { skipMaterials: true } } }));
    }
    const container = containers.get(lod.url);
    const root = [...container.transformNodes, ...container.meshes].find((n) => n.name === lod.node);
    check(root, `${id} LOD${i}: node ${lod.node} missing`);
    if (!root) continue;
    const meshes = [...(root instanceof Mesh ? [root] : []), ...root.getChildMeshes(false)].filter((m) => m.getTotalVertices() > 0);
    const tris = meshes.reduce((n, m) => n + m.getTotalIndices() / 3, 0);
    check(tris === lod.triangles, `${id} LOD${i}: ${tris} tris vs manifest ${lod.triangles}`);
    if (i === 0) {
      const min = new Vector3(Infinity, Infinity, Infinity), max = min.scale(-1);
      for (const m of meshes) { m.computeWorldMatrix(true); m.refreshBoundingInfo(); const b = m.getBoundingInfo().boundingBox; min.minimizeInPlace(b.minimumWorld); max.maximizeInPlace(b.maximumWorld); }
      const err = Math.max(...[...min.asArray(), ...max.asArray()].map((v, k) => Math.abs(v - [...asset.bounds.min, ...asset.bounds.max][k])));
      check(err < 0.02, `${id} LOD0 bounds differ by ${err.toFixed(3)} (${min} ${max})`);
      // Vegetation keeps its authored embedment (roots and leaf tips below ground), like ../verify.mjs trees.
      check(asset.bounds.min[1] > (asset.category === "prop" ? -0.05 : -0.3), `${id}: pivot not at ground (min y ${asset.bounds.min[1]})`);
    }
    sizes.push(tris);
  }
  console.log(`${id.padEnd(28)} ${sizes.join("/").padEnd(18)} ${asset.collision.kind.padEnd(10)} ${asset.url}`);
}
for (const c of containers.values()) c.dispose();
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
const files = [...new Set(VN_PROP_IDS.map((id) => VN_PROP_MANIFEST[id].url))];
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
console.log(`${VN_PROP_IDS.length} props in ${files.length} files, ${decoded} KTX2 textures decoded`);
if (errors.length) { console.error(errors.map((e) => "  x " + e).join("\n")); process.exit(1); }
console.log("vn prop checks passed");
