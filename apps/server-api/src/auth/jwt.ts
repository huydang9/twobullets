import { JWT_ALG, type JwtHeader } from "@twobullets/contracts/claims";
import { verify as verifySignature, sign, type KeyObject } from "node:crypto";

// Minimal EdDSA (Ed25519) JWT signing and verification with node:crypto. No `alg` negotiation: the header must say
// EdDSA and name a known `kid`.

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function signJwt(payload: object, kid: string, privateKey: KeyObject): string {
  const header: JwtHeader = { alg: JWT_ALG, typ: "JWT", kid };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput, "utf8"), privateKey).toString("base64url")}`;
}

export type JwtVerifyResult<T> = { readonly ok: true; readonly payload: T; readonly kid: string } | { readonly ok: false; readonly reason: string };

function decodeJson(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** Signature and header only; the caller checks claims. `publicKey(kid)` returns undefined for unknown kids. */
export function verifyJwtSignature<T>(token: string, publicKey: (kid: string) => KeyObject | undefined): JwtVerifyResult<T> {
  if (token.length > 4096) return { ok: false, reason: "too long" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h) as { alg?: unknown; kid?: unknown } | null;
  if (header === null || header.alg !== JWT_ALG || typeof header.kid !== "string") return { ok: false, reason: "header" };
  const key = publicKey(header.kid);
  if (key === undefined) return { ok: false, reason: "unknown kid" };
  if (!verifySignature(null, Buffer.from(`${h}.${p}`, "utf8"), key, Buffer.from(s, "base64url"))) return { ok: false, reason: "signature" };
  const payload = decodeJson(p);
  if (typeof payload !== "object" || payload === null) return { ok: false, reason: "payload" };
  return { ok: true, payload: payload as T, kid: header.kid };
}
