import type { ApiErrorCode, LobbyView, MatchSummaryView, TicketView } from "./rest";

// server-api push channel for the front door: `GET /v1/ws` upgraded to a WebSocket, JSON text frames. It only pushes
// state changes; everything is also readable over REST, so a client that loses the socket polls
// `GET /v1/me/active-match` and reconnects with backoff (1 s, 2 s, 4 s … 30 s).
//
// 1. The client opens the socket and sends `auth` within 5 s (the token never goes in the URL, so proxies don't log it).
// 2. The server answers `ready`, then pushes events for the lobby, ticket and match this account is part of.
// 3. `ping` every 25 s keeps idle proxies from closing the socket; the server replies `pong`.
// Close codes: 4001 auth failed or timed out, 4008 rate limited, 4010 replaced by a newer socket for the same account.

export const WS_PATH = "/v1/ws";
export const WS_AUTH_TIMEOUT_MS = 5000;
export const WS_CLOSE_AUTH = 4001;
export const WS_CLOSE_RATE_LIMITED = 4008;
export const WS_CLOSE_REPLACED = 4010;

export type ClientToApiWs = { readonly t: "auth"; readonly accessToken: string } | { readonly t: "ping" };

export type ApiToClientWs =
  | { readonly t: "ready"; readonly accountId: string }
  | { readonly t: "pong" }
  /** Any change to a lobby the account is in: members, teams, settings, status (and `matchId` once allocated). */
  | { readonly t: "lobby.updated"; readonly lobby: LobbyView }
  /** The account was removed from a lobby (left elsewhere, lobby closed). */
  | { readonly t: "lobby.left"; readonly code: string }
  | { readonly t: "ticket.updated"; readonly ticket: TicketView }
  /** A match was allocated for the account: call `POST /v1/matches/{matchId}/join`, then connect. */
  | { readonly t: "match.assigned"; readonly match: MatchSummaryView }
  /** Phase or status change of the account's match (running → ended/aborted). */
  | { readonly t: "match.updated"; readonly match: MatchSummaryView }
  /** Allocation failed; tickets go back to the queue, lobbies back to open. */
  | { readonly t: "match.failed"; readonly matchId: string; readonly error: ApiErrorCode };
