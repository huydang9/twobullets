import { DisconnectReason, type Hello, type TransportKind } from "@twobullets/protocol/messages/control";
import { CONTENT_HASH, PROTOCOL_VERSION } from "@twobullets/protocol/version";

// Everything about joining a local server-match (M3) in one place: URL shape, the dev token endpoint, Hello fields,
// timeouts and close codes. Spec relayed from T3.4:
//   WS  ws://localhost:7350/m/local — one protocol message per binary WS message, first byte MsgId, no length prefix
//   GET http://localhost:7350/dev/token?sub=<id>&team=<0..teamCount-1> → { token, matchId, url, expiresAt } (HS256, 120 s, single-use jti)
//   C→S Hello within 5 s → S→C Welcome | Disconnect{reason} + close 4000 + reason

export const DEFAULT_MATCH_PATH = "/m/local";
export const HELLO_TIMEOUT_MS = 5000;
/** Welcome must arrive this long after the socket opens. */
export const WELCOME_TIMEOUT_MS = 5000;
export const CONNECT_TIMEOUT_MS = 5000;
/** Server closes with 4000 + DisconnectReason. */
export const CLOSE_CODE_REASON_BASE = 4000;
/** Client-initiated close (browsers only allow 1000 or 3000–4999). */
export const CLOSE_CODE_CLIENT_LEAVE = 1000;

export interface NetEndpoint {
  /** WebSocket URL of the match. */
  readonly wsUrl: string;
  /** Dev token endpoint on the same host. */
  readonly tokenUrl: string;
}

export interface DevToken {
  readonly token: string;
  readonly matchId: string;
  readonly url: string;
  readonly expiresAt: number;
}

/** `?net=ws://localhost:7350/m/local` (or just `ws://localhost:7350`, which gets the local match path). */
export function parseNetParam(value: string): NetEndpoint {
  const url = new URL(value.includes("://") ? value : `ws://${value}`);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  if (url.pathname === "" || url.pathname === "/") url.pathname = DEFAULT_MATCH_PATH;
  const http = url.protocol === "wss:" ? "https:" : "http:";
  return { wsUrl: url.toString(), tokenUrl: `${http}//${url.host}/dev/token` };
}

/** One stable dev account id per browser tab (sessionStorage), so a reload rejoins as the same player. */
export function devPlayerId(override: string | null): string {
  if (override) return override;
  const key = "twobullets.net.devId";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = `dev-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return `dev-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Fetches a fresh single-use join token; call once per connect attempt. */
export async function fetchDevToken(endpoint: NetEndpoint, sub: string, team: number): Promise<DevToken> {
  const url = `${endpoint.tokenUrl}?sub=${encodeURIComponent(sub)}&team=${team}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`dev token: HTTP ${response.status}`);
  const body = (await response.json()) as Partial<DevToken>;
  if (typeof body.token !== "string") throw new Error("dev token: response has no token");
  return { token: body.token, matchId: body.matchId ?? "", url: body.url ?? endpoint.wsUrl, expiresAt: body.expiresAt ?? 0 };
}

export function helloFor(joinToken: string, transport: TransportKind, maxDatagramSize: number): Hello {
  return { protocolVersion: PROTOCOL_VERSION, contentHash: CONTENT_HASH, joinToken, maxDatagramSize, transport };
}

const REASON_TEXT: Record<number, string> = {
  [DisconnectReason.clientLeave]: "left the match",
  [DisconnectReason.versionMismatch]: "version mismatch (rebuild client and server)",
  [DisconnectReason.badToken]: "join token rejected",
  [DisconnectReason.notAssigned]: "not assigned to this match",
  [DisconnectReason.matchFull]: "match or team full",
  [DisconnectReason.replaced]: "replaced by a newer connection",
  [DisconnectReason.kicked]: "kicked",
  [DisconnectReason.rateLimited]: "rate limited",
  [DisconnectReason.timeout]: "timed out",
  [DisconnectReason.matchEnded]: "match ended",
  [DisconnectReason.serverShutdown]: "server shut down",
  [DisconnectReason.internalError]: "server error",
};

export function describeDisconnectReason(reason: number): string {
  return REASON_TEXT[reason] ?? `reason ${reason}`;
}

/** Close code → text, decoding 4000 + reason. */
export function describeCloseCode(code: number): string {
  if (code >= CLOSE_CODE_REASON_BASE && code < CLOSE_CODE_REASON_BASE + 256) return describeDisconnectReason(code - CLOSE_CODE_REASON_BASE);
  if (code === 1006) return "connection lost";
  return `socket closed (${code})`;
}
