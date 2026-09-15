import { WS_AUTH_TIMEOUT_MS, WS_CLOSE_AUTH, WS_CLOSE_RATE_LIMITED, WS_CLOSE_REPLACED, WS_PATH, type ApiToClientWs, type ClientToApiWs } from "@twobullets/contracts/ws";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { TokenService } from "../auth/tokens";

// Push channel (packages/contracts/src/ws.ts). One socket per account; a newer socket replaces the older one.

export interface Push {
  send(accountId: string, message: ApiToClientWs): void;
}

export class RecordingPush implements Push {
  readonly sent: { accountId: string; message: ApiToClientWs }[] = [];
  send(accountId: string, message: ApiToClientWs): void {
    this.sent.push({ accountId, message });
  }
  of(accountId: string, t?: ApiToClientWs["t"]): ApiToClientWs[] {
    return this.sent.filter((s) => s.accountId === accountId && (t === undefined || s.message.t === t)).map((s) => s.message);
  }
}

const MAX_MESSAGES_PER_10S = 50;

export class WsPushHub implements Push {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  private readonly sockets = new Map<string, WebSocket>();
  private readonly tokens: TokenService;
  private readonly log: (line: string) => void;

  constructor(tokens: TokenService, log: (line: string) => void = () => {}) {
    this.tokens = tokens;
    this.log = log;
  }

  get connections(): number {
    return this.sockets.size;
  }

  attach(server: Server, allowOrigin: (origin: string | undefined) => boolean): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== WS_PATH || !allowOrigin(req.headers.origin)) {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
  }

  private onSocket(ws: WebSocket): void {
    let accountId: string | null = null;
    let windowStart = Date.now();
    let count = 0;
    const authTimer = setTimeout(() => ws.close(WS_CLOSE_AUTH, "auth timeout"), WS_AUTH_TIMEOUT_MS);
    ws.on("message", (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart > 10_000) {
        windowStart = now;
        count = 0;
      }
      if (++count > MAX_MESSAGES_PER_10S) {
        ws.close(WS_CLOSE_RATE_LIMITED, "rate limited");
        return;
      }
      if (isBinary) return;
      let msg: ClientToApiWs;
      try {
        msg = JSON.parse(data.toString()) as ClientToApiWs;
      } catch {
        return;
      }
      if (msg?.t === "ping") {
        if (accountId !== null) this.write(ws, { t: "pong" });
        return;
      }
      if (msg?.t === "auth" && accountId === null) {
        const claims = typeof msg.accessToken === "string" ? this.tokens.verifyAccess(msg.accessToken) : null;
        if (claims === null) {
          ws.close(WS_CLOSE_AUTH, "auth failed");
          return;
        }
        clearTimeout(authTimer);
        accountId = claims.sub;
        const previous = this.sockets.get(accountId);
        if (previous && previous !== ws) previous.close(WS_CLOSE_REPLACED, "replaced");
        this.sockets.set(accountId, ws);
        this.write(ws, { t: "ready", accountId });
      }
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      if (accountId !== null && this.sockets.get(accountId) === ws) this.sockets.delete(accountId);
    });
    ws.on("error", (err) => this.log(`[ws] ${err.message}`));
  }

  private write(ws: WebSocket, message: ApiToClientWs): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  send(accountId: string, message: ApiToClientWs): void {
    const ws = this.sockets.get(accountId);
    if (ws) this.write(ws, message);
  }

  close(): void {
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}
