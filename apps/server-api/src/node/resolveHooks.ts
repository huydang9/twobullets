// Runs server-api from TypeScript sources with Node's type stripping:
//   node --import ./src/node/resolveHooks.ts src/main.ts
// Workspace sources use extensionless relative imports (the way Vite/Vitest resolve them); this maps them to `.ts` or
// `/index.ts`. Same approach as apps/server-match/src/node/resolveHooks.ts.

import { existsSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier) && parent?.startsWith("file:") && parent.endsWith(".ts")) {
      const base = resolvePath(dirname(fileURLToPath(parent)), specifier);
      for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
        if (isFile(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
