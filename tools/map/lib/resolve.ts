/**
 * Module resolution for the map tools (Node's type stripping, `node --experimental-transform-types`):
 * - `@babylonjs/*` resolves from apps/client, where pnpm installed it;
 * - `@twobullets/shared` resolves to its source barrel;
 * - extensionless relative imports resolve to `.ts` or `/index.ts`, the way Vite does.
 *
 * Import this module first and load everything else with dynamic `import()`.
 */
import { existsSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLIENT_PACKAGE_URL = pathToFileURL(join(REPO_ROOT, "apps/client/package.json")).href;
const SHARED_ENTRY_URL = pathToFileURL(join(REPO_ROOT, "packages/shared/src/index.ts")).href;

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@twobullets/shared") return { url: SHARED_ENTRY_URL, shortCircuit: true };
    if (specifier.startsWith("@babylonjs/")) {
      const fromClient = { ...context, parentURL: CLIENT_PACKAGE_URL };
      try {
        return nextResolve(specifier, fromClient);
      } catch {
        return nextResolve(`${specifier}.js`, fromClient);
      }
    }
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.endsWith(".ts")) {
      const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
