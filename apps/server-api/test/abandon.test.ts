import { CONTENT_HASH, PROTOCOL_VERSION } from "@twobullets/protocol/version";
import { afterEach, describe, expect, it } from "vitest";
import { startTestApi, type TestApi } from "./helpers";

// Giving a running match up from the front door (docs/release/quit-match.md §3): the account's active-match pointer is
// freed so the menu stops offering "Vào lại trận" and a new match may start, while the match itself carries on.

let api: TestApi;
afterEach(async () => api?.close());

const BUILD = { "x-tb-protocol": `${PROTOCOL_VERSION}.${CONTENT_HASH >>> 0}` };

async function startedMatch() {
  const host = await api.guest("Host");
  const created = await api.call("POST", "/v1/lobbies", { token: host.accessToken, body: { mode: "duo", maxPlayers: 10, mapId: "v1", fillWithBots: true } });
  const code = created.body.lobby.code as string;
  const started = await api.call("POST", `/v1/lobbies/${code}/start`, { token: host.accessToken, headers: BUILD });
  expect(started.status).toBe(200);
  return { host, matchId: started.body.lobby.matchId as string };
}

describe("abandoning a running match", () => {
  it("frees the account: no rejoin offer, and a new match can start straight away", async () => {
    api = await startTestApi();
    const { host, matchId } = await startedMatch();
    expect((await api.call("GET", "/v1/me/active-match", { token: host.accessToken })).body.match.matchId).toBe(matchId);
    // While it is held, a new lobby is refused.
    expect((await api.call("POST", "/v1/lobbies", { token: host.accessToken, body: { mode: "solo", maxPlayers: 4, mapId: "v1", fillWithBots: true } })).status).toBe(409);

    const left = await api.call("POST", `/v1/matches/${matchId}/leave`, { token: host.accessToken });
    expect(left.status).toBe(200);
    expect(left.body).toEqual({ ok: true });
    expect((await api.call("GET", "/v1/me/active-match", { token: host.accessToken })).body.match).toBeNull();

    // The match itself is untouched: it is still running for the others.
    expect(api.allocator.allocated.some((c) => c.matchId === matchId)).toBe(true);
    const next = await api.call("POST", "/v1/lobbies", { token: host.accessToken, body: { mode: "solo", maxPlayers: 4, mapId: "v1", fillWithBots: true } });
    expect(next.status).toBe(201);
  });

  it("retires join tokens, is idempotent, and refuses matches this account was never in", async () => {
    api = await startTestApi();
    const { host, matchId } = await startedMatch();
    const before = await api.call("POST", `/v1/matches/${matchId}/join`, { token: host.accessToken });
    expect(before.status).toBe(200);

    await api.call("POST", `/v1/matches/${matchId}/leave`, { token: host.accessToken });
    // A token issued after abandoning carries a higher epoch, so the one the player still held is stale.
    const epochOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).epoch as number;
    const after = await api.call("POST", `/v1/matches/${matchId}/join`, { token: host.accessToken });
    expect(epochOf(after.body.joinToken)).toBeGreaterThan(epochOf(before.body.joinToken));

    // Twice is harmless; somebody else's match (or a made-up one) is not theirs to abandon.
    expect((await api.call("POST", `/v1/matches/${matchId}/leave`, { token: host.accessToken })).status).toBe(200);
    const stranger = await api.guest("Stranger");
    expect((await api.call("POST", `/v1/matches/${matchId}/leave`, { token: stranger.accessToken })).status).toBe(404);
    expect((await api.call("POST", "/v1/matches/m_nope/leave", { token: host.accessToken })).status).toBe(404);
    expect((await api.call("POST", `/v1/matches/${matchId}/leave`)).status).toBe(401);
  });
});
