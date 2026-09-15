import type { PlayerState } from "@twobullets/shared/input";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { createMoveState } from "@twobullets/shared/movement/movement";
import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import { DEFAULT_LOADOUT } from "@twobullets/shared/weapons/weapons";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";
import { createBotBrain } from "@twobullets/shared/bots/brain/brain";
import type { MatchEvent } from "@twobullets/shared/match/types";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CharacterBody } from "../src/CharacterBody";
import { createSimWorld, stepPlayer, type HavokModule, type SimWorld } from "../src/index";
import { loadHavok } from "../src/node/loadHavok";
import { createHeadlessMatch } from "./match/harness";
import { fingerprint, randomInputs } from "./simHarness";

// CharacterBody's shortcuts (rest steps, lazy proximity queries) must be invisible: the same inputs give bit-identical
// movement and the same match with them on and off. Counters and a loose time budget keep them from silently
// switching off.

const TICKS = 6000;

let havok: HavokModule;
let world: SimWorld;

beforeAll(async () => {
  havok = await loadHavok();
  world = await createSimWorld(havok, ARENA_LEVEL);
}, 60_000);

afterAll(() => {
  world?.dispose();
  CharacterBody.fastPaths = true;
});

function runScript(fastPaths: boolean): { prints: string[]; stats: CharacterBody["queryStats"]; ms: number } {
  CharacterBody.fastPaths = fastPaths;
  const [x, y, z] = ARENA_LEVEL.spawnPoints[0]!.position;
  const body = world.createBody({ x, y, z }) as CharacterBody;
  const { inputs, gates } = randomInputs(0xfa57, TICKS);
  let state: PlayerState = { move: createMoveState(), weapon: createWeaponState(DEFAULT_LOADOUT) };
  const prints: string[] = [];
  const started = performance.now();
  for (let t = 0; t < TICKS; t++) {
    // Standing still for a while every 600 ticks (turning and not), so rest steps get exercised.
    const input = t % 600 < 150 ? { ...inputs[t]!, forward: 0 as const, right: 0 as const, buttons: 0, yawQ: t % 1200 < 600 ? inputs[t]!.yawQ : 12345 } : inputs[t]!;
    state = stepPlayer(body, state, input, TICK_SECONDS, { replay: false, gates: gates[t] }).state;
    prints.push(fingerprint(body, state));
    // A restore now and then (netcode corrections) must invalidate the rest state.
    if (t % 997 === 0) body.restore(body.feet, state.move.velocity, state.move.stance);
  }
  const ms = performance.now() - started;
  const stats = body.queryStats;
  body.dispose();
  return { prints, stats, ms };
}

describe("CharacterBody fast paths", () => {
  it("move bit for bit like the plain controller path on a random input script", () => {
    const plain = runScript(false);
    const fast = runScript(true);
    let firstDiff = -1;
    for (let t = 0; t < TICKS && firstDiff < 0; t++) if (plain.prints[t] !== fast.prints[t]) firstDiff = t;
    expect(firstDiff).toBe(-1);
    expect(plain.stats.restSkips).toBe(0);
    expect(plain.stats.proximitySkipped).toBe(0);
    // Both shortcuts actually fire: rest steps while standing still, and at least one proximity query saved per moving step.
    expect(fast.stats.restSkips).toBeGreaterThan(TICKS * 0.05);
    expect(fast.stats.proximitySkipped).toBeGreaterThan((TICKS - fast.stats.restSkips) * 0.8);
    console.info(`[fast paths] script ${TICKS} ticks: plain ${plain.ms.toFixed(0)} ms, fast ${fast.ms.toFixed(0)} ms; rest skips ${fast.stats.restSkips}, proximity queries run ${fast.stats.proximityQueries}, skipped ${fast.stats.proximitySkipped}`);
  }, 60_000);

  it("leave a seeded 20-bot match with real brains unchanged (events and final positions)", async () => {
    const run = async (fastPaths: boolean) => {
      CharacterBody.fastPaths = fastPaths;
      const match = await createHeadlessMatch(havok, { seed: 7, brains: createBotBrain, loadout: "starting", profile: true, config: { maxPlayers: 20, teamMode: "duo" } });
      const started = performance.now();
      for (let i = 0; i < 1500; i++) match.sim.tick();
      const ms = performance.now() - started;
      const positions = match.sim.state.actors.map((a) => [a.feet.x, a.feet.y, a.feet.z, a.health, a.life]);
      const hash = createHash("sha1").update(JSON.stringify(match.events satisfies MatchEvent[])).digest("hex");
      let restSkips = 0;
      for (const a of match.sim.state.actors) restSkips += (match.sim.bodyOf(a.slot) as CharacterBody | null)?.queryStats.restSkips ?? 0;
      match.dispose();
      return { positions, hash, ms, restSkips, events: match.events.length };
    };
    const plain = await run(false);
    const fast = await run(true);
    expect(fast.hash).toBe(plain.hash);
    expect(fast.positions).toEqual(plain.positions);
    // The 5 s countdown alone is 300 frozen ticks for 20 bots.
    expect(fast.restSkips).toBeGreaterThan(20 * 250);
    console.info(`[fast paths] 20-bot match 1500 ticks: plain ${(plain.ms / 1500).toFixed(3)} ms/tick, fast ${(fast.ms / 1500).toFixed(3)} ms/tick, rest skips ${fast.restSkips}, ${fast.events} events`);
    // Loose regression budget for a busy dev machine (≈1 ms/tick measured on an M2 Pro).
    expect(fast.ms / 1500).toBeLessThan(4);
  }, 120_000);
});
