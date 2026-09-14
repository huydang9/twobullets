import type { PlayerState } from "@twobullets/shared/input";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { createMoveState } from "@twobullets/shared/movement/movement";
import { AccumulatorClock, TICK_SECONDS } from "@twobullets/shared/tickClock";
import { DEFAULT_LOADOUT } from "@twobullets/shared/weapons/weapons";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CharacterBody } from "../src/CharacterBody";
import { createSimWorld, stepPlayer, type SimWorld } from "../src/index";
import { loadHavok } from "../src/node/loadHavok";
import { fingerprint, randomInputs } from "./simHarness";

// Refactor R3/R4 acceptance: the same per-tick PlayerInput stream gives identical tick states whatever the render rate,
// with movement modifiers derived in the tick from the weapon's tick ADS blend.

const TICKS = 1200;

let world: SimWorld;

beforeAll(async () => {
  world = await createSimWorld(await loadHavok(), ARENA_LEVEL);
});

afterAll(() => world?.dispose());

/** Runs the offline frame loop at `fps` (with occasional hitches) until TICKS ticks ran; returns every tick's fingerprint. */
function run(fps: number, hitchEvery: number): string[] {
  const [x, y, z] = ARENA_LEVEL.spawnPoints[0]!.position;
  const body = world.createBody({ x, y, z }) as CharacterBody;
  const { inputs, gates } = randomInputs(0xf00d, TICKS);
  const clock = new AccumulatorClock();
  let state: PlayerState = { move: createMoveState(), weapon: createWeaponState(DEFAULT_LOADOUT) };
  const prints: string[] = [];
  let frame = 0;
  while (prints.length < TICKS) {
    frame++;
    // A long frame now and then: the backlog (≤ maxBacklogTicks) must carry into the next frames, not vanish.
    const dt = hitchEvery > 0 && frame % hitchEvery === 0 ? 0.1 : 1 / fps;
    for (let n = clock.advance(dt); n > 0 && prints.length < TICKS; n--) {
      const tick = clock.nextTick();
      // Movement (modifiers from the start-of-tick weapon state), then the weapon, in one step (R3 tick order).
      state = stepPlayer(body, state, inputs[tick]!, TICK_SECONDS, { replay: false, gates: gates[tick], weapons: true }).state;
      prints.push(fingerprint(body, state));
    }
  }
  body.dispose();
  return prints;
}

describe("render-rate independence", () => {
  it("30, 60 and 144 fps produce identical tick states", () => {
    const at60 = run(60, 0);
    const at30 = run(30, 0);
    const at144 = run(144, 97);
    expect(at30).toEqual(at60);
    expect(at144).toEqual(at60);
    // ADS actually changed speed at some point (the modifiers came from the tick blend, not a constant).
    expect(new Set(at60.map((print) => print.slice(-16))).size).toBeGreaterThan(2);
  }, 120_000);
});
