import { quantizePitch, quantizeYaw } from "@twobullets/shared/aim";
import { Btn, deriveMoveModifiers, type PlayerInput, type PlayerState } from "@twobullets/shared/input";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { MOVEMENT } from "@twobullets/shared/constants";
import { createMoveState } from "@twobullets/shared/movement/movement";
import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import { DEFAULT_LOADOUT } from "@twobullets/shared/weapons/weapons";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stepPlayer } from "../src/index";
import { createMapSimWorld, type MapSimWorld } from "../src/map/mapCollision";
import { loadHavok } from "../src/node/loadHavok";
import { loadMapV1 } from "./match/mapV1World";

// Smooth terrain movement: a straight run over open, flat-ish Map v1 ground holds the target speed every tick. The
// controller's refreshed proximity manifold once held neighbouring heightfield triangles as walls (5.7–9.0 m/s sprint).

const FLAT_NORMAL_Y = Math.cos((10 * Math.PI) / 180);

let map: MapSimWorld;

beforeAll(async () => {
  map = createMapSimWorld(await loadHavok(), await loadMapV1());
}, 60_000);

afterAll(() => map?.dispose());

/** Horizontal speed per grounded tick on flat-ish ground between `from` and `to` (the stretch from spawn 0 is open). */
function run(buttons: number, from: number, to: number): { speeds: number[]; target: number } {
  const spawn = MAP_V1.spawns[0]!;
  const ground = map.groundFeet(spawn.position[0], spawn.position[1]);
  const body = map.createBody({ x: ground.x, y: ground.y + 0.05, z: ground.z });
  let state: PlayerState = { move: createMoveState(), weapon: createWeaponState(DEFAULT_LOADOUT) };
  const normal = { x: 0, y: 1, z: 0 };
  const speeds: number[] = [];
  let input: PlayerInput | null = null;
  for (let tick = 0; tick < to; tick++) {
    input = { tick, forward: 1, right: 0, buttons, select: 0, yawQ: quantizeYaw(spawn.yaw), pitchQ: quantizePitch(0), viewOffset8: 0, action: null };
    state = stepPlayer(body, state, input, TICK_SECONDS, { replay: false }).state;
    const v = state.move.velocity;
    if (tick >= from && state.move.grounded && map.terrain.sampleNormal(body.feet.x, body.feet.z, normal).y >= FLAT_NORMAL_Y) {
      speeds.push(Math.sqrt(v.x * v.x + v.z * v.z));
    }
  }
  body.dispose();
  const base = buttons & Btn.sprint ? MOVEMENT.sprintSpeed : MOVEMENT.walkSpeed;
  return { speeds, target: base * deriveMoveModifiers(state.weapon, input!).speedScale };
}

describe("movement on Map v1 terrain", () => {
  for (const [name, buttons, to] of [["sprint", Btn.sprint, 240], ["walk", 0, 360]] as const) {
    it(`a straight ${name} from spawn 0 holds its speed within ±1% every tick`, () => {
      const { speeds, target } = run(buttons, 45, to);
      expect(speeds.length).toBeGreaterThan((to - 45) * 0.8);
      const worst = Math.max(...speeds.map((s) => Math.abs(s - target) / target));
      expect(worst).toBeLessThanOrEqual(0.01);
    }, 60_000);
  }
});
