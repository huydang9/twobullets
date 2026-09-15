import { ACCESS_TOKEN_TTL_SEC } from "@twobullets/contracts/claims";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeNickname } from "../src/accounts/accounts";
import { startTestApi, type TestApi } from "./helpers";

let api: TestApi;
afterEach(async () => api?.close());

describe("guest auth", () => {
  it("creates a guest from a nickname and serves /v1/me with the access token", async () => {
    api = await startTestApi();
    const auth = await api.guest("Huy Đặng");
    expect(auth.account).toMatchObject({ nickname: "Huy Đặng", language: "vi" });
    expect(auth.account.id).toMatch(/^g_[0-9A-Z]{26}$/);
    expect(auth.account.tag).toMatch(/^\d{4}$/);
    expect(auth.expiresAt).toBe(api.clock.now + ACCESS_TOKEN_TTL_SEC * 1000);
    const me = await api.call("GET", "/v1/me", { token: auth.accessToken });
    expect(me.status).toBe(200);
    expect(me.body.account.id).toBe(auth.account.id);
  });

  it("validates nicknames (Vietnamese letters allowed, symbols and bad lengths rejected)", async () => {
    expect(normalizeNickname("  Trần   Minh ")).toBe("Trần Minh");
    expect(normalizeNickname("ab")).toBeNull();
    expect(normalizeNickname("a".repeat(17))).toBeNull();
    expect(normalizeNickname("<script>")).toBeNull();
    expect(normalizeNickname(42)).toBeNull();
    api = await startTestApi();
    const res = await api.call("POST", "/v1/auth/guest", { body: { nickname: "x" } });
    expect(res).toMatchObject({ status: 400, body: { error: "nicknameInvalid" } });
  });

  it("rejects missing, garbage, expired and wrong-audience tokens", async () => {
    api = await startTestApi();
    const auth = await api.guest("Tester");
    expect((await api.call("GET", "/v1/me")).status).toBe(401);
    expect((await api.call("GET", "/v1/me", { token: "a.b.c" })).status).toBe(401);
    // A join token (aud "match") must not work as an API token.
    const join = api.app.tokens.issueJoin({ accountId: auth.account.id, matchId: "m", hostId: "h", teamId: 0, epoch: 0, reconnect: false });
    expect((await api.call("GET", "/v1/me", { token: join.token })).status).toBe(401);
    api.clock.now += (ACCESS_TOKEN_TTL_SEC + 10) * 1000;
    expect((await api.call("GET", "/v1/me", { token: auth.accessToken })).status).toBe(401);
  });

  it("refresh rotates the secret and keeps the same account", async () => {
    api = await startTestApi();
    const auth = await api.guest("Refresher");
    const r1 = await api.call("POST", "/v1/auth/refresh", { body: { refreshToken: auth.refreshToken } });
    expect(r1.status).toBe(200);
    expect(r1.body.account.id).toBe(auth.account.id);
    expect(r1.body.refreshToken).not.toBe(auth.refreshToken);
    expect((await api.call("POST", "/v1/auth/refresh", { body: { refreshToken: auth.refreshToken } })).status).toBe(401);
    expect((await api.call("POST", "/v1/auth/refresh", { body: { refreshToken: r1.body.refreshToken } })).status).toBe(200);
  });

  it("enforces the invite code when configured", async () => {
    api = await startTestApi({ inviteCode: "friends-2026" });
    expect((await api.call("GET", "/v1/catalog")).body.inviteRequired).toBe(true);
    expect(await api.call("POST", "/v1/auth/guest", { body: { nickname: "Nope" } })).toMatchObject({ status: 403, body: { error: "inviteRequired" } });
    expect((await api.call("POST", "/v1/auth/guest", { body: { nickname: "Friend", inviteCode: "friends-2026" } })).status).toBe(201);
  });

  it("rate limits login per IP", async () => {
    api = await startTestApi({ rateAuthPerMin: 3 });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await api.call("POST", "/v1/auth/guest", { body: { nickname: `Player${i}` } })).status);
    expect(codes).toEqual([201, 201, 201, 429, 429]);
  });

  it("updates nickname and language, and rejects oversized or non-JSON bodies", async () => {
    api = await startTestApi();
    const auth = await api.guest("Before");
    const res = await api.call("PATCH", "/v1/me", { token: auth.accessToken, body: { nickname: "After", language: "en" } });
    expect(res.body.account).toMatchObject({ nickname: "After", language: "en" });
    const big = await api.call("PATCH", "/v1/me", { token: auth.accessToken, body: { nickname: "x".repeat(20_000) } });
    expect(big.status).toBe(400);
    const notJson = await fetch(`${api.base}/v1/auth/guest`, { method: "POST", headers: { "content-type": "text/plain" }, body: "nickname=hi" });
    expect(notJson.status).toBe(400);
  });

  it("serves health, version, catalog and private metrics", async () => {
    api = await startTestApi();
    expect((await api.call("GET", "/healthz")).body.ok).toBe(true);
    expect((await api.call("GET", "/readyz")).body.checks).toEqual({ db: true, keys: true });
    const catalog = (await api.call("GET", "/v1/catalog")).body;
    expect(catalog).toMatchObject({ minPlayers: 2, maxPlayers: 20, defaultMode: "duo", defaultMapId: "v1", defaultLanguage: "vi" });
    expect(catalog.modes.map((m: { mode: string }) => m.mode)).toEqual(["solo", "duo", "squad"]);
    expect((await api.call("GET", "/metrics")).status).toBe(403);
    const metrics = await api.call("GET", "/metrics", { token: "metrics-secret" });
    expect(metrics.status).toBe(200);
    expect(metrics.body).toContain("tb_http_requests_total");
  });
});
