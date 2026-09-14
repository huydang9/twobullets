import { describe, expect, it } from "vitest";
import simPackage from "../../sim/package.json";
import { canonicalContent, computeContentHash } from "../src/contentHash";
import { CONTENT_HASH, isCompatible, PROTOCOL_VERSION } from "../src/version";
import { contentHashInputs } from "../scripts/contentInputs";

describe("contentHash", () => {
  it("is canonical: key order and -0 don't matter, values do", () => {
    expect(canonicalContent({ b: 1, a: [1, -0, "x"] })).toBe(canonicalContent({ a: [1, 0, "x"], b: 1 }));
    expect(computeContentHash({ a: 1 })).not.toBe(computeContentHash({ a: 1.0000001 }));
    expect(computeContentHash({ a: 1 })).toBe(computeContentHash({ a: 1 }));
  });

  it("version.ts CONTENT_HASH matches the shared tables (regenerate with scripts/content-hash.ts)", () => {
    const deps = simPackage.dependencies as Record<string, string>;
    const engine = { babylon: deps["@babylonjs/core"] ?? "unknown", havok: deps["@babylonjs/havok"] ?? "unknown" };
    const expected = computeContentHash(contentHashInputs(engine));
    expect(`0x${CONTENT_HASH.toString(16).padStart(8, "0")}`).toBe(`0x${expected.toString(16).padStart(8, "0")}`);
    expect(isCompatible(PROTOCOL_VERSION, CONTENT_HASH)).toBe(true);
    expect(isCompatible(PROTOCOL_VERSION + 1, CONTENT_HASH)).toBe(false);
  });
});
