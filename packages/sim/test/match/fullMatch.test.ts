import type { MatchEvent } from "@twobullets/shared/match/types";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { HavokModule } from "../../src/index";
import { loadHavok } from "../../src/node/loadHavok";
import { createHeadlessMatch, runHeadlessMatch } from "./harness";
import { createBotBrain } from "@twobullets/shared/bots/brain/brain";
import { fighterScript } from "./testBrains";

// Headless smoke matches (design.md §12.2): 10 bots on Map v1 with the real nav grid, fixed seed, zone at timeScale
// 0.25 (~8–11 k ticks). The scripted fighters gate the simulation (kills, winner, stuck, CPU); the real brain run gates
// only what the sim owns until the brain loots and fights on Map v1. Numbers are printed for the bench log.

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
}, 60_000);

function eventHash(events: readonly MatchEvent[]): string {
  return createHash("sha1").update(JSON.stringify(events)).digest("hex");
}

describe("headless bots-only match", () => {
  it("runs a seeded 5×2 match to a winner: kills, zone, no NaN, nobody stuck ≥ 20 s, per-tick CPU", async () => {
    const match = await createHeadlessMatch(havok, { seed: 1, brains: fighterScript, timeScale: 0.25, profile: true });
    const capTicks = match.sim.schedule.timeCapTick;
    const summary = runHeadlessMatch(match, capTicks + 600);
    match.dispose();
    console.info(
      `[headless match] ${summary.reason} winner team ${summary.winnerTeam} after ${summary.combatSeconds.toFixed(0)} s combat (${summary.ticks} ticks, wall ${(summary.wallMs / 1000).toFixed(1)} s): ` +
        `${summary.kills} kills, ${summary.knocks} knocks, ${summary.revives} revives, ${summary.zoneDeaths} zone deaths, ${summary.shots} shots, ` +
        `stuck ${summary.stuck.length} (longest ${summary.longestStuckSeconds} s); tick ms p50 ${summary.tickMs.p50.toFixed(3)} p99 ${summary.tickMs.p99.toFixed(3)} max ${summary.tickMs.max.toFixed(2)}; brain p99 ${summary.brainMs.p99.toFixed(3)}`,
    );
    expect(["lastTeam", "allDead"]).toContain(summary.reason);
    expect(summary.ticks).toBeLessThan(capTicks);
    expect(summary.kills).toBeGreaterThanOrEqual(1);
    expect(summary.nanPositions).toBe(0);
    expect(summary.belowKillY).toBe(0);
    expect(summary.longestStuckSeconds).toBeLessThan(20);
    expect(summary.placements.every(([, placement]) => placement >= 1)).toBe(true);
    // Loose gates for a busy dev machine; real numbers are printed above and by tools/bench/bots/match.ts.
    expect(summary.tickMs.p99).toBeLessThan(5);
    expect(summary.brainMs.p99).toBeLessThan(1);
    expect(summary.wallMs).toBeLessThan(60_000);
  }, 120_000);

  it("20 bots in 5 squads run to a winner with the per-tick CPU gate", async () => {
    const match = await createHeadlessMatch(havok, { seed: 2, brains: fighterScript, timeScale: 0.25, profile: true, config: { maxPlayers: 20, teamMode: "squad" } });
    expect(match.sim.state.actors.filter(Boolean)).toHaveLength(20);
    expect(match.sim.state.teams.map((t) => t.slots.length)).toEqual([4, 4, 4, 4, 4]);
    const capTicks = match.sim.schedule.timeCapTick;
    const summary = runHeadlessMatch(match, capTicks + 600);
    match.dispose();
    console.info(
      `[headless match 20 squad] ${summary.reason} winner team ${summary.winnerTeam} after ${summary.combatSeconds.toFixed(0)} s: ${summary.kills} kills, ${summary.knocks} knocks, ` +
        `${summary.revives} revives; tick ms p50 ${summary.tickMs.p50.toFixed(3)} p99 ${summary.tickMs.p99.toFixed(3)} max ${summary.tickMs.max.toFixed(2)}; brain p99 ${summary.brainMs.p99.toFixed(3)}`,
    );
    expect(["lastTeam", "allDead", "timeCap"]).toContain(summary.reason);
    expect(summary.kills).toBeGreaterThanOrEqual(1);
    expect(summary.nanPositions).toBe(0);
    expect(summary.belowKillY).toBe(0);
    expect(summary.placements.every(([, placement]) => placement >= 1)).toBe(true);
    expect(summary.tickMs.p99).toBeLessThan(8);
  }, 180_000);

  it("real brains and nav (shared/bots): the match ends, no NaN, brain CPU within budget (kills and stuck reported, not gated yet)", async () => {
    const match = await createHeadlessMatch(havok, { seed: 1, brains: createBotBrain, timeScale: 0.25, loadout: "empty", profile: true });
    const capTicks = match.sim.schedule.timeCapTick;
    const summary = runHeadlessMatch(match, capTicks + 600);
    const armed = match.sim.state.actors.filter((a) => match.sim.inventoryOf(a.slot)?.weapons.some(Boolean)).length;
    match.dispose();
    console.info(
      `[headless match, real brain] ${summary.reason} winner ${summary.winnerTeam} after ${summary.combatSeconds.toFixed(0)} s: ${summary.kills} kills (${summary.zoneDeaths} zone), ${summary.shots} shots, ` +
        `armed at end ${armed}, stuck ${summary.stuck.length} (longest ${summary.longestStuckSeconds} s ${JSON.stringify(summary.stuck.map((i) => [i.slot, Math.round(i.x), Math.round(i.z), i.seconds]))}); ` +
        `tick ms p50 ${summary.tickMs.p50.toFixed(3)} p99 ${summary.tickMs.p99.toFixed(3)}; brain+nav p50 ${summary.brainMs.p50.toFixed(3)} p99 ${summary.brainMs.p99.toFixed(3)} ` +
        `(brains p99 ${summary.brainOnlyMs.p99.toFixed(3)}, nav.update p99 ${summary.navMs.p99.toFixed(3)})`,
    );
    expect(["lastTeam", "allDead", "timeCap"]).toContain(summary.reason);
    expect(summary.nanPositions).toBe(0);
    expect(summary.belowKillY).toBe(0);
    // Brains alone get the 1 ms budget (design.md §7). nav.update is a time slice bounded by its 1,500-expansion
    // budget, so it gets its own gate; brain+nav is printed above.
    expect(summary.brainOnlyMs.p99).toBeLessThan(1);
    expect(summary.navMs.p99).toBeLessThan(1.5);
  }, 120_000);

  it("is deterministic: the same seed twice gives the same events and final positions", async () => {
    const run = async () => {
      const match = await createHeadlessMatch(havok, { seed: 3, brains: fighterScript, timeScale: 0.25 });
      for (let i = 0; i < 2400; i++) match.sim.tick();
      const positions = match.sim.state.actors.map((a) => [a.feet.x, a.feet.y, a.feet.z, a.health, a.life]);
      const result = { hash: eventHash(match.events), positions, count: match.events.length, shots: match.sim.stats.shots };
      match.dispose();
      return result;
    };
    const a = await run();
    const b = await run();
    expect(a.shots).toBeGreaterThan(0);
    expect(b.count).toBe(a.count);
    expect(b.hash).toBe(a.hash);
    expect(b.positions).toEqual(a.positions);
  }, 120_000);
});
