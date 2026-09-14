/**
 * Regenerates CONTENT_HASH in packages/protocol/src/version.ts from the shared tuning tables and engine pins.
 *
 *   node --experimental-transform-types packages/protocol/scripts/content-hash.ts [--check]
 *
 * `--check` exits 1 when version.ts is stale instead of writing it.
 */
import "../../../tools/map/lib/resolve.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

setTimeout(() => {
  console.error("[content-hash] watchdog: took longer than 60 s");
  process.exit(2);
}, 60_000).unref();

const here = dirname(fileURLToPath(import.meta.url));
const { computeContentHash } = await import("../src/contentHash.ts");
const { contentHashInputs, engineVersionsFromSimPackage } = await import("./contentInputs.ts");

const engine = engineVersionsFromSimPackage(readFileSync(join(here, "../../sim/package.json"), "utf8"));
const hash = computeContentHash(contentHashInputs(engine));
const hex = `0x${hash.toString(16).padStart(8, "0")}`;

const versionPath = join(here, "../src/version.ts");
const source = readFileSync(versionPath, "utf8");
const pattern = /export const CONTENT_HASH = [^;]+;/;
if (!pattern.test(source)) {
  console.error("[content-hash] CONTENT_HASH declaration not found in version.ts");
  process.exit(1);
}
const next = source.replace(pattern, `export const CONTENT_HASH = ${hex};`);

if (process.argv.includes("--check")) {
  if (next !== source) {
    console.error(`[content-hash] stale: expected ${hex}; run node --experimental-transform-types packages/protocol/scripts/content-hash.ts`);
    process.exit(1);
  }
  console.log(`[content-hash] up to date (${hex})`);
} else {
  if (next !== source) writeFileSync(versionPath, next);
  console.log(`[content-hash] ${hex}`);
}
process.exit(0);
