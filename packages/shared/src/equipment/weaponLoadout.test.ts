import { describe, expect, it } from "vitest";
import type { CombatInput, WeaponContext, WeaponEvent, WeaponState } from "../weapons/types";
import { createWeaponState, cycleWeaponSlot, stepWeapon } from "../weapons/weaponStep";
import { WEAPONS } from "../weapons/weapons";
import { IDLE_EQUIPMENT_INPUT, createPlayerEquipment, deriveEquipmentModifiers, stepPlayerEquipment, type PlayerEquipmentState } from "./equipmentStep";
import { countItem, createInventory, drop, pickUp, wantsAutoPickup, type InventoryResult, type InventoryState } from "./inventory";
import { createOfflineInventory, createTestLoot } from "./presets";
import { THROW } from "./throw";
import { commitWeaponsToInventory, gateCombatInput, syncWeaponsFromInventory, weaponStateFromInventory, type WeaponLoadoutOptions } from "./weaponLoadout";

const DT = 1 / 60;
const idle: CombatInput = { fire: false, aim: false, reload: false, selectIndex: null };
const ctx: WeaponContext = { eye: { x: 0, y: 1.65, z: 0 }, yaw: 0, pitch: 0, horizontalSpeed: 0, grounded: true, sprinting: false };
const fromItems: WeaponLoadoutOptions = { ammoFromInventory: true };

function ok<T>(result: InventoryResult<T>): InventoryState {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.inventory;
}

/** The CombatSystem tick: sync from the inventory, step (gated), commit magazines and ammo back. */
function combatTick(state: WeaponState, inventory: InventoryState, input: Partial<CombatInput>, options = fromItems) {
  const synced = syncWeaponsFromInventory(state, inventory, options);
  const step = stepWeapon(synced.state, { ...idle, ...input }, ctx, DT);
  return {
    state: step.state,
    inventory: commitWeaponsToInventory(synced.state, step.state, inventory, options),
    shots: step.shots.length,
    events: [...synced.events, ...step.events] as WeaponEvent[],
  };
}

describe("empty weapon slots", () => {
  it("creates states with empty slots and starts on the first filled one", () => {
    const state = createWeaponState([null, "sniper", "pistol"]);
    expect(state.slots[0]).toBeNull();
    expect(state.activeIndex).toBe(1);
    expect(createWeaponState([null, null]).activeIndex).toBe(0);
  });

  it("never selects an empty slot, and an unarmed state does nothing", () => {
    const state = createWeaponState(["rifle", null, "pistol"]);
    const select = stepWeapon(state, { ...idle, selectIndex: 1 }, ctx, DT);
    expect(select.state.activeIndex).toBe(0);
    expect(select.events).toEqual([]);

    const unarmed = createWeaponState([null, null, null]);
    for (const input of [{ fire: true }, { reload: true }, { aim: true }, { selectIndex: 2 }]) {
      const step = stepWeapon(unarmed, { ...idle, ...input }, ctx, DT);
      expect(step.shots).toEqual([]);
      expect(step.state).toMatchObject({ activeIndex: 0, phase: "ready", adsBlend: 0 });
    }
  });

  it("wheel cycling skips empty slots and wraps", () => {
    const slots = createWeaponState(["rifle", null, "pistol"]).slots;
    expect(cycleWeaponSlot(slots, 0, 1)).toBe(2);
    expect(cycleWeaponSlot(slots, 2, 1)).toBe(0);
    expect(cycleWeaponSlot(slots, 0, -1)).toBe(2);
    expect(cycleWeaponSlot(slots, 0, 2)).toBe(0);
    expect(cycleWeaponSlot(createWeaponState([null, null]).slots, 0, 1)).toBeNull();
  });
});

describe("weapon slots from the inventory", () => {
  it("mirrors inventory slots with magazines as carried and reserve from ammo items", () => {
    const inventory = createOfflineInventory();
    const state = weaponStateFromInventory(inventory, fromItems);
    expect(state.slots).toEqual([
      { id: "rifle", magazine: 30, reserve: 120 },
      { id: "sniper", magazine: 5, reserve: 20 },
      { id: "pistol", magazine: 12, reserve: 48 },
    ]);
    expect(state).toMatchObject({ activeIndex: 0, phase: "ready" });
    // Nothing changed: same object, no events.
    const again = syncWeaponsFromInventory(state, inventory, fromItems);
    expect(again.state).toBe(state);
    expect(again.events).toEqual([]);
  });

  it("swapping the active weapon draws the new one and the old one keeps its magazine on the ground", () => {
    let inventory = createOfflineInventory();
    let state = weaponStateFromInventory(inventory, fromItems);
    // Fire 3 rounds from the rifle.
    let fired = 0;
    for (let t = 0; t < 30 && fired < 3; t++) {
      const tick = combatTick(state, inventory, { fire: true });
      ({ state, inventory } = tick);
      fired += tick.shots;
    }
    expect(inventory.weapons[0]).toEqual({ weaponId: "rifle", magazine: 27 });

    const swap = pickUp(inventory, { itemId: "weapon_shotgun", quantity: 1, magazine: 4 }, 0);
    if (!swap.ok) throw new Error(swap.error);
    expect(swap.dropped).toEqual([{ itemId: "weapon_rifle", quantity: 1, magazine: 27 }]);
    const drawn = combatTick(state, swap.inventory, {});
    expect(drawn.events).toEqual([{ type: "equipStarted", weaponId: "shotgun", seconds: WEAPONS.shotgun.equipSeconds }]);
    expect(drawn.state.slots[0]).toEqual({ id: "shotgun", magazine: 4, reserve: 0 });
    expect(drawn.state.phase).toBe("equipping");

    // Picking the rifle back up (into primary 2 by swapping out the sniper) restores its 27 rounds.
    const back = ok(pickUp(drawn.inventory, swap.dropped[0]!, 1));
    const synced = syncWeaponsFromInventory(drawn.state, back, fromItems);
    expect(synced.state.slots[1]).toEqual({ id: "rifle", magazine: 27, reserve: 120 });
    expect(synced.state.activeIndex).toBe(0);
  });

  it("dropping the active weapon draws the next filled slot; dropping all leaves the player unarmed", () => {
    let inventory = createOfflineInventory();
    let state: WeaponState = { ...weaponStateFromInventory(inventory, fromItems), phase: "reloading", phaseTimer: 1 };
    inventory = ok(drop(inventory, { kind: "weapon", slot: 0 }));
    const next = syncWeaponsFromInventory(state, inventory, fromItems);
    expect(next.events).toEqual([
      { type: "reloadCancelled", weaponId: "rifle" },
      { type: "equipStarted", weaponId: "sniper", seconds: WEAPONS.sniper.equipSeconds },
    ]);
    expect(next.state.activeIndex).toBe(1);

    inventory = ok(drop(ok(drop(inventory, { kind: "weapon", slot: 1 })), { kind: "weapon", slot: 2 }));
    state = syncWeaponsFromInventory(next.state, inventory, fromItems).state;
    expect(state.slots).toEqual([null, null, null]);
    expect(state.phase).toBe("ready");
    expect(combatTick(state, inventory, { fire: true }).shots).toBe(0);

    // Unarmed: the first weapon picked up (a sidearm here) is drawn.
    inventory = ok(pickUp(inventory, { itemId: "weapon_pistol", quantity: 1, magazine: 7 }));
    const armed = syncWeaponsFromInventory(state, inventory, fromItems);
    expect(armed.state.activeIndex).toBe(2);
    expect(armed.events).toEqual([{ type: "equipStarted", weaponId: "pistol", seconds: WEAPONS.pistol.equipSeconds }]);
  });
});

describe("ammo items", () => {
  it("reload loads from the bag and consumes the loaded rounds", () => {
    let inventory = createInventory({ weapons: [{ weaponId: "rifle", magazine: 10 }, null, null], stacks: [{ itemId: "ammo_556", quantity: 12 }] });
    let state = weaponStateFromInventory(inventory, fromItems);
    const reloadTicks = Math.round(WEAPONS.rifle.reloadSeconds * 60);
    for (let t = 0; t <= reloadTicks; t++) ({ state, inventory } = combatTick(state, inventory, { reload: t === 0 }));
    expect(state.phase).toBe("ready");
    expect(inventory.weapons[0]).toEqual({ weaponId: "rifle", magazine: 22 });
    expect(countItem(inventory, "ammo_556")).toBe(0);
    expect(inventory.stacks).toEqual([]);

    // No ammo left: reload is refused.
    const refused = combatTick(state, inventory, { reload: true });
    expect(refused.state.phase).toBe("ready");
  });

  it("partial reloads leave the rest in the bag, and picked-up ammo shows as reserve on the next tick", () => {
    let inventory = createInventory({ weapons: [{ weaponId: "rifle", magazine: 25 }, null, null], stacks: [{ itemId: "ammo_556", quantity: 60 }] });
    let state = weaponStateFromInventory(inventory, fromItems);
    for (let t = 0; t <= Math.round(WEAPONS.rifle.reloadSeconds * 60); t++) ({ state, inventory } = combatTick(state, inventory, { reload: t === 0 }));
    expect(countItem(inventory, "ammo_556")).toBe(55);
    inventory = ok(pickUp(inventory, { itemId: "ammo_556", quantity: 30 }));
    const synced = syncWeaponsFromInventory(state, inventory, fromItems);
    expect(synced.state.slots[0]).toEqual({ id: "rifle", magazine: 30, reserve: 85 });
    expect(synced.events).toEqual([]);
  });

  it("keeps per-weapon reserve when the flag is off", () => {
    const options = { ammoFromInventory: false };
    const inventory = createOfflineInventory();
    const state = weaponStateFromInventory(inventory, options);
    expect(state.slots[0]).toEqual({ id: "rifle", magazine: 30, reserve: WEAPONS.rifle.reserveAmmo });
  });
});

describe("weapon gate", () => {
  it("drops fire, aim and reload while blocked, and needs a fresh press once the gate lifts", () => {
    const fire: CombatInput = { ...idle, fire: true, aim: true, reload: true, selectIndex: 1 };
    const gated = gateCombatInput(fire, false, false);
    expect(gated.input).toEqual({ ...idle, selectIndex: 1 });
    expect(gateCombatInput(fire, true, true).input.fire).toBe(false);
    expect(gateCombatInput({ ...idle }, true, true).fireLatched).toBe(false);
  });

  it("can't shoot while holding a grenade (throwable drawn, pin pulled, thrown)", () => {
    // One frag, so the hand is empty (not drawing the next grenade) after the throw.
    const inventory = createInventory({ weapons: createOfflineInventory().weapons, stacks: [{ itemId: "ammo_556", quantity: 120 }, { itemId: "frag", quantity: 1 }] });
    let equipment: PlayerEquipmentState = createPlayerEquipment(inventory);
    let weapons = weaponStateFromInventory(equipment.inventory, fromItems);
    let latched = false;
    let shots = 0;
    const eq = { eye: ctx.eye, yaw: 0, pitch: 0, velocity: { x: 0, y: 0, z: 0 } };
    const equipTicks = Math.round(THROW.equipSeconds * 60);
    const releaseTick = equipTicks + 30;
    let released = false;
    for (let t = 0; t < releaseTick + 60; t++) {
      // Fire held from the pin pull until well after the throw animation ends.
      const holding = t > equipTicks && t < releaseTick + 50;
      const fire = t >= equipTicks + 2 && t !== releaseTick && holding;
      const gate = deriveEquipmentModifiers(equipment).allowWeapons;
      const input = gateCombatInput({ ...idle, fire }, gate, latched);
      latched = input.fireLatched;
      const step = stepWeapon(weapons, input.input, ctx, DT);
      weapons = step.state;
      shots += step.shots.length;
      const result = stepPlayerEquipment(equipment, { ...IDLE_EQUIPMENT_INPUT, equipThrowablePressed: t === 0, fire, firePressed: t === equipTicks + 2 }, eq, DT);
      equipment = result.state;
      if (result.release) released = true;
      // Released at `releaseTick`; the pin was pulled before it.
      if (t === releaseTick - 1) expect(equipment.throw.phase).toBe("primed");
    }
    expect(released).toBe(true);
    expect(countItem(equipment.inventory, "frag")).toBe(0);
    expect(equipment.throw.phase).toBe("idle");
    // Gate reopened after the throw, but fire was still held from the throw: no shot until a fresh press.
    expect(shots).toBe(0);
    const press = gateCombatInput({ ...idle, fire: true }, deriveEquipmentModifiers(equipment).allowWeapons, false);
    expect(stepWeapon(weapons, press.input, ctx, DT).shots).toHaveLength(1);
  });
});

describe("auto pickup and test loot", () => {
  it("auto-picks stackables that fit, ammo only for carried weapons, never gear", () => {
    const inventory = createInventory({ weapons: [{ weaponId: "rifle", magazine: 30 }, null, null] });
    expect(wantsAutoPickup(inventory, "ammo_556")).toBe(true);
    expect(wantsAutoPickup(inventory, "ammo_12g")).toBe(false);
    expect(wantsAutoPickup(inventory, "bandage")).toBe(true);
    expect(wantsAutoPickup(inventory, "frag")).toBe(true);
    expect(wantsAutoPickup(inventory, "helmet_1")).toBe(false);
    expect(wantsAutoPickup(inventory, "weapon_pistol")).toBe(false);
    const full = createInventory({ stacks: [{ itemId: "medkit", quantity: 2 }, { itemId: "first_aid", quantity: 1 }] });
    expect(wantsAutoPickup(full, "medkit")).toBe(false);
  });

  it("puts one test pile in front of every spawn", () => {
    const items = createTestLoot([
      { position: [0, 0, 0], yaw: 0 },
      { position: [10, 2, 0], yaw: Math.PI / 2 },
    ]);
    const piles = new Set(items.map((item) => item.pileId));
    expect(piles.size).toBe(2);
    expect(new Set(items.map((item) => item.lootId)).size).toBe(items.length);
    for (const item of items.filter((i) => i.pileId === 1)) {
      expect(item.position[1]).toBe(2);
      expect(item.position[0]).toBeGreaterThan(11.5);
    }
    expect(items.some((item) => item.itemId === "weapon_shotgun")).toBe(true);
  });
});
