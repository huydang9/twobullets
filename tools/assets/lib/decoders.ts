import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "rolldown";
import type { DecoderUrls } from "../../../apps/client/src/assets/manifest.ts";
import { OUT_DIR } from "../config.ts";

const require = createRequire(import.meta.url);
const DIR = "decoders";

const KTX2_WASM = {
  wasmMSCTranscoder: "msc_basis_transcoder.wasm",
  wasmUASTCToASTC: "uastc_astc.wasm",
  wasmUASTCToBC7: "uastc_bc7.wasm",
  wasmUASTCToRGBA_UNORM: "uastc_rgba8_unorm_v2.wasm",
  wasmUASTCToRGBA_SRGB: "uastc_rgba8_srgb_v2.wasm",
  wasmUASTCToR8_UNORM: "uastc_r8_unorm.wasm",
  wasmUASTCToRG8_UNORM: "uastc_rg8_unorm.wasm",
  wasmZSTDDecoder: "zstddec.wasm",
} as const;

export const DECODER_URLS: DecoderUrls = {
  meshopt: `${DIR}/meshopt_decoder.js`,
  ktx2: {
    jsDecoderModule: `${DIR}/babylon.ktx2Decoder.js`,
    jsMSCTranscoder: `${DIR}/msc_basis_transcoder.js`,
    ...(Object.fromEntries(Object.entries(KTX2_WASM).map(([key, file]) => [key, `${DIR}/${file}`])) as Record<
      keyof typeof KTX2_WASM,
      string
    >),
  },
};

function packageDir(name: string): string {
  let dir = dirname(require.resolve(name));
  while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
  return dir;
}

/** Versions of the packages the decoders come from; used as the cache key. */
export async function decoderVersions(): Promise<string> {
  const version = async (pkg: string) =>
    JSON.parse(await readFile(join(packageDir(pkg), "package.json"), "utf8")).version as string;
  return `meshoptimizer@${await version("meshoptimizer")} ktx2decoder@${await version("@babylonjs/ktx2decoder")}`;
}

/**
 * Hosts the runtime decoders locally instead of Babylon's CDN: meshopt's classic-script build, and
 * Babylon's KTX2 worker module (bundled from the ESM package into the UMD global it expects) with its wasm.
 */
export async function buildDecoders(): Promise<void> {
  const out = join(OUT_DIR, DIR);
  await mkdir(out, { recursive: true });
  await copyFile(require.resolve("meshoptimizer/decoder.cjs"), join(out, "meshopt_decoder.js"));

  const ktx2Root = packageDir("@babylonjs/ktx2decoder");
  await build({
    input: join(ktx2Root, "legacy/legacy.js"),
    logLevel: "warn",
    output: { file: join(out, "babylon.ktx2Decoder.js"), format: "umd", name: "KTX2DECODER", minify: true },
  });
  await copyFile(join(ktx2Root, "wasm/msc_basis_transcoder.js"), join(out, "msc_basis_transcoder.js"));
  for (const file of Object.values(KTX2_WASM)) await copyFile(join(ktx2Root, "wasm", file), join(out, file));
}
