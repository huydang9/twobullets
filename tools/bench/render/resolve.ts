/** The runtime bench resolution, plus `@twobullets/*` packages resolved from apps/client for files outside the workspace packages. */
import * as nodeModule from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../runtime/lib/resolve.ts";

const CLIENT_PACKAGE_URL = pathToFileURL(join(REPO_ROOT, "apps/client/package.json")).href;

nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@twobullets/") && specifier !== "@twobullets/sim" && context.parentURL?.includes("/tools/bench/")) {
      return nextResolve(specifier, { ...context, parentURL: CLIENT_PACKAGE_URL });
    }
    return nextResolve(specifier, context);
  },
});
