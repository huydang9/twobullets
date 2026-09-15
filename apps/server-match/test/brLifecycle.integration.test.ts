import { DisconnectReason, MatchEndReason, PhaseCode } from "@twobullets/protocol";
import type { ZoneSpec } from "@twobullets/shared/match/types";
import type { HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import type { HeadlessClient } from "../src/dev/HeadlessClient";
import { createHarness, type Harness } from "./harness";

// Battle royale lifecycle on the arena (plan.md B1): phases, damage gates, zone schedule on the wire, zone damage, team
// eliminations, MatchEnd, results, cancel/abort and the time cap. Virtual clock, memory sessions.

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
});

/** One fast phase: announced 0.2 s into combat, shrinks to r 12 over 0.3 s, 25 HP/s outside. */
const FAST_ZONE: ZoneSpec = {
  initial: { cx: 0, cz: 0, r: 60 },
  phases: [{ waitSeconds: 0.2, shrinkSeconds: 0.3, radius: 12, dps: 25 }],
  firstAnnounceSeconds: 0.2,
  damageIntervalTicks: 6,
  edgeMargin: 4,
};

const stand = (c: HeadlessClient): void => {
  c.script = (_tick, e) => {
    e.forward = 0;
    e.right = 0;
    e.buttons = 0;
  };
};

function runUntil(h: Harness, done: () => boolean, maxMs: number): boolean {
  for (let t = 0; t < maxMs; t += 10) {
    if (done()) return true;
    h.run(10);
  }
  return done();
}

describe("BR lifecycle (arena)", () => {
  it("duo: warmup without damage → all joined → combat → zone wipes team 1 → MatchEnd, placements, result, close", async () => {
    const h = await createHarness(havok, {
      maxPlayers: 4,
      teamMode: "duo",
      configure: (c) => ({ ...c, teams: [{ teamId: 0, accountIds: ["a0", "a1"] }, { teamId: 1, accountIds: ["b0", "b1"] }] }),
      lifecycle: { warmupSeconds: 30, allJoinedSeconds: 0.5, endLingerSeconds: 0.5, zone: FAST_ZONE, zoneSalt: 99, nowEpochMs: () => 1_800_000_000_000 },
    });
    const lc = h.match.lifecycle!;
    expect(h.lifecyclePhases).toEqual(["Warmup"]);
    expect(h.match.combat!.damageEnabled).toBe(false);

    const a0 = h.connect({ token: h.token({ sub: "a0", team: 0 }) });
    h.run(300);
    expect(a0.welcome).toMatchObject({ phase: PhaseCode.Warmup });
    // First human in: a 30 s warmup is scheduled.
    expect(a0.phase).toMatchObject({ phase: PhaseCode.Warmup, teamsAlive: 1, playersAlive: 1 });
    expect(a0.phase!.endTick - lc.phaseStartTick).toBeGreaterThan(29 * 60);

    const others = ["a1", "b0", "b1"].map((sub, i) => h.connect({ token: h.token({ sub, team: i === 0 ? 0 : 1 }) }));
    const clients = [a0, ...others];
    clients.forEach(stand);
    h.run(200);
    expect(clients.every((c) => c.welcome !== null && c.disconnect === null)).toBe(true);
    // Everyone rostered is in: the countdown shortens to 0.5 s.
    expect(a0.phase!.phase).toBe(PhaseCode.Warmup);
    expect(a0.phase!.endTick - h.match.nextTick).toBeLessThanOrEqual(30);

    expect(runUntil(h, () => lc.phase === "Combat", 2000)).toBe(true);
    expect(h.lifecyclePhases).toEqual(["Warmup", "LandingSelect", "Glide", "Combat"]);
    expect(h.match.combat!.damageEnabled).toBe(true);
    expect(h.match.combat!.respawnEnabled).toBe(false);
    h.run(50);
    expect(a0.phases.map((p) => p.phase)).toEqual(expect.arrayContaining([PhaseCode.LandingSelect, PhaseCode.Glide, PhaseCode.Combat]));
    expect(a0.phase).toMatchObject({ phase: PhaseCode.Combat, endTick: 0, teamsAlive: 2, playersAlive: 4 });

    // A new account can't join after warmup.
    const late = h.connect({ token: h.token({ sub: "late", team: 0 }) });
    h.run(100);
    expect(late.disconnect?.reason).toBe(DisconnectReason.notAssigned);

    expect(runUntil(h, () => lc.zonePhases.length > 0, 1000)).toBe(true);
    h.run(50);
    const zone = lc.zonePhases[0]!;
    for (const c of clients) expect(c.zonePhases).toEqual([zone]);
    // Team 0 on the final circle's center, team 1 well outside it (toward the arena center).
    const { cx, cz } = zone.to;
    const len = Math.sqrt(cx * cx + cz * cz);
    const [ux, uz] = len > 1 ? [-cx / len, -cz / len] : [1, 0];
    const y = h.match.player(0)!.spawn.feet.y;
    h.match.debugPlace(0, { x: cx, y, z: cz });
    h.match.debugPlace(1, { x: cx + 1, y, z: cz });
    h.match.debugPlace(2, { x: cx + ux * 30, y, z: cz + uz * 30 });
    h.match.debugPlace(3, { x: cx + ux * 31, y, z: cz + uz * 31 });

    expect(runUntil(h, () => lc.phase === "End", 8000)).toBe(true);
    expect(lc.endReason).toBe("lastTeam");
    expect(lc.winnerTeam).toBe(0);
    expect(h.lifecyclePhases.at(-1)).toBe("Ended");
    h.run(50);
    for (const c of clients) {
      expect(c.matchEnd).toMatchObject({ reason: MatchEndReason.lastTeam, winningTeam: 0 });
      const places = new Map(c.matchEnd!.players.map((p) => [p.slot, p.placement]));
      expect([places.get(0), places.get(1), places.get(2), places.get(3)]).toEqual([1, 1, 2, 2]);
    }
    expect(h.results).toHaveLength(1);
    const result = h.results[0]!;
    expect(result).toMatchObject({ matchId: "local", outcome: "completed", winningTeamId: 0, startedAt: 1_800_000_000_000 });
    const byId = new Map(result.players.map((p) => [p.accountId, p]));
    expect(byId.get("a0")).toMatchObject({ teamId: 0, placement: 1, bot: false });
    expect(byId.get("b1")).toMatchObject({ teamId: 1, placement: 2 });
    expect(byId.get("b1")!.survivedMs).toBeGreaterThan(3000);
    expect(byId.get("a0")!.survivedMs).toBeGreaterThanOrEqual(byId.get("b1")!.survivedMs);

    // Inputs freeze, then the linger ends and everyone is disconnected with matchEnded.
    expect(runUntil(h, () => h.closed.value, 2000)).toBe(true);
    h.run(50);
    for (const c of clients) expect(c.disconnect?.reason).toBe(DisconnectReason.matchEnded);
    expect(h.results).toHaveLength(1);
    await h.dispose();
  }, 60_000);

  it("cancels a warmup nobody joins, and results list every rostered seat with bots flagged", async () => {
    const h = await createHarness(havok, {
      maxPlayers: 4,
      teamMode: "duo",
      configure: (c) => ({ ...c, teams: [{ teamId: 0, accountIds: ["human", "bot:0"] }, { teamId: 1, accountIds: ["bot:1", "bot:2"] }] }),
      lifecycle: { noHumansTimeoutMs: 2000 },
    });
    h.run(3200);
    expect(h.lifecyclePhases).toEqual(["Warmup", "Cancelled"]);
    expect(h.closed.value).toBe(true);
    expect(h.results).toHaveLength(1);
    expect(h.results[0]).toMatchObject({ outcome: "cancelled", winningTeamId: null });
    expect(h.results[0]!.players.map((p) => [p.accountId, p.bot, p.placement])).toEqual([
      ["human", false, 0],
      ["bot:0", true, 0],
      ["bot:1", true, 0],
      ["bot:2", true, 0],
    ]);
    await h.dispose();
  }, 30_000);

  it("solo: aborting in combat reports aborted with ranked placements; a time cap ends with the healthiest player first", async () => {
    const aborted = await createHarness(havok, { maxPlayers: 2, teamMode: "solo", lifecycle: { allJoinedSeconds: 0.2 } });
    const [p0, p1] = [aborted.connect(), aborted.connect()];
    [p0, p1].forEach(stand);
    expect(runUntil(aborted, () => aborted.match.lifecycle!.phase === "Combat", 2000)).toBe(true);
    aborted.run(100);
    aborted.match.abort(DisconnectReason.serverShutdown);
    aborted.run(50);
    expect(aborted.closed.value).toBe(true);
    expect(aborted.results[0]).toMatchObject({ outcome: "aborted", winningTeamId: null });
    expect(aborted.results[0]!.players.map((p) => p.placement).sort()).toEqual([1, 2]);
    expect(p0.matchEnd?.reason).toBe(MatchEndReason.aborted);
    expect(p1.disconnect?.reason).toBe(DisconnectReason.serverShutdown);
    await aborted.dispose();

    const capped = await createHarness(havok, { maxPlayers: 2, teamMode: "solo", lifecycle: { allJoinedSeconds: 0.2, timeCapSeconds: 0.5, endLingerSeconds: 0.1 } });
    const [q0, q1] = [capped.connect(), capped.connect()];
    [q0, q1].forEach(stand);
    expect(runUntil(capped, () => capped.match.lifecycle!.phase === "Combat", 2000)).toBe(true);
    const second = capped.match.player(1)!;
    second.vitals = { ...second.vitals, health: 40 };
    expect(runUntil(capped, () => capped.closed.value, 3000)).toBe(true);
    expect(capped.match.lifecycle!.endReason).toBe("timeCap");
    expect(capped.results[0]).toMatchObject({ outcome: "completed", winningTeamId: 0 });
    expect(q1.matchEnd).toMatchObject({ reason: MatchEndReason.timeCap, winningTeam: 0 });
    await capped.dispose();
  }, 30_000);
});
