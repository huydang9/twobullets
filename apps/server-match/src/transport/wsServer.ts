import { MAX_MATCH_PLAYERS, type DevJoinTokenResponse } from "@twobullets/contracts";
import type { Clock, Session } from "@twobullets/netcode";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { SessionManager } from "../session/SessionManager";
import { WsSession } from "./WsSession";

// Plain WS listener (behind HAProxy TLS in production, ADR 0002) plus a tiny HTTP surface:
//   GET /healthz          → {"ok":true,...}
//   GET /dev/token?sub=&team=  → DevJoinTokenResponse (local mode only, CORS *); team 0..devTeamCount-1
//   Upgrade /m/{matchId}  → WebSocket session handed to the SessionManager

export interface WsServerOptions {
  readonly host: string;
  readonly port: number;
  readonly clock: Clock;
  readonly sessions: SessionManager;
  /** Mints dev join tokens; omit to disable `/dev/token`. */
  readonly devTokens?: (sub: string, team: number, publicUrl: string) => DevJoinTokenResponse;
  /** Teams in the dev match; `/dev/token` rejects `team` ≥ this (default MAX_MATCH_PLAYERS). */
  readonly devTeamCount?: number;
  /** Wraps each accepted session (e.g. a server-side LinkConditioner for `--fake-net`). */
  readonly wrapSession?: (session: Session) => Session;
  readonly onSessionClosed?: (session: Session) => void;
  readonly maxBufferedBytes?: number;
  readonly log?: (line: string) => void;
}

export interface WsServerHandle {
  readonly port: number;
  connectionCount(): number;
  close(): Promise<void>;
}

const MATCH_PATH = /^\/m\/([A-Za-z0-9_.:-]{1,64})\/?$/;

export function startWsServer(options: WsServerOptions): Promise<WsServerHandle> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  const http = createServer((req, res) => handleHttp(req, res, options, portOf(), wss.clients.size));
  const portOf = (): number => (http.address() as AddressInfo | null)?.port ?? options.port;

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = MATCH_PATH.exec(url.pathname);
    if (m === null) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const raw = new WsSession(ws, options.clock, { maxBufferedBytes: options.maxBufferedBytes });
      const session = options.wrapSession ? options.wrapSession(raw) : raw;
      const handle = options.sessions.accept(session, { pathMatchId: m[1]!, remote: `${req.socket.remoteAddress}:${req.socket.remotePort}` });
      ws.on("close", () => {
        handle.transportClosed();
        options.onSessionClosed?.(session);
      });
      ws.on("error", (err) => options.log?.(`[ws] socket error: ${err.message}`));
    });
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, () => {
      http.off("error", reject);
      resolve({
        port: portOf(),
        connectionCount: () => wss.clients.size,
        close: () =>
          new Promise<void>((done) => {
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            http.closeAllConnections();
            http.close(() => done());
          }),
      });
    });
  });
}

function handleHttp(req: IncomingMessage, res: ServerResponse, options: WsServerOptions, port: number, connections: number): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  };
  if (req.method === "GET" && url.pathname === "/healthz") {
    json(200, { ok: true, connections });
    return;
  }
  if (req.method === "GET" && url.pathname === "/dev/token" && options.devTokens) {
    const sub = url.searchParams.get("sub") ?? `dev-${Math.floor(performance.now())}`;
    const team = Number(url.searchParams.get("team") ?? "0");
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(sub) || !Number.isInteger(team) || team < 0 || team >= (options.devTeamCount ?? MAX_MATCH_PLAYERS)) {
      json(400, { error: "bad sub or team" });
      return;
    }
    const host = req.headers.host ?? `localhost:${port}`;
    json(200, options.devTokens(sub, team, `ws://${host}`));
    return;
  }
  json(404, { error: "not found" });
}
