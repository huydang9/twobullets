import type { ApiError, ApiErrorCode } from "@twobullets/contracts/rest";

/** API error codes plus the two the client produces itself. */
export type ClientErrorCode = ApiErrorCode | "network" | "badResponse";

const STATUS_CODES: Readonly<Record<number, ApiErrorCode>> = {
  400: "badRequest",
  401: "unauthorized",
  403: "forbidden",
  404: "notFound",
  409: "conflict",
  426: "upgradeRequired",
  429: "rateLimited",
  503: "noCapacity",
};

export class ApiRequestError extends Error {
  readonly code: ClientErrorCode;
  /** HTTP status, 0 when the request never got a response. */
  readonly status: number;
  readonly retryAfterSec?: number;

  constructor(code: ClientErrorCode, status: number, message: string, retryAfterSec?: number) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export function isApiErrorBody(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string";
}

export function codeForStatus(status: number): ApiErrorCode {
  return STATUS_CODES[status] ?? "internal";
}

export function errorCodeOf(error: unknown): ClientErrorCode {
  return error instanceof ApiRequestError ? error.code : "network";
}
