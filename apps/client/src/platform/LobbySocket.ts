import { WS_CLOSE_AUTH, WS_CLOSE_REPLACED, type ApiToClientWs, type ClientToApiWs } from "@twobullets/contracts/ws";

// server-api push channel (packages/contracts/src/ws.ts): authenticates in the first frame, pings every 25 s and
// reconnects with backoff 1 s, 2 s, 4 s … 30 s. A `ready` after every (re)connect tells the owner to resync over REST,
// since pushes sent while the socket was down are lost. Close 4001 refreshes the token first; 4010 (another tab took
// the account's socket) stops for good.

/** The subset of `WebSocket` this client uses, so tests can pass a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type LobbySocketStatus = "idle" | "connecting" | "open" | "reconnecting" | "replaced" | "stopped";

export interface LobbySocketOptions {
  readonly url: string;
  readonly createSocket?: (url: string) => SocketLike;
  /** A valid access token, or null when logged out (the socket stops). */
  readonly accessToken: () => Promise<string | null>;
  /** After close 4001: refresh the token; false stops the socket. */
  readonly refreshAccess: () => Promise<boolean>;
  readonly backoffMs?: readonly number[];
  readonly pingMs?: number;
}

export const SOCKET_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000, 30000];
export const SOCKET_PING_MS = 25_000;
const OPEN = 1;

export class LobbySocket {
  private socket: SocketLike | null = null;
  private statusValue: LobbySocketStatus = "idle";
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<(message: ApiToClientWs) => void>();
  private readonly statusListeners = new Set<(status: LobbySocketStatus) => void>();
  private readonly createSocket: (url: string) => SocketLike;
  private readonly backoff: readonly number[];
  private readonly pingMs: number;
  private readonly options: LobbySocketOptions;

  constructor(options: LobbySocketOptions) {
    this.options = options;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.backoff = options.backoffMs ?? SOCKET_BACKOFF_MS;
    this.pingMs = options.pingMs ?? SOCKET_PING_MS;
  }

  get status(): LobbySocketStatus {
    return this.statusValue;
  }

  on(listener: (message: ApiToClientWs) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: LobbySocketStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  start(): void {
    if (this.statusValue === "connecting" || this.statusValue === "open") return;
    clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    clearTimeout(this.reconnectTimer);
    this.clearPing();
    const socket = this.socket;
    this.socket = null;
    this.setStatus("stopped");
    if (socket) {
      detach(socket);
      socket.close(1000, "client stop");
    }
  }

  private open(): void {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => void this.authenticate(socket);
    socket.onmessage = (event) => this.onMessage(socket, event.data);
    socket.onerror = () => {};
    socket.onclose = (event) => void this.onClose(socket, event.code);
  }

  private async authenticate(socket: SocketLike): Promise<void> {
    let token: string | null = null;
    try {
      token = await this.options.accessToken();
    } catch {
      token = null;
    }
    if (socket !== this.socket) return;
    if (token === null) {
      this.stop();
      return;
    }
    if (socket.readyState === OPEN) send(socket, { t: "auth", accessToken: token });
  }

  private onMessage(socket: SocketLike, data: unknown): void {
    if (socket !== this.socket || typeof data !== "string") return;
    let message: ApiToClientWs;
    try {
      message = JSON.parse(data) as ApiToClientWs;
    } catch {
      return;
    }
    if (typeof message?.t !== "string" || message.t === "pong") return;
    if (message.t === "ready") {
      this.attempt = 0;
      this.setStatus("open");
      this.clearPing();
      this.pingTimer = setInterval(() => {
        if (this.socket?.readyState === OPEN) send(this.socket, { t: "ping" });
      }, this.pingMs);
    }
    for (const listener of this.listeners) listener(message);
  }

  private async onClose(socket: SocketLike, code: number): Promise<void> {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearPing();
    if (code === WS_CLOSE_REPLACED) {
      this.setStatus("replaced");
      return;
    }
    if (code === WS_CLOSE_AUTH) {
      let refreshed = false;
      try {
        refreshed = await this.options.refreshAccess();
      } catch {
        refreshed = true; // network trouble: retry with backoff
      }
      if (this.statusValue === "stopped") return;
      if (!refreshed) {
        this.setStatus("stopped");
        return;
      }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.statusValue === "stopped") return;
    const delay = this.backoff[Math.min(this.attempt, this.backoff.length - 1)] ?? 30_000;
    this.attempt++;
    this.setStatus("reconnecting");
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private clearPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private setStatus(status: LobbySocketStatus): void {
    if (status === this.statusValue) return;
    this.statusValue = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

function send(socket: SocketLike, message: ClientToApiWs): void {
  socket.send(JSON.stringify(message));
}

function detach(socket: SocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}
