import { Observable, Vector3 } from "@babylonjs/core";
import { createInventory, createMoveState, SIMULATION, type MoveState } from "@twobullets/shared";
import type { HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHeadlessMatch, type HeadlessMatch } from "../../../../packages/sim/test/match/harness";
import { idleScript } from "../../../../packages/sim/test/match/testBrains";
import type { CombatSystem } from "../../src/combat/CombatSystem";
import { EquipmentSystem, type EquipmentInputSource, type EquipmentPlayer } from "../../src/equipment/EquipmentSystem";
import type { Action } from "../../src/input/bindings";
import { HumanActor } from "../../src/match/HumanActor";
import type { PlayerController, PlayerTick } from "../../src/player/PlayerController";

// Offline practice healing, end to end on the client path: MatchSim damages the human through HumanActor →
// EquipmentSystem vitals; a heal hotkey runs the use channel in EquipmentSystem's tick; the HUD (equipment.vitals) and
// the match state (sim.state.actors[0]) must both show the healed health.

const DT = 1 / SIMULATION.tickRate;

let havok: HavokModule;
let open: HeadlessMatch | null = null;

beforeAll(async () => {
  havok = await loadHavok();
}, 60_000);

afterAll(() => open?.dispose());

class FakeInput implements EquipmentInputSource {
  isLocked = true;
  readonly down = new Set<Action>();
  pressed = new Set<Action>();
  isActionDown(action: Action): boolean {
    return this.down.has(action);
  }
  wasActionPressed(action: Action): boolean {
    return this.pressed.has(action);
  }
  wheelDelta(): number {
    return 0;
  }
}

interface Rig {
  readonly match: HeadlessMatch;
  readonly equipment: EquipmentSystem;
  readonly input: FakeInput;
  /** One client tick: player.onTick (EquipmentSystem), then the match (OfflineMatch.tick order). */
  step(ticks?: number): void;
  press(action: Action): void;
}

async function rig(stacks: Parameters<typeof createInventory>[0]): Promise<Rig> {
  open?.dispose();
  const [x, z] = MAP_V1.spawns[0]!.position;
  const onTick = new Observable<PlayerTick>();
  const move: MoveState = createMoveState();
  let feet = { x, y: 0, z };
  const player = {
    onTick,
    moveState: move,
    get tickFeet() {
      return feet;
    },
    getEyeToRef: (out: Vector3) => out.set(feet.x, feet.y + 1.62, feet.z),
    getAim: () => ({ yaw: 0, pitch: 0 }),
  };
  const input = new FakeInput();
  let equipment!: EquipmentSystem;
  let human!: HumanActor;
  const combat = { weaponState: { adsBlend: 0 }, armed: false, activeWeapon: { id: "rifle" } } as unknown as CombatSystem;
  const match = await createHeadlessMatch(havok, {
    seed: 7,
    nav: "straight",
    loadout: "empty",
    brains: idleScript,
    config: { teamCount: 2, teamSize: 1, humanSlot: 0, timings: { countdownSeconds: 0.1 } },
    spawns: (world) => {
      feet = world.groundFeet(x, z);
      return [
        { team: 0, poiId: "town", feet: [feet], yaw: 0 },
        { team: 1, poiId: "town", feet: [world.groundFeet(x + 200, z + 200)], yaw: 0 },
      ];
    },
    external: (world) => {
      equipment = new EquipmentSystem(world.scene, input, player as unknown as EquipmentPlayer, { loot: [], inventory: createInventory(stacks) });
      human = new HumanActor(player as unknown as PlayerController, combat, equipment, () => {}, 9000);
      return [human];
    },
  });
  open = match;
  // Past the countdown into combat.
  while (match.sim.state.phase !== "combat") match.sim.tick();
  const step = (ticks = 1) => {
    for (let i = 0; i < ticks; i++) {
      const tick = { dt: DT, input: { yaw: 0, pitch: 0 }, playerInput: {}, state: move, landingSpeed: 0 } as unknown as PlayerTick;
      onTick.notifyObservers(tick);
      input.pressed = new Set();
      equipment.update();
      human.captureTick(tick);
      match.sim.tick();
    }
  };
  return { match, equipment, input, step, press: (action) => input.pressed.add(action) };
}

function hurt(r: Rig, to: number): void {
  const feet = r.match.sim.state.actors[0]!.feet;
  const amount = r.equipment.vitals.health - to;
  r.match.sim.damageActor({ attacker: 1, victim: 0, amount, kind: "fall", zone: null, weaponId: null, position: feet, direction: { x: 0, y: -1, z: 0 } });
  r.step();
  expect(r.equipment.vitals.health).toBe(to);
  expect(r.match.sim.state.actors[0]!.health).toBe(to);
}

describe("offline practice healing (EquipmentSystem + HumanActor + MatchSim)", () => {
  it("medkit hotkey heals 40 → 100 in 8 s, on the HUD vitals and in the match state", async () => {
    const r = await rig({ stacks: [{ itemId: "medkit", quantity: 1 }] });
    hurt(r, 40);
    r.press("useMedkit");
    r.step(8 * 60 + 2);
    expect(r.equipment.vitals.health).toBe(100);
    expect(r.match.sim.state.actors[0]!.health).toBe(100);
    expect(r.equipment.inventory.stacks.find((s) => s.itemId === "medkit")?.quantity ?? 0).toBe(0);
  }, 60_000);

  it("first aid from the inventory screen (useItem) heals to 75, not above", async () => {
    const r = await rig({ stacks: [{ itemId: "first_aid", quantity: 1 }] });
    hurt(r, 40);
    r.equipment.useItem("first_aid");
    r.step(6 * 60 + 2);
    expect(r.equipment.vitals.health).toBe(75);
    expect(r.match.sim.state.actors[0]!.health).toBe(75);
  }, 60_000);

  it("energy drink fills boost and heals over time", async () => {
    const r = await rig({ stacks: [{ itemId: "energy_drink", quantity: 1 }] });
    hurt(r, 40);
    r.press("useBoost");
    r.step(4 * 60 + 2);
    expect(r.equipment.vitals.boost).toBeGreaterThan(39);
    r.step(30 * 60);
    expect(r.equipment.vitals.health).toBeGreaterThan(40);
    expect(r.match.sim.state.actors[0]!.health).toBe(r.equipment.vitals.health);
  }, 60_000);
});
