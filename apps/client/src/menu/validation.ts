import { LOBBY_CODE_ALPHABET, LOBBY_CODE_LENGTH, NICKNAME_MAX, NICKNAME_MIN } from "@twobullets/contracts/rest";
import type { ClientErrorCode } from "../platform/ApiRequestError";
import type { MessageKey } from "../i18n";

// Client-side checks mirroring server-api (accounts.ts normalizeNickname, lobby codes), so obvious mistakes don't cost a
// request. The server still validates everything.

const NICKNAME_CHARS = /^[\p{L}\p{M}\p{N} _.-]+$/u;

/** The nickname as the server will store it, or null when the server would reject it. */
export function normalizeNickname(raw: string): string | null {
  const value = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  const length = [...value].length;
  if (length < NICKNAME_MIN || length > NICKNAME_MAX || !NICKNAME_CHARS.test(value)) return null;
  return value;
}

/** Upper-cased code when it has the lobby code shape, else null. */
export function normalizeLobbyCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (code.length !== LOBBY_CODE_LENGTH) return null;
  for (const char of code) if (!LOBBY_CODE_ALPHABET.includes(char)) return null;
  return code;
}

const ERROR_KEYS: Readonly<Record<ClientErrorCode, MessageKey>> = {
  badRequest: "error.badRequest",
  unauthorized: "error.unauthorized",
  forbidden: "error.forbidden",
  notFound: "error.notFound",
  conflict: "error.conflict",
  rateLimited: "error.rateLimited",
  upgradeRequired: "error.upgradeRequired",
  noCapacity: "error.noCapacity",
  inviteRequired: "error.inviteRequired",
  nicknameInvalid: "error.nicknameInvalid",
  lobbyFull: "error.lobbyFull",
  lobbyClosed: "error.lobbyClosed",
  alreadyInMatch: "error.alreadyInMatch",
  internal: "error.internal",
  network: "error.network",
  badResponse: "error.badResponse",
};

export function errorMessageKey(code: ClientErrorCode): MessageKey {
  return ERROR_KEYS[code] ?? "error.internal";
}
