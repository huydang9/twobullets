import { describe, expect, it } from "vitest";
import { INITIAL_MENU_STATE, menuReducer, type MenuEvent, type MenuState } from "../../src/menu/menuState";
import { ACCOUNT } from "../platform/fakes";
import { active, catalog, lobby, match, result, ticket } from "./fixtures";

const run = (state: MenuState, ...events: MenuEvent[]): MenuState => events.reduce(menuReducer, state);
const loggedIn = (): MenuState => run(INITIAL_MENU_STATE, { type: "catalogLoaded", catalog }, { type: "resumed", account: ACCOUNT, active: active(), lobby: null });

describe("menu state: boot and login", () => {
  it("boot → login without a session, login → main", () => {
    let state = run(INITIAL_MENU_STATE, { type: "catalogLoaded", catalog }, { type: "noSession" });
    expect(state.screen).toEqual({ kind: "login" });
    state = run(state, { type: "busy" }, { type: "failed", code: "nicknameInvalid" });
    expect(state.notice).toBe("nicknameInvalid");
    expect(state.busy).toBe(false);
    state = run(state, { type: "busy" }, { type: "resumed", account: ACCOUNT, active: active(), lobby: null });
    expect(state.screen).toEqual({ kind: "main", panel: "home" });
    expect(state.account).toBe(ACCOUNT);
    expect(state.notice).toBeNull();
  });

  it("resumes into the lobby, the queue, or main with a rejoin offer", () => {
    expect(run(INITIAL_MENU_STATE, { type: "resumed", account: ACCOUNT, active: active({ lobbyCode: "ABCDEF" }), lobby: lobby() }).screen.kind).toBe("lobby");
    expect(run(INITIAL_MENU_STATE, { type: "resumed", account: ACCOUNT, active: active({ ticket: ticket() }), lobby: null }).screen.kind).toBe("queue");
    const rejoin = run(INITIAL_MENU_STATE, { type: "resumed", account: ACCOUNT, active: active({ match: match(), lobbyCode: "ABCDEF" }), lobby: lobby({ status: "inMatch", matchId: "m_1" }) });
    expect(rejoin.screen).toEqual({ kind: "main", panel: "home" });
    expect(rejoin.rejoin?.matchId).toBe("m_1");
    expect(run(rejoin, { type: "rejoin" }).screen).toEqual({ kind: "connecting", matchId: "m_1", mapId: "v1", reconnect: true });
  });

  it("an ended match is not offered for rejoin", () => {
    const state = run(INITIAL_MENU_STATE, { type: "resumed", account: ACCOUNT, active: active({ match: match({ status: "ended" }) }), lobby: null });
    expect(state.rejoin).toBeNull();
  });

  it("session lost goes back to login, except while a game runs", () => {
    expect(run(loggedIn(), { type: "sessionLost" }).screen.kind).toBe("login");
    const inGame: MenuState = { ...loggedIn(), screen: { kind: "inGame", matchId: "m_1" } };
    expect(run(inGame, { type: "sessionLost" }).screen.kind).toBe("inGame");
  });

  it("426 locks the menu behind reload", () => {
    const state = run(loggedIn(), { type: "failed", code: "upgradeRequired" });
    expect(state.upgradeRequired).toBe(true);
  });
});

describe("menu state: custom match", () => {
  it("create → lobby updates → host start → connecting → game → results → main", () => {
    let state = run(loggedIn(), { type: "busy" }, { type: "lobbyEntered", lobby: lobby() });
    expect(state.screen.kind).toBe("lobby");

    const joined = lobby({ members: [...lobby().members, { accountId: "g_FRIEND", nickname: "Lan", tag: "0001", teamId: 1, host: false }] });
    state = run(state, { type: "push", message: { t: "lobby.updated", lobby: joined } });
    expect(state.screen.kind === "lobby" && state.screen.lobby.members.length).toBe(2);

    // Pushes for another lobby are ignored.
    expect(run(state, { type: "push", message: { t: "lobby.updated", lobby: lobby({ code: "ZZZZZZ" }) } })).toBe(state);

    state = run(state, { type: "busy" }, { type: "push", message: { t: "lobby.updated", lobby: lobby({ status: "starting" }) } });
    expect(state.busy).toBe(true);
    state = run(state, { type: "push", message: { t: "match.assigned", match: match() } });
    expect(state.screen).toEqual({ kind: "connecting", matchId: "m_1", mapId: "v1", reconnect: false });
    expect(state.busy).toBe(false);

    // The start response (inMatch) arriving after match.assigned keeps connecting.
    expect(run(state, { type: "push", message: { t: "lobby.updated", lobby: lobby({ status: "inMatch", matchId: "m_1" }) } }).screen.kind).toBe("connecting");

    state = run(state, { type: "gameLaunched", matchId: "m_1" });
    expect(state.screen).toEqual({ kind: "inGame", matchId: "m_1" });

    state = run(state, { type: "push", message: { t: "match.updated", match: match({ status: "ended", phase: "Ended" }) } });
    expect(state.screen).toEqual({ kind: "results", matchId: "m_1", result: null, fromGame: true, awaitingGame: true });
    // The in-game result screen hands over; another match's exit changes nothing.
    expect(run(state, { type: "gameExited", matchId: "m_9" })).toBe(state);
    state = run(state, { type: "gameExited", matchId: "m_1" });
    expect(state.screen).toEqual({ kind: "results", matchId: "m_1", result: null, fromGame: true, awaitingGame: false });
    state = run(state, { type: "resultLoaded", result: result("m_2") });
    expect(state.screen.kind === "results" && state.screen.result).toBeNull();
    state = run(state, { type: "resultLoaded", result: result() });
    expect(state.screen.kind === "results" && state.screen.result?.participants.length).toBe(2);
    expect(run(state, { type: "closeResults" }).screen).toEqual({ kind: "main", panel: "home" });
  });

  it("a lobby update to inMatch moves members to connecting", () => {
    const state = run(loggedIn(), { type: "lobbyEntered", lobby: lobby() }, { type: "push", message: { t: "lobby.updated", lobby: lobby({ status: "inMatch", matchId: "m_9" }) } });
    expect(state.screen).toEqual({ kind: "connecting", matchId: "m_9", mapId: "v1", reconnect: false });
  });

  it("leaving or being removed returns to main; a failed allocation stays in the lobby with a notice", () => {
    const inLobby = run(loggedIn(), { type: "lobbyEntered", lobby: lobby() });
    expect(run(inLobby, { type: "lobbyLeft" }).screen.kind).toBe("main");
    expect(run(inLobby, { type: "push", message: { t: "lobby.left", code: "ABCDEF" } }).screen.kind).toBe("main");
    const failed = run(inLobby, { type: "push", message: { t: "match.failed", matchId: "m_1", error: "noCapacity" } });
    expect(failed.screen.kind).toBe("lobby");
    expect(failed.notice).toBe("noCapacity");
  });
});

describe("menu state: quick play", () => {
  it("queue → ticket updates → matched → connecting", () => {
    let state = run(loggedIn(), { type: "panel", panel: "quickPlay" }, { type: "busy" }, { type: "queued", ticket: ticket() });
    expect(state.screen.kind).toBe("queue");
    state = run(state, { type: "push", message: { t: "ticket.updated", ticket: ticket({ playersWaiting: 3 }) } });
    expect(state.screen.kind === "queue" && state.screen.ticket.playersWaiting).toBe(3);
    state = run(state, { type: "push", message: { t: "ticket.updated", ticket: ticket({ status: "matched", matchId: "m_5", startsBy: null }) } });
    expect(state.screen).toEqual({ kind: "connecting", matchId: "m_5", mapId: "v1", reconnect: false });
  });

  it("cancel returns to the quick play panel; an allocation failure keeps the ticket queued with a notice", () => {
    const queued = run(loggedIn(), { type: "queued", ticket: ticket() });
    expect(run(queued, { type: "queueCancelled" }).screen).toEqual({ kind: "main", panel: "quickPlay" });
    const failed = run(queued, { type: "push", message: { t: "ticket.updated", ticket: ticket({ failure: "noCapacity" }) } });
    expect(failed.screen.kind).toBe("queue");
    expect(failed.notice).toBe("noCapacity");
  });

  it("a connect failure goes back to main with the error", () => {
    const state = run(loggedIn(), { type: "queued", ticket: ticket() }, { type: "push", message: { t: "match.assigned", match: match() } }, { type: "connectFailed", code: "conflict" });
    expect(state.screen.kind).toBe("main");
    expect(state.notice).toBe("conflict");
  });
});

describe("menu state: reconnect and results", () => {
  it("a match that ended while the tab was closed shows its results from main", () => {
    const state = run(loggedIn(), { type: "matchEnded", matchId: "m_1" });
    expect(state.screen).toEqual({ kind: "results", matchId: "m_1", result: null, fromGame: false, awaitingGame: false });
  });

  it("a running match pushed to main becomes a rejoin offer, and its end removes it", () => {
    let state = run(loggedIn(), { type: "push", message: { t: "match.updated", match: match() } });
    expect(state.rejoin?.matchId).toBe("m_1");
    state = run(state, { type: "panel", panel: "settings" }, { type: "push", message: { t: "match.updated", match: match({ status: "aborted" }) } });
    expect(state.rejoin).toBeNull();
  });

  it("remembers what the last match was started from, so the results screen can offer 'play again'", () => {
    // From a lobby: the code comes along, so play again goes back to the same (reopened) lobby.
    let state = run(loggedIn(), { type: "lobbyEntered", lobby: lobby() }, { type: "push", message: { t: "lobby.updated", lobby: lobby({ status: "inMatch", matchId: "m_1" }) } });
    expect(state.lastMatch).toEqual({ source: "lobby", settings: lobby().settings, lobbyCode: "ABCDEF" });
    state = run(state, { type: "gameLaunched", matchId: "m_1" }, { type: "matchEnded", matchId: "m_1" });
    expect(state.screen.kind).toBe("results");
    expect(state.lastMatch?.lobbyCode).toBe("ABCDEF");

    // From the queue: no lobby, so play again queues with the same settings.
    const queued = run(loggedIn(), { type: "queued", ticket: ticket() }, { type: "push", message: { t: "ticket.updated", ticket: ticket({ status: "matched", matchId: "m_2" }) } });
    expect(queued.lastMatch).toEqual({ source: "queue", settings: ticket().settings, lobbyCode: null });

    // A reload mid-match picks it up again from the API.
    const resumed = run(INITIAL_MENU_STATE, { type: "resumed", account: ACCOUNT, active: active({ match: match(), lobbyCode: "ABCDEF" }), lobby: null });
    expect(resumed.lastMatch).toEqual({ source: "lobby", settings: match().settings, lobbyCode: "ABCDEF" });
    expect(INITIAL_MENU_STATE.lastMatch).toBeNull();
  });

  it("resume keeps the open panel and the in-game screen", () => {
    const settingsPanel = run(loggedIn(), { type: "panel", panel: "settings" });
    expect(run(settingsPanel, { type: "resumed", account: ACCOUNT, active: active(), lobby: null }).screen).toEqual({ kind: "main", panel: "settings" });
    const inGame: MenuState = { ...loggedIn(), screen: { kind: "inGame", matchId: "m_1" } };
    expect(run(inGame, { type: "resumed", account: ACCOUNT, active: active({ match: match() }), lobby: null }).screen.kind).toBe("inGame");
  });
});
