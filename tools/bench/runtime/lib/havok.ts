/** Loads the Havok WASM module in Node (the ESM build fetches its .wasm by URL, which Node's fetch can't do for file:). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { REPO_ROOT } from "./paths.ts";

const requireFromClient = createRequire(join(REPO_ROOT, "apps/client/package.json"));

export const HAVOK_ESM_PATH = requireFromClient.resolve("@babylonjs/havok").replace(/umd[\\/]HavokPhysics_umd\.js$/, "esm/HavokPhysics_es.js");
export const HAVOK_WASM_PATH = HAVOK_ESM_PATH.replace(/HavokPhysics_es\.js$/, "HavokPhysics.wasm");

/** Precompiled module, so worker threads can share one compilation (WebAssembly.Module is transferable). */
export function compileHavok(): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(HAVOK_WASM_PATH));
}

// The emscripten API is untyped here on purpose: benchmarks call HP_* functions directly.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type HavokApi = any;

export async function loadHavok(module?: WebAssembly.Module): Promise<HavokApi> {
  const { default: HavokPhysics } = (await import(HAVOK_ESM_PATH)) as { default: (options: object) => Promise<HavokApi> };
  if (module) {
    return HavokPhysics({
      instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
        WebAssembly.instantiate(module, imports).then((instance) => done(instance, module));
        return {};
      },
    });
  }
  return HavokPhysics({ wasmBinary: readFileSync(HAVOK_WASM_PATH) });
}

export function havokHeapBytes(hk: HavokApi): number {
  return (hk.HEAPU8 as Uint8Array).buffer.byteLength;
}
