import { describe, expect, it } from "vitest";
import { createOfflineMatchConfig } from "../../src/match/createOfflineMatchSim";
import { readOfflineMatchOptions } from "../../src/match/options";

// `?bots=1&players=&mode=` URL flags and the offline match config they build.

describe("offline match size and team mode", () => {
  it("defaults to 10 players in duos", () => {
    const o = readOfflineMatchOptions("?bots=1", true);
    expect([o.maxPlayers, o.teamMode, o.teams]).toEqual([10, "duo", 5]);
  });

  it("reads players and mode, clamps the size, keeps the legacy teams flag", () => {
    expect(readOfflineMatchOptions("?bots=1&players=20&mode=squad", true)).toMatchObject({ maxPlayers: 20, teamMode: "squad", teams: 5 });
    expect(readOfflineMatchOptions("?bots=1&players=20&mode=solo", true)).toMatchObject({ maxPlayers: 20, teamMode: "solo", teams: 20 });
    expect(readOfflineMatchOptions("?bots=1&players=99&mode=nope", true)).toMatchObject({ maxPlayers: 20, teamMode: "duo", teams: 10 });
    expect(readOfflineMatchOptions("?bots=1&players=1", true)).toMatchObject({ maxPlayers: 2, teams: 1 });
    expect(readOfflineMatchOptions("?bots=1&teams=3", true)).toMatchObject({ maxPlayers: 6, teams: 3 });
  });

  it("builds N actors with the human on slot 0 and its squad of bots", () => {
    const options = readOfflineMatchOptions("?bots=1&players=16&mode=squad", true);
    const config = createOfflineMatchConfig({ seed: 1, options, difficulty: "normal", humanSlot: 0 });
    expect(config.actors).toHaveLength(16);
    expect(config.actors.filter((a) => a.team === 0).map((a) => a.kind)).toEqual(["human", "bot", "bot", "bot"]);
    const alone = createOfflineMatchConfig({ seed: 1, options: { ...options, teammate: false }, difficulty: "normal", humanSlot: 0 });
    expect(alone.actors.filter((a) => a.team === 0)).toHaveLength(1);
    expect(alone.actors).toHaveLength(13);
  });
});
