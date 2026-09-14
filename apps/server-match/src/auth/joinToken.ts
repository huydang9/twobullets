import type { JoinClaims, Jwk } from "@twobullets/contracts";
import { DisconnectReason, isCompatible } from "@twobullets/protocol";
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature, type KeyObject } from "node:crypto";

// Join token verification (ADR 0106, architecture.md D17). Production: Ed25519 (EdDSA) JWTs checked offline against the
// JWKS the host agent pushes. M3 dev tokens are HS256 with a shared secret, verified by this same code path: header →
// key by `kid` → signature → claims (aud, time, pv/ch, single-use jti). Only the key type differs.

export type VerifyKey =
  | { readonly kid: string; readonly alg: "HS256"; readonly secret: Uint8Array }
  | { readonly kid: string; readonly alg: "EdDSA"; readonly key: KeyObject };

export const DEV_KID = "dev";
export const DEV_JOIN_SECRET_DEFAULT = "twobullets-dev-join-secret";
export const JOIN_TOKEN_TTL_SEC = 120;

export function devHmacKey(secret: string, kid = DEV_KID): VerifyKey {
  return { kid, alg: "HS256", secret: Buffer.from(secret, "utf8") };
}

export function ed25519KeyFromJwk(jwk: Jwk): VerifyKey {
  return { kid: jwk.kid, alg: "EdDSA", key: createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: "jwk" }) };
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: JoinClaims }
  | { readonly ok: false; readonly reason: DisconnectReason; readonly detail: string };

export interface JoinTokenVerifierOptions {
  readonly keys: readonly VerifyKey[];
  /** Unix seconds. */
  readonly nowSec: () => number;
  readonly leewaySec?: number;
  readonly maxTtlSec?: number;
}

function fail(reason: DisconnectReason, detail: string): VerifyResult {
  return { ok: false, reason, detail };
}

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function parseClaims(value: unknown): JoinClaims | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  const strings = ["iss", "sub", "mid", "hid", "jti"] as const;
  for (const k of strings) if (typeof c[k] !== "string" || (c[k] as string).length === 0) return null;
  const ints = ["team", "pv", "ch", "epoch", "iat", "exp"] as const;
  for (const k of ints) if (!isInt(c[k])) return null;
  if (c.aud !== "match" || typeof c.rc !== "boolean") return null;
  return c as unknown as JoinClaims;
}

export class JoinTokenVerifier {
  private keys = new Map<string, VerifyKey>();
  private readonly nowSec: () => number;
  private readonly leeway: number;
  private readonly maxTtl: number;
  /** jti → exp (unix s); single use (ADR 0106). */
  private readonly usedJti = new Map<string, number>();

  constructor(options: JoinTokenVerifierOptions) {
    this.setKeys(options.keys);
    this.nowSec = options.nowSec;
    this.leeway = options.leewaySec ?? 5;
    this.maxTtl = options.maxTtlSec ?? JOIN_TOKEN_TTL_SEC;
  }

  /** Replaces the key set (JWKS rotation from the host agent). */
  setKeys(keys: readonly VerifyKey[]): void {
    this.keys = new Map(keys.map((k) => [k.kid, k]));
  }

  verify(token: string): VerifyResult {
    const parts = token.split(".");
    if (parts.length !== 3) return fail(DisconnectReason.badToken, "malformed");
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodeJson(headerPart) as { alg?: unknown; kid?: unknown } | null;
    if (header === null || typeof header.kid !== "string") return fail(DisconnectReason.badToken, "header");
    const key = this.keys.get(header.kid);
    if (key === undefined) return fail(DisconnectReason.badToken, "unknown kid");
    if (header.alg !== key.alg) return fail(DisconnectReason.badToken, "alg");

    const signingInput = Buffer.from(`${headerPart}.${payloadPart}`, "utf8");
    const signature = Buffer.from(signaturePart, "base64url");
    let valid: boolean;
    if (key.alg === "HS256") {
      const expected = createHmac("sha256", key.secret).update(signingInput).digest();
      valid = expected.length === signature.length && timingSafeEqual(expected, signature);
    } else {
      valid = verifySignature(null, signingInput, key.key, signature);
    }
    if (!valid) return fail(DisconnectReason.badToken, "signature");

    const claims = parseClaims(decodeJson(payloadPart));
    if (claims === null) return fail(DisconnectReason.badToken, "claims");
    const now = this.nowSec();
    if (claims.exp + this.leeway < now) return fail(DisconnectReason.badToken, "expired");
    if (claims.iat - this.leeway > now) return fail(DisconnectReason.badToken, "not yet valid");
    if (claims.exp - claims.iat > this.maxTtl) return fail(DisconnectReason.badToken, "ttl");
    if (!isCompatible(claims.pv, claims.ch)) return fail(DisconnectReason.versionMismatch, "token compat key");
    this.sweepJti(now);
    if (this.usedJti.has(claims.jti)) return fail(DisconnectReason.badToken, "jti reused");
    this.usedJti.set(claims.jti, claims.exp);
    return { ok: true, claims };
  }

  private sweepJti(now: number): void {
    if (this.usedJti.size < 1024) return;
    for (const [jti, exp] of this.usedJti) if (exp + this.leeway < now) this.usedJti.delete(jti);
  }
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Dev/test signer. Production tokens are signed by server-api with Ed25519. */
export function signDevJoinToken(claims: JoinClaims, secret: string, kid = DEV_KID): string {
  const signingInput = `${base64urlJson({ alg: "HS256", typ: "JWT", kid })}.${base64urlJson(claims)}`;
  const signature = createHmac("sha256", Buffer.from(secret, "utf8")).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

export interface DevClaimsInput {
  readonly sub: string;
  readonly team: number;
  readonly matchId: string;
  readonly hostId: string;
  readonly protocolVersion: number;
  readonly contentHash: number;
  readonly nowSec: number;
  readonly ttlSec?: number;
  readonly epoch?: number;
  readonly rc?: boolean;
  readonly jti?: string;
}

export function createDevClaims(input: DevClaimsInput): JoinClaims {
  return {
    iss: "twobullets-dev",
    aud: "match",
    sub: input.sub,
    mid: input.matchId,
    hid: input.hostId,
    team: input.team,
    pv: input.protocolVersion,
    ch: input.contentHash >>> 0,
    epoch: input.epoch ?? 0,
    rc: input.rc ?? false,
    jti: input.jti ?? randomBytes(16).toString("hex"),
    iat: Math.floor(input.nowSec),
    exp: Math.floor(input.nowSec) + (input.ttlSec ?? JOIN_TOKEN_TTL_SEC),
  };
}
