import { CONTENT_HASH, DisconnectReason, PROTOCOL_VERSION } from "@twobullets/protocol";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDevClaims, devHmacKey, ed25519KeyFromJwk, JoinTokenVerifier, signDevJoinToken } from "../src/auth/joinToken";

const NOW = 1_800_000_000;
const SECRET = "test-secret";

function claims(overrides: Partial<Parameters<typeof createDevClaims>[0]> = {}) {
  return createDevClaims({ sub: "acc-1", team: 2, matchId: "m1", hostId: "h1", protocolVersion: PROTOCOL_VERSION, contentHash: CONTENT_HASH, nowSec: NOW, ...overrides });
}

function verifier(now = NOW) {
  return new JoinTokenVerifier({ keys: [devHmacKey(SECRET)], nowSec: () => now });
}

describe("join token verification", () => {
  it("accepts a valid dev token once (jti single use)", () => {
    const v = verifier();
    const token = signDevJoinToken(claims(), SECRET);
    const first = v.verify(token);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.claims).toMatchObject({ sub: "acc-1", team: 2, mid: "m1", aud: "match" });
    expect(v.verify(token)).toMatchObject({ ok: false, reason: DisconnectReason.badToken, detail: "jti reused" });
  });

  it("rejects bad signatures, unknown kids, expiry, long TTL and malformed tokens", () => {
    const v = verifier();
    expect(v.verify(signDevJoinToken(claims(), "other-secret"))).toMatchObject({ ok: false, detail: "signature" });
    expect(v.verify(signDevJoinToken(claims(), SECRET, "prod-1"))).toMatchObject({ ok: false, detail: "unknown kid" });
    expect(v.verify(signDevJoinToken(claims({ nowSec: NOW - 1000 }), SECRET))).toMatchObject({ ok: false, detail: "expired" });
    expect(v.verify(signDevJoinToken(claims({ ttlSec: 3600 }), SECRET))).toMatchObject({ ok: false, detail: "ttl" });
    expect(v.verify("not.a.jwt")).toMatchObject({ ok: false, reason: DisconnectReason.badToken });
    expect(v.verify("garbage")).toMatchObject({ ok: false, reason: DisconnectReason.badToken });
    // Tampered payload with the original signature.
    const [h, , s] = signDevJoinToken(claims(), SECRET).split(".");
    const forged = Buffer.from(JSON.stringify({ ...claims(), team: 0 })).toString("base64url");
    expect(v.verify(`${h}.${forged}.${s}`)).toMatchObject({ ok: false, detail: "signature" });
  });

  it("maps a stale compat key in the token to versionMismatch", () => {
    const v = verifier();
    expect(v.verify(signDevJoinToken(claims({ protocolVersion: PROTOCOL_VERSION + 1 }), SECRET))).toMatchObject({
      ok: false,
      reason: DisconnectReason.versionMismatch,
    });
  });

  it("refuses alg confusion (HS256 header against an EdDSA key)", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    const v = new JoinTokenVerifier({ keys: [ed25519KeyFromJwk({ kty: "OKP", crv: "Ed25519", x: jwk.x, kid: "prod-1" })], nowSec: () => NOW });
    const body = Buffer.from(JSON.stringify(claims())).toString("base64url");
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", kid: "prod-1" })).toString("base64url");
    const sig = createHmac("sha256", jwk.x).update(`${header}.${body}`).digest("base64url");
    expect(v.verify(`${header}.${body}.${sig}`)).toMatchObject({ ok: false, detail: "alg" });
  });

  it("verifies production-style Ed25519 tokens through the same path", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    const v = new JoinTokenVerifier({ keys: [ed25519KeyFromJwk({ kty: "OKP", crv: "Ed25519", x: jwk.x, kid: "prod-1" })], nowSec: () => NOW });
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "prod-1" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(claims())).toString("base64url");
    const signature = sign(null, Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
    expect(v.verify(`${header}.${body}.${signature}`).ok).toBe(true);
    expect(v.verify(`${header}.${body}.${signature.slice(0, -4)}AAAA`).ok).toBe(false);
  });
});
