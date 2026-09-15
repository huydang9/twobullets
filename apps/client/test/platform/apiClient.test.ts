import { PROTOCOL_HEADER } from "@twobullets/contracts/rest";
import { CONTENT_HASH, PROTOCOL_VERSION } from "@twobullets/protocol/version";
import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "../../src/platform/ApiClient";
import { apiSocketUrl, DEV_API_URL, resolveApiBaseUrl } from "../../src/platform/apiConfig";
import { ApiRequestError } from "../../src/platform/ApiRequestError";
import { createApiJoinTokenProvider } from "../../src/platform/joinToken";
import { ACCESS_KEY, REFRESH_KEY, SessionStore } from "../../src/platform/SessionStore";
import { ACCOUNT, auth, FakeServer, MemoryStorage } from "./fakes";

const BASE = "http://api.test";
const HOUR = 3600_000;

function setup(now = { value: 1_000_000 }) {
  const server = new FakeServer();
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const store = new SessionStore(session, local);
  const api = new ApiClient({ baseUrl: BASE, fetch: server.fetch, store, now: () => now.value });
  return { server, session, local, store, api, now };
}

describe("api config", () => {
  it("uses the build variable, else localhost:8080 in dev and the page origin in production", () => {
    expect(resolveApiBaseUrl({ DEV: true })).toBe(DEV_API_URL);
    expect(DEV_API_URL).toBe("http://localhost:8080");
    expect(resolveApiBaseUrl({ DEV: false })).toBe("");
    expect(resolveApiBaseUrl({ DEV: false, VITE_TB_API_URL: "https://play.example.com/" })).toBe("https://play.example.com");
    expect(resolveApiBaseUrl({ DEV: true, VITE_API_URL: "http://localhost:9000" })).toBe("http://localhost:9000");
    expect(apiSocketUrl("", "https://play.example.com")).toBe("wss://play.example.com/v1/ws");
    expect(apiSocketUrl("http://localhost:8080", "http://localhost:5173")).toBe("ws://localhost:8080/v1/ws");
  });
});

describe("ApiClient login and tokens", () => {
  it("logs in as a guest and stores the access token (session) and refresh secret (local)", async () => {
    const { server, api, session, local, now } = setup();
    server.on("POST /v1/auth/guest", (call) => ({ status: 201, body: { ...auth("A1", "R1", now.value + 12 * HOUR), account: { ...ACCOUNT, nickname: (call.body as { nickname: string }).nickname } } }));
    const response = await api.loginGuest({ nickname: "Huy", language: "vi" });
    expect(response.account.nickname).toBe("Huy");
    expect(server.calls[0]!.body).toEqual({ nickname: "Huy", language: "vi" });
    expect(JSON.parse(session.getItem(ACCESS_KEY)!).accessToken).toBe("A1");
    expect(local.getItem(REFRESH_KEY)).toBe("R1");
    expect(api.account?.nickname).toBe("Huy");

    // A reload of the tab restores the session from sessionStorage.
    const reloaded = new ApiClient({ baseUrl: BASE, fetch: server.fetch, store: new SessionStore(session, local), now: () => now.value });
    expect(reloaded.hasSession).toBe(true);
    expect(await reloaded.accessToken()).toBe("A1");
  });

  it("sends the bearer token and the protocol header on authenticated calls", async () => {
    const { server, api, store, now } = setup();
    store.save(auth("A1", "R1", now.value + HOUR));
    server.on("GET /v1/me/active-match", () => ({ body: { match: null, ticket: null, lobbyCode: null } }));
    await api.activeMatch();
    const headers = server.calls[0]!.headers;
    expect(headers.Authorization).toBe("Bearer A1");
    expect(headers[PROTOCOL_HEADER]).toBe(`${PROTOCOL_VERSION}.${CONTENT_HASH >>> 0}`);
  });

  it("refreshes a token that is about to expire before the call, once for parallel calls", async () => {
    const { server, api, store, local, now } = setup();
    store.save(auth("OLD", "R1", now.value + 30_000));
    let refreshes = 0;
    server.on("POST /v1/auth/refresh", (call) => {
      refreshes++;
      expect(call.body).toEqual({ refreshToken: "R1" });
      return { body: auth("NEW", "R2", now.value + 12 * HOUR) };
    });
    server.on("GET /v1/me/active-match", (call) => ({ body: { match: null, ticket: null, lobbyCode: call.headers.Authorization } }));
    const [a, b] = await Promise.all([api.activeMatch(), api.activeMatch()]);
    expect(refreshes).toBe(1);
    expect(a.lobbyCode).toBe("Bearer NEW");
    expect(b.lobbyCode).toBe("Bearer NEW");
    expect(local.getItem(REFRESH_KEY)).toBe("R2");
  });

  it("refreshes and retries once on a 401", async () => {
    const { server, api, store, now } = setup();
    store.save(auth("REVOKED", "R1", now.value + HOUR));
    server.on("POST /v1/auth/refresh", () => ({ body: auth("NEW", "R2", now.value + HOUR) }));
    server.on("GET /v1/me", (call) =>
      call.headers.Authorization === "Bearer NEW" ? { body: { account: ACCOUNT } } : { status: 401, body: { error: "unauthorized", message: "bad token" } },
    );
    expect((await api.me()).id).toBe(ACCOUNT.id);
    expect(server.paths()).toEqual(["GET /v1/me", "POST /v1/auth/refresh", "GET /v1/me"]);
  });

  it("ends the session when the refresh secret is rejected", async () => {
    const { server, api, store, local, now } = setup();
    store.save(auth("REVOKED", "R1", now.value + HOUR));
    const lost = vi.fn();
    api.onSessionLost(lost);
    server.on("POST /v1/auth/refresh", () => ({ status: 401, body: { error: "unauthorized", message: "unknown refresh token" } }));
    server.on("GET /v1/me", () => ({ status: 401, body: { error: "unauthorized", message: "bad token" } }));
    await expect(api.me()).rejects.toMatchObject({ code: "unauthorized" });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(api.hasSession).toBe(false);
    expect(local.getItem(REFRESH_KEY)).toBeNull();
  });

  it("uses a secret another tab rotated in the meantime", async () => {
    const { server, api, store, local, now } = setup();
    store.save(auth("OLD", "R1", now.value - 1));
    server.on("POST /v1/auth/refresh", (call) => {
      const secret = (call.body as { refreshToken: string }).refreshToken;
      if (secret === "R1") {
        local.setItem(REFRESH_KEY, "R2"); // the other tab won the race
        return { status: 401, body: { error: "unauthorized", message: "rotated" } };
      }
      return { body: auth("NEW", "R3", now.value + HOUR) };
    });
    expect(await api.accessToken()).toBe("NEW");
  });
});

describe("ApiClient errors", () => {
  it("426 reports upgradeRequired to listeners", async () => {
    const { server, api, store, now } = setup();
    store.save(auth("A1", "R1", now.value + HOUR));
    const upgrade = vi.fn();
    api.onUpgradeRequired(upgrade);
    server.on("POST /v1/lobbies", () => ({ status: 426, body: { error: "upgradeRequired", message: "reload" } }));
    const error = await api.createLobby({ mode: "duo", maxPlayers: 10, mapId: "v1", fillWithBots: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ code: "upgradeRequired", status: 426 });
    expect(upgrade).toHaveBeenCalledTimes(1);
  });

  it("maps API error bodies, rate limits and network failures to codes", async () => {
    const { server, api, store, now } = setup();
    store.save(auth("A1", "R1", now.value + HOUR));
    server.on("POST /v1/lobbies/ABCDEF/join", () => ({ status: 409, body: { error: "lobbyFull", message: "The lobby is full" } }));
    server.on("POST /v1/queue/tickets", () => ({ status: 429, body: { error: "rateLimited", message: "slow down", retryAfterSec: 7 } }));
    await expect(api.joinLobby("ABCDEF")).rejects.toMatchObject({ code: "lobbyFull", status: 409 });
    await expect(api.createTicket({ mode: "solo", maxPlayers: 10 })).rejects.toMatchObject({ code: "rateLimited", retryAfterSec: 7 });
    server.offline = true;
    await expect(api.catalog()).rejects.toMatchObject({ code: "network", status: 0 });
  });
});

describe("join token provider", () => {
  it("uses the connecting screen's token first, then fetches a fresh one per connect", async () => {
    const first = { wsUrl: "ws://localhost:7400/m/m_1", joinToken: "J1", expiresAt: 200_000, matchId: "m_1", teamId: 2, reconnect: false };
    const joinMatch = vi.fn(async (matchId: string) => ({ ...first, matchId, joinToken: "J2", reconnect: true }));
    const provider = createApiJoinTokenProvider({ joinMatch }, first, () => 100_000);
    expect(await provider()).toEqual({ token: "J1", matchId: "m_1", url: first.wsUrl, expiresAt: 200_000 });
    expect(joinMatch).not.toHaveBeenCalled();
    expect((await provider()).token).toBe("J2");
    expect(joinMatch).toHaveBeenCalledWith("m_1");
  });

  it("does not reuse a token about to expire", async () => {
    const first = { wsUrl: "ws://x/m/m_1", joinToken: "J1", expiresAt: 105_000, matchId: "m_1", teamId: 0, reconnect: false };
    const joinMatch = vi.fn(async () => ({ ...first, joinToken: "J2" }));
    expect((await createApiJoinTokenProvider({ joinMatch }, first, () => 100_000)()).token).toBe("J2");
  });
});
