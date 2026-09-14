import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Package boundary gate (ADR 0005 §6, architecture.md §6.9): pure packages never reach Babylon or node:*, directly or
// through workspace/relative imports, and workspace dependencies follow shared ← protocol ← netcode, shared ← sim.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*\(?\s*["']([^"']+)["']/gm;

function listTs(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    if (statSync(child).isDirectory()) return name === "node_modules" ? [] : listTs(child);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [child] : [];
  });
}

function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  return [...text.matchAll(IMPORT_RE)].map((m) => (m[1] ?? m[2])!);
}

function resolveTs(base: string): string | null {
  for (const candidate of [`${base}.ts`, join(base, "index.ts"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const WORKSPACE: Record<string, string> = {
  shared: "packages/shared",
  protocol: "packages/protocol",
  netcode: "packages/netcode",
  sim: "packages/sim",
  contracts: "packages/contracts",
};

/** Resolves relative and `@twobullets/<pkg>[/sub]` imports to files; external specifiers stay as strings. */
function resolveImport(from: string, spec: string): string | null {
  if (spec.startsWith(".")) return resolveTs(join(dirname(from), spec));
  const ws = /^@twobullets\/([^/]+)(?:\/(.+))?$/.exec(spec);
  if (ws && WORKSPACE[ws[1]!]) return resolveTs(join(ROOT, WORKSPACE[ws[1]!]!, "src", ws[2] ?? "index"));
  return null;
}

/** Every external specifier reachable from `entries`, with the file that imports it. */
function reachableExternals(entries: string[]): { file: string; spec: string }[] {
  const seen = new Set<string>();
  const out: { file: string; spec: string }[] = [];
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(file)) {
      const target = resolveImport(file, spec);
      if (target) stack.push(target);
      else out.push({ file: relative(ROOT, file), spec });
    }
  }
  return out;
}

const PURE_ROOTS = [
  "packages/shared/src/input.ts",
  "packages/shared/src/hitreg",
  "packages/protocol/src",
  "packages/netcode/src",
  "packages/contracts/src",
];

describe("package boundaries", () => {
  it("pure code reaches no @babylonjs/* or node:* import", () => {
    const entries = PURE_ROOTS.flatMap((p) => listTs(join(ROOT, p)));
    expect(entries.length).toBeGreaterThan(0);
    const violations = reachableExternals(entries).filter(({ spec }) => spec.startsWith("@babylonjs/") || spec.startsWith("node:"));
    expect(violations).toEqual([]);
  });

  it("pure packages import no workspace package outside their allowed direction", () => {
    const allowed: Record<string, string[]> = { protocol: ["shared"], netcode: ["shared", "protocol"], contracts: [] };
    const violations: string[] = [];
    for (const [pkg, deps] of Object.entries(allowed)) {
      for (const file of listTs(join(ROOT, WORKSPACE[pkg]!, "src"))) {
        for (const spec of specifiers(file)) {
          const ws = /^@twobullets\/([^/]+)/.exec(spec);
          if (ws && !deps.includes(ws[1]!)) violations.push(`${relative(ROOT, file)} → ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("sim, server-match and bot never import the @babylonjs/core barrel", () => {
    const files = ["packages/sim/src", "apps/server-match/src", "apps/bot/src"].flatMap((p) => listTs(join(ROOT, p)));
    const violations = files.flatMap((file) =>
      specifiers(file)
        .filter((spec) => spec === "@babylonjs/core")
        .map((spec) => `${relative(ROOT, file)} → ${spec}`),
    );
    expect(violations).toEqual([]);
  });

  it("package.json workspace dependencies follow the dependency direction", () => {
    const allowed: Record<string, string[]> = {
      "packages/shared": [],
      "packages/contracts": [],
      "packages/protocol": ["shared"],
      "packages/netcode": ["shared", "protocol"],
      "packages/sim": ["shared"],
    };
    const violations: string[] = [];
    for (const [dir, deps] of Object.entries(allowed)) {
      const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
        const ws = /^@twobullets\/(.+)$/.exec(name);
        if (ws && !deps.includes(ws[1]!)) violations.push(`${dir} → ${name}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
