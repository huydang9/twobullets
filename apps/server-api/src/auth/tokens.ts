import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_TTL_SEC, JOIN_TOKEN_AUDIENCE, JOIN_TOKEN_TTL_SEC, type AccessClaims } from "@twobullets/contracts/claims";
import type { JoinClaims } from "@twobullets/contracts/match";
import { CONTENT_HASH, PROTOCOL_VERSION } from "@twobullets/protocol/version";
import { randomBytes } from "node:crypto";
import { verifyJwtSignature } from "./jwt";
import type { KeyRing } from "./keyRing";

// Access tokens (aud "api") for the REST/WS API and join tokens (aud "match") for server-match. Same key ring; the
// audience keeps one from being used as the other.

export interface TokenServiceOptions {
  readonly keys: KeyRing;
  readonly issuer: string;
  /** Epoch ms. */
  readonly now?: () => number;
  readonly clockSkewSec?: number;
}

export interface JoinTokenInput {
  readonly accountId: string;
  readonly matchId: string;
  readonly hostId: string;
  readonly teamId: number;
  readonly epoch: number;
  readonly reconnect: boolean;
}

export class TokenService {
  readonly keys: KeyRing;
  private readonly issuer: string;
  private readonly now: () => number;
  private readonly skew: number;

  constructor(options: TokenServiceOptions) {
    this.keys = options.keys;
    this.issuer = options.issuer;
    this.now = options.now ?? Date.now;
    this.skew = options.clockSkewSec ?? 5;
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  issueAccess(accountId: string, nickname: string): { token: string; expiresAt: number } {
    const iat = this.nowSec();
    const claims: AccessClaims = {
      iss: this.issuer,
      aud: ACCESS_TOKEN_AUDIENCE,
      sub: accountId,
      nick: nickname,
      kind: "guest",
      jti: randomBytes(12).toString("base64url"),
      iat,
      exp: iat + ACCESS_TOKEN_TTL_SEC,
    };
    return { token: this.keys.sign(claims), expiresAt: claims.exp * 1000 };
  }

  verifyAccess(token: string): AccessClaims | null {
    const res = verifyJwtSignature<AccessClaims>(token, (kid) => this.keys.publicKey(kid));
    if (!res.ok) return null;
    const c = res.payload;
    const now = this.nowSec();
    if (c.aud !== ACCESS_TOKEN_AUDIENCE || c.iss !== this.issuer || typeof c.sub !== "string" || typeof c.exp !== "number" || typeof c.iat !== "number") return null;
    if (c.exp + this.skew < now || c.iat - this.skew > now) return null;
    return c;
  }

  /** Join JWT per ADR 0106 + ADR 0002 §6 (`pv`, `ch` from the build this API ships with). */
  issueJoin(input: JoinTokenInput): { token: string; expiresAt: number; claims: JoinClaims } {
    const iat = this.nowSec();
    const claims: JoinClaims = {
      iss: this.issuer,
      aud: JOIN_TOKEN_AUDIENCE,
      sub: input.accountId,
      mid: input.matchId,
      hid: input.hostId,
      team: input.teamId,
      pv: PROTOCOL_VERSION,
      ch: CONTENT_HASH >>> 0,
      epoch: input.epoch,
      rc: input.reconnect,
      jti: randomBytes(16).toString("hex"),
      iat,
      exp: iat + JOIN_TOKEN_TTL_SEC,
    };
    return { token: this.keys.sign(claims), expiresAt: claims.exp * 1000, claims };
  }
}
