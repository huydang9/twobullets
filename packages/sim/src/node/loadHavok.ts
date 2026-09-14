import HavokPhysics from "@babylonjs/havok";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { HavokModule } from "../index";

// Node-only (server, bots, tests); not exported from the package barrel. Havok's ESM build fetches its .wasm by URL,
// which Node's fetch can't do for file: URLs, so the binary is handed over directly.

const require = createRequire(import.meta.url);

/** Instantiates the Havok WASM module in Node. One module can back several SimWorlds. */
export function loadHavok(): Promise<HavokModule> {
  const wasmBinary = readFileSync(require.resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm"));
  return HavokPhysics({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) });
}
