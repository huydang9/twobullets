import { PROTOCOL_HEADER, type AccountView, type ActiveMatchResponse, type AuthResponse, type HealthResponse, type VersionResponse } from "@twobullets/contracts/rest";
import { CONTENT_HASH, PROTOCOL_VERSION } from "@twobullets/protocol/version";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isLanguage, AccountStore, normalizeNickname } from "./accounts/accounts";
import type { KeyRing } from "./auth/keyRing";
import { TokenService } from "./auth/tokens";
import type { ApiConfig } from "./config";
import { dbHealthy, type Db } from "./db";
import type { Allocator } from "./fleet/allocator";
import { HttpError } from "./http/errors";
import { RateLimiter } from "./http/rateLimit";
import { errorReply, readJsonBody, Router, sendReply, type RequestContext } from "./http/router";
import { LobbyService } from "./lobby/lobbyService";
import { catalog } from "./matches/matchConfig";
import { MatchService } from "./matches/matchService";
import { Metrics } from "./metrics";
import { WsPushHub, type Push } from "./push/push";
import { QueueService } from "./queue/queueService";
import { ResultsStore } from "./results/resultsStore";

// Wiring: stores → services → routes → node:http server (+ WS push). Used by main.ts and by the HTTP tests.

export const API_VERSION = "1.0.0";

export type AppConfig = Pick<
  ApiConfig,
  "publicUrl" | "build" | "region" | "hostId" | "inviteCode" | "metricsToken" | "corsOrigins" | "trustProxy" | "rateAuthPerMin" | "rateApiPerMin" | "queue" | "lobbyIdleMinutes"
>;

export interface ApiDeps {
  readonly config: AppConfig;
  readonly db: Db;
  readonly keys: KeyRing;
  readonly allocator: Allocator;
  /** Defaults to the WebSocket hub. */
  readonly push?: Push;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Tests drive `queue.tick()` themselves. */
  readonly autoTick?: boolean;
}

export interface ApiApp {
  readonly server: Server;
  readonly tokens: TokenService;
  readonly accounts: AccountStore;
  readonly matches: MatchService;
  readonly lobbies: LobbyService;
  readonly queue: QueueService;
  readonly results: ResultsStore;
  readonly metrics: Metrics;
  listen(port: number, host: string): Promise<number>;
  /** Reloads keys (after `keys rotate`) and pushes the new JWKS to running matches. */
  reloadKeys(file: Parameters<KeyRing["replace"]>[0]): void;
  close(): Promise<void>;
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function isPrivateIp(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, "");
  return v4 === "127.0.0.1" || ip === "::1" || /^10\./.test(v4) || /^192\.168\./.test(v4) || /^172\.(1[6-9]|2\d|3[01])\./.test(v4);
}

export function createApi(deps: ApiDeps): ApiApp {
  const { config, db, keys } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const startedAt = now();
  const metrics = new Metrics();
  const tokens = new TokenService({ keys, issuer: config.publicUrl, now });
  const accounts = new AccountStore(db, now);
  const results = new ResultsStore(db);
  const hub = deps.push === undefined ? new WsPushHub(tokens, log) : null;
  const push: Push = deps.push ?? hub!;
  const matches = new MatchService({ allocator: deps.allocator, tokens, results, push, metrics, hostId: config.hostId, region: config.region, build: config.build, now, log });
  let queue: QueueService;
  const lobbies = new LobbyService({ matches, push, metrics, idleMs: config.lobbyIdleMinutes * 60_000, isQueued: (id) => queue.isQueued(id), now });
  queue = new QueueService({ matches, push, metrics, startAfterSec: config.queue.startAfterSec, minHumans: config.queue.minHumans, isInLobby: (id) => lobbies.lobbyCodeOf(id) !== null, now, log });
  if (hub) metrics.gauge("tb_ws_connections", "Push sockets", () => hub.connections);

  const authLimiter = new RateLimiter(config.rateAuthPerMin, { now });
  const apiLimiter = new RateLimiter(config.rateApiPerMin, { now });

  const authed = (ctx: RequestContext): AccountView => {
    const header = ctx.req.headers.authorization ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    const claims = m ? tokens.verifyAccess(m[1]!) : null;
    if (claims === null) throw new HttpError("unauthorized", "Missing or invalid access token");
    const retry = apiLimiter.take(`acct:${claims.sub}`);
    if (retry > 0) throw new HttpError("rateLimited", "Too many requests", retry);
    const account = accounts.get(claims.sub);
    if (account === null) throw new HttpError("unauthorized", "Unknown account");
    return account;
  };
  const requireBuild = (ctx: RequestContext): void => {
    const header = ctx.req.headers[PROTOCOL_HEADER];
    if (header === undefined) return; // curl and tools; the client always sends it
    const [pv, ch] = String(header).split(".");
    if (Number(pv) !== PROTOCOL_VERSION || Number(ch) >>> 0 !== CONTENT_HASH >>> 0) throw new HttpError("upgradeRequired", "A newer game version is available; reload the page");
  };
  const authLimit = (ctx: RequestContext): void => {
    const retry = authLimiter.take(`ip:${ctx.ip}`);
    if (retry > 0) throw new HttpError("rateLimited", "Too many login attempts", retry);
  };
  const authResponse = (account: AccountView, refreshToken: string): AuthResponse => {
    const access = tokens.issueAccess(account.id, account.nickname);
    return { accessToken: access.token, expiresAt: access.expiresAt, refreshToken, account };
  };

  const router = new Router()
    .add("GET", "/healthz", () => ({ body: { ok: true, build: config.build, uptimeSec: Math.round((now() - startedAt) / 1000) } satisfies HealthResponse }))
    .add("GET", "/readyz", () => {
      const checks = { db: dbHealthy(db), keys: keys.jwks().keys.length > 0 };
      const ok = checks.db && checks.keys;
      return { status: ok ? 200 : 503, body: { ok, build: config.build, uptimeSec: Math.round((now() - startedAt) / 1000), checks } satisfies HealthResponse };
    })
    .add("GET", "/metrics", (ctx) => {
      const token = config.metricsToken;
      const bearer = /^Bearer\s+(\S+)$/i.exec(ctx.req.headers.authorization ?? "")?.[1];
      if (token !== null ? bearer !== token : !isPrivateIp(ctx.req.socket.remoteAddress ?? "")) throw new HttpError("forbidden", "metrics are private");
      return { body: metrics.render(), contentType: "text/plain; version=0.0.4" };
    })
    .add("GET", "/.well-known/jwks.json", () => ({ body: keys.jwks(), headers: { "Cache-Control": "public, max-age=300" } }))
    .add("GET", "/v1/version", () => ({ body: { apiVersion: API_VERSION, protocolVersion: PROTOCOL_VERSION, contentHash: CONTENT_HASH >>> 0, build: config.build } satisfies VersionResponse }))
    .add("GET", "/v1/catalog", () => ({ body: catalog({ queueStartAfterSec: config.queue.startAfterSec, inviteRequired: config.inviteCode !== null }) }))
    .add("POST", "/v1/auth/guest", async (ctx) => {
      authLimit(ctx);
      const body = await ctx.body();
      if (config.inviteCode !== null && body.inviteCode !== config.inviteCode) throw new HttpError("inviteRequired", "A valid invite code is required");
      const nickname = normalizeNickname(body.nickname);
      if (nickname === null) throw new HttpError("nicknameInvalid", "Nickname must be 3–16 letters, digits, spaces, _ - or .");
      const language = body.language === undefined ? "vi" : body.language;
      if (!isLanguage(language)) throw new HttpError("badRequest", "language must be vi or en");
      const { account, refreshToken } = accounts.createGuest(nickname, language);
      metrics.inc("tb_auth_guest_total", {}, 1, "Guest accounts created");
      return { status: 201, body: authResponse(account, refreshToken) };
    })
    .add("POST", "/v1/auth/refresh", async (ctx) => {
      authLimit(ctx);
      const body = await ctx.body();
      const res = typeof body.refreshToken === "string" ? accounts.refresh(body.refreshToken) : null;
      if (res === null) throw new HttpError("unauthorized", "Unknown refresh token; log in again");
      return { body: authResponse(res.account, res.refreshToken) };
    })
    .add("GET", "/v1/me", (ctx) => ({ body: { account: authed(ctx) } }))
    .add("PATCH", "/v1/me", async (ctx) => {
      const account = authed(ctx);
      const body = await ctx.body();
      const patch: { nickname?: string; language?: "vi" | "en" } = {};
      if (body.nickname !== undefined) {
        const n = normalizeNickname(body.nickname);
        if (n === null) throw new HttpError("nicknameInvalid", "Nickname must be 3–16 letters, digits, spaces, _ - or .");
        patch.nickname = n;
      }
      if (body.language !== undefined) {
        if (!isLanguage(body.language)) throw new HttpError("badRequest", "language must be vi or en");
        patch.language = body.language;
      }
      return { body: { account: accounts.update(account.id, patch) } };
    })
    .add("GET", "/v1/me/active-match", (ctx) => {
      const account = authed(ctx);
      const record = matches.activeMatchOf(account.id);
      const body: ActiveMatchResponse = {
        match: record === null ? null : matches.summary(record, account.id),
        ticket: queue.ticketOf(account.id),
        lobbyCode: lobbies.lobbyCodeOf(account.id),
      };
      return { body };
    })
    .add("GET", "/v1/me/matches", (ctx) => {
      const account = authed(ctx);
      const limit = Number(ctx.query.get("limit") ?? "20");
      return { body: { matches: results.history(account.id, Number.isFinite(limit) ? limit : 20) } };
    })
    .add("GET", "/v1/lobbies", (ctx) => {
      authed(ctx);
      return { body: { lobbies: lobbies.listPublic() } };
    })
    .add("POST", "/v1/lobbies", async (ctx) => {
      const account = authed(ctx);
      requireBuild(ctx);
      const body = await ctx.body();
      return { status: 201, body: { lobby: lobbies.create(account, body as never) } };
    })
    .add("GET", "/v1/lobbies/{code}", (ctx) => {
      authed(ctx);
      return { body: { lobby: lobbies.get(ctx.params.code!) } };
    })
    .add("POST", "/v1/lobbies/{code}/join", async (ctx) => {
      const account = authed(ctx);
      requireBuild(ctx);
      const body = await ctx.body();
      const teamId = typeof body.teamId === "number" ? body.teamId : undefined;
      return { body: { lobby: lobbies.join(account, ctx.params.code!, teamId) } };
    })
    .add("POST", "/v1/lobbies/{code}/team", async (ctx) => {
      const account = authed(ctx);
      const body = await ctx.body();
      if (typeof body.teamId !== "number") throw new HttpError("badRequest", "teamId required");
      return { body: { lobby: lobbies.changeTeam(account.id, ctx.params.code!, body.teamId) } };
    })
    .add("PATCH", "/v1/lobbies/{code}", async (ctx) => {
      const account = authed(ctx);
      const body = await ctx.body();
      return { body: { lobby: lobbies.update(account.id, ctx.params.code!, body as never) } };
    })
    .add("POST", "/v1/lobbies/{code}/leave", (ctx) => {
      const account = authed(ctx);
      lobbies.leave(account.id, ctx.params.code!);
      return { body: { ok: true } };
    })
    .add("POST", "/v1/lobbies/{code}/start", async (ctx) => {
      const account = authed(ctx);
      requireBuild(ctx);
      return { body: { lobby: await lobbies.start(account.id, ctx.params.code!) } };
    })
    .add("POST", "/v1/queue/tickets", async (ctx) => {
      const account = authed(ctx);
      requireBuild(ctx);
      const body = await ctx.body();
      return { status: 201, body: { ticket: queue.create(account, body as never) } };
    })
    .add("GET", "/v1/queue/tickets/{id}", (ctx) => {
      const account = authed(ctx);
      return { body: { ticket: queue.get(account.id, ctx.params.id!) } };
    })
    .add("DELETE", "/v1/queue/tickets/{id}", (ctx) => {
      const account = authed(ctx);
      queue.cancel(account.id, ctx.params.id!);
      return { body: { ok: true } };
    })
    .add("POST", "/v1/matches/{id}/join", (ctx) => {
      const account = authed(ctx);
      requireBuild(ctx);
      return { body: matches.issueJoin(account.id, ctx.params.id!) };
    })
    .add("GET", "/v1/matches/{id}/result", (ctx) => {
      authed(ctx);
      const result = results.getResult(ctx.params.id!);
      if (result === null) throw new HttpError("notFound", "No result for this match (yet)");
      return { body: result };
    });

  const allowOrigin = (origin: string | undefined): boolean => origin === undefined || config.corsOrigins.length === 0 || config.corsOrigins.includes(origin) || origin === config.publicUrl;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const origin = req.headers.origin;
    if (origin !== undefined && config.corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", `Authorization, Content-Type, ${PROTOCOL_HEADER}`);
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (method === "OPTIONS") {
      sendReply(res, { status: 204, body: null });
      return;
    }
    const found = router.match(method, url.pathname);
    let routeLabel = "unmatched";
    try {
      if (found === null) throw new HttpError("notFound", "No such route");
      if (found === "methodNotAllowed") throw new HttpError("badRequest", "Method not allowed");
      routeLabel = found.route.pattern;
      let bodyPromise: Promise<Record<string, unknown>> | null = null;
      const ctx: RequestContext = {
        req,
        method,
        path: url.pathname,
        params: found.params,
        query: url.searchParams,
        ip: clientIp(req, config.trustProxy),
        body: () => (bodyPromise ??= readJsonBody(req)),
      };
      sendReply(res, await found.route.handler(ctx));
    } catch (err) {
      if (!(err instanceof HttpError)) log(`[http] ${method} ${url.pathname} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (!res.headersSent) sendReply(res, errorReply(err));
    } finally {
      metrics.inc("tb_http_requests_total", { route: routeLabel, method, status: `${Math.floor(res.statusCode / 100)}xx` }, 1, "HTTP requests");
    }
  };

  const server = createServer((req, res) => void handle(req, res));
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  hub?.attach(server, allowOrigin);

  const timers: NodeJS.Timeout[] = [];
  if (deps.autoTick !== false) {
    timers.push(setInterval(() => void queue.tick().catch((err) => log(`[queue] tick failed: ${String(err)}`)), config.queue.tickMs));
    timers.push(
      setInterval(() => {
        lobbies.sweep();
        matches.sweep();
        authLimiter.sweep();
        apiLimiter.sweep();
      }, 60_000),
    );
    for (const t of timers) t.unref();
  }

  return {
    server,
    tokens,
    accounts,
    matches,
    lobbies,
    queue,
    results,
    metrics,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve((server.address() as AddressInfo).port);
        });
      }),
    reloadKeys(file) {
      keys.replace(file);
      deps.allocator.pushJwks(keys.agentJwks());
      log(`[keys] reloaded; active kid ${keys.activeKid}, ${keys.jwks().keys.length} published`);
    },
    async close() {
      for (const t of timers) clearInterval(t);
      hub?.close();
      await deps.allocator.shutdown();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
