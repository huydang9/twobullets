import type { JoinClaims } from "./match";

// Token claims issued by server-api (ADR 0106, platform.md §1.5, §6.7). Every token is an EdDSA (Ed25519) JWT whose
// header carries `kid`; the public keys are served at `GET /.well-known/jwks.json`. The audience keeps the two kinds
// apart: server-match accepts only `aud: "match"`, server-api only `aud: "api"`.

export type { JoinClaims };

export const JWT_ALG = "EdDSA";
export const ACCESS_TOKEN_AUDIENCE = "api";
export const JOIN_TOKEN_AUDIENCE = "match";
/** Access tokens are short enough to limit a leak, long enough for an evening of play. Refresh with the guest secret. */
export const ACCESS_TOKEN_TTL_SEC = 12 * 3600;
/** Join tokens: single use, one match on one host (ADR 0106). */
export const JOIN_TOKEN_TTL_SEC = 120;

export interface JwtHeader {
  readonly alg: typeof JWT_ALG;
  readonly typ: "JWT";
  readonly kid: string;
}

/** `Authorization: Bearer <access token>` on every `/v1/*` call except login, refresh, catalog and version. */
export interface AccessClaims {
  readonly iss: string;
  readonly aud: typeof ACCESS_TOKEN_AUDIENCE;
  /** Account id, `g_<26 chars>`. */
  readonly sub: string;
  /** Nickname at issue time (display only; the API reads the current one from its store). */
  readonly nick: string;
  readonly kind: "guest";
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

/** Bot account ids in rosters and results (`TeamAssignment.accountIds`, `PlayerResult.accountId`). */
export const BOT_ACCOUNT_PREFIX = "bot:";
export function isBotAccountId(accountId: string): boolean {
  return accountId.startsWith(BOT_ACCOUNT_PREFIX);
}
