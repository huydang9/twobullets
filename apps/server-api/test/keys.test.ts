import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeyRing, readKeyFile, writeKeyFile } from "../src/auth/keyRing";
import { TokenService } from "../src/auth/tokens";
import { startTestApi, type TestApi } from "./helpers";

let api: TestApi | null = null;
afterEach(async () => {
  await api?.close();
  api = null;
});

describe("JWKS and key rotation", () => {
  it("publishes the active key and verifies tokens across a rotation until the old key is pruned", () => {
    let now = 1_800_000_000_000;
    const ring = KeyRing.generate(now);
    const tokens = new TokenService({ keys: ring, issuer: "https://play.test", now: () => now });
    const oldKid = ring.activeKid;
    const before = tokens.issueAccess("g_A", "A");

    now += 1000;
    const newKid = ring.rotate(now);
    expect(newKid).not.toBe(oldKid);
    expect(ring.activeKid).toBe(newKid);
    expect(ring.jwks().keys.map((k) => k.kid).sort()).toEqual([oldKid, newKid].sort());
    const after = tokens.issueAccess("g_A", "A");
    expect(JSON.parse(Buffer.from(after.token.split(".")[0]!, "base64url").toString()).kid).toBe(newKid);
    expect(tokens.verifyAccess(before.token)?.sub).toBe("g_A");
    expect(tokens.verifyAccess(after.token)?.sub).toBe("g_A");

    expect(ring.prune(3_600_000, now + 1000)).toEqual([]); // too young
    expect(ring.prune(3_600_000, now + 3_600_000)).toEqual([oldKid]);
    expect(tokens.verifyAccess(before.token)).toBeNull();
    expect(tokens.verifyAccess(after.token)?.sub).toBe("g_A");
  });

  it("rejects invalid key files and keeps the previous keys", () => {
    const ring = KeyRing.generate();
    const kid = ring.activeKid;
    expect(() => ring.replace({ version: 1, keys: [] })).toThrow(/exactly one active/);
    expect(() => ring.replace({ version: 1, keys: [{ ...ring.toFile().keys[0]!, status: "retired" }] })).toThrow();
    expect(ring.activeKid).toBe(kid);
  });

  it("writes the key file with 0600 permissions and reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb-keys-"));
    try {
      const file = join(dir, "keys", "jwt-keys.json");
      const ring = KeyRing.generate();
      writeKeyFile(file, ring.toFile());
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(new KeyRing(readKeyFile(file)!).activeKid).toBe(ring.activeKid);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves /.well-known/jwks.json and pushes a reloaded JWKS to running matches", async () => {
    api = await startTestApi();
    const first = await api.call("GET", "/.well-known/jwks.json");
    expect(first.body.keys).toHaveLength(1);
    expect(first.body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", kid: api.keys.activeKid });
    const next = KeyRing.generate();
    next.replace(api.keys.toFile());
    next.rotate();
    api.app.reloadKeys(next.toFile());
    expect((await api.call("GET", "/.well-known/jwks.json")).body.keys).toHaveLength(2);
    expect(api.allocator.jwksPushes.at(-1)?.map((k) => k.kid)).toContain(next.activeKid);
  });
});
