/** Repo root lookup that works from source (.ts) and from the stripped JS build under node_modules/.cache. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`repo root not found above ${start}`);
    dir = parent;
  }
  return dir;
}

export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
