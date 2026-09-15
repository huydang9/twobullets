import * as contracts from "@twobullets/contracts";
import type { JoinClaims, MatchConfig, TeamMode } from "@twobullets/contracts";
import * as shared from "@twobullets/shared/match/teams";
import { describe, expect, it } from "vitest";
import { localMatchConfig } from "../src/app";
import { chooseSlot, matchTeamCount, matchTeamSize, SpawnPlanner } from "../src/match/slots";

// MatchConfig-driven slots and teams (contracts match.ts): slot = teamId · teamSize + member, slots < maxPlayers.

const claims = (sub: string, team: number): JoinClaims => ({ iss: "t", aud: "match", sub, mid: "m", hid: "h", team, pv: 3, ch: 0, epoch: 0, rc: false, jti: sub, iat: 0, exp: 1 });

function fill(config: MatchConfig, teamOf: (i: number) => number, count: number): { slot: number; teamId: number }[] {
  const taken = new Set<number>();
  const out: { slot: number; teamId: number }[] = [];
  for (let i = 0; i < count; i++) {
    const choice = chooseSlot(config, claims(`p${i}`, teamOf(i)), (s) => taken.has(s));
    if (!choice.ok) break;
    taken.add(choice.slot);
    out.push({ slot: choice.slot, teamId: choice.teamId });
  }
  return out;
}

describe("match slots and teams", () => {
  it("contracts and shared helpers agree", () => {
    expect(contracts.MAX_MATCH_PLAYERS).toBe(shared.MAX_MATCH_PLAYERS);
    expect(contracts.TEAM_MODE_SIZE).toEqual(shared.TEAM_MODE_SIZE);
    for (const mode of ["solo", "duo", "squad"] as TeamMode[]) {
      for (let n = 0; n <= 25; n++) expect(contracts.teamCount(n, mode)).toBe(shared.teamCount(n, mode));
      for (let slot = 0; slot < 20; slot++) {
        expect(contracts.teamOfSlot(slot, shared.TEAM_MODE_SIZE[mode])).toBe(shared.teamOfSlot(slot, shared.TEAM_MODE_SIZE[mode]));
        expect(contracts.memberOfSlot(slot, shared.TEAM_MODE_SIZE[mode])).toBe(shared.memberOfSlot(slot, shared.TEAM_MODE_SIZE[mode]));
      }
    }
    expect(contracts.matchTeamMode({ maxTeamSize: 4 })).toBe("squad");
    expect(contracts.matchTeamMode({ maxTeamSize: 2, teamMode: "solo" })).toBe("solo");
  });

  it("20 solo: 20 teams, every slot is its own team", () => {
    const config = localMatchConfig("m", 1, 20, "solo");
    expect(matchTeamCount(config)).toBe(20);
    const got = fill(config, (i) => i, 21);
    expect(got).toHaveLength(20);
    for (const g of got) expect(g.teamId).toBe(g.slot);
    expect(chooseSlot(config, claims("late", 0), () => true)).toEqual({ ok: false, reason: "matchFull" });
  });

  it("20 squad: 5 teams × 4; a full team overflows to the next one with room", () => {
    const config = localMatchConfig("m", 1, 20, "squad");
    expect([matchTeamCount(config), matchTeamSize(config)]).toEqual([5, 4]);
    const got = fill(config, () => 2, 20);
    expect(got.slice(0, 4).map((g) => [g.teamId, g.slot])).toEqual([
      [2, 8],
      [2, 9],
      [2, 10],
      [2, 11],
    ]);
    expect(got[4]).toEqual({ teamId: 3, slot: 12 });
    expect(got).toHaveLength(20);
    for (const g of got) expect(g.teamId).toBe(Math.floor(g.slot / 4));
  });

  it("10 players in squads: teams of 4, 4, 2; out-of-range team falls back to team 0", () => {
    const config = localMatchConfig("m", 1, 10, "squad");
    expect(matchTeamCount(config)).toBe(3);
    const got = fill(config, () => 2, 11);
    expect(got).toHaveLength(10);
    expect(got.filter((g) => g.teamId === 2).map((g) => g.slot)).toEqual([8, 9]);
    expect(chooseSlot(config, claims("x", 7), () => false)).toEqual({ ok: true, teamId: 0, slot: 0 });
  });

  it("roster teams map by teamId up to 19", () => {
    const config: MatchConfig = { ...localMatchConfig("m", 1, 20, "solo"), teams: [{ teamId: 19, accountIds: ["last"] }] };
    expect(chooseSlot(config, claims("last", 0), () => false)).toEqual({ ok: true, teamId: 19, slot: 19 });
    expect(chooseSlot(config, claims("other", 0), () => false)).toEqual({ ok: false, reason: "notAssigned" });
  });

  it("spawns: squads stand in two rows; teams beyond the spawn points stand behind the shared point", () => {
    const points = [{ position: [0, 0, 0] as const, yaw: 0 }, { position: [50, 0, 0] as const, yaw: 0 }];
    const squad = new SpawnPlanner(points as never, 1, 4);
    const feet = [0, 1, 2, 3].map((s) => squad.spawnFor(s).feet);
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(Math.hypot(feet[i]!.x - feet[j]!.x, feet[i]!.z - feet[j]!.z)).toBeGreaterThan(1.1);
    const solo = new SpawnPlanner(points as never, 1, 1);
    const all = Array.from({ length: 6 }, (_, s) => solo.spawnFor(s).feet);
    expect(new Set(all.map((f) => `${f.x},${f.z}`)).size).toBe(6);
  });
});
