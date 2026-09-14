/**
 * Module resolution for the runtime benchmarks, installed with `module.registerHooks` (synchronous, per thread).
 *  - `@babylonjs/*` resolves from apps/client, where pnpm installed it (the repo root has no copy).
 *  - `@twobullets/sim` resolves to its source barrel (tools/bench has no node_modules of its own); the sim's own
 *    `@twobullets/shared/*` and deep `@babylonjs/*` imports resolve through packages/sim/node_modules.
 *  - Extensionless relative imports inside packages/shared, packages/sim, apps/client/src and tools/bench resolve to
 *    `.ts` or `/index.ts`, the way Vite/Vitest resolve them, so Node's built-in type stripping can run the shared gameplay code unmodified.
 *
 * Import this module FIRST and load everything else with dynamic `import()`: static imports are linked before any
 * module body runs, so hooks registered here cannot affect sibling static imports.
 */
import { existsSync } from "node:fs";
import * as nodeModule from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT } from "./paths.ts";

export { REPO_ROOT };
const CLIENT_PACKAGE_URL = pathToFileURL(join(REPO_ROOT, "apps/client/package.json")).href;
/** TB_BABYLON_DEEP=1: redirect the `@babylonjs/core` barrel to lib/babylonDeep.ts (deep imports only). */
const DEEP_BABYLON = process.env.TB_BABYLON_DEEP === "1";
const DEEP_SHIM_URL = pathToFileURL(join(REPO_ROOT, "tools/bench/runtime/lib/babylonDeep.ts")).href;
const SIM_ENTRY_URL = pathToFileURL(join(REPO_ROOT, "packages/sim/src/index.ts")).href;
const TS_SOURCE_DIRS = ["/packages/shared/src/", "/packages/sim/src/", "/apps/client/src/", "/tools/bench/"];

// Bun resolves extensionless TS imports natively and has no registerHooks; only Node needs the hooks.
const registerHooks = (nodeModule as { registerHooks?: typeof import("node:module").registerHooks }).registerHooks;
registerHooks?.({
  resolve(specifier, context, nextResolve) {
    if (DEEP_BABYLON && specifier === "@babylonjs/core" && !context.parentURL?.endsWith("/lib/babylonDeep.ts")) {
      return nextResolve(DEEP_SHIM_URL, context);
    }
    if (specifier === "@twobullets/sim") return { url: SIM_ENTRY_URL, shortCircuit: true };
    if (specifier.startsWith("@babylonjs/") && !context.parentURL?.includes("/packages/sim/src/")) {
      const fromClient = { ...context, parentURL: CLIENT_PACKAGE_URL };
      try {
        return nextResolve(specifier, fromClient);
      } catch {
        // Deep imports such as "@babylonjs/core/Physics/v2/physicsBody" omit the extension.
        return nextResolve(`${specifier}.js`, fromClient);
      }
    }
    if (
      specifier.startsWith(".") &&
      !/\.[cm]?[jt]s$/.test(specifier) &&
      context.parentURL !== undefined &&
      TS_SOURCE_DIRS.some((dir) => context.parentURL!.includes(dir))
    ) {
      // Directory imports ("./prefabs") resolve to their index.ts, like Vite.
      const base = new URL(specifier, context.parentURL);
      const file = existsSync(fileURLToPath(`${base.href}.ts`)) ? `${specifier}.ts` : `${specifier}/index.ts`;
      return nextResolve(file, context);
    }
    return nextResolve(specifier, context);
  },
});
