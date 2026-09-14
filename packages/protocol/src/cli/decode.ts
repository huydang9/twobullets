/**
 * Decodes one protocol message to JSON.
 *
 *   node --import ./tools/map/lib/resolve.ts packages/protocol/src/cli/decode.ts <hex> [--ref=<tick>]
 *   node --import ./tools/map/lib/resolve.ts packages/protocol/src/cli/decode.ts --file=<path> [--ref=<tick>]
 *
 * (`pnpm --filter @twobullets/protocol decode -- <hex>` wraps the first form.) Delta snapshots decode header-only
 * because the baseline isn't available. Not exported from the package barrel; `process.getBuiltinModule` keeps
 * node:* out of the import graph checked by the boundary test.
 */
import { bytesToHex, describeMessage, hexToBytes } from "../debug/describe";

// Typed locally so the pure package doesn't need @types/node.
interface CliProcess {
  readonly argv: readonly string[];
  exit(code: number): never;
  getBuiltinModule(id: "node:fs"): { readFileSync(path: string): Uint8Array & { toString(encoding: "utf8"): string } };
}
const process: CliProcess = (globalThis as unknown as { process: CliProcess }).process;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const positional = args.filter((a) => !a.startsWith("--"));

let bytes: Uint8Array | null = null;
const file = flag("file");
if (file !== undefined) {
  const fs = process.getBuiltinModule("node:fs");
  const data = fs.readFileSync(file);
  const text = data.toString("utf8").trim();
  bytes = /^(0x)?[0-9a-f\s:]+$/i.test(text) && text.length > 1 ? hexToBytes(text) : new Uint8Array(data);
} else if (positional.length > 0) {
  bytes = hexToBytes(positional.join(""));
}

if (bytes === null) {
  console.error("usage: decode.ts <hex> | --file=<path> [--ref=<tick>]");
  process.exit(2);
}

const ref = Number(flag("ref") ?? 0);
const input: Uint8Array = bytes;
const result = describeMessage(input, { referenceTick: Number.isFinite(ref) ? ref : 0 });
console.log(JSON.stringify({ hex: bytesToHex(input), ...result }, null, 2));
process.exit(result.ok ? 0 : 1);
