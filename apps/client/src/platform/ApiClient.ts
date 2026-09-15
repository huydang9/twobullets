import {
  PROTOCOL_HEADER,
  type AccountView,
  type ActiveMatchResponse,
  type AuthResponse,
  type CatalogResponse,
  type CreateLobbyRequest,
  type CreateTicketRequest,
  type GuestLoginRequest,
  type JoinMatchResponse,
  type LeaveResponse,
  type LobbyResponse,
  type LobbyView,
  type MatchHistoryResponse,
  type MatchResultResponse,
  type MeResponse,
  type TicketResponse,
  type TicketView,
  type UpdateLobbyRequest,
  type UpdateMeRequest,
  type VersionResponse,
} from "@twobullets/contracts/rest";
import { PROTOCOL_HEADER_VALUE } from "./apiConfig";
import { ApiRequestError, codeForStatus, isApiErrorBody } from "./ApiRequestError";
import { SessionStore } from "./SessionStore";

// REST client for server-api (packages/contracts/src/rest.ts). Authenticated calls refresh the access token a minute
// before it expires, and once more on a 401; a refresh the server rejects ends the session (`onSessionLost`). Any 426
// fires `onUpgradeRequired` (the page must reload to get the new build).

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** server-api origin, "" for same origin (apiConfig.ts). */
  readonly baseUrl: string;
  readonly store?: SessionStore;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/** Refresh when less than this is left on the access token. */
export const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

interface SendOptions {
  readonly body?: unknown;
  readonly token?: string;
}

export class ApiClient {
  readonly store: SessionStore;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private refreshing: Promise<boolean> | null = null;
  private readonly upgradeListeners = new Set<() => void>();
  private readonly sessionLostListeners = new Set<() => void>();

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.store = options.store ?? new SessionStore();
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get account(): AccountView | null {
    return this.store.account;
  }

  /** A stored access token or refresh secret exists (it may still turn out to be invalid). */
  get hasSession(): boolean {
    return this.store.current !== null || this.store.refreshToken !== null;
  }

  onUpgradeRequired(listener: () => void): () => void {
    this.upgradeListeners.add(listener);
    return () => this.upgradeListeners.delete(listener);
  }

  onSessionLost(listener: () => void): () => void {
    this.sessionLostListeners.add(listener);
    return () => this.sessionLostListeners.delete(listener);
  }

  // ─── public routes ────────────────────────────────────────────────────────────────────────────────────────────────

  version(): Promise<VersionResponse> {
    return this.send("GET", "/v1/version");
  }

  catalog(): Promise<CatalogResponse> {
    return this.send("GET", "/v1/catalog");
  }

  async loginGuest(request: GuestLoginRequest): Promise<AuthResponse> {
    const auth = await this.send<AuthResponse>("POST", "/v1/auth/guest", { body: request });
    this.store.save(auth);
    return auth;
  }

  /** Rotates the refresh secret for a new access token. Single flight; false when the server rejects the secret. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.refreshOnce().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** A valid access token, refreshing when needed; null when there is no usable session. */
  async accessToken(): Promise<string | null> {
    const current = this.store.current;
    if (current && current.expiresAt - this.now() > REFRESH_MARGIN_MS) return current.accessToken;
    if (this.store.refreshToken === null) return current && current.expiresAt > this.now() ? current.accessToken : null;
    try {
      if (await this.refresh()) return this.store.current?.accessToken ?? null;
    } catch (error) {
      // Network trouble: keep using a token that has not expired yet.
      if (current && current.expiresAt > this.now()) return current.accessToken;
      throw error;
    }
    this.loseSession();
    return null;
  }

  logout(): void {
    this.store.clear();
  }

  // ─── account ──────────────────────────────────────────────────────────────────────────────────────────────────────

  async me(): Promise<AccountView> {
    const { account } = await this.authed<MeResponse>("GET", "/v1/me");
    this.store.updateAccount(account);
    return account;
  }

  async updateMe(patch: UpdateMeRequest): Promise<AccountView> {
    const { account } = await this.authed<MeResponse>("PATCH", "/v1/me", patch);
    this.store.updateAccount(account);
    return account;
  }

  activeMatch(): Promise<ActiveMatchResponse> {
    return this.authed("GET", "/v1/me/active-match");
  }

  matchHistory(): Promise<MatchHistoryResponse> {
    return this.authed("GET", "/v1/me/matches");
  }

  // ─── lobbies ──────────────────────────────────────────────────────────────────────────────────────────────────────

  async createLobby(request: CreateLobbyRequest): Promise<LobbyView> {
    return (await this.authed<LobbyResponse>("POST", "/v1/lobbies", request)).lobby;
  }

  async getLobby(code: string): Promise<LobbyView> {
    return (await this.authed<LobbyResponse>("GET", `/v1/lobbies/${encodeURIComponent(code)}`)).lobby;
  }

  async joinLobby(code: string, teamId?: number): Promise<LobbyView> {
    return (await this.authed<LobbyResponse>("POST", `/v1/lobbies/${encodeURIComponent(code)}/join`, teamId === undefined ? {} : { teamId })).lobby;
  }

  async changeTeam(code: string, teamId: number): Promise<LobbyView> {
    return (await this.authed<LobbyResponse>("POST", `/v1/lobbies/${encodeURIComponent(code)}/team`, { teamId })).lobby;
  }

  async updateLobby(code: string, patch: UpdateLobbyRequest): Promise<LobbyView> {
    return (await this.authed<LobbyResponse>("PATCH", `/v1/lobbies/${encodeURIComponent(code)}`, patch)).lobby;
  }

  async leaveLobby(code: string): Promise<void> {
    await this.authed<LeaveResponse>("POST", `/v1/lobbies/${encodeURIComponent(code)}/leave`);
  }

  async startLobby(code: string): Promise<LobbyView> {
    return (await this.authed<LobbyResponse>("POST", `/v1/lobbies/${encodeURIComponent(code)}/start`)).lobby;
  }

  // ─── quick queue ──────────────────────────────────────────────────────────────────────────────────────────────────

  async createTicket(request: CreateTicketRequest): Promise<TicketView> {
    return (await this.authed<TicketResponse>("POST", "/v1/queue/tickets", request)).ticket;
  }

  async getTicket(id: string): Promise<TicketView> {
    return (await this.authed<TicketResponse>("GET", `/v1/queue/tickets/${encodeURIComponent(id)}`)).ticket;
  }

  async cancelTicket(id: string): Promise<void> {
    await this.authed<LeaveResponse>("DELETE", `/v1/queue/tickets/${encodeURIComponent(id)}`);
  }

  // ─── matches ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A fresh single-use join token; call once per connect attempt. */
  joinMatch(matchId: string): Promise<JoinMatchResponse> {
    return this.authed("POST", `/v1/matches/${encodeURIComponent(matchId)}/join`);
  }

  matchResult(matchId: string): Promise<MatchResultResponse> {
    return this.authed("GET", `/v1/matches/${encodeURIComponent(matchId)}/result`);
  }

  // ─── transport ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken();
    if (token === null) throw new ApiRequestError("unauthorized", 401, "Not logged in");
    try {
      return await this.send<T>(method, path, { body, token });
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.code !== "unauthorized") throw error;
      // Keys rotated or the token was revoked: one refresh, one retry.
      this.store.dropAccess();
      if (this.store.refreshToken !== null && (await this.refresh())) {
        const fresh = this.store.current?.accessToken;
        if (fresh) return this.send<T>(method, path, { body, token: fresh });
      }
      this.loseSession();
      throw error;
    }
  }

  private async refreshOnce(): Promise<boolean> {
    const secret = this.store.refreshToken;
    if (secret === null) return false;
    try {
      this.store.save(await this.send<AuthResponse>("POST", "/v1/auth/refresh", { body: { refreshToken: secret } }));
      return true;
    } catch (error) {
      if (!(error instanceof ApiRequestError) || error.code !== "unauthorized") throw error;
      // Another tab may have rotated the secret in the meantime.
      const latest = this.store.refreshToken;
      if (latest === null || latest === secret) return false;
      try {
        this.store.save(await this.send<AuthResponse>("POST", "/v1/auth/refresh", { body: { refreshToken: latest } }));
        return true;
      } catch (retryError) {
        if (retryError instanceof ApiRequestError && retryError.code === "unauthorized") return false;
        throw retryError;
      }
    }
  }

  private loseSession(): void {
    this.store.clear();
    for (const listener of this.sessionLostListeners) listener();
  }

  private async send<T>(method: string, path: string, options: SendOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.token !== undefined) {
      headers.Authorization = `Bearer ${options.token}`;
      headers[PROTOCOL_HEADER] = PROTOCOL_HEADER_VALUE;
    }
    const controller = typeof AbortController === "undefined" ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : undefined;
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller?.signal,
      });
      text = await response.text();
    } catch (error) {
      throw new ApiRequestError("network", 0, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
    let payload: unknown = null;
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.ok) throw new ApiRequestError("badResponse", response.status, `${method} ${path}: invalid JSON`);
      }
    }
    if (!response.ok) {
      const code = isApiErrorBody(payload) ? payload.error : codeForStatus(response.status);
      const retryAfter = isApiErrorBody(payload) ? payload.retryAfterSec : Number(response.headers.get("Retry-After")) || undefined;
      const error = new ApiRequestError(response.status === 426 ? "upgradeRequired" : code, response.status, isApiErrorBody(payload) ? payload.message : `${method} ${path}: HTTP ${response.status}`, retryAfter);
      if (error.code === "upgradeRequired") for (const listener of this.upgradeListeners) listener();
      throw error;
    }
    return payload as T;
  }
}
