import { Observable } from "@babylonjs/core";
import { createInventory, createStartingInventory, createVitals, type ExternalActorPose, type MatchExternalActor } from "@twobullets/shared";
import { createGroundLoot } from "@twobullets/shared/equipment/loot";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { planTeamSpawns } from "@twobullets/shared/match/spawns";
import { createMapSimWorld, type MapSimWorld } from "@twobullets/sim/map/mapCollision";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMapV1 } from "../../../../packages/sim/test/match/mapV1World";
import { StraightNav } from "../../../../packages/sim/test/match/straightNav";
import { EquipmentSystem, type EquipmentInputSource, type EquipmentPlayer } from "../../src/equipment/EquipmentSystem";
import { HoldToggles } from "../../src/input/holdToggle";
import { createOfflineMatchConfig, createOfflineMatchSim } from "../../src/match/createOfflineMatchSim";
import { readOfflineMatchOptions } from "../../src/match/options";
import { createNetStartingInventory } from "@twobullets/shared/equipment/presets";
import { createNetLocalInventory } from "../../src/net/NetEquipmentView";

// Starting kit per mode: the offline human (EquipmentSystem's default and respawn loadout, which OfflineMatch also
// resets to), the offline match's bots (createOfflineMatchSim), and the networked local inventory (no grenades).

let world: MapSimWorld;
let terrain: Awaited<ReturnType<typeof loadMapV1>>["terrain"];

beforeAll(async () => {
  const havok = await loadHavok();
  const map = await loadMapV1();
  terrain = map.terrain;
  world = createMapSimWorld(havok, map);
}, 60_000);

afterAll(() => world?.dispose());

const inputSource = { isLocked: true, isActionDown: () => false, wasActionPressed: () => false, wheelDelta: () => 0 };
const input: EquipmentInputSource = { ...inputSource, holds: new HoldToggles(inputSource) };

describe("starting kit", () => {
  it("offline human: EquipmentSystem starts and respawns with the AR-4, P-9, a frag and a smoke", () => {
    const player = { onTick: new Observable(), moveState: {}, tickFeet: { x: 0, y: 0, z: 0 }, getEyeToRef: () => null, getAim: () => ({ yaw: 0, pitch: 0 }) };
    const equipment = new EquipmentSystem(world.scene, input, player as unknown as EquipmentPlayer, { loot: [] });
    expect(equipment.inventory).toEqual(createStartingInventory());
    expect(equipment.inventory.backpack).toBe(1);
    expect(equipment.capacity.max).toBe(200);
    equipment.resetLoadout(createInventory());
    expect(equipment.inventory.weapons).toEqual([null, null, null]);
    equipment.resetLoadout();
    expect(equipment.inventory).toEqual(createStartingInventory());
    expect(equipment.inventory.backpack).toBe(1);
    equipment.dispose();
  });

  it("offline match bots start with the same kit", () => {
    const options = readOfflineMatchOptions("?bots=1&difficulty=easy&seed=5&players=8&mode=duo", true);
    const seed = options.seed!;
    const config = createOfflineMatchConfig({ seed, options, difficulty: options.difficulty, humanSlot: 0 });
    const spawns = planTeamSpawns(seed, config.teamCount, config.teamSize, MAP_V1.pois, MAP_V1.spawns, (x, z) => terrain.sampleHeight(x, z));
    const human: MatchExternalActor = {
      slot: 0,
      vitals: createVitals(),
      armor: { helmet: null, vest: null },
      readPose: (out: ExternalActorPose) => void out,
      applyDamage: () => {
        throw new Error("unused");
      },
      setCanBeKnocked() {},
      setReviver() {},
      eliminate() {},
    };
    const sim = createOfflineMatchSim({
      seed,
      options,
      difficulty: options.difficulty,
      humanSlot: 0,
      spawns,
      killY: MAP_V1.bounds.killY,
      raycastWorld: world.raycastWorld,
      nav: new StraightNav(terrain),
      isValidZoneCenter: () => true,
      groundLoot: createGroundLoot([]),
      equipment: { smokes: [], throwables: [], spawnRelease: () => -1 },
      external: [human],
      createBody: (at) => world.createBody(at),
    });
    const bots = sim.state.actors.filter((a) => a.kind === "bot");
    expect(bots.length).toBeGreaterThan(0);
    for (const bot of bots) {
      const inventory = sim.inventoryOf(bot.slot)!;
      expect(inventory).toEqual(createStartingInventory());
      expect(inventory.backpack).toBe(1);
      expect(inventory.stacks.find((s) => s.itemId === "ammo_556")?.quantity).toBe(60);
      expect(inventory.stacks.find((s) => s.itemId === "ammo_9mm")?.quantity).toBe(24);
    }
    sim.dispose();
  });

  it("networked local inventory: the server's starting kit (B5): guns, spare rounds, Lv1 backpack, no grenades or heals", () => {
    const inventory = createNetLocalInventory();
    expect(inventory).toEqual(createNetStartingInventory());
    expect(inventory.weapons.map((w) => w?.weaponId ?? null)).toEqual(["rifle", null, "pistol"]);
    expect(inventory.stacks).toEqual([
      { itemId: "ammo_556", quantity: 60 },
      { itemId: "ammo_9mm", quantity: 24 },
    ]);
    expect(inventory.backpack).toBe(1);
    expect(inventory.selectedThrowable).toBeNull();
  });
});
