import type { MatchResult } from "@twobullets/contracts/match";
import { CONTENT_HASH, PROTOCOL_VERSION } from "@twobullets/protocol/version";
import { afterEach, describe, expect, it } from "vitest";
import { startTestApi, type TestApi } from "./helpers";

let api: TestApi;
afterEach(async () => api?.close());

async function lobbyWith(host: string, settings: Record<string, unknown>) {
  const a = await api.guest(host);
  const res = await api.call("POST", "/v1/lobbies", { token: a.accessToken, body: settings });
  expect(res.status).toBe(201);
  return { auth: a, code: res.body.lobby.code as string, lobby: res.body.lobby };
}

describe("custom lobbies", () => {
  it("create → join by code → pick teams → start allocates a roster with bots → join tokens → result → lobby reopens", async () => {
    api = await startTestApi();
    const { auth: host, code, lobby } = await lobbyWith("Host", { mode: "squad", maxPlayers: 10, mapId: "v1", fillWithBots: true });
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    expect(lobby).toMatchObject({ status: "open", teamCount: 3, teamSize: 4, botSlots: 9, visibility: "private" });

    const friend = await api.guest("Friend");
    const joined = await api.call("POST", `/v1/lobbies/${code.toLowerCase()}/join`, { token: friend.accessToken, body: { teamId: 2 } });
    expect(joined.status).toBe(200);
    expect(joined.body.lobby.members.find((m: { accountId: string }) => m.accountId === friend.account.id).teamId).toBe(2);
    expect(api.push.of(host.account.id, "lobby.updated")).toHaveLength(1);

    // Only the host starts; the friend moves to the host's team first.
    expect((await api.call("POST", `/v1/lobbies/${code}/start`, { token: friend.accessToken })).status).toBe(403);
    await api.call("POST", `/v1/lobbies/${code}/team`, { token: friend.accessToken, body: { teamId: 0 } });
    const started = await api.call("POST", `/v1/lobbies/${code}/start`, { token: host.accessToken, headers: { "x-tb-protocol": `${PROTOCOL_VERSION}.${CONTENT_HASH >>> 0}` } });
    expect(started.status).toBe(200);
    expect(started.body.lobby.status).toBe("inMatch");
    const matchId = started.body.lobby.matchId as string;

    const config = api.allocator.allocated[0]!;
    expect(config).toMatchObject({ matchId, hostId: "sg-test", mapId: "v1", maxPlayers: 10, maxTeamSize: 4, teamMode: "squad", protocolVersion: PROTOCOL_VERSION });
    expect(config.rules).toEqual({ friendlyFire: true, reviveSeconds: 5, bodyBlocking: true, fillWithBots: true });
    expect(config.teams.map((t) => t.accountIds.length)).toEqual([4, 4, 2]);
    expect(config.teams[0]!.accountIds.slice(0, 2).sort()).toEqual([host.account.id, friend.account.id].sort());
    expect(config.teams.flatMap((t) => t.accountIds).filter((id) => id.startsWith("bot:"))).toHaveLength(8);
    expect(api.push.of(friend.account.id, "match.assigned")).toHaveLength(1);

    // Join tokens: first join, then a reconnect with a higher epoch.
    const j1 = await api.call("POST", `/v1/matches/${matchId}/join`, { token: friend.accessToken });
    expect(j1.body).toMatchObject({ matchId, teamId: 0, reconnect: false, wsUrl: `ws://fake.local/m/${matchId}` });
    const j2 = await api.call("POST", `/v1/matches/${matchId}/join`, { token: friend.accessToken });
    expect(j2.body.reconnect).toBe(true);
    const claims = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString());
    expect(claims(j2.body.joinToken).epoch).toBe(claims(j1.body.joinToken).epoch + 1);
    const stranger = await api.guest("Stranger");
    expect((await api.call("POST", `/v1/matches/${matchId}/join`, { token: stranger.accessToken })).status).toBe(404);

    const active = await api.call("GET", "/v1/me/active-match", { token: host.accessToken });
    expect(active.body).toMatchObject({ match: { matchId, status: "running", teamId: 0 }, lobbyCode: code, ticket: null });
    // In a match: can't queue.
    expect((await api.call("POST", "/v1/queue/tickets", { token: host.accessToken, body: { mode: "solo", maxPlayers: 10 } })).status).toBe(409);

    api.allocator.phase(matchId, "Combat");
    const result: MatchResult = {
      matchId,
      protocolVersion: PROTOCOL_VERSION,
      contentHash: CONTENT_HASH,
      outcome: "completed",
      startedAt: api.clock.now,
      endedAt: api.clock.now + 600_000,
      winningTeamId: 0,
      players: [
        { accountId: host.account.id, teamId: 0, bot: false, placement: 1, kills: 3, knocks: 4, revives: 1, damageDealt: 420.4, survivedMs: 600_000 },
        { accountId: friend.account.id, teamId: 0, bot: false, placement: 1, kills: 1, knocks: 1, revives: 0, damageDealt: 120, survivedMs: 500_000 },
        { accountId: "bot:4", teamId: 1, bot: true, placement: 2, kills: 0, knocks: 0, revives: 0, damageDealt: 10, survivedMs: 300_000 },
      ],
    };
    api.allocator.result(result);
    api.allocator.exit(matchId, 0);

    const res = await api.call("GET", `/v1/matches/${matchId}/result`, { token: friend.accessToken });
    expect(res.body).toMatchObject({ outcome: "completed", winningTeamId: 0, settings: { mode: "squad", maxPlayers: 10 } });
    const names = res.body.participants.map((p: { nickname: string }) => p.nickname);
    expect(names.slice(0, 2).sort()).toEqual(["Friend", "Host"]);
    expect(names[2]).toBe("Bot 4");
    expect(res.body.participants.find((p: { nickname: string }) => p.nickname === "Host").damageDealt).toBe(420);
    const history = await api.call("GET", "/v1/me/matches", { token: host.accessToken });
    expect(history.body.matches).toEqual([expect.objectContaining({ matchId, placement: 1, kills: 3, teamCount: 2 })]);

    const after = await api.call("GET", `/v1/lobbies/${code}`, { token: host.accessToken });
    expect(after.body.lobby).toMatchObject({ status: "open", matchId: null });
    expect((await api.call("GET", "/v1/me/active-match", { token: host.accessToken })).body.match).toBeNull();
    expect((await api.call("POST", `/v1/matches/${matchId}/join`, { token: host.accessToken })).status).toBe(409);
  });

  it("rejects bad settings, unavailable maps, full teams and a full lobby", async () => {
    api = await startTestApi();
    const host = await api.guest("Host");
    for (const body of [{ mode: "trio" }, { maxPlayers: 21 }, { maxPlayers: 1 }, { mapId: "vn-hoian" }, { fillWithBots: "yes" }]) {
      expect((await api.call("POST", "/v1/lobbies", { token: host.accessToken, body })).status).toBe(400);
    }
    const { code } = await lobbyWith("Host2", { mode: "duo", maxPlayers: 3, mapId: "arena", fillWithBots: false });
    const b = await api.guest("Bravo");
    const c = await api.guest("Charlie");
    const d = await api.guest("Delta");
    expect((await api.call("POST", `/v1/lobbies/${code}/join`, { token: b.accessToken, body: { teamId: 1 } })).body.lobby.members).toHaveLength(2);
    // Team 1 is partial (3 players in duos = 2 + 1) and already full.
    expect((await api.call("POST", `/v1/lobbies/${code}/team`, { token: b.accessToken, body: { teamId: 7 } })).status).toBe(400);
    expect((await api.call("POST", `/v1/lobbies/${code}/join`, { token: c.accessToken, body: { teamId: 1 } })).body.lobby.members.find((m: { accountId: string }) => m.accountId === c.account.id).teamId).toBe(0);
    expect(await api.call("POST", `/v1/lobbies/${code}/join`, { token: d.accessToken })).toMatchObject({ status: 409, body: { error: "lobbyFull" } });
  });

  it("host settings change re-seats players; host leaving hands over; last member leaving closes", async () => {
    api = await startTestApi();
    const { auth: host, code } = await lobbyWith("Host", { mode: "duo", maxPlayers: 10, visibility: "public" });
    const b = await api.guest("Bravo");
    await api.call("POST", `/v1/lobbies/${code}/join`, { token: b.accessToken, body: { teamId: 4 } });
    expect((await api.call("GET", "/v1/lobbies", { token: b.accessToken })).body.lobbies.map((l: { code: string }) => l.code)).toEqual([code]);
    expect((await api.call("PATCH", `/v1/lobbies/${code}`, { token: b.accessToken, body: { mode: "solo" } })).status).toBe(403);
    const changed = await api.call("PATCH", `/v1/lobbies/${code}`, { token: host.accessToken, body: { mode: "squad", maxPlayers: 4 } });
    expect(changed.body.lobby).toMatchObject({ teamCount: 1, teamSize: 4 });
    expect(changed.body.lobby.members.map((m: { teamId: number }) => m.teamId)).toEqual([0, 0]);
    expect((await api.call("PATCH", `/v1/lobbies/${code}`, { token: host.accessToken, body: { maxPlayers: 1 } })).status).toBe(400);

    await api.call("POST", `/v1/lobbies/${code}/leave`, { token: host.accessToken });
    const view = await api.call("GET", `/v1/lobbies/${code}`, { token: b.accessToken });
    expect(view.body.lobby.members).toEqual([expect.objectContaining({ accountId: b.account.id, host: true })]);
    await api.call("POST", `/v1/lobbies/${code}/leave`, { token: b.accessToken });
    expect((await api.call("GET", `/v1/lobbies/${code}`, { token: b.accessToken })).status).toBe(404);
  });

  it("lobby botDifficulty: create, update, validation, view, and MatchConfig.botDifficulty at allocate", async () => {
    api = await startTestApi();
    const { auth: host, code, lobby } = await lobbyWith("Host", { mode: "duo", maxPlayers: 6, botDifficulty: "easy" });
    expect(lobby.settings).toMatchObject({ botDifficulty: "easy" });
    expect((await api.call("POST", "/v1/lobbies", { token: (await api.guest("Other")).accessToken, body: { botDifficulty: "brutal" } })).status).toBe(400);
    expect((await api.call("PATCH", `/v1/lobbies/${code}`, { token: host.accessToken, body: { botDifficulty: "brutal" } })).status).toBe(400);
    const patched = await api.call("PATCH", `/v1/lobbies/${code}`, { token: host.accessToken, body: { maxPlayers: 8 } });
    expect(patched.body.lobby.settings).toMatchObject({ maxPlayers: 8, botDifficulty: "easy" });
    const hard = await api.call("PATCH", `/v1/lobbies/${code}`, { token: host.accessToken, body: { botDifficulty: "hard" } });
    expect(hard.body.lobby.settings.botDifficulty).toBe("hard");
    const started = await api.call("POST", `/v1/lobbies/${code}/start`, { token: host.accessToken });
    expect(started.body.lobby.status).toBe("inMatch");
    expect(api.allocator.allocated.at(-1)).toMatchObject({ maxPlayers: 8, botDifficulty: "hard" });
    // The join token carries the nickname for the match roster.
    const join = await api.call("POST", `/v1/matches/${started.body.lobby.matchId}/join`, { token: host.accessToken });
    expect(JSON.parse(Buffer.from(join.body.joinToken.split(".")[1], "base64url").toString()).nick).toBe("Host");

    const { auth: other, code: plainCode } = await lobbyWith("Plain", { mode: "solo", maxPlayers: 4 });
    await api.call("POST", `/v1/lobbies/${plainCode}/start`, { token: other.accessToken });
    expect(api.allocator.allocated.at(-1)!.botDifficulty).toBeUndefined();
  });

  it("without bots, start needs two teams; a failed allocation reopens the lobby with noCapacity", async () => {
    api = await startTestApi();
    const { auth: host, code } = await lobbyWith("Host", { mode: "solo", maxPlayers: 4, fillWithBots: false });
    expect((await api.call("POST", `/v1/lobbies/${code}/start`, { token: host.accessToken })).status).toBe(409);
    const b = await api.guest("Bravo");
    await api.call("POST", `/v1/lobbies/${code}/join`, { token: b.accessToken });
    api.allocator.failNext = "noCapacity";
    const failed = await api.call("POST", `/v1/lobbies/${code}/start`, { token: host.accessToken });
    expect(failed).toMatchObject({ status: 503, body: { error: "noCapacity", retryAfterSec: 30 } });
    expect((await api.call("GET", `/v1/lobbies/${code}`, { token: host.accessToken })).body.lobby.status).toBe("open");
    expect(api.push.of(b.account.id, "match.failed")).toHaveLength(1);
    const ok = await api.call("POST", `/v1/lobbies/${code}/start`, { token: host.accessToken });
    expect(ok.body.lobby.status).toBe("inMatch");
    expect(api.allocator.allocated.at(-1)!.teams).toEqual([
      { teamId: 0, accountIds: [host.account.id] },
      { teamId: 1, accountIds: [b.account.id] },
    ]);
  });

  it("a crashed match process is recorded as aborted and frees the players", async () => {
    api = await startTestApi();
    const { auth: host, code } = await lobbyWith("Host", { mode: "duo", maxPlayers: 6 });
    const started = await api.call("POST", `/v1/lobbies/${code}/start`, { token: host.accessToken });
    const matchId = started.body.lobby.matchId;
    api.allocator.exit(matchId, 137, "signal SIGKILL");
    expect((await api.call("GET", `/v1/matches/${matchId}/result`, { token: host.accessToken })).body).toMatchObject({ outcome: "aborted", participants: [] });
    expect((await api.call("GET", "/v1/me/active-match", { token: host.accessToken })).body.match).toBeNull();
    expect(api.push.of(host.account.id, "match.updated").at(-1)).toMatchObject({ match: { status: "aborted" } });
  });

  it("answers 426 to a client built for another protocol", async () => {
    api = await startTestApi();
    const host = await api.guest("Old client");
    const res = await api.call("POST", "/v1/lobbies", { token: host.accessToken, body: {}, headers: { "x-tb-protocol": `${PROTOCOL_VERSION - 1}.1` } });
    expect(res).toMatchObject({ status: 426, body: { error: "upgradeRequired" } });
  });
});
