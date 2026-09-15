import type { MatchPhase, TeamMode } from "./match";

// server-api REST contract (v1) for the client front door: guest login, lobby (custom matches), quick queue, join
// tokens, reconnect and results. JSON bodies ≤ 16 KB, `Content-Type: application/json`. Authenticated routes take
// `Authorization: Bearer <accessToken>`. Clients also send `X-TB-Protocol: <PROTOCOL_VERSION>.<CONTENT_HASH>` on
// lobby/queue/join calls; a different build gets `426 upgradeRequired` and should reload (platform.md §3.5).
//
// Route table (method, path → request → response):
//   GET    /v1/version                         → VersionResponse
//   GET    /v1/catalog                         → CatalogResponse
//   POST   /v1/auth/guest        GuestLoginRequest   → AuthResponse
//   POST   /v1/auth/refresh      RefreshRequest      → AuthResponse
//   GET    /v1/me                              → MeResponse
//   PATCH  /v1/me                UpdateMeRequest     → MeResponse
//   GET    /v1/me/active-match                 → ActiveMatchResponse         (reconnect entry point)
//   GET    /v1/me/matches                      → MatchHistoryResponse
//   GET    /v1/lobbies                         → LobbyListResponse           (public lobbies still open)
//   POST   /v1/lobbies           CreateLobbyRequest  → LobbyResponse
//   GET    /v1/lobbies/{code}                  → LobbyResponse
//   POST   /v1/lobbies/{code}/join   JoinLobbyRequest → LobbyResponse
//   POST   /v1/lobbies/{code}/team   ChangeTeamRequest → LobbyResponse
//   POST   /v1/lobbies/{code}/leave                → LeaveResponse
//   PATCH  /v1/lobbies/{code}    UpdateLobbyRequest  → LobbyResponse         (host only, while open)
//   POST   /v1/lobbies/{code}/start                → LobbyResponse           (host only)
//   POST   /v1/queue/tickets     CreateTicketRequest → TicketResponse
//   GET    /v1/queue/tickets/{id}                  → TicketResponse
//   DELETE /v1/queue/tickets/{id}                  → LeaveResponse
//   POST   /v1/matches/{id}/join                   → JoinMatchResponse       (fresh single-use join token)
//   GET    /v1/matches/{id}/result                 → MatchResultResponse
//   GET    /.well-known/jwks.json                  → JwksResponse
//   GET    /healthz, /readyz                       → HealthResponse
//   GET    /metrics                                → Prometheus text (bearer TB_METRICS_TOKEN; not proxied publicly)
//   GET    /v1/ws                                  → WebSocket push, see ws.ts

export const API_PREFIX = "/v1";
export const PROTOCOL_HEADER = "x-tb-protocol";

export type Language = "vi" | "en";
export const LANGUAGES: readonly Language[] = ["vi", "en"];
export const DEFAULT_LANGUAGE: Language = "vi";

export type ApiErrorCode =
  | "badRequest"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "conflict"
  | "rateLimited"
  | "upgradeRequired"
  | "noCapacity"
  | "inviteRequired"
  | "nicknameInvalid"
  | "lobbyFull"
  | "lobbyClosed"
  | "alreadyInMatch"
  | "internal";

/** Every non-2xx response. `message` is English for logs; the client localises by `code`. */
export interface ApiError {
  readonly error: ApiErrorCode;
  readonly message: string;
  /** Seconds, on `rateLimited` (also sent as `Retry-After`). */
  readonly retryAfterSec?: number;
}

// ─── version and catalog ─────────────────────────────────────────────────────────────────────────────────────────────

export interface VersionResponse {
  readonly apiVersion: string;
  readonly protocolVersion: number;
  readonly contentHash: number;
  /** Git sha or image tag of the running server build. */
  readonly build: string;
}

export interface LocalizedText {
  readonly vi: string;
  readonly en: string;
}

export interface MapInfo {
  /** `v1` (Map v1), `arena`, or `<countryCode>-<place>` for real-world maps (e.g. `cz-holasovice`). */
  readonly id: string;
  readonly name: LocalizedText;
  /** Side length in metres. */
  readonly sizeM: number;
  /** false: listed as "coming soon" and rejected by create/queue. */
  readonly available: boolean;
  readonly kind: "handmade" | "realWorld" | "dev";
}

export interface CatalogResponse {
  readonly modes: readonly { readonly mode: TeamMode; readonly teamSize: number; readonly name: LocalizedText }[];
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly defaultPlayers: number;
  readonly defaultMode: TeamMode;
  readonly maps: readonly MapInfo[];
  readonly defaultMapId: string;
  readonly languages: readonly Language[];
  readonly defaultLanguage: Language;
  /** Seconds a quick-queue ticket waits before the match starts with bots filling the rest. */
  readonly queueStartAfterSec: number;
  /** Guest login needs `inviteCode` on this deployment. */
  readonly inviteRequired: boolean;
}

// ─── auth and profile ────────────────────────────────────────────────────────────────────────────────────────────────

/** Nickname rule: 3–16 characters after NFC + trim; letters (Vietnamese diacritics OK), digits, space, `_`, `-`, `.`. */
export const NICKNAME_MIN = 3;
export const NICKNAME_MAX = 16;

export interface GuestLoginRequest {
  readonly nickname: string;
  readonly language?: Language;
  /** Required when `CatalogResponse.inviteRequired`. */
  readonly inviteCode?: string;
}

export interface RefreshRequest {
  /** The `refreshToken` from the first login; keep it in localStorage. */
  readonly refreshToken: string;
}

export interface AccountView {
  readonly id: string;
  readonly nickname: string;
  /** 4 digits shown after the nickname (`Huy#4821`) so equal nicknames stay distinguishable. */
  readonly tag: string;
  readonly language: Language;
  readonly createdAt: number;
}

export interface AuthResponse {
  readonly accessToken: string;
  /** Epoch ms. */
  readonly expiresAt: number;
  /** Returned on every login/refresh (rotated); the previous one stops working. */
  readonly refreshToken: string;
  readonly account: AccountView;
}

export interface UpdateMeRequest {
  readonly nickname?: string;
  readonly language?: Language;
}

export interface MeResponse {
  readonly account: AccountView;
}

// ─── lobbies (custom matches) ────────────────────────────────────────────────────────────────────────────────────────

/** 6 characters from `LOBBY_CODE_ALPHABET` (no 0/O/1/I). */
export const LOBBY_CODE_LENGTH = 6;
export const LOBBY_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export interface MatchSettings {
  readonly mode: TeamMode;
  /** MIN_MATCH_PLAYERS..MAX_MATCH_PLAYERS, humans + bots. */
  readonly maxPlayers: number;
  readonly mapId: string;
  readonly fillWithBots: boolean;
}

export interface CreateLobbyRequest extends MatchSettings {
  /** private: join by code only (default). public: also listed in `GET /v1/lobbies`. */
  readonly visibility?: "private" | "public";
}

export type UpdateLobbyRequest = Partial<CreateLobbyRequest>;

export interface JoinLobbyRequest {
  /** Preferred team; the first team with room when absent or full. */
  readonly teamId?: number;
}

export interface ChangeTeamRequest {
  readonly teamId: number;
}

export type LobbyStatus = "open" | "starting" | "inMatch" | "closed";

export interface LobbyMember {
  readonly accountId: string;
  readonly nickname: string;
  readonly tag: string;
  readonly teamId: number;
  readonly host: boolean;
}

export interface LobbyView {
  readonly code: string;
  readonly status: LobbyStatus;
  readonly visibility: "private" | "public";
  readonly settings: MatchSettings;
  readonly teamCount: number;
  readonly teamSize: number;
  readonly members: readonly LobbyMember[];
  /** Slots bots will take at start (0 when `fillWithBots` is off). */
  readonly botSlots: number;
  /** Set once the match is allocated. */
  readonly matchId: string | null;
  readonly createdAt: number;
}

export interface LobbyResponse {
  readonly lobby: LobbyView;
}

export interface LobbyListResponse {
  readonly lobbies: readonly LobbyView[];
}

export interface LeaveResponse {
  readonly ok: true;
}

// ─── quick queue ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CreateTicketRequest {
  readonly mode: TeamMode;
  readonly maxPlayers: number;
  /** Omit for the default map. */
  readonly mapId?: string;
}

export type TicketStatus = "queued" | "matched" | "cancelled" | "failed";

export interface TicketView {
  readonly id: string;
  readonly status: TicketStatus;
  readonly settings: MatchSettings;
  /** Epoch ms. */
  readonly createdAt: number;
  /** Humans waiting in the same bucket, including this ticket. */
  readonly playersWaiting: number;
  /** Epoch ms at which the start rule fires with bots filling (null once matched). */
  readonly startsBy: number | null;
  readonly matchId: string | null;
  readonly failure?: ApiErrorCode;
}

export interface TicketResponse {
  readonly ticket: TicketView;
}

// ─── matches, join and reconnect ─────────────────────────────────────────────────────────────────────────────────────

export type MatchStatus = "allocating" | "running" | "ended" | "aborted";

export interface MatchSummaryView {
  readonly matchId: string;
  readonly status: MatchStatus;
  /** Last phase reported by the match process. */
  readonly phase: MatchPhase | null;
  readonly settings: MatchSettings;
  readonly source: "lobby" | "queue";
  readonly teamId: number;
  readonly createdAt: number;
}

export interface JoinMatchResponse {
  /** `wss://<domain>/gs/<port>/m/<matchId>` in production, `ws://localhost:<port>/m/<matchId>` locally. */
  readonly wsUrl: string;
  /** Single-use join JWT (aud "match", TTL 120 s); send it in `Hello`, never in the URL. Fetch a new one per connect. */
  readonly joinToken: string;
  /** Epoch ms. */
  readonly expiresAt: number;
  readonly matchId: string;
  readonly teamId: number;
  /** true when this account already received a token for this match (a reconnect). */
  readonly reconnect: boolean;
}

export interface ActiveMatchResponse {
  /** null: not in a match. Otherwise call `POST /v1/matches/{id}/join` while status is allocating/running. */
  readonly match: MatchSummaryView | null;
  readonly ticket: TicketView | null;
  readonly lobbyCode: string | null;
}

export interface ParticipantResultView {
  readonly accountId: string;
  readonly nickname: string;
  readonly teamId: number;
  readonly bot: boolean;
  readonly placement: number;
  readonly kills: number;
  readonly knocks: number;
  readonly revives: number;
  readonly damageDealt: number;
  readonly survivedMs: number;
}

export interface MatchResultResponse {
  readonly matchId: string;
  readonly outcome: "completed" | "cancelled" | "aborted";
  readonly settings: MatchSettings;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly winningTeamId: number | null;
  readonly participants: readonly ParticipantResultView[];
}

export interface MatchHistoryEntry {
  readonly matchId: string;
  readonly outcome: "completed" | "cancelled" | "aborted";
  readonly settings: MatchSettings;
  readonly endedAt: number;
  readonly placement: number;
  readonly kills: number;
  readonly teamCount: number;
}

export interface MatchHistoryResponse {
  readonly matches: readonly MatchHistoryEntry[];
}

// ─── keys and health ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface JwksKey {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
  readonly kid: string;
  readonly alg: "EdDSA";
  readonly use: "sig";
}

export interface JwksResponse {
  readonly keys: readonly JwksKey[];
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly build: string;
  readonly uptimeSec: number;
  readonly checks?: Readonly<Record<string, boolean>>;
}
