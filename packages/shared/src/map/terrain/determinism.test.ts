import { describe, expect, it } from "vitest";

// Vite's glob import (this package doesn't load vite/client or Node types).
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  }
}

/**
 * Terrain must build bit-identical ground in every browser and in Node. IEEE basic arithmetic and sqrt are correctly
 * rounded everywhere; these are not (or aren't seeded), so they're banned from generation code. `Math.atan` is
 * allowed only for the degrees-based tooling helper `slopeAt`.
 */
const BANNED = [
  /Math\.random/,
  /Math\.(sin|cos|tan|asin|acos|atan2|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b/,
  /\*\*/,
  /from\s+["']@babylonjs/,
];

const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true });

describe("terrain determinism rules", () => {
  const files = Object.keys(sources).filter((file) => !file.endsWith(".test.ts"));

  it("covers the terrain sources", () => {
    expect(files).toContain("./generate.ts");
  });

  it.each(files)("%s avoids engine-dependent math and Babylon imports", (file: string) => {
    const code = sources[file]!
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const pattern of BANNED) expect(code, `${file} matches ${pattern}`).not.toMatch(pattern);
  });
});
