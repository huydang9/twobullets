import { MatchEndReason, PhaseCode } from "@twobullets/protocol";
import type { HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import type { HeadlessClient } from "../src/dev/HeadlessClient";
import { resolveServerLevel } from "../src/level/serverLevel";
import { createHarness, type Harness } from "./harness";

// plan.md B6: server bots in the roster's `bot:<n>` seats play through the human path (input buffer → stepPlayer with
// weapons → ServerProjectiles → ServerCombat) on built maps. Virtual clock; tick work is measured in real time.

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
});

const stand = (c: HeadlessClient): void => {
  c.script = (_tick, e) => {
    e.forward = 0;
    e.right = 0;
    e.buttons = 0;
  };
};

function runUntil(h: Harness, done: () => boolean, maxMs: number, stepMs = 4): boolean {
  for (let t = 0; t < maxMs; t += 20) {
    if (done()) return true;
    h.run(20, stepMs);
  }
  return done();
}

/** Real-time work of every `match.tick` call. */
function timeTicks(h: Harness): number[] {
  const samples: number[] = [];
  const match = h.match;
  const tick = match.tick.bind(match);
  match.tick = (t: number) => {
    const t0 = performance.now();
    tick(t);
    samples.push(performance.now() - t0);
  };
  return samples;
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

describe("server bots", () => {
  it("Map v1 squads: 1 human + 19 bots join, move, shoot, and the match reaches MatchEnd on a scaled zone", async () => {
    const level = await resolveServerLevel("v1");
    const bot = (n: number) => `bot:${n}`;
    const teams = [{ teamId: 0, accountIds: ["human", bot(0), bot(1), bot(2)] }];
    for (let t = 1; t < 5; t++) teams.push({ teamId: t, accountIds: [0, 1, 2, 3].map((m) => bot(3 + (t - 1) * 4 + m)) });
    const h = await createHarness(havok, {
      level,
      maxPlayers: 20,
      teamMode: "squad",
      configure: (c) => ({ ...c, mapId: "v1", teams, botDifficulty: "hard" }),
      lifecycle: { warmupSeconds: 30, allJoinedSeconds: 0.5, timeScale: 0.08, endLingerSeconds: 0.5, zoneSalt: 11 },
    });
    const match = h.match;
    const lc = match.lifecycle!;
    const bots = match.bots!;
    expect(bots.count).toBe(19);
    expect(bots.difficulty).toBe("hard");
    expect(match.navInfo?.kind).toBe("grid");
    expect(match.players.map((p) => p.slot)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
    expect(match.players.every((p) => p.bot !== null && p.session === null)).toBe(true);

    const human = h.connect({ token: h.token({ sub: "human", team: 0 }) });
    stand(human);
    let maxEntities = 0;
    human.onSnapshot = (s) => {
      if (s.entities.length > maxEntities) maxEntities = s.entities.length;
    };
    expect(runUntil(h, () => lc.phase === "Combat", 5000)).toBe(true);
    expect(human.welcome).toMatchObject({ playerSlot: 0, teamId: 0, teamSize: 4, maxPlayers: 20 });
    // Bots stand still through warmup, landing and glide.
    const starts = new Map(match.players.map((p) => [p.slot, { x: p.feet.x, z: p.feet.z }]));
    h.run(100, 4);
    expect(human.phase).toMatchObject({ phase: PhaseCode.Combat, teamsAlive: 5, playersAlive: 20 });

    const samples = timeTicks(h);
    h.run(8000, 4);
    let moved = 0;
    for (const p of match.players) {
      const s = starts.get(p.slot)!;
      if (p.bot !== null && Math.sqrt((p.feet.x - s.x) ** 2 + (p.feet.z - s.z) ** 2) > 3) moved++;
    }
    expect(moved).toBeGreaterThanOrEqual(15);
    expect(bots.stats.inputs).toBeGreaterThan(19 * 400);
    // Every bot input went through its buffer as a real (non-synthetic) input.
    const botPlayer = match.players.find((p) => p.bot !== null && p.life !== "dead")!;
    expect(botPlayer.inputs.stats.consumed).toBeGreaterThan(400);
    expect(maxEntities).toBeGreaterThanOrEqual(19);
    const alive = [...samples].sort((a, b) => a - b);

    // Bring two squads face to face so the fight is certain: team 2 on team 1's start, 25 m east.
    const t1 = match.players.filter((p) => p.teamId === 1 && p.life !== "dead");
    const t2 = match.players.filter((p) => p.teamId === 2 && p.life !== "dead");
    const anchor = level.planTeamSpawns(match.config.matchSeed, 5, 4)[1]!.feet[0]!;
    t1.forEach((p, i) => match.debugPlace(p.slot, { x: anchor.x + i, y: level.heightAt!(anchor.x + i, anchor.z) + 0.05, z: anchor.z }));
    t2.forEach((p, i) => match.debugPlace(p.slot, { x: anchor.x + 25 + i, y: level.heightAt!(anchor.x + 25 + i, anchor.z + 2) + 0.05, z: anchor.z + 2 }));

    expect(runUntil(h, () => lc.phase === "End", 120_000)).toBe(true);
    const combat = match.combat!.stats;
    const sorted = [...samples].sort((a, b) => a - b);
    const line =
      `[bots] v1 1+19 squads: nav ${match.navInfo!.buildMs.toFixed(0)} ms; first 8 s of combat (all alive, ${alive.length} ticks) tick p50 ${percentile(alive, 0.5).toFixed(2)} ms p99 ${percentile(alive, 0.99).toFixed(2)} ms; ` +
      `whole combat ${samples.length} ticks p50 ${percentile(sorted, 0.5).toFixed(2)} ms p99 ${percentile(sorted, 0.99).toFixed(2)} ms max ${sorted.at(-1)!.toFixed(1)} ms, ` +
      `brain avg ${(bots.stats.brainTotalMs / Math.max(1, bots.stats.ticks)).toFixed(2)} ms; bot shots ${bots.stats.shots}, hits ${combat.hits}, knocks ${combat.knocks}, kills ${combat.kills}, revives ${combat.revives}; ` +
      `end ${lc.endReason} winner ${lc.winnerTeam}, zone phases ${lc.zonePhases.length}; ` +
      `loot: ${match.loot!.stats.pickups} pickups (refused ${JSON.stringify(match.loot!.stats.rejected)}), ${match.loot!.stats.deathDrops} death piles, human ${human.lootBytes} B in ${human.lootMessages} messages`;
    console.log(line);
    // Loose guard only (shared machine); the budget is p99 < 12 ms.
    expect(percentile(alive, 0.99)).toBeLessThan(50);
    expect(bots.stats.shots).toBeGreaterThan(0);
    // B5: bots loot the server's ground loot through the same pickup action, and deaths leave piles.
    expect(match.loot!.stats.pickups).toBeGreaterThan(0);
    expect(human.lootMalformed).toBe(0);
    expect(combat.hits).toBeGreaterThan(0);
    expect(combat.damageEvents).toBeGreaterThan(0);
    expect(lc.zonePhases.length).toBeGreaterThan(0);
    expect(["lastTeam", "allDead", "timeCap"]).toContain(lc.endReason);
    h.run(200, 4);
    expect(human.matchEnd).not.toBeNull();
    expect([MatchEndReason.lastTeam, MatchEndReason.allDead, MatchEndReason.timeCap]).toContain(human.matchEnd!.reason);
    expect(human.matchEnd!.players.filter((p) => p.bot)).toHaveLength(19);
    expect(h.results).toHaveLength(1);
    expect(h.results[0]!.players.filter((p) => p.bot)).toHaveLength(19);
    expect(h.results[0]!.outcome).toBe("completed");
    await h.dispose();
  }, 300_000);

  it("vn-hangxanh (real map): allocate from its bake with a nav grid, then a short duo bot match with fillWithBots", async () => {
    const level = await resolveServerLevel("vn-hangxanh");
    expect(level).toMatchObject({ mapId: "vn-hangxanh", source: "bake" });
    const h = await createHarness(havok, {
      level,
      maxPlayers: 6,
      teamMode: "duo",
      // One rostered bot; the two empty slots of team 2 are filled when warmup ends.
      configure: (c) => ({ ...c, mapId: "vn-hangxanh", teams: [{ teamId: 0, accountIds: ["human", "bot:0"] }, { teamId: 1, accountIds: ["bot:1", "bot:2"] }], botDifficulty: "easy" }),
      lifecycle: { warmupSeconds: 30, allJoinedSeconds: 0.3, timeScale: 0.05, endLingerSeconds: 0.3 },
    });
    const match = h.match;
    expect(match.navInfo?.kind).toBe("grid");
    expect(match.bots!.count).toBe(3);
    console.log(`[bots] vn-hangxanh: map load ${level.loadMs.toFixed(0)} ms, nav ${match.navInfo!.buildMs.toFixed(0)} ms`);
    const human = h.connect({ token: h.token({ sub: "human", team: 0 }) });
    stand(human);
    expect(runUntil(h, () => match.lifecycle!.phase === "Combat", 5000)).toBe(true);
    expect(match.bots!.count).toBe(5);
    expect(match.players.map((p) => p.accountId)).toEqual(["human", "bot:0", "bot:1", "bot:2", "bot:3", "bot:4"]);
    const starts = match.players.map((p) => ({ x: p.feet.x, z: p.feet.z }));
    h.run(100, 4);
    expect(human.phase).toMatchObject({ phase: PhaseCode.Combat, teamsAlive: 3, playersAlive: 6 });
    h.run(6000, 4);
    const moved = match.players.filter((p, i) => p.bot !== null && Math.sqrt((p.feet.x - starts[i]!.x) ** 2 + (p.feet.z - starts[i]!.z) ** 2) > 3).length;
    expect(moved).toBeGreaterThanOrEqual(3);
    for (const p of match.players) if (p.life !== "dead") expect(p.feet.y).toBeGreaterThan(level.heightAt!(p.feet.x, p.feet.z) - 0.3);
    match.abort();
    h.run(100, 4);
    expect(h.results[0]).toMatchObject({ outcome: "aborted" });
    await h.dispose();
  }, 180_000);

  // Opt-in bench: TB_BOTS_BENCH_SECONDS=120 pnpm --filter @twobullets/server-match exec vitest run test/bots.integration.test.ts
  const benchSeconds = Number(process.env.TB_BOTS_BENCH_SECONDS ?? 0);
  it.runIf(benchSeconds > 0)(`bench: 1 human + 19 hard bots on Map v1, ${benchSeconds} s of real-time-scale combat`, async () => {
    const level = await resolveServerLevel("v1");
    const teams = [{ teamId: 0, accountIds: ["human", "bot:0", "bot:1", "bot:2"] }];
    for (let t = 1; t < 5; t++) teams.push({ teamId: t, accountIds: [0, 1, 2, 3].map((m) => `bot:${3 + (t - 1) * 4 + m}`) });
    const h = await createHarness(havok, {
      level,
      maxPlayers: 20,
      teamMode: "squad",
      configure: (c) => ({ ...c, mapId: "v1", teams, botDifficulty: "hard" }),
      lifecycle: { warmupSeconds: 30, allJoinedSeconds: 0.5 },
    });
    const human = h.connect({ token: h.token({ sub: "human", team: 0 }) });
    stand(human);
    expect(runUntil(h, () => h.match.lifecycle!.phase === "Combat", 5000)).toBe(true);
    const samples = timeTicks(h);
    const wallStart = performance.now();
    h.run(benchSeconds * 1000, 4);
    const wall = performance.now() - wallStart;
    const sorted = [...samples].sort((a, b) => a - b);
    const alive = h.match.players.filter((p) => p.life !== "dead").length;
    const s = h.match.bots!.stats;
    console.log(
      `[bots bench] v1 1+19 hard, ${samples.length} ticks: p50 ${percentile(sorted, 0.5).toFixed(2)} ms p90 ${percentile(sorted, 0.9).toFixed(2)} ms p99 ${percentile(sorted, 0.99).toFixed(2)} ms max ${sorted.at(-1)!.toFixed(1)} ms; ` +
        `brain+nav avg ${(s.brainTotalMs / Math.max(1, s.ticks)).toFixed(2)} ms; ${alive} alive at the end, bot shots ${s.shots}; harness wall ${(wall / 1000).toFixed(1)} s; rss ${(process.memoryUsage.rss() / 1e6).toFixed(0)} MB`,
    );
    h.match.abort();
    h.run(100, 4);
    await h.dispose();
  }, 1_200_000);
});
