import type { TeamMode } from "@twobullets/contracts/match";
import type { AccountView, JoinMatchResponse, LobbyView, MatchSettings, UpdateLobbyRequest } from "@twobullets/contracts/rest";
import type { ApiToClientWs } from "@twobullets/contracts/ws";
import type { Language } from "../i18n";
import type { ApiClient } from "../platform/ApiClient";
import { errorCodeOf } from "../platform/ApiRequestError";
import { createApiJoinTokenProvider } from "../platform/joinToken";
import type { LobbySocket } from "../platform/LobbySocket";
import type { KeyValueStorage } from "../platform/SessionStore";
import type { NetMatchExit } from "../game/launch";
import type { MatchLaunch, PracticeSettings } from "./launch";
import { INITIAL_MENU_STATE, menuReducer, type MainPanel, type MenuEvent, type MenuState, type Screen } from "./menuState";

// Effects around the pure menu state machine: server-api calls, the push socket (with REST polling while it is down),
// fetching the join token and handing over to the game, and loading results.

export interface MenuControllerDeps {
  readonly api: ApiClient;
  readonly socket: LobbySocket;
  /** Starts the networked game (menu/launch.ts); resolves once the game runs. */
  readonly launchMatch: (launch: MatchLaunch) => Promise<void>;
  /** Reloads into the offline bot match. */
  readonly launchPractice: (settings: PracticeSettings) => void;
  /** Reloads the page on the menu (after a match: the game can't be torn down in place). */
  readonly reloadToMenu: () => void;
  /** Per-tab storage for the match whose results are still to be shown. */
  readonly session?: KeyValueStorage | null;
  readonly language: () => Language;
  readonly wait?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** REST polling period while the push socket is down, ms. */
  readonly pollMs?: number;
}

export const LAST_MATCH_KEY = "tb.menu.lastMatch";
/** How long the connecting screen retries `POST /matches/{id}/join` while the match is still starting. */
export const JOIN_RETRY_MS = 30_000;
const RESULT_ATTEMPTS = 15;
/** Results wait behind the game at most this long when the game never hands over (it lost the MatchEnd), ms. */
export const GAME_HANDOFF_TIMEOUT_MS = 20_000;

export class MenuController {
  private stateValue: MenuState = INITIAL_MENU_STATE;
  private readonly listeners = new Set<(state: MenuState) => void>();
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private booted = false;
  private readonly deps: MenuControllerDeps;

  constructor(deps: MenuControllerDeps) {
    this.deps = deps;
    this.wait = deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  get api(): ApiClient {
    return this.deps.api;
  }

  get state(): MenuState {
    return this.stateValue;
  }

  subscribe(listener: (state: MenuState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispatch(event: MenuEvent): void {
    const previous = this.stateValue;
    const next = menuReducer(previous, event);
    if (next === previous) return;
    this.stateValue = next;
    for (const listener of this.listeners) listener(next);
    this.afterTransition(previous.screen, next.screen);
  }

  // ─── boot and session ─────────────────────────────────────────────────────────────────────────────────────────────

  async boot(): Promise<void> {
    const { api, socket } = this.deps;
    if (!this.booted) {
      this.booted = true;
      api.onUpgradeRequired(() => this.dispatch({ type: "upgradeRequired" }));
      api.onSessionLost(() => {
        socket.stop();
        this.dispatch({ type: "sessionLost" });
      });
      socket.onStatus((status) => this.dispatch({ type: "socket", status }));
      socket.on((message) => this.onPush(message));
      this.pollTimer = setInterval(() => void this.poll(), this.deps.pollMs ?? 4000);
    }
    try {
      this.dispatch({ type: "catalogLoaded", catalog: await api.catalog() });
    } catch (error) {
      this.dispatch({ type: "failed", code: errorCodeOf(error) });
    }
    if (!api.hasSession) {
      this.dispatch({ type: "noSession" });
      return;
    }
    await this.resync(true);
  }

  dispose(): void {
    clearInterval(this.pollTimer);
    this.deps.socket.stop();
  }

  async login(nickname: string, inviteCode: string): Promise<void> {
    this.dispatch({ type: "busy" });
    try {
      const code = inviteCode.trim();
      await this.deps.api.loginGuest({ nickname, language: this.deps.language(), ...(code ? { inviteCode: code } : {}) });
    } catch (error) {
      this.dispatch({ type: "failed", code: errorCodeOf(error) });
      return;
    }
    await this.resync(false);
  }

  logout(): void {
    this.deps.socket.stop();
    this.deps.api.logout();
    this.dispatch({ type: "noSession" });
  }

  /** Saves the language on the account (the UI already switched). */
  async saveLanguage(language: Language): Promise<void> {
    if (!this.stateValue.account || this.stateValue.account.language === language) return;
    try {
      this.dispatch({ type: "account", account: await this.deps.api.updateMe({ language }) });
    } catch {
      // Cosmetic: the local choice already applies.
    }
  }

  openPanel(panel: MainPanel): void {
    this.dispatch({ type: "panel", panel });
  }

  dismissNotice(): void {
    this.dispatch({ type: "dismissNotice" });
  }

  practice(settings: PracticeSettings): void {
    this.deps.launchPractice(settings);
  }

  // ─── quick play ───────────────────────────────────────────────────────────────────────────────────────────────────

  async quickPlay(mode: TeamMode, maxPlayers: number): Promise<void> {
    await this.run(async (api) => this.dispatch({ type: "queued", ticket: await api.createTicket({ mode, maxPlayers }) }));
  }

  async cancelQueue(): Promise<void> {
    const screen = this.stateValue.screen;
    if (screen.kind !== "queue") return;
    await this.run(async (api) => {
      await api.cancelTicket(screen.ticket.id);
      this.dispatch({ type: "queueCancelled" });
    });
  }

  // ─── lobbies ──────────────────────────────────────────────────────────────────────────────────────────────────────

  async createLobby(settings: MatchSettings): Promise<void> {
    await this.run(async (api) => this.dispatch({ type: "lobbyEntered", lobby: await api.createLobby({ ...settings, visibility: "private" }) }));
  }

  async joinLobby(code: string): Promise<void> {
    await this.run(async (api) => this.dispatch({ type: "lobbyEntered", lobby: await api.joinLobby(code.trim().toUpperCase()) }));
  }

  async updateLobby(patch: UpdateLobbyRequest): Promise<void> {
    await this.inLobby((api, code) => api.updateLobby(code, patch));
  }

  async switchTeam(teamId: number): Promise<void> {
    await this.inLobby((api, code) => api.changeTeam(code, teamId));
  }

  async startLobby(): Promise<void> {
    // Resolves after allocation; `match.assigned` usually arrives first and moves on to connecting.
    await this.inLobby((api, code) => api.startLobby(code));
  }

  async leaveLobby(): Promise<void> {
    const screen = this.stateValue.screen;
    if (screen.kind !== "lobby") return;
    await this.run(async (api) => {
      await api.leaveLobby(screen.lobby.code);
      this.dispatch({ type: "lobbyLeft" });
    });
  }

  // ─── matches ──────────────────────────────────────────────────────────────────────────────────────────────────────

  rejoin(): void {
    this.dispatch({ type: "rejoin" });
  }

  /**
   * The game is done with a match: after its in-game result screen the front door's results take over; a player who
   * left early goes back to the menu, which offers "Rejoin" while the match runs (and its results after).
   */
  gameExited(exit: NetMatchExit): void {
    if (exit.reason === "left") {
      this.deps.reloadToMenu();
      return;
    }
    this.dispatch({ type: "gameExited", matchId: exit.matchId });
  }

  closeResults(): void {
    const screen = this.stateValue.screen;
    if (screen.kind !== "results") return;
    removeItem(this.deps.session, LAST_MATCH_KEY);
    if (screen.fromGame) {
      this.deps.reloadToMenu();
      return;
    }
    this.dispatch({ type: "closeResults" });
    void this.resync(false);
  }

  // ─── internals ────────────────────────────────────────────────────────────────────────────────────────────────────

  private afterTransition(previous: Screen, next: Screen): void {
    if (next.kind === "connecting" && (previous.kind !== "connecting" || previous.matchId !== next.matchId)) void this.connect(next.matchId, next.mapId);
    if (next.kind === "results" && (previous.kind !== "results" || previous.matchId !== next.matchId)) {
      void this.loadResult(next.matchId);
      if (next.awaitingGame) void this.handoffTimeout(next.matchId);
    }
  }

  /** Account, active match, lobby and ticket from REST; starts the push socket. */
  private async resync(initial: boolean): Promise<void> {
    const { api, socket } = this.deps;
    try {
      const account: AccountView = api.account ?? (await api.me());
      const active = await api.activeMatch();
      const lobby = active.lobbyCode ? await api.getLobby(active.lobbyCode).catch(() => null) : null;
      const before = this.stateValue.screen;
      this.dispatch({ type: "resumed", account, active, lobby });
      socket.start();
      const last = getItem(this.deps.session, LAST_MATCH_KEY);
      if (initial && last && active.match?.matchId !== last) this.dispatch({ type: "matchEnded", matchId: last });
      // The end was pushed while the socket was down.
      if (before.kind === "inGame" && active.match?.matchId !== before.matchId) this.dispatch({ type: "matchEnded", matchId: before.matchId });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "unauthorized") return; // onSessionLost already moved to login
      if (this.stateValue.screen.kind === "boot") this.dispatch({ type: "noSession" });
      this.dispatch({ type: "failed", code });
    }
  }

  private onPush(message: ApiToClientWs): void {
    // Pushes sent while the socket was down are lost: resync on every (re)connect.
    if (message.t === "ready") {
      if (this.stateValue.account && this.stateValue.screen.kind !== "boot") void this.resync(false);
      return;
    }
    this.dispatch({ type: "push", message });
  }

  /** REST fallback while the push socket is down. */
  private async poll(): Promise<void> {
    const state = this.stateValue;
    if (this.polling || state.socket === "open" || !state.account) return;
    const screen = state.screen;
    const api = this.deps.api;
    this.polling = true;
    try {
      if (screen.kind === "lobby") {
        this.dispatch({ type: "push", message: { t: "lobby.updated", lobby: await api.getLobby(screen.lobby.code) } });
      } else if (screen.kind === "queue") {
        this.dispatch({ type: "push", message: { t: "ticket.updated", ticket: await api.getTicket(screen.ticket.id) } });
      } else if (screen.kind === "inGame") {
        const active = await api.activeMatch();
        if (active.match?.matchId !== screen.matchId) this.dispatch({ type: "matchEnded", matchId: screen.matchId });
      }
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "notFound" && screen.kind === "lobby") this.dispatch({ type: "push", message: { t: "lobby.left", code: screen.lobby.code } });
    } finally {
      this.polling = false;
    }
  }

  private stillConnecting(matchId: string): boolean {
    const screen = this.stateValue.screen;
    return screen.kind === "connecting" && screen.matchId === matchId;
  }

  private async connect(matchId: string, mapId: string): Promise<void> {
    const { api } = this.deps;
    const deadline = this.now() + JOIN_RETRY_MS;
    let join: JoinMatchResponse | null = null;
    while (join === null) {
      try {
        join = await api.joinMatch(matchId);
      } catch (error) {
        const code = errorCodeOf(error);
        // conflict: still allocating (match.assigned not sent yet); network: a blip.
        if ((code === "conflict" || code === "network" || code === "rateLimited") && this.now() < deadline) {
          await this.wait(1000);
          if (!this.stillConnecting(matchId)) return;
          continue;
        }
        if (this.stillConnecting(matchId)) this.dispatch({ type: "connectFailed", code });
        return;
      }
    }
    const account = this.stateValue.account;
    if (!this.stillConnecting(matchId) || !account) return;
    setItem(this.deps.session, LAST_MATCH_KEY, matchId);
    this.dispatch({ type: "gameLaunched", matchId });
    try {
      await this.deps.launchMatch({ join, mapId, account, tokens: createApiJoinTokenProvider(api, join, this.now), onExit: (exit) => this.gameExited(exit) });
    } catch (error) {
      console.error("[menu] game failed to start", error);
      this.dispatch({ type: "failed", code: "internal" });
    }
  }

  private async handoffTimeout(matchId: string): Promise<void> {
    await this.wait(GAME_HANDOFF_TIMEOUT_MS);
    const screen = this.stateValue.screen;
    if (screen.kind === "results" && screen.matchId === matchId && screen.awaitingGame) this.dispatch({ type: "gameExited", matchId });
  }

  private async loadResult(matchId: string): Promise<void> {
    for (let attempt = 0; attempt < RESULT_ATTEMPTS; attempt++) {
      try {
        this.dispatch({ type: "resultLoaded", result: await this.deps.api.matchResult(matchId) });
        return;
      } catch (error) {
        const code = errorCodeOf(error);
        // The match process reports a few seconds after the end.
        if (code !== "notFound" && code !== "network") {
          this.dispatch({ type: "failed", code });
          return;
        }
      }
      await this.wait(2000);
      const screen = this.stateValue.screen;
      if (screen.kind !== "results" || screen.matchId !== matchId) return;
    }
    this.dispatch({ type: "failed", code: "notFound" });
  }

  private async run(action: (api: ApiClient) => Promise<void>): Promise<void> {
    this.dispatch({ type: "busy" });
    try {
      await action(this.deps.api);
    } catch (error) {
      this.dispatch({ type: "failed", code: errorCodeOf(error) });
    }
  }

  private async inLobby(call: (api: ApiClient, code: string) => Promise<LobbyView>): Promise<void> {
    const screen = this.stateValue.screen;
    if (screen.kind !== "lobby") return;
    await this.run(async (api) => {
      const lobby = await call(api, screen.lobby.code);
      // As a push: a start that already moved on to connecting must not return to the lobby screen.
      this.dispatch({ type: "push", message: { t: "lobby.updated", lobby } });
    });
  }
}

function getItem(storage: KeyValueStorage | null | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function setItem(storage: KeyValueStorage | null | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // Ignore.
  }
}

function removeItem(storage: KeyValueStorage | null | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Ignore.
  }
}
