import { createRng } from "@twobullets/shared/equipment/math";
import type { PlayerState } from "@twobullets/shared/input";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { createMoveState } from "@twobullets/shared/movement/movement";
import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import { DEFAULT_LOADOUT } from "@twobullets/shared/weapons/weapons";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CharacterBody } from "../src/CharacterBody";
import { createSimWorld, stepPlayer, type SimWorld } from "../src/index";
import { loadHavok } from "../src/node/loadHavok";
import { fingerprint, randomInputs } from "./simHarness";

// Refactor R5 acceptance (architecture.md §7.2): random inputs, restore at random ticks, replay → bitwise equal.

const TICKS = 10_000;
const RESTORES = 250;
const MAX_REPLAY = 30;

let world: SimWorld;

beforeAll(async () => {
  world = await createSimWorld(await loadHavok(), ARENA_LEVEL);
});

afterAll(() => world?.dispose());

describe("stepPlayer replay consistency", () => {
  it("restoring any recorded tick and replaying its inputs reproduces the run bit for bit", () => {
    const [x, y, z] = ARENA_LEVEL.spawnPoints[0]!.position;
    const body = world.createBody({ x, y, z });
    if (!(body instanceof CharacterBody)) throw new Error("expected a CharacterBody");
    const { inputs, gates } = randomInputs(0x5eed, TICKS);

    const states: PlayerState[] = [{ move: createMoveState(), weapon: createWeaponState(DEFAULT_LOADOUT) }];
    const feet = [{ ...body.feet }];
    const prints = [fingerprint(body, states[0]!)];
    let grounded = 0;
    const stances = new Set<string>();
    for (let t = 0; t < TICKS; t++) {
      const { state } = stepPlayer(body, states[t]!, inputs[t]!, TICK_SECONDS, { replay: false, gates: gates[t] });
      states.push(state);
      feet.push({ ...body.feet });
      prints.push(fingerprint(body, state));
      if (state.move.grounded) grounded++;
      stances.add(state.move.stance);
    }
    // The script actually exercises ground, air and every stance inside the arena.
    expect(grounded).toBeGreaterThan(TICKS * 0.5);
    expect(grounded).toBeLessThan(TICKS);
    expect([...stances].sort()).toEqual(["crouch", "prone", "stand"]);
    expect(Math.abs(feet[TICKS]!.x) + Math.abs(feet[TICKS]!.z)).toBeGreaterThan(0);

    const random = createRng(0xbeef);
    let replayed = 0;
    for (let r = 0; r < RESTORES; r++) {
      const from = Math.floor(random() * (TICKS - MAX_REPLAY));
      const length = 1 + Math.floor(random() * MAX_REPLAY);
      let state = states[from]!;
      body.restore(feet[from]!, state.move.velocity, state.move.stance);
      for (let t = from; t < from + length; t++) {
        state = stepPlayer(body, state, inputs[t]!, TICK_SECONDS, { replay: true, gates: gates[t] }).state;
        replayed++;
        if (fingerprint(body, state) !== prints[t + 1]) {
          expect.fail(`replay from tick ${from} diverged at tick ${t + 1}`);
        }
      }
    }
    expect(replayed).toBeGreaterThan(RESTORES);
    body.dispose();
  }, 120_000);
});
