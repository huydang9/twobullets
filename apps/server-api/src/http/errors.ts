import type { ApiErrorCode } from "@twobullets/contracts/rest";

const STATUS: Record<ApiErrorCode, number> = {
  badRequest: 400,
  nicknameInvalid: 400,
  unauthorized: 401,
  inviteRequired: 403,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  alreadyInMatch: 409,
  lobbyFull: 409,
  lobbyClosed: 409,
  upgradeRequired: 426,
  rateLimited: 429,
  internal: 500,
  noCapacity: 503,
};

/** Thrown by services and handlers; the router turns it into an `ApiError` body. */
export class HttpError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryAfterSec?: number;

  constructor(code: ApiErrorCode, message: string, retryAfterSec?: number) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.retryAfterSec = retryAfterSec;
  }
}
