/**
 * Emits plain-JS copies of a TypeScript entry and its relative imports using Node's built-in
 * `module.stripTypeScriptTypes`, into node_modules/.cache/twobullets-bench (gitignored). Worker threads load these
 * instead of .ts so their measured memory doesn't include Node's TypeScript stripper (amaro/swc wasm), which a
 * production build would not ship.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { REPO_ROOT } from "./paths.ts";

export const BUILD_ROOT = join(REPO_ROOT, "node_modules/.cache/twobullets-bench");

const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']+)\2/g;

/** Returns the absolute path of the emitted JS for `entry` (an absolute .ts path). */
export function buildJs(entry: string): string {
  const seen = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    const js = stripTypeScriptTypes(source, { mode: "strip" }).replace(IMPORT_RE, (_match, prefix: string, quote: string, spec: string) => {
      const target = spec.endsWith(".ts") ? spec : /\.[cm]?js$/.test(spec) ? spec : `${spec}.ts`;
      if (target.endsWith(".ts")) queue.push(resolve(dirname(file), target));
      return `${prefix}${quote}${target.replace(/\.ts$/, ".js")}${quote}`;
    });
    const out = join(BUILD_ROOT, relative(REPO_ROOT, file)).replace(/\.ts$/, ".js");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, js);
  }
  return join(BUILD_ROOT, relative(REPO_ROOT, resolve(entry))).replace(/\.ts$/, ".js");
}
