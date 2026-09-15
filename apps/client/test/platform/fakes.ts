import type { AccountView, AuthResponse } from "@twobullets/contracts/rest";
import type { KeyValueStorage } from "../../src/platform/SessionStore";
import type { SocketLike } from "../../src/platform/LobbySocket";

export class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export const ACCOUNT: AccountView = { id: "g_TEST", nickname: "Huy", tag: "4821", language: "vi", createdAt: 1 };

export function auth(access: string, refresh: string, expiresAt: number): AuthResponse {
  return { accessToken: access, refreshToken: refresh, expiresAt, account: ACCOUNT };
}

export interface FetchCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Route = (call: FetchCall) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

/** A scripted server: routes keyed by "METHOD /path"; unknown routes answer 404. */
export class FakeServer {
  readonly calls: FetchCall[] = [];
  readonly routes = new Map<string, Route>();
  offline = false;

  on(key: string, route: Route): this {
    this.routes.set(key, route);
    return this;
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    if (this.offline) throw new TypeError("Failed to fetch");
    const url = new URL(input);
    const call: FetchCall = {
      method: init.method ?? "GET",
      path: url.pathname,
      headers: { ...(init.headers as Record<string, string>) },
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    this.calls.push(call);
    const route = this.routes.get(`${call.method} ${call.path}`);
    const reply = route ? await route(call) : { status: 404, body: { error: "notFound", message: "No such route" } };
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  };

  paths(): string[] {
    return this.calls.map((c) => `${c.method} ${c.path}`);
  }
}

export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  readonly sent: unknown[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closedWith: number | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverSend(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** Lets pending promise callbacks run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
