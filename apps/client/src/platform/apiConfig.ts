import { WS_PATH } from "@twobullets/contracts/ws";
import { CONTENT_HASH, PROTOCOL_VERSION } from "@twobullets/protocol/version";

/** server-api's default port (`TB_API_PORT`, apps/server-api/src/config.ts). */
export const DEV_API_URL = "http://localhost:8080";

/** `X-TB-Protocol` value: a different build gets `426 upgradeRequired`. */
export const PROTOCOL_HEADER_VALUE = `${PROTOCOL_VERSION}.${CONTENT_HASH >>> 0}`;

export interface ApiEnv {
  readonly DEV: boolean;
  /** Build arg of infra/docker/web.Dockerfile. Empty means the page's own origin (Caddy proxies `/v1`). */
  readonly VITE_TB_API_URL?: string;
  /** Alias. */
  readonly VITE_API_URL?: string;
}

/** Origin of server-api without a trailing slash; "" means same origin. DEV defaults to the local server-api. */
export function resolveApiBaseUrl(env: ApiEnv): string {
  const configured = env.VITE_TB_API_URL || env.VITE_API_URL;
  if (configured) return configured.replace(/\/+$/, "");
  return env.DEV ? DEV_API_URL : "";
}

/** `ws(s)://…/v1/ws` for an API base ("" resolves against the page origin). */
export function apiSocketUrl(baseUrl: string, pageOrigin: string): string {
  const origin = baseUrl === "" ? pageOrigin : baseUrl;
  return `${origin.replace(/^http/, "ws")}${WS_PATH}`;
}

export function apiBaseUrlFromBuild(): string {
  const env = import.meta.env as unknown as ApiEnv;
  return resolveApiBaseUrl({ DEV: import.meta.env.DEV, VITE_TB_API_URL: env.VITE_TB_API_URL, VITE_API_URL: env.VITE_API_URL });
}
