import type { ApiToClientWs } from "@twobullets/contracts/ws";
import { describe, expect, it, vi } from "vitest";
import type { MatchLaunch } from "../../src/menu/launch";
import { LAST_MATCH_KEY, LEFT_MATCH_KEY, MenuController } from "../../src/menu/MenuController";
import { ApiClient } from "../../src/platform/ApiClient";
import { LobbySocket } from "../../src/platform/LobbySocket";
import { SessionStore } from "../../src/platform/SessionStore";
import { ACCOUNT, auth, FakeServer, FakeSocket, flush, MemoryStorage } from "../platform/fakes";
import { active, catalog, lobby, match, result, settings, ticket } from "./fixtures";

const HOUR = 3600_000;

function setup(options: { loggedIn?: boolean } = {}) {
  FakeSocket.instances = [];
  const server = new FakeServer();
  const store = new SessionStore(new MemoryStorage(), new MemoryStorage());
  if (options.loggedIn) store.save(auth("A1", "R1", Date.now() + HOUR));
  const api = new ApiClient({ baseUrl: "http://api.test", fetch: server.fetch, store });
  const socket = new LobbySocket({ url: "ws://api.test/v1/ws", createSocket: (url) => new FakeSocket(url), accessToken: () => api.accessToken(), refreshAccess: async () => false });
  const launches: MatchLaunch[] = [];
  const session = new MemoryStorage();
  const reloadToMenu = vi.fn();
  const controller = new MenuController({
    api,
    socket,
    session,
    language: () => "vi",
    launchMatch: async (launch) => void launches.push(launch),
    launchPractice: vi.fn(),
    reloadToMenu,
    wait: async () => {},
    pollMs: 60_000,
  });
  server.on("GET /v1/catalog", () => ({ body: catalog }));
  server.on("GET /v1/me/active-match", () => ({ body: active() }));
  const push = async (message: ApiToClientWs) => {
    FakeSocket.instances[0]!.serverSend(message);
    await flush(20);
  };
  return { server, api, socket, controller, launches, session, reloadToMenu, push };
}

describe("MenuController", () => {
  it("boots to login without a session and logs in to the main menu with the push socket", async () => {
    const { server, controller } = setup();
    server.on("POST /v1/auth/guest", () => ({ status: 201, body: auth("A1", "R1", Date.now() + HOUR) }));
    await controller.boot();
    expect(controller.state.screen.kind).toBe("login");
    expect(controller.state.catalog?.maxPlayers).toBe(20);

    await controller.login("Huy", "");
    expect(controller.state.screen).toEqual({ kind: "main", panel: "home" });
    expect(controller.state.account?.id).toBe(ACCOUNT.id);
    expect(server.calls.find((c) => c.path === "/v1/auth/guest")?.body).toEqual({ nickname: "Huy", language: "vi" });
    expect(FakeSocket.instances).toHaveLength(1);
    controller.dispose();
  });

  it("shows the server error on login (invite code)", async () => {
    const { server, controller } = setup();
    server.on("POST /v1/auth/guest", () => ({ status: 403, body: { error: "inviteRequired", message: "A valid invite code is required" } }));
    await controller.boot();
    await controller.login("Huy", "wrong");
    expect(controller.state.screen.kind).toBe("login");
    expect(controller.state.notice).toBe("inviteRequired");
    expect(server.calls.find((c) => c.path === "/v1/auth/guest")?.body).toEqual({ nickname: "Huy", language: "vi", inviteCode: "wrong" });
    controller.dispose();
  });

  it("create lobby → start → match.assigned → join token → launch → match end → results", async () => {
    const { server, controller, launches, session, reloadToMenu, push } = setup({ loggedIn: true });
    server.on("POST /v1/lobbies", (call) => ({ status: 201, body: { lobby: lobby({ settings: call.body as never }) } }));
    server.on("POST /v1/lobbies/ABCDEF/start", () => ({ body: { lobby: lobby({ status: "inMatch", matchId: "m_1" }) } }));
    let joins = 0;
    server.on("POST /v1/matches/m_1/join", () =>
      ++joins === 1
        ? { status: 409, body: { error: "conflict", message: "The match is still starting" } }
        : { body: { wsUrl: "ws://localhost:7400/m/m_1", joinToken: "J1", expiresAt: Date.now() + 120_000, matchId: "m_1", teamId: 0, reconnect: false } },
    );
    server.on("GET /v1/matches/m_1/result", () => ({ body: result() }));

    await controller.boot();
    expect(controller.state.screen.kind).toBe("main");
    await controller.createLobby({ mode: "squad", maxPlayers: 16, mapId: "v1", fillWithBots: true });
    expect(controller.state.screen.kind === "lobby" && controller.state.screen.lobby.settings.maxPlayers).toBe(16);

    await controller.startLobby();
    await vi.waitFor(() => expect(controller.state.screen).toEqual({ kind: "inGame", matchId: "m_1" }));
    expect(joins).toBe(2);
    expect(launches).toHaveLength(1);
    expect(launches[0]!.join.wsUrl).toBe("ws://localhost:7400/m/m_1");
    expect(launches[0]!.mapId).toBe("v1");
    expect((await launches[0]!.tokens()).token).toBe("J1");
    expect(session.getItem(LAST_MATCH_KEY)).toBe("m_1");

    FakeSocket.instances[0]!.serverOpen();
    await push({ t: "match.updated", match: match({ status: "ended" }) });
    expect(controller.state.screen.kind).toBe("results");
    await vi.waitFor(() => {
      const screen = controller.state.screen;
      expect(screen.kind === "results" && screen.result?.winningTeamId).toBe(0);
    });

    controller.closeResults();
    expect(reloadToMenu).toHaveBeenCalled();
    expect(session.getItem(LAST_MATCH_KEY)).toBeNull();
    controller.dispose();
  });

  it("game hand-off: the in-game result screen closes into the front-door results; leaving early reloads to the menu", async () => {
    const { server, controller, launches, reloadToMenu, session } = setup({ loggedIn: true });
    server.on("GET /v1/me/active-match", () => ({ body: active({ match: match({ matchId: "m_3" }) }) }));
    server.on("POST /v1/matches/m_3/join", () => ({ body: { wsUrl: "ws://localhost:7402/m/m_3", joinToken: "J3", expiresAt: Date.now() + 120_000, matchId: "m_3", teamId: 0, reconnect: true } }));
    server.on("GET /v1/matches/m_3/result", () => ({ body: result("m_3") }));
    await controller.boot();
    controller.rejoin();
    await vi.waitFor(() => expect(controller.state.screen).toEqual({ kind: "inGame", matchId: "m_3" }));
    expect(launches[0]!.onExit).toBeTypeOf("function");

    launches[0]!.onExit!({ matchId: "m_3", reason: "ended" });
    await vi.waitFor(() => {
      const screen = controller.state.screen;
      expect(screen.kind === "results" && screen.fromGame && !screen.awaitingGame && screen.result?.matchId).toBe("m_3");
    });
    expect(reloadToMenu).not.toHaveBeenCalled();
    launches[0]!.onExit!({ matchId: "m_3", reason: "left" });
    expect(reloadToMenu).toHaveBeenCalledTimes(1);
    // Quitting on purpose: the match keeps running for the others, but is never offered back after the reload.
    expect(session.getItem(LEFT_MATCH_KEY)).toBe("m_3");
    expect(controller.state.leftMatchId).toBe("m_3");
    controller.dispose();

    const back = setup({ loggedIn: true });
    back.server.on("GET /v1/me/active-match", () => ({ body: active({ match: match({ matchId: "m_3" }) }) }));
    (back.session as MemoryStorage).setItem(LEFT_MATCH_KEY, "m_3");
    await back.controller.boot();
    expect(back.controller.state.rejoin).toBeNull();
    back.controller.dispose();
  });

  it("offers rejoin on load when the API reports an active match, and rejoins with a fresh token", async () => {
    const { server, controller, launches } = setup({ loggedIn: true });
    server.on("GET /v1/me/active-match", () => ({ body: active({ match: match({ matchId: "m_7" }) }) }));
    server.on("POST /v1/matches/m_7/join", () => ({ body: { wsUrl: "ws://localhost:7401/m/m_7", joinToken: "J7", expiresAt: Date.now() + 120_000, matchId: "m_7", teamId: 1, reconnect: true } }));
    await controller.boot();
    expect(controller.state.rejoin?.matchId).toBe("m_7");
    controller.rejoin();
    await vi.waitFor(() => expect(controller.state.screen).toEqual({ kind: "inGame", matchId: "m_7" }));
    expect(launches[0]!.join.reconnect).toBe(true);
    controller.dispose();
  });

  it("abandoning the rejoin offer tells the API and drops the card for good", async () => {
    const { server, controller, session } = setup({ loggedIn: true });
    server.on("GET /v1/me/active-match", () => ({ body: active({ match: match({ matchId: "m_8" }) }) }));
    server.on("POST /v1/matches/m_8/leave", () => ({ body: { ok: true } }));
    await controller.boot();
    expect(controller.state.rejoin?.matchId).toBe("m_8");

    await controller.abandonRejoin();
    expect(server.paths()).toContain("POST /v1/matches/m_8/leave");
    expect(controller.state.rejoin).toBeNull();
    expect(controller.state.busy).toBe(false);
    // Survives the reload: the API still reports the match as running.
    expect(session.getItem(LEFT_MATCH_KEY)).toBe("m_8");
    expect(session.getItem(LAST_MATCH_KEY)).toBeNull();
    controller.dispose();
  });

  it("a match the API already forgot counts as abandoned; a real failure keeps the card", async () => {
    const { server, controller } = setup({ loggedIn: true });
    server.on("GET /v1/me/active-match", () => ({ body: active({ match: match({ matchId: "m_8" }) }) }));
    let gone = false;
    server.on("POST /v1/matches/m_8/leave", () => (gone ? { status: 404, body: { error: "notFound", message: "gone" } } : { status: 500, body: { error: "internal", message: "boom" } }));
    await controller.boot();

    await controller.abandonRejoin();
    expect(controller.state.rejoin?.matchId).toBe("m_8");
    expect(controller.state.notice).toBe("internal");

    gone = true;
    await controller.abandonRejoin();
    expect(controller.state.rejoin).toBeNull();
    controller.dispose();
  });

  it("a new match instead of the rejoin: abandon, then a fresh lobby with the same settings", async () => {
    const { server, controller } = setup({ loggedIn: true });
    server.on("GET /v1/me/active-match", () => ({ body: active({ match: match({ matchId: "m_8" }), lobbyCode: "ABCDEF" }) }));
    server.on("POST /v1/matches/m_8/leave", () => ({ body: { ok: true } }));
    server.on("POST /v1/lobbies", (call) => ({ status: 201, body: { lobby: lobby({ code: "NEWLBY", settings: call.body as never }) } }));
    await controller.boot();
    expect(controller.state.rejoin?.matchId).toBe("m_8");

    await controller.newMatchInsteadOfRejoin();
    // The old lobby is still busy with the abandoned match, so this opens a new one with the same settings.
    expect(server.paths()).toContain("POST /v1/matches/m_8/leave");
    expect(server.calls.find((c) => c.path === "/v1/lobbies")?.body).toMatchObject({ ...settings, visibility: "private" });
    expect(controller.state.screen).toMatchObject({ kind: "lobby", lobby: { code: "NEWLBY" } });
    expect(controller.state.rejoin).toBeNull();
    expect(controller.state.busy).toBe(false);
    controller.dispose();
  });

  it("a new match after quick play queues again instead of opening a lobby", async () => {
    const { server, controller } = setup({ loggedIn: true });
    server.on("GET /v1/me/active-match", () => ({ body: active({ match: match({ matchId: "m_9", source: "queue" }) }) }));
    server.on("POST /v1/matches/m_9/leave", () => ({ body: { ok: true } }));
    server.on("POST /v1/queue/tickets", () => ({ status: 201, body: { ticket: ticket({ id: "t_9" }) } }));
    await controller.boot();
    await controller.newMatchInsteadOfRejoin();
    expect(controller.state.screen).toMatchObject({ kind: "queue", ticket: { id: "t_9" } });
    controller.dispose();
  });

  it("play again from the results: back into the same lobby, or a new one when it is gone", async () => {
    const { server, controller, push } = setup({ loggedIn: true });
    server.on("POST /v1/lobbies", (call) => ({ status: 201, body: { lobby: lobby({ code: "NEWLBY", settings: call.body as never }) } }));
    server.on("GET /v1/matches/m_1/result", () => ({ body: result() }));
    let lobbyGone = false;
    server.on("POST /v1/lobbies/ABCDEF/join", () => (lobbyGone ? { status: 404, body: { error: "notFound", message: "gone" } } : { body: { lobby: lobby() } }));

    await controller.boot();
    controller.dispatch({ type: "lobbyEntered", lobby: lobby() });
    await push({ t: "lobby.updated", lobby: lobby({ status: "inMatch", matchId: "m_1" }) });
    controller.dispatch({ type: "gameLaunched", matchId: "m_1" });
    await push({ t: "match.updated", match: match({ status: "ended" }) });
    expect(controller.state.screen.kind).toBe("results");
    expect(controller.state.lastMatch).toMatchObject({ source: "lobby", lobbyCode: "ABCDEF" });

    // The lobby reopened when the match finished: rejoin it and keep the party.
    await controller.playAgain();
    expect(controller.state.screen).toMatchObject({ kind: "lobby", lobby: { code: "ABCDEF" } });
    expect(server.calls.some((c) => c.path === "/v1/lobbies/ABCDEF/join")).toBe(true);

    // Same flow with the lobby gone: a fresh one with the same settings.
    lobbyGone = true;
    controller.dispatch({ type: "lobbyLeft" });
    controller.dispatch({ type: "matchEnded", matchId: "m_1" });
    expect(controller.state.screen.kind).toBe("results");
    await controller.playAgain();
    expect(controller.state.screen).toMatchObject({ kind: "lobby", lobby: { code: "NEWLBY" } });
    expect(server.calls.find((c) => c.path === "/v1/lobbies")?.body).toMatchObject({ ...settings, visibility: "private" });
    controller.dispose();
  });

  it("play again after quick play queues again with the same settings", async () => {
    const { server, controller, push } = setup({ loggedIn: true });
    server.on("POST /v1/queue/tickets", (call) => ({ status: 201, body: { ticket: ticket({ id: "t_2", settings: { ...settings, ...(call.body as object) } as never }) } }));
    server.on("GET /v1/matches/m_2/result", () => ({ body: result("m_2") }));
    await controller.boot();
    controller.dispatch({ type: "queued", ticket: ticket() });
    await push({ t: "ticket.updated", ticket: ticket({ status: "matched", matchId: "m_2" }) });
    controller.dispatch({ type: "gameLaunched", matchId: "m_2" });
    controller.dispatch({ type: "matchEnded", matchId: "m_2" });
    expect(controller.state.screen.kind).toBe("results");

    await controller.playAgain();
    expect(controller.state.screen).toMatchObject({ kind: "queue", ticket: { id: "t_2" } });
    expect(server.calls.find((c) => c.path === "/v1/queue/tickets")?.body).toEqual({ mode: settings.mode, maxPlayers: settings.maxPlayers, mapId: settings.mapId });
    controller.dispose();
  });

  it("play again from the in-game results screen reloads into the menu after starting the next lobby", async () => {
    const { server, controller, launches, reloadToMenu } = setup({ loggedIn: true });
    server.on("GET /v1/me/active-match", () => ({ body: active({ match: match({ matchId: "m_5" }), lobbyCode: "ABCDEF" }) }));
    server.on("POST /v1/matches/m_5/join", () => ({ body: { wsUrl: "ws://localhost:7405/m/m_5", joinToken: "J5", expiresAt: Date.now() + 120_000, matchId: "m_5", teamId: 0, reconnect: true } }));
    server.on("GET /v1/matches/m_5/result", () => ({ body: result("m_5") }));
    server.on("POST /v1/lobbies/ABCDEF/join", () => ({ body: { lobby: lobby() } }));
    await controller.boot();
    controller.rejoin();
    await vi.waitFor(() => expect(controller.state.screen).toEqual({ kind: "inGame", matchId: "m_5" }));
    launches[0]!.onExit!({ matchId: "m_5", reason: "ended" });
    await vi.waitFor(() => expect(controller.state.screen.kind).toBe("results"));

    await controller.playAgain();
    // The game can't be torn down in place: the page reloads and the resync lands in the lobby.
    expect(reloadToMenu).toHaveBeenCalledTimes(1);
    expect(server.calls.some((c) => c.path === "/v1/lobbies/ABCDEF/join")).toBe(true);
    controller.dispose();
  });

  it("quick play: queue, cancel", async () => {
    const { server, controller } = setup({ loggedIn: true });
    server.on("POST /v1/queue/tickets", (call) => ({
      status: 201,
      body: { ticket: { id: "t_1", status: "queued", settings: { ...(call.body as object), mapId: "v1", fillWithBots: true }, createdAt: Date.now(), playersWaiting: 1, startsBy: Date.now() + 30_000, matchId: null } },
    }));
    server.on("DELETE /v1/queue/tickets/t_1", () => ({ body: { ok: true } }));
    await controller.boot();
    await controller.quickPlay("solo", 20);
    expect(controller.state.screen.kind).toBe("queue");
    expect(server.calls.find((c) => c.path === "/v1/queue/tickets")?.body).toEqual({ mode: "solo", maxPlayers: 20 });
    await controller.cancelQueue();
    expect(controller.state.screen).toEqual({ kind: "main", panel: "quickPlay" });
    controller.dispose();
  });

  it("an API that can't be reached still lands on login with a network notice", async () => {
    const { server, controller } = setup({ loggedIn: true });
    server.offline = true;
    await controller.boot();
    expect(controller.state.screen.kind).toBe("login");
    expect(controller.state.notice).toBe("network");
    controller.dispose();
  });
});
