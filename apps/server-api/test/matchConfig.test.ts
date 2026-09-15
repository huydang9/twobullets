import { teamOfSlot } from "@twobullets/contracts/match";
import { describe, expect, it } from "vitest";
import { buildMatchConfig, parseSettings, seatInOrder, teamCapacity, teamsOf } from "../src/matches/matchConfig";

const base = { matchId: "m", hostId: "h", region: "sg", matchSeed: 7 };

describe("match config from lobby/queue settings", () => {
  it("follows the match-size contract: dense slots, partial last team, bots in every free seat", () => {
    const settings = { mode: "squad" as const, maxPlayers: 10, mapId: "v1", fillWithBots: true };
    expect(teamsOf(settings)).toEqual({ teamCount: 3, teamSize: 4 });
    expect([0, 1, 2, 3].map((t) => teamCapacity(settings, t))).toEqual([4, 4, 2, 0]);
    const config = buildMatchConfig({ ...base, settings, humans: [{ accountId: "g_a", teamId: 2 }] });
    expect(config.teams).toEqual([
      { teamId: 0, accountIds: ["bot:0", "bot:1", "bot:2", "bot:3"] },
      { teamId: 1, accountIds: ["bot:4", "bot:5", "bot:6", "bot:7"] },
      { teamId: 2, accountIds: ["g_a", "bot:8"] },
    ]);
    // Slot → team agrees with the contract helper for every seat.
    for (let slot = 0; slot < 10; slot++) expect(teamOfSlot(slot, config.maxTeamSize)).toBe(Math.floor(slot / 4));
  });

  it("solo 20 gives 20 one-seat teams; no bots leaves empty teams out of the roster", () => {
    const solo = buildMatchConfig({ ...base, settings: { mode: "solo", maxPlayers: 20, mapId: "v1", fillWithBots: true }, humans: [] });
    expect(solo.teams).toHaveLength(20);
    const noBots = buildMatchConfig({ ...base, settings: { mode: "duo", maxPlayers: 10, mapId: "arena", fillWithBots: false }, humans: seatInOrder({ mode: "duo", maxPlayers: 10, mapId: "arena", fillWithBots: false }, ["a", "b", "c"]) });
    expect(noBots.teams).toEqual([
      { teamId: 0, accountIds: ["a", "b"] },
      { teamId: 1, accountIds: ["c"] },
    ]);
    expect(noBots.rules.fillWithBots).toBe(false);
  });

  it("throws on over-full or out-of-range teams and validates settings", () => {
    const settings = { mode: "duo" as const, maxPlayers: 3, mapId: "v1", fillWithBots: false };
    expect(() => buildMatchConfig({ ...base, settings, humans: [{ accountId: "a", teamId: 1 }, { accountId: "b", teamId: 1 }] })).toThrow(/full/);
    expect(() => buildMatchConfig({ ...base, settings, humans: [{ accountId: "a", teamId: 2 }] })).toThrow(/range/);
    expect(parseSettings({})).toEqual({ mode: "duo", maxPlayers: 10, mapId: "v1", fillWithBots: true });
    expect(parseSettings({ maxPlayers: 2.5 })).toBe("maxPlayers");
    expect(parseSettings({ mapId: "cz-holasovice" })).toBe("mapId");
  });

  it("botDifficulty is optional, validated, inherited by updates and copied into MatchConfig", () => {
    expect(parseSettings({ botDifficulty: "hard" })).toEqual({ mode: "duo", maxPlayers: 10, mapId: "v1", fillWithBots: true, botDifficulty: "hard" });
    expect(parseSettings({ botDifficulty: "insane" })).toBe("botDifficulty");
    expect(parseSettings({ botDifficulty: 2 })).toBe("botDifficulty");
    const easy = parseSettings({ botDifficulty: "easy" });
    if (typeof easy === "string") throw new Error(easy);
    expect(parseSettings({ maxPlayers: 6 }, easy)).toMatchObject({ maxPlayers: 6, botDifficulty: "easy" });
    expect(parseSettings({ botDifficulty: "normal" }, easy)).toMatchObject({ botDifficulty: "normal" });
    expect(buildMatchConfig({ ...base, settings: easy, humans: [] }).botDifficulty).toBe("easy");
    const plain = buildMatchConfig({ ...base, settings: { mode: "duo", maxPlayers: 4, mapId: "v1", fillWithBots: true }, humans: [] });
    expect("botDifficulty" in plain).toBe(false);
  });
});
