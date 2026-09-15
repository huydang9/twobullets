import type { AccountView, ActiveMatchResponse, CatalogResponse, LobbyView, MatchResultResponse, MatchSummaryView, TicketView } from "@twobullets/contracts/rest";
import type { ApiToClientWs } from "@twobullets/contracts/ws";
import type { ClientErrorCode } from "../platform/ApiRequestError";
import type { LobbySocketStatus } from "../platform/LobbySocket";

// Front-door state machine: pure `(state, event) → state`, so every transition is unit-tested without a DOM or a
// server. MenuController performs the effects (API calls, the lobby socket, launching the game) and feeds results
// back in as events; MenuView renders the state.

export type MainPanel = "home" | "quickPlay" | "joinCode" | "practice" | "settings" | "credits";

export type Screen =
  | { readonly kind: "boot" }
  | { readonly kind: "login" }
  | { readonly kind: "main"; readonly panel: MainPanel }
  | { readonly kind: "lobby"; readonly lobby: LobbyView }
  | { readonly kind: "queue"; readonly ticket: TicketView }
  /** Fetching the join token, then loading the game. */
  | { readonly kind: "connecting"; readonly matchId: string; readonly mapId: string; readonly reconnect: boolean }
  /** The game runs; the menu is hidden but keeps listening for the match end. */
  | { readonly kind: "inGame"; readonly matchId: string }
  /**
   * `fromGame`: shown over the game (leaving reloads to the menu). `awaitingGame`: the in-game result screen is still up,
   * so this one stays hidden (results already load) until the game hands over (`gameExited`).
   */
  | { readonly kind: "results"; readonly matchId: string; readonly result: MatchResultResponse | null; readonly fromGame: boolean; readonly awaitingGame: boolean };

export type ScreenKind = Screen["kind"];

export interface MenuState {
  readonly screen: Screen;
  readonly account: AccountView | null;
  readonly catalog: CatalogResponse | null;
  /** The running match this account can rejoin ("Vào lại trận"). */
  readonly rejoin: MatchSummaryView | null;
  /** Last error to show on the current screen. */
  readonly notice: ClientErrorCode | null;
  /** A request in flight: buttons are disabled. */
  readonly busy: boolean;
  /** A 426 was seen: only "reload" is offered. */
  readonly upgradeRequired: boolean;
  readonly socket: LobbySocketStatus;
}

export type MenuEvent =
  | { readonly type: "catalogLoaded"; readonly catalog: CatalogResponse }
  | { readonly type: "noSession" }
  /** Logged in (or a stored session worked) and the active-match state is known. */
  | { readonly type: "resumed"; readonly account: AccountView; readonly active: ActiveMatchResponse; readonly lobby: LobbyView | null }
  | { readonly type: "sessionLost" }
  | { readonly type: "busy" }
  | { readonly type: "failed"; readonly code: ClientErrorCode }
  | { readonly type: "dismissNotice" }
  | { readonly type: "panel"; readonly panel: MainPanel }
  | { readonly type: "account"; readonly account: AccountView }
  | { readonly type: "lobbyEntered"; readonly lobby: LobbyView }
  | { readonly type: "lobbyLeft" }
  | { readonly type: "queued"; readonly ticket: TicketView }
  | { readonly type: "queueCancelled" }
  | { readonly type: "push"; readonly message: ApiToClientWs }
  | { readonly type: "socket"; readonly status: LobbySocketStatus }
  | { readonly type: "rejoin" }
  | { readonly type: "connectFailed"; readonly code: ClientErrorCode }
  | { readonly type: "gameLaunched"; readonly matchId: string }
  | { readonly type: "matchEnded"; readonly matchId: string }
  /** The game closed its in-game result screen for this match. */
  | { readonly type: "gameExited"; readonly matchId: string }
  | { readonly type: "resultLoaded"; readonly result: MatchResultResponse }
  | { readonly type: "closeResults" }
  | { readonly type: "upgradeRequired" };

export const INITIAL_MENU_STATE: MenuState = {
  screen: { kind: "boot" },
  account: null,
  catalog: null,
  rejoin: null,
  notice: null,
  busy: false,
  upgradeRequired: false,
  socket: "idle",
};

const MAIN: Screen = { kind: "main", panel: "home" };

function isLive(match: MatchSummaryView | null): match is MatchSummaryView {
  return match !== null && (match.status === "allocating" || match.status === "running");
}

function connecting(match: { readonly matchId: string; readonly settings: { readonly mapId: string } }, reconnect: boolean): Screen {
  return { kind: "connecting", matchId: match.matchId, mapId: match.settings.mapId, reconnect };
}

/** The match this screen is joining or playing, if any. */
export function screenMatchId(screen: Screen): string | null {
  return screen.kind === "connecting" || screen.kind === "inGame" || screen.kind === "results" ? screen.matchId : null;
}

export function menuReducer(state: MenuState, event: MenuEvent): MenuState {
  const screen = state.screen;
  switch (event.type) {
    case "catalogLoaded":
      return { ...state, catalog: event.catalog };
    case "noSession":
      return { ...state, screen: { kind: "login" }, account: null, busy: false };
    case "sessionLost":
      return { ...state, screen: screen.kind === "inGame" ? screen : { kind: "login" }, account: null, rejoin: null, busy: false, notice: "unauthorized" };
    case "resumed": {
      const base = { ...state, account: event.account, busy: false, notice: null };
      const { active } = event;
      if (event.lobby && event.lobby.status !== "closed" && !isLive(active.match)) return { ...base, rejoin: null, screen: { kind: "lobby", lobby: event.lobby } };
      if (active.ticket && active.ticket.status === "queued") return { ...base, rejoin: null, screen: { kind: "queue", ticket: active.ticket } };
      if (isLive(active.match)) {
        // Mid-game results screen or game already running for this match: keep it.
        if (screenMatchId(screen) === active.match.matchId) return { ...base, rejoin: null };
        return { ...base, rejoin: active.match, screen: screen.kind === "main" ? screen : MAIN };
      }
      if (screen.kind === "inGame" || screen.kind === "results" || screen.kind === "connecting") return { ...base, rejoin: null };
      return { ...base, rejoin: null, screen: screen.kind === "main" ? screen : MAIN };
    }
    case "busy":
      return { ...state, busy: true, notice: null };
    case "failed":
      return { ...state, busy: false, notice: event.code, upgradeRequired: state.upgradeRequired || event.code === "upgradeRequired" };
    case "dismissNotice":
      return { ...state, notice: null };
    case "panel":
      return screen.kind === "main" ? { ...state, screen: { kind: "main", panel: event.panel }, notice: null } : state;
    case "account":
      return { ...state, account: event.account, busy: false };
    case "lobbyEntered":
      return { ...state, busy: false, notice: null, screen: { kind: "lobby", lobby: event.lobby } };
    case "lobbyLeft":
      return screen.kind === "lobby" ? { ...state, busy: false, screen: MAIN } : { ...state, busy: false };
    case "queued":
      return { ...state, busy: false, notice: null, screen: { kind: "queue", ticket: event.ticket } };
    case "queueCancelled":
      return screen.kind === "queue" ? { ...state, busy: false, screen: { kind: "main", panel: "quickPlay" } } : { ...state, busy: false };
    case "socket":
      return { ...state, socket: event.status };
    case "rejoin":
      return state.rejoin && (screen.kind === "main" || screen.kind === "lobby") ? { ...state, busy: false, notice: null, screen: connecting(state.rejoin, true) } : state;
    case "connectFailed":
      return screen.kind === "connecting" ? { ...state, busy: false, notice: event.code, screen: MAIN } : state;
    case "gameLaunched":
      return screen.kind === "connecting" && screen.matchId === event.matchId ? { ...state, busy: false, rejoin: null, screen: { kind: "inGame", matchId: event.matchId } } : state;
    case "matchEnded":
      return matchEnded(state, event.matchId);
    case "gameExited":
      if (screen.kind === "inGame" && screen.matchId === event.matchId) {
        return { ...state, busy: false, rejoin: null, screen: { kind: "results", matchId: event.matchId, result: null, fromGame: true, awaitingGame: false } };
      }
      return screen.kind === "results" && screen.matchId === event.matchId && screen.awaitingGame ? { ...state, screen: { ...screen, awaitingGame: false } } : state;
    case "resultLoaded":
      return screen.kind === "results" && screen.matchId === event.result.matchId ? { ...state, screen: { ...screen, result: event.result } } : state;
    case "closeResults":
      return screen.kind === "results" ? { ...state, screen: MAIN, notice: null } : state;
    case "upgradeRequired":
      return { ...state, upgradeRequired: true, busy: false };
    case "push":
      return onPush(state, event.message);
  }
}

function matchEnded(state: MenuState, matchId: string): MenuState {
  const screen = state.screen;
  const rejoin = state.rejoin?.matchId === matchId ? null : state.rejoin;
  if (screen.kind === "results") return { ...state, rejoin };
  const fromGame = screen.kind === "inGame" && screen.matchId === matchId;
  const waiting = screen.kind === "connecting" && screen.matchId === matchId;
  if (fromGame || waiting || screen.kind === "main" || screen.kind === "boot") {
    return { ...state, rejoin, busy: false, screen: { kind: "results", matchId, result: null, fromGame, awaitingGame: fromGame } };
  }
  return { ...state, rejoin };
}

function onPush(state: MenuState, message: ApiToClientWs): MenuState {
  const screen = state.screen;
  switch (message.t) {
    case "ready":
    case "pong":
      return state;
    case "lobby.updated": {
      if (screen.kind !== "lobby" || screen.lobby.code !== message.lobby.code) return state;
      const lobby = message.lobby;
      if (lobby.status === "inMatch" && lobby.matchId !== null) {
        return { ...state, busy: false, screen: { kind: "connecting", matchId: lobby.matchId, mapId: lobby.settings.mapId, reconnect: false } };
      }
      return { ...state, busy: lobby.status === "starting" ? state.busy : false, screen: { kind: "lobby", lobby } };
    }
    case "lobby.left":
      return screen.kind === "lobby" && screen.lobby.code === message.code ? { ...state, busy: false, screen: MAIN } : state;
    case "ticket.updated": {
      if (screen.kind !== "queue" || screen.ticket.id !== message.ticket.id) return state;
      const ticket = message.ticket;
      if (ticket.status === "matched" && ticket.matchId !== null) return { ...state, screen: { kind: "connecting", matchId: ticket.matchId, mapId: ticket.settings.mapId, reconnect: false } };
      if (ticket.status === "cancelled") return { ...state, screen: { kind: "main", panel: "quickPlay" } };
      if (ticket.status === "failed") return { ...state, notice: ticket.failure ?? "internal", screen: { kind: "main", panel: "quickPlay" } };
      // Allocation failed: the ticket stays queued and the error is shown.
      return { ...state, notice: ticket.failure ?? state.notice, screen: { kind: "queue", ticket } };
    }
    case "match.assigned": {
      const match = message.match;
      if (screenMatchId(screen) === match.matchId) return state;
      if (screen.kind === "lobby" || screen.kind === "queue" || screen.kind === "main") return { ...state, busy: false, rejoin: null, screen: connecting(match, false) };
      return state;
    }
    case "match.updated": {
      const match = message.match;
      if (match.status === "ended" || match.status === "aborted") return matchEnded(state, match.matchId);
      if (screen.kind === "main" && isLive(match) && screenMatchId(screen) === null) return { ...state, rejoin: match };
      return state;
    }
    case "match.failed":
      if (screen.kind === "connecting" && screen.matchId === message.matchId) return { ...state, busy: false, notice: message.error, screen: MAIN };
      if (screen.kind === "lobby" || screen.kind === "queue") return { ...state, busy: false, notice: message.error };
      return state;
  }
}
