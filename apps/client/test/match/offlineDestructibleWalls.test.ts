import { Observable, Vector3 } from "@babylonjs/core";
import { buildNavGrid, createNavQuery, isValidZoneCenter } from "@twobullets/shared/bots/nav/index";
import { buildDestructibleWalls, WallKind } from "@twobullets/shared/equipment/destructible";
import { createGroundLoot } from "@twobullets/shared/equipment/loot";
import { createInventory } from "@twobullets/shared/equipment/inventory";
import { createMoveState, type MoveState } from "@twobullets/shared/movement/movement";
import { SIMULATION } from "@twobullets/shared/constants";
import { planTeamSpawns } from "@twobullets/shared/match/spawns";
import { createMapSimWorld, type MapSimWorld } from "@twobullets/sim/map/mapCollision";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import type { HavokModule, MatchSim, MatchWalls } from "@twobullets/sim";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMapWorld, MAP_V1, MAZE_BR } from "../../../../packages/sim/test/match/mazeBrWorld";
import { EquipmentSystem, type EquipmentInputSource, type EquipmentPlayer } from "../../src/equipment/EquipmentSystem";
import type { Action } from "../../src/input/bindings";
import { HoldToggles } from "../../src/input/holdToggle";
import { createOfflineMatchSim } from "../../src/match/createOfflineMatchSim";
import { readOfflineMatchOptions } from "../../src/match/options";
import type { PlayerTick } from "../../src/player/PlayerController";

// The offline destructible-wall wiring, end to end on the client path a browser actually runs: OfflineMatch builds the
// `MatchWalls` port, `createOfflineMatchSim` forwards it, MatchSim installs it in the client's own EquipmentSystem
// (`setWalls`), a frag stepped by that system destroys a pane in the match's state, and the next match tick takes the
// pane's Havok collider out of the world. Everything here typechecks even when the port is not connected, so each step
// is asserted on its effect, not on its shape.

const DT = 1 / SIMULATION.tickRate;

let havok: HavokModule;
let open: Rig | null = null;

beforeAll(async () => {
  havok = await loadHavok();
}, 60_000);

afterAll(() => open?.dispose());

class FakeInput implements EquipmentInputSource {
  isLocked = true;
  readonly holds = new HoldToggles(this);
  isActionDown(_action: Action): boolean {
    return false;
  }
  wasActionPressed(_action: Action): boolean {
    return false;
  }
  wheelDelta(): number {
    return 0;
  }
}

interface Rig {
  readonly sim: MatchSim;
  readonly world: MapSimWorld;
  readonly equipment: EquipmentSystem;
  readonly walls: MatchWalls;
  /** Every `removeCollider` call the match made, as `prop#instance`. */
  readonly removed: string[];
  /** One client tick: EquipmentSystem (player.onTick), then the match — OfflineMatch's order. */
  step(ticks?: number): void;
  dispose(): void;
}

/** The maze with the offline match's own ports, built the way `OfflineMatch.start` builds them. */
function rig(destructible: boolean): Rig {
  const { terrain, layout } = loadMapWorld(MAZE_BR);
  const world = createMapSimWorld(havok, { terrain, layout });
  // Its own grid: the nav patch writes into it, and the cached one is shared with every other maze test.
  const grid = buildNavGrid({ map: MAZE_BR, terrain, layout });
  const onTick = new Observable<PlayerTick>();
  const move: MoveState = createMoveState();
  const feet = { x: 0, y: terrain.sampleHeight(0, 0), z: 0 };
  const player = {
    onTick,
    moveState: move,
    getEyeToRef: (out: Vector3) => out.set(feet.x, feet.y + 1.62, feet.z),
    getAim: () => ({ yaw: 0, pitch: 0 }),
  };
  const equipment = new EquipmentSystem(world.scene, new FakeInput(), player as unknown as EquipmentPlayer, { loot: [], inventory: createInventory() });

  const removed: string[] = [];
  const walls: MatchWalls = {
    layout,
    walls: buildDestructibleWalls(layout),
    removeCollider: (prop, instance) => {
      removed.push(`${prop}#${instance}`);
      return world.collision.removeInstance(prop, instance);
    },
  };
  const options = readOfflineMatchOptions("?bots=1&players=2&mode=solo&seed=7", true);
  const seed = options.seed!;
  const spawns = planTeamSpawns(seed, 2, 1, MAZE_BR.pois, MAZE_BR.spawns, (x, z) => terrain.sampleHeight(x, z));
  const sim = createOfflineMatchSim({
    seed,
    options,
    difficulty: "normal",
    humanSlot: null,
    spawns,
    playableHalfExtent: MAZE_BR.terrain.playableHalfExtent,
    pois: MAZE_BR.pois,
    killY: MAZE_BR.bounds.killY,
    raycastWorld: world.raycastWorld,
    nav: createNavQuery(grid),
    isValidZoneCenter: isValidZoneCenter(grid),
    groundLoot: createGroundLoot([]),
    equipment: {
      get smokes() {
        return equipment.smokes;
      },
      throwables: [],
      spawnRelease: (release, slot) => equipment.spawnExternalRelease(release, slot),
      setWalls: (installed) => equipment.setWalls(installed),
    },
    ...(destructible ? { walls } : {}),
    external: [],
    createBody: (at) => world.createBody(at),
  });
  const built: Rig = {
    sim,
    world,
    equipment,
    walls,
    removed,
    step(ticks = 1) {
      for (let i = 0; i < ticks; i++) {
        onTick.notifyObservers({ dt: DT, input: { yaw: 0, pitch: 0 }, playerInput: {}, state: move, landingSpeed: 0 } as unknown as PlayerTick);
        sim.tick();
      }
    },
    dispose() {
      sim.dispose();
      world.dispose();
    },
  };
  open?.dispose();
  open = built;
  return built;
}

/** First standing pane, and a point half a metre off its face (inside the 3 m frag radius, outside its collider). */
function paneBlast(r: Rig): { readonly index: number; readonly x: number; readonly y: number; readonly z: number } {
  const walls = r.walls.walls;
  for (let i = 0; i < walls.count; i++) {
    if (walls.kind[i] !== WallKind.pane || walls.destroyed[i] === 1) continue;
    const reach = walls.halfZ[i]! + 0.5;
    return { index: i, x: walls.x[i]! + Math.sin(walls.yaw[i]!) * reach, y: walls.y[i]! + 1, z: walls.z[i]! + Math.cos(walls.yaw[i]!) * reach };
  }
  throw new Error("the maze has no mirror panes");
}

describe("offline destructible walls (client path)", () => {
  it("a frag stepped by EquipmentSystem destroys a pane and the match removes its collider", () => {
    const r = rig(true);
    const registry = r.walls.walls;
    expect(registry.count).toBeGreaterThan(0);
    // The port reached MatchSim at all.
    expect(r.sim.walls).toBe(registry);

    const blast = paneBlast(r);
    const prop = r.walls.layout.props[registry.set[blast.index]!]!.prop;
    const key = `${prop}#${registry.instance[blast.index]!}`;
    expect(r.world.collision.removeInstance(prop, -1)).toBe(false);

    // Spawned in the client's own equipment world, stepped by EquipmentSystem's tick: if `setWalls` never ran, the
    // blast lands in a world with `walls: null` and nothing below changes.
    r.equipment.netSpawnThrowable(4242, 0, "frag", { x: blast.x, y: blast.y, z: blast.z }, { x: 0, y: 0, z: 0 }, 0.1);
    r.step(12);

    expect(registry.destroyed[blast.index]).toBe(1);
    expect(r.removed).toContain(key);
    // The collider really left Havok: a second removal of the same instance finds nothing.
    expect(r.world.collision.removeInstance(prop, registry.instance[blast.index]!)).toBe(false);
    // And the match patched the nav grid on the same tick.
    expect(r.sim.navPatchStats!.opened).toBeGreaterThan(0);
  }, 180_000);

  it("a map without mirrors or hedges gets no port, so nothing is installed", () => {
    expect(buildDestructibleWalls(loadMapWorld(MAP_V1).layout).count).toBe(0);
    const r = rig(false);
    expect(r.sim.walls).toBeNull();
    expect(r.sim.navPatchStats).toBeNull();
    r.step(2);
    expect(r.removed).toEqual([]);
  }, 180_000);
});
