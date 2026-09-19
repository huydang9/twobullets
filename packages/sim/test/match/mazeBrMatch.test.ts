import { createBotBrain } from "@twobullets/shared/bots/brain/brain";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { MAZE_BR } from "@twobullets/shared/map/mazeBr";
import type { MapData } from "@twobullets/shared/map/types";
import { beforeAll, describe, expect, it } from "vitest";
import type { HavokModule } from "../../src/index";
import { loadHavok } from "../../src/node/loadHavok";
import { EARLY_SECONDS, formatActivity, runWithActivity, type BotActivity } from "./botActivity";
import { createMapMatch } from "./mazeBrWorld";

// Bots on the maze map (a map made of props: 682 walls, one watchtower). Map v1 is the control: every number here is
// only meaningful as the delta between the two, because a brain change that helps a maze must not quietly turn Map v1
// into a different game. Seeds are averaged — one seed's match is chaotic.

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
}, 60_000);

/** One seed in CI (this file runs next to a timing-gated test); widen it by hand when tuning. */
const SEEDS = [7];
/** Real match pacing, stopped after the opening: that window is where the zone pushes nobody and bots must self-start. */
const RUN_TICKS = 9_000;

function run(map: MapData, seed: number): BotActivity {
  const match = createMapMatch(havok, {
    map,
    seed,
    brains: createBotBrain,
    timeScale: 1,
    loadout: "empty",
    config: { maxPlayers: 10, teamMode: "duo" },
  });
  try {
    return runWithActivity(match, RUN_TICKS);
  } finally {
    match.dispose();
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

function sweep(label: string, map: MapData): { readonly walk: number; readonly earlyWalk: number; readonly earlyPace: number; readonly pushing: number; readonly shots: number; readonly kills: number; readonly frozen: number; readonly idle: number } {
  const runs = SEEDS.map((seed) => run(map, seed));
  for (let i = 0; i < runs.length; i++) console.info(formatActivity(`${label} seed ${SEEDS[i]}`, runs[i]!));
  const idle = (a: BotActivity) => (a.early.goals.get("idle") ?? 0) / Math.max(1, a.early.samples);
  const result = {
    walk: mean(runs.map((a) => a.medianDistance)),
    earlyWalk: mean(runs.map((a) => a.early.medianDistance)),
    // Metres a second, not metres: a seed where the maze empties out early stops the clock, and that shortens the
    // walk without anyone having stood still. The pace is what "the bots self-start and keep moving" actually means.
    earlyPace: mean(runs.map((a) => a.early.medianDistance / Math.max(1, Math.min(a.combatTicks / 60, EARLY_SECONDS)))),
    pushing: mean(runs.map((a) => a.pushing / Math.max(1, a.samples))),
    shots: mean(runs.map((a) => a.shots)),
    kills: mean(runs.map((a) => a.kills - a.zoneKills)),
    frozen: mean(runs.map((a) => a.frozen)),
    idle: mean(runs.map(idle)),
  };
  console.info(
    `[${label} mean of ${SEEDS.length}] walk ${result.walk.toFixed(0)} m (first 180 s ${result.earlyWalk.toFixed(0)} m), pushing ${(result.pushing * 100).toFixed(0)}%, ` +
      `idle goal (first 180 s) ${(result.idle * 100).toFixed(0)}%, pace ${result.earlyPace.toFixed(2)} m/s, ${result.shots.toFixed(0)} shots, ${result.kills.toFixed(1)} gunfight kills, frozen ${result.frozen.toFixed(1)}`,
  );
  return result;
}

describe("bots on the maze map", () => {
  it("move and fight on the maze, with Map v1 as the control", () => {
    const maze = sweep("maze", MAZE_BR);
    const v1 = sweep("map v1", MAP_V1);

    // The bug: every goal scores zero on a map without buildings, so `idle` (0.05) wins and the bot stands and scans.
    expect(maze.frozen).toBe(0);
    expect(maze.idle).toBeLessThan(0.5);
    expect(maze.earlyPace).toBeGreaterThan(1.9);
    expect(maze.pushing).toBeGreaterThan(0.5);
    // And they find each other. How much shooting one seed produces in a maze swings hard (line of sight is a few
    // metres), so this only gates that fights happen at all; the sweep above the assertions is the real measurement.
    expect(maze.shots).toBeGreaterThan(10);

    // Control: Map v1 keeps walking, shooting and killing at its tuned rate.
    expect(v1.frozen).toBe(0);
    expect(v1.earlyPace).toBeGreaterThan(1.35);
    expect(v1.shots).toBeGreaterThan(100);
    expect(v1.kills).toBeGreaterThanOrEqual(2);
  }, 600_000);
});
