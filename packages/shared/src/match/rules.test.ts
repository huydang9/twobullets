import { describe, expect, it } from "vitest";
import { MAP_V1 } from "../map/mapV1";
import { footstepRadius, hears, landNoiseRadius, NOISE_RADII, shotNoiseRadius } from "./noise";
import {
  brPhaseSchedule,
  canActorBeKnocked,
  createBrMatchConfig,
  createTeamStates,
  downedWithoutStandingTeammate,
  killCauseOf,
  killFeedLine,
  refreshTeamCounts,
  resolveEliminations,
  resolveTimeCap,
  type RulesActor,
} from "./rules";
import { planTeamSpawns, spawnsByPoi } from "./spawns";
import type { MatchEvent } from "./types";

function actors(lives: readonly RulesActor["life"][], health: readonly number[] = []): RulesActor[] {
  return lives.map((life, slot) => ({ slot, team: Math.floor(slot / 2), life, health: life === "alive" ? (health[slot] ?? 100) : 0 }));
}

describe("match config", () => {
  it("5 teams × 2 slots, human slot 0 and bot teammate slot 1", () => {
    const config = createBrMatchConfig({ seed: 7, humanSlot: 0, difficulty: "hard" });
    expect(config.actors).toHaveLength(10);
    expect(config.actors.map((a) => a.team)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    expect(config.actors[0]).toMatchObject({ kind: "human", difficulty: null });
    expect(config.actors[1]).toMatchObject({ kind: "bot", difficulty: "hard", team: 0 });
    expect(config.rules).toEqual({ friendlyFire: true, reviveSeconds: 5, bodyBlocking: true });
    expect(config.timings.timeCapSeconds).toBe(720);
  });

  it("teammate=none leaves the human's team with one slot", () => {
    const config = createBrMatchConfig({ seed: 1, humanSlot: 0, humanTeammate: false, teamCount: 3 });
    expect(config.actors.map((a) => a.slot)).toEqual([0, 2, 3, 4, 5]);
    expect(createTeamStates(config)[0]!.slots).toEqual([0]);
  });

  it("phase schedule with countdown, zero landing/glide and time scale", () => {
    const s = brPhaseSchedule(createBrMatchConfig({ seed: 1, timeScale: 0.5 }), 100);
    expect(s).toEqual({ warmupStartTick: 100, warmupEndTick: 250, landingEndTick: 250, combatStartTick: 250, timeCapTick: 250 + 360 * 60 });
  });
});

describe("knock, wipes, placements, win", () => {
  it("knocks only while a teammate stands and knock-down is enabled", () => {
    const a = actors(["alive", "alive", "alive", "downed"]);
    expect(canActorBeKnocked({ reviveSeconds: 5 }, 0, 0, a)).toBe(true);
    expect(canActorBeKnocked({ reviveSeconds: 5 }, 2, 1, a)).toBe(false);
    expect(canActorBeKnocked({ reviveSeconds: 0 }, 0, 0, a)).toBe(false);
  });

  it("finds downed members whose team has nobody standing", () => {
    const config = createBrMatchConfig({ seed: 1 });
    const teams = createTeamStates(config);
    const out: number[] = [];
    expect(downedWithoutStandingTeammate(teams, actors(["downed", "alive", "downed", "dead", "downed", "downed"]), out)).toEqual([2, 4, 5]);
  });

  it("placement = teams in play at the start of the tick; same-tick wipes share it", () => {
    const config = createBrMatchConfig({ seed: 1 });
    const teams = createTeamStates(config);
    const events: MatchEvent[] = [];
    // Tick 10: teams 1 and 2 wiped together (5 in play → both 5th).
    let lives: RulesActor["life"][] = ["alive", "alive", "dead", "dead", "dead", "dead", "alive", "downed", "alive", "alive"];
    refreshTeamCounts(teams, actors(lives));
    expect(resolveEliminations(teams, 10, events)).toBeNull();
    expect(teams.map((t) => t.placement)).toEqual([null, 5, 5, null, null]);
    // Tick 20: team 3 wiped (3 in play → 3rd).
    lives = ["alive", "downed", "dead", "dead", "dead", "dead", "dead", "dead", "alive", "alive"];
    refreshTeamCounts(teams, actors(lives));
    expect(resolveEliminations(teams, 20, events)).toBeNull();
    expect(teams[3]!.placement).toBe(3);
    expect(teams[0]!.standing).toBe(1);
    expect(teams[0]!.inPlay).toBe(2);
    // Tick 30: team 4 wiped → team 0 wins.
    lives = ["alive", "downed", "dead", "dead", "dead", "dead", "dead", "dead", "dead", "dead"];
    refreshTeamCounts(teams, actors(lives));
    expect(resolveEliminations(teams, 30, events)).toEqual({ reason: "lastTeam", winnerTeam: 0 });
    expect(teams.map((t) => t.placement)).toEqual([1, 5, 5, 3, 2]);
    expect(events.map((e) => e.type)).toEqual(["teamEliminated", "teamEliminated", "teamEliminated", "teamEliminated", "win", "matchEnded"]);
    const ended = events.at(-1)!;
    expect(ended.type === "matchEnded" && ended.results.map((r) => [r.team, r.placement])).toEqual([
      [0, 1],
      [4, 2],
      [3, 3],
      [1, 5],
      [2, 5],
    ]);
  });

  it("the last teams dying on the same tick share 1st with no winner", () => {
    const config = createBrMatchConfig({ seed: 1, teamCount: 3 });
    const teams = createTeamStates(config);
    const events: MatchEvent[] = [];
    refreshTeamCounts(teams, actors(["dead", "dead", "alive", "alive", "alive", "alive"]));
    resolveEliminations(teams, 5, events);
    refreshTeamCounts(teams, actors(["dead", "dead", "dead", "dead", "dead", "dead"]));
    expect(resolveEliminations(teams, 9, events)).toEqual({ reason: "allDead", winnerTeam: null });
    expect(teams.map((t) => t.placement)).toEqual([3, 1, 1]);
    expect(events.some((e) => e.type === "win")).toBe(false);
  });

  it("time cap ranks by standing, then health, then team index", () => {
    const config = createBrMatchConfig({ seed: 1, teamCount: 4 });
    const teams = createTeamStates(config);
    const a = actors(["alive", "downed", "alive", "downed", "alive", "alive", "dead", "dead"], [80, 0, 90, 0, 10, 10]);
    refreshTeamCounts(teams, a);
    resolveEliminations(teams, 1, []);
    const events: MatchEvent[] = [];
    expect(resolveTimeCap(teams, a, 2, events)).toEqual({ reason: "timeCap", winnerTeam: 2 });
    expect(teams.map((t) => t.placement)).toEqual([3, 2, 1, 4]);
    expect(events.map((e) => e.type)).toEqual(["win", "matchEnded"]);
  });
});

describe("kill feed", () => {
  const names = (slot: number) => ["A", "B", "C"][slot] ?? `#${slot}`;
  it("formats knocks, kills, bleed-outs, zone deaths and eliminations", () => {
    expect(killFeedLine({ type: "knock", tick: 1, attacker: 0, victim: 1, cause: "rifle", headshot: false }, names)).toBe("A knocked B with AR-4");
    expect(killFeedLine({ type: "kill", tick: 1, killer: 0, victim: 1, cause: "rifle", headshot: true, knockedBy: -1, teamKill: false }, names)).toBe("A killed B with AR-4 (Headshot)");
    expect(killFeedLine({ type: "kill", tick: 1, killer: 0, victim: 1, cause: "bleedOut", headshot: false, knockedBy: 0, teamKill: false }, names)).toBe("B bled out");
    expect(killFeedLine({ type: "kill", tick: 1, killer: -1, victim: 2, cause: "zone", headshot: false, knockedBy: -1, teamKill: false }, names)).toBe("C died to the zone");
    expect(killFeedLine({ type: "teamEliminated", tick: 1, team: 2, placement: 4 }, names)).toBe("Team 3 eliminated (#4)");
    expect(killFeedLine({ type: "win", tick: 1, team: 0 }, names)).toBeNull();
    expect(killCauseOf("explosion", null)).toBe("frag");
    expect(killCauseOf("bullet", "sniper")).toBe("sniper");
  });
});

describe("spawn plan", () => {
  it("Map v1: ten non-training POIs (four of them minor) with two spawns each", () => {
    const groups = spawnsByPoi(MAP_V1.pois, MAP_V1.spawns);
    expect(groups.map((g) => [g.poi.id, g.spawns.length])).toEqual([
      ["town", 2],
      ["farm", 2],
      ["military", 2],
      ["radar", 2],
      ["quarry", 2],
      ["forest", 2],
      ["millbrook", 2],
      ["truckstop", 2],
      ["camp", 2],
      ["orchard", 2],
    ]);
  });

  it("5 distinct seeded POIs, teammates side by side on one of the POI's spawns, with terrain heights", () => {
    const plan = planTeamSpawns(11, 5, 2, MAP_V1.pois, MAP_V1.spawns, (x, z) => x * 0.01 + z * 0.001);
    expect(new Set(plan.map((p) => p.poiId)).size).toBe(5);
    expect(plan.every((p) => p.poiId !== "training")).toBe(true);
    for (const team of plan) {
      expect(team.feet).toHaveLength(2);
      for (const f of team.feet) expect(f.y).toBeCloseTo(f.x * 0.01 + f.z * 0.001, 9);
      const [a, b] = team.feet;
      expect(Math.hypot(a!.x - b!.x, a!.z - b!.z)).toBeCloseTo(2, 9);
      const mid = { x: (a!.x + b!.x) / 2, z: (a!.z + b!.z) / 2 };
      expect(MAP_V1.spawns.some((s) => Math.hypot(s.position[0] - mid.x, s.position[1] - mid.z) < 1e-9 && s.yaw === team.yaw)).toBe(true);
    }
    expect(planTeamSpawns(11, 5, 2, MAP_V1.pois, MAP_V1.spawns, () => 0)).toEqual(planTeamSpawns(11, 5, 2, MAP_V1.pois, MAP_V1.spawns, () => 0));
    const firsts = new Set(Array.from({ length: 30 }, (_, seed) => planTeamSpawns(seed, 5, 2, MAP_V1.pois, MAP_V1.spawns, () => 0)[0]!.poiId));
    expect(firsts.size).toBeGreaterThan(3);
    expect(() => planTeamSpawns(1, 11, 2, MAP_V1.pois, MAP_V1.spawns, () => 0)).toThrow();
  });
});

describe("noise radii", () => {
  it("follows the ADR 0207 table", () => {
    expect(footstepRadius("stand", false, 5, true)).toBe(20);
    expect(footstepRadius("stand", true, 9, true)).toBe(40);
    expect(footstepRadius("crouch", false, 3, true)).toBe(8);
    expect(footstepRadius("stand", false, 0.2, true)).toBe(0);
    expect(footstepRadius("stand", true, 9, false)).toBe(0);
    expect(shotNoiseRadius("sniper")).toBe(1000);
    expect(landNoiseRadius(8)).toBe(NOISE_RADII.land);
    expect(landNoiseRadius(3)).toBe(0);
    expect(hears(20, 0.6, 12 * 12)).toBe(true);
    expect(hears(20, 0.6, 13 * 13)).toBe(false);
  });
});
