import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { createMoveState } from "@twobullets/shared/movement/movement";
import { OPEN_MOVE_GATES } from "@twobullets/shared/input";
import { quantizePitch, quantizeYaw } from "@twobullets/shared/aim";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stepPlayer } from "../../src/index";
import { createMapSimWorld, type MapSimWorld } from "../../src/map/mapCollision";
import { loadMapV1 } from "./mapV1World";
import { loadHavok } from "../../src/node/loadHavok";

let world: MapSimWorld;

beforeAll(async () => {
  const map = await loadMapV1();
  world = createMapSimWorld(await loadHavok(), map);
  console.info(`[map v1 headless] terrain ${map.source} + layout ${map.ms.toFixed(0)} ms, collision ${world.collision.stats.buildMs.toFixed(0)} ms, ${world.collision.stats.buildings} buildings, ${world.collision.stats.propBodies} prop bodies in ${world.collision.stats.propShapes} shapes`);
}, 60_000);

afterAll(() => world?.dispose());

describe("headless Map v1 collision", () => {
  it("world rays hit the terrain at the sampled height", () => {
    for (const { position: [x, z] } of MAP_V1.spawns) {
      const hit = world.raycastWorld({ x, y: 200, z }, { x, y: -100, z });
      expect(hit).not.toBeNull();
      expect(hit!.point.y).toBeCloseTo(world.terrain.sampleHeight(x, z), 2);
    }
  });

  it("buildings block rays; fences don't (bullets pass), trees do", () => {
    const b = world.layout.buildings.find((building) => building.prefab.startsWith("house"))!;
    const [x, y, z] = b.position;
    const down = world.raycastWorld({ x, y: y + 30, z }, { x, y: y - 5, z });
    expect(down).not.toBeNull();
    expect(down!.point.y).toBeGreaterThan(y + 1);

    const fences = world.layout.props.find((set) => set.prop === "fence_wood")!;
    const [fx, fy, fz, fyaw] = [fences.data[0]!, fences.data[1]!, fences.data[2]!, fences.data[3]!];
    // Fence segments run along local X: cross it along local Z at 0.6 m.
    const nx = Math.sin(fyaw);
    const nz = Math.cos(fyaw);
    expect(world.raycastWorld({ x: fx - nx, y: fy + 0.6, z: fz - nz }, { x: fx + nx, y: fy + 0.6, z: fz + nz })).toBeNull();

    const trees = world.layout.props.find((set) => set.prop.startsWith("tree"))!;
    const [tx, ty, tz] = [trees.data[0]!, trees.data[1]!, trees.data[2]!];
    expect(world.raycastWorld({ x: tx - 3, y: ty + 1.2, z: tz }, { x: tx + 3, y: ty + 1.2, z: tz })).not.toBeNull();
  });

  it("a character body stands and walks on the terrain at a spawn", () => {
    const [x, z] = MAP_V1.spawns[0]!.position;
    const body = world.createBody(world.groundFeet(x, z));
    let state = { move: createMoveState(), weapon: createWeaponState([null, null, null]) };
    const input = { tick: 0, forward: 1 as const, right: 0 as const, buttons: 0, select: 0, yawQ: quantizeYaw(MAP_V1.spawns[0]!.yaw), pitchQ: quantizePitch(0), viewOffset8: 0, action: null };
    for (let i = 0; i < 120; i++) state = stepPlayer(body, state, { ...input, tick: i }, 1 / 60, { replay: false, gates: OPEN_MOVE_GATES }).state;
    expect(state.move.grounded).toBe(true);
    const f = body.feet;
    expect(Math.hypot(f.x - x, f.z - z)).toBeGreaterThan(8);
    expect(Math.abs(f.y - world.terrain.sampleHeight(f.x, f.z))).toBeLessThan(0.2);
    body.dispose();
  });
});
