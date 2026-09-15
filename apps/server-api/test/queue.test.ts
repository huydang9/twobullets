import { afterEach, describe, expect, it } from "vitest";
import { startTestApi, type TestApi } from "./helpers";

let api: TestApi;
afterEach(async () => api?.close());

describe("quick queue", () => {
  it("starts at once when a bucket holds a full match of humans, seated fill-style", async () => {
    api = await startTestApi();
    const players = await Promise.all(["Ann", "Ben", "Cat", "Dan"].map((n) => api.guest(n)));
    const tickets = [];
    for (const p of players) tickets.push((await api.call("POST", "/v1/queue/tickets", { token: p.accessToken, body: { mode: "duo", maxPlayers: 4, mapId: "v1" } })).body.ticket);
    expect(tickets[3]).toMatchObject({ status: "queued", playersWaiting: 4, startsBy: api.clock.now + 30_000 });

    expect(await api.app.queue.tick()).toBe(1);
    const config = api.allocator.allocated[0]!;
    expect(config.teams).toEqual([
      { teamId: 0, accountIds: [players[0]!.account.id, players[1]!.account.id] },
      { teamId: 1, accountIds: [players[2]!.account.id, players[3]!.account.id] },
    ]);
    const t = await api.call("GET", `/v1/queue/tickets/${tickets[0].id}`, { token: players[0]!.accessToken });
    expect(t.body.ticket).toMatchObject({ status: "matched", matchId: config.matchId, startsBy: null });
    const join = await api.call("POST", `/v1/matches/${config.matchId}/join`, { token: players[3]!.accessToken });
    expect(join.body.teamId).toBe(1);
  });

  it("waits, then starts with bots after startAfterSec; buckets don't mix", async () => {
    api = await startTestApi();
    const a = await api.guest("Solo A");
    const b = await api.guest("Solo B");
    const squad = await api.guest("Squad C");
    await api.call("POST", "/v1/queue/tickets", { token: a.accessToken, body: { mode: "solo", maxPlayers: 10 } });
    api.clock.now += 10_000;
    await api.call("POST", "/v1/queue/tickets", { token: b.accessToken, body: { mode: "solo", maxPlayers: 10 } });
    await api.call("POST", "/v1/queue/tickets", { token: squad.accessToken, body: { mode: "squad", maxPlayers: 20 } });

    api.clock.now += 19_000;
    expect(await api.app.queue.tick()).toBe(0);
    api.clock.now += 1_000; // oldest solo ticket has waited 30 s
    expect(await api.app.queue.tick()).toBe(1);
    const config = api.allocator.allocated[0]!;
    expect(config).toMatchObject({ maxPlayers: 10, teamMode: "solo", maxTeamSize: 1, mapId: "v1" });
    expect(config.rules.fillWithBots).toBe(true);
    expect(config.teams).toHaveLength(10);
    expect(config.teams.slice(0, 2).map((t) => t.accountIds[0])).toEqual([a.account.id, b.account.id]);
    expect(config.teams.slice(2).every((t) => t.accountIds[0]!.startsWith("bot:"))).toBe(true);

    const active = await api.call("GET", "/v1/me/active-match", { token: squad.accessToken });
    expect(active.body).toMatchObject({ match: null, ticket: { status: "queued", settings: { mode: "squad", maxPlayers: 20 } } });
  });

  it("cancel removes the ticket; duplicates and conflicting states are refused", async () => {
    api = await startTestApi();
    const a = await api.guest("Ann");
    const t1 = (await api.call("POST", "/v1/queue/tickets", { token: a.accessToken, body: { mode: "duo", maxPlayers: 10 } })).body.ticket;
    const again = await api.call("POST", "/v1/queue/tickets", { token: a.accessToken, body: { mode: "duo", maxPlayers: 10 } });
    expect(again.body.ticket.id).toBe(t1.id);
    expect((await api.call("POST", "/v1/queue/tickets", { token: a.accessToken, body: { mode: "solo", maxPlayers: 10 } })).status).toBe(409);
    expect((await api.call("POST", "/v1/lobbies", { token: a.accessToken, body: {} })).status).toBe(409);
    expect((await api.call("POST", "/v1/queue/tickets", { token: a.accessToken, body: { mode: "duo", maxPlayers: 30 } })).status).toBe(400);

    const other = await api.guest("Other");
    expect((await api.call("DELETE", `/v1/queue/tickets/${t1.id}`, { token: other.accessToken })).status).toBe(404);
    expect((await api.call("DELETE", `/v1/queue/tickets/${t1.id}`, { token: a.accessToken })).status).toBe(200);
    api.clock.now += 60_000;
    expect(await api.app.queue.tick()).toBe(0);
    expect(api.allocator.allocated).toHaveLength(0);
  });

  it("keeps tickets queued with a failure code when allocation fails, and retries on the next tick", async () => {
    api = await startTestApi({ queue: { startAfterSec: 0, minHumans: 1, tickMs: 1000 } });
    const a = await api.guest("Ann");
    const t = (await api.call("POST", "/v1/queue/tickets", { token: a.accessToken, body: { mode: "solo", maxPlayers: 2 } })).body.ticket;
    api.allocator.failNext = "timeout";
    await api.app.queue.tick();
    expect((await api.call("GET", `/v1/queue/tickets/${t.id}`, { token: a.accessToken })).body.ticket).toMatchObject({ status: "queued", failure: "internal" });
    await api.app.queue.tick();
    expect((await api.call("GET", `/v1/queue/tickets/${t.id}`, { token: a.accessToken })).body.ticket.status).toBe("matched");
  });
});
