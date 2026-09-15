import type { ApiError } from "@twobullets/contracts/rest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError } from "./errors";

// A deliberately small router on node:http: exact segments and `{param}` segments, JSON in and out, 16 KB bodies.

export const MAX_BODY_BYTES = 16 * 1024;

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly ip: string;
  /** Parsed JSON object body ({} when empty). */
  body(): Promise<Record<string, unknown>>;
}

export type Reply = { readonly status?: number; readonly body: unknown; readonly contentType?: string; readonly headers?: Record<string, string> };
export type Handler = (ctx: RequestContext) => Promise<Reply> | Reply;

interface Route {
  readonly method: string;
  readonly pattern: string;
  readonly segments: readonly string[];
  readonly handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, pattern, segments: pattern.split("/").filter(Boolean), handler });
    return this;
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | "methodNotAllowed" | null {
    const parts = path.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i]!;
        if (seg.startsWith("{") && seg.endsWith("}")) {
          try {
            params[seg.slice(1, -1)] = decodeURIComponent(parts[i]!);
          } catch {
            ok = false;
            break;
          }
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? "methodNotAllowed" : null;
  }
}

export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const type = req.headers["content-type"] ?? "";
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError("badRequest", "body too large"));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError("badRequest", "body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (size === 0) return resolve({});
      if (!type.startsWith("application/json")) return reject(new HttpError("badRequest", "Content-Type must be application/json"));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (typeof value !== "object" || value === null || Array.isArray(value)) return reject(new HttpError("badRequest", "body must be a JSON object"));
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new HttpError("badRequest", "invalid JSON"));
      }
    });
  });
}

export function sendReply(res: ServerResponse, reply: Reply): void {
  const status = reply.status ?? 200;
  const headers: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...reply.headers };
  if (status === 204) {
    res.writeHead(204, headers).end();
    return;
  }
  const contentType = reply.contentType ?? "application/json; charset=utf-8";
  const body = contentType.startsWith("application/json") ? JSON.stringify(reply.body) : String(reply.body);
  res.writeHead(status, { ...headers, "Content-Type": contentType }).end(body);
}

export function errorReply(err: unknown): Reply {
  if (err instanceof HttpError) {
    const body: ApiError = { error: err.code, message: err.message, ...(err.retryAfterSec !== undefined ? { retryAfterSec: err.retryAfterSec } : {}) };
    return { status: err.status, body, headers: err.retryAfterSec !== undefined ? { "Retry-After": String(err.retryAfterSec) } : undefined };
  }
  return { status: 500, body: { error: "internal", message: "Internal error" } satisfies ApiError };
}
