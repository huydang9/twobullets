import { describe, expect, it } from "vitest";
import { createArmorPiece } from "./armor";
import {
  addStack,
  capacityOf,
  consumeAmmo,
  countItem,
  createInventory,
  cycleThrowable,
  drop,
  inventoryCapacity,
  inventoryWeight,
  maxAddable,
  pickUp,
  removeStack,
  reserveFor,
  swapWeapons,
  type InventoryResult,
  type InventoryState,
} from "./inventory";
import { ITEMS } from "./items";
import { IDLE_ITEM_USE, itemUseProgress, stepItemUse, type ItemUseInput, type ItemUseState } from "./itemUse";
import { createOfflineInventory } from "./presets";
import { createVitals, type Vitals } from "./vitals";

function ok<T>(result: InventoryResult<T>): InventoryState {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.inventory;
}

describe("capacity", () => {
  it("adds vest pouches and backpack levels to the base pockets", () => {
    expect(capacityOf(0, false)).toBe(50);
    expect(capacityOf(0, true)).toBe(100);
    expect(capacityOf(1, false)).toBe(200);
    expect(capacityOf(3, true)).toBe(350);
  });

  it("takes partial stacks by weight and leaves the remainder on the ground", () => {
    const inventory = createInventory();
    // 50 capacity / 0.5 per 5.56 round = 100 rounds.
    const result = pickUp(inventory, { itemId: "ammo_556", quantity: 150 });
    if (!result.ok) throw new Error(result.error);
    expect(result.taken).toBe(100);
    expect(result.remainder).toEqual({ itemId: "ammo_556", quantity: 50 });
    expect(inventoryWeight(result.inventory)).toBe(50);
    expect(pickUp(result.inventory, { itemId: "bandage", quantity: 1 })).toEqual({ ok: false, error: "full" });
  });

  it("merges into one stack per item and respects the stack cap", () => {
    let inventory = createInventory({ backpack: 3, vest: createArmorPiece("vest", 1) });
    inventory = ok(addStack(inventory, "bandage", 30));
    inventory = ok(addStack(inventory, "bandage", 30));
    expect(inventory.stacks).toEqual([{ itemId: "bandage", quantity: 60 }]);
    expect(maxAddable(inventory, "bandage")).toBe(ITEMS.bandage.maxStack - 60);
    expect(addStack(inventory, "bandage", 0)).toEqual({ ok: false, error: "invalidQuantity" });
  });

  it("keeps stacks in catalog order", () => {
    let inventory = createInventory({ backpack: 3 });
    inventory = ok(addStack(inventory, "medkit", 1));
    inventory = ok(addStack(inventory, "ammo_9mm", 10));
    inventory = ok(addStack(inventory, "frag", 1));
    expect(inventory.stacks.map((s) => s.itemId)).toEqual(["ammo_9mm", "frag", "medkit"]);
  });
});

describe("weapons", () => {
  it("fills empty slots by class, then swaps the chosen primary and drops the old weapon", () => {
    let inventory = createInventory();
    inventory = ok(pickUp(inventory, { itemId: "weapon_pistol", quantity: 1, magazine: 3 }));
    expect(inventory.weapons[2]).toEqual({ weaponId: "pistol", magazine: 3 });
    inventory = ok(pickUp(inventory, { itemId: "weapon_rifle", quantity: 1 }));
    inventory = ok(pickUp(inventory, { itemId: "weapon_sniper", quantity: 1 }));
    expect(inventory.weapons.map((w) => w?.weaponId)).toEqual(["rifle", "sniper", "pistol"]);

    const swap = pickUp(inventory, { itemId: "weapon_shotgun", quantity: 1, magazine: 5 }, 1);
    if (!swap.ok) throw new Error(swap.error);
    expect(swap.inventory.weapons.map((w) => w?.weaponId)).toEqual(["rifle", "shotgun", "pistol"]);
    expect(swap.dropped).toEqual([{ itemId: "weapon_sniper", quantity: 1, magazine: 0 }]);

    const sidearm = pickUp(swap.inventory, { itemId: "weapon_pistol", quantity: 1, magazine: 12 }, 0);
    if (!sidearm.ok) throw new Error(sidearm.error);
    expect(sidearm.inventory.weapons[0]?.weaponId).toBe("rifle");
    expect(sidearm.dropped[0]).toMatchObject({ itemId: "weapon_pistol", magazine: 3 });
  });

  it("swaps primaries only and drops weapons with their magazine", () => {
    const inventory = createOfflineInventory();
    expect(ok(swapWeapons(inventory, 0, 1)).weapons.map((w) => w?.weaponId)).toEqual(["sniper", "rifle", "pistol"]);
    expect(swapWeapons(inventory, 0, 2)).toEqual({ ok: false, error: "invalidSlot" });
    const dropped = drop(inventory, { kind: "weapon", slot: 0 });
    if (!dropped.ok) throw new Error(dropped.error);
    expect(dropped.dropped).toEqual({ itemId: "weapon_rifle", quantity: 1, magazine: 30 });
    expect(dropped.inventory.weapons[0]).toBeNull();
    expect(drop(dropped.inventory, { kind: "weapon", slot: 0 })).toEqual({ ok: false, error: "notCarried" });
  });

  it("bridges ammo items to weapon reserve", () => {
    const inventory = createOfflineInventory();
    expect(reserveFor(inventory, "rifle")).toBe(120);
    expect(reserveFor(inventory, "shotgun")).toBe(0);
    const after = consumeAmmo(inventory, "rifle", 25);
    expect(reserveFor(after, "rifle")).toBe(95);
    expect(countItem(consumeAmmo(after, "rifle", 1000), "ammo_556")).toBe(0);
  });
});

describe("armor and backpacks", () => {
  it("swaps armor and drops the worn piece with its durability", () => {
    const inventory = createInventory({ helmet: { level: 1, durability: 12 } });
    const result = pickUp(inventory, { itemId: "helmet_3", quantity: 1, durability: 90 });
    if (!result.ok) throw new Error(result.error);
    expect(result.inventory.helmet).toEqual({ level: 3, durability: 90 });
    expect(result.dropped).toEqual([{ itemId: "helmet_1", quantity: 1, durability: 12 }]);
    const fresh = ok(pickUp(createInventory(), { itemId: "vest_2", quantity: 1 }));
    expect(fresh.vest).toEqual({ level: 2, durability: ITEMS.vest_2.durability });
  });

  it("refuses to shrink capacity below the carried weight", () => {
    let inventory = createInventory({ backpack: 2, vest: createArmorPiece("vest", 1) });
    inventory = ok(addStack(inventory, "ammo_12g", 216)); // 270 weight of 50 + 50 + 200
    expect(inventoryCapacity(inventory)).toBe(300);
    expect(pickUp(inventory, { itemId: "backpack_1", quantity: 1 })).toEqual({ ok: false, error: "overCapacity" });
    expect(drop(inventory, { kind: "backpack" })).toEqual({ ok: false, error: "overCapacity" });
    expect(drop(inventory, { kind: "armor", slot: "vest" }).ok).toBe(false);

    const bigger = pickUp(inventory, { itemId: "backpack_3", quantity: 1 });
    if (!bigger.ok) throw new Error(bigger.error);
    expect(inventoryCapacity(bigger.inventory)).toBe(350);
    expect(bigger.inventory.stacks).toEqual(inventory.stacks);
    expect(bigger.dropped).toEqual([{ itemId: "backpack_2", quantity: 1 }]);
    const lighter = ok(removeStack(inventory, "ammo_12g", 100));
    expect(drop(lighter, { kind: "armor", slot: "vest" }).ok).toBe(true);
  });
});

describe("throwable selection", () => {
  it("cycles through carried kinds and follows the stock", () => {
    let inventory = createInventory({ backpack: 1, stacks: [{ itemId: "smoke", quantity: 1 }, { itemId: "molotov", quantity: 2 }] });
    expect(inventory.selectedThrowable).toBe("smoke");
    inventory = cycleThrowable(inventory);
    expect(inventory.selectedThrowable).toBe("molotov");
    inventory = cycleThrowable(inventory);
    expect(inventory.selectedThrowable).toBe("smoke");
    inventory = ok(removeStack(inventory, "smoke", 1));
    expect(inventory.selectedThrowable).toBe("molotov");
    inventory = ok(removeStack(inventory, "molotov", 2));
    expect(inventory.selectedThrowable).toBeNull();
    expect(cycleThrowable(inventory)).toBe(inventory);
  });
});

describe("item use", () => {
  const DT = 1 / 60;
  const idle: ItemUseInput = { start: null, interrupt: false, sprint: false };

  function run(ticks: number, inputs: (tick: number) => ItemUseInput, init: { vitals?: Vitals; inventory?: InventoryState; state?: ItemUseState } = {}) {
    let state = init.state ?? IDLE_ITEM_USE;
    let inventory = init.inventory ?? createOfflineInventory();
    let vitals = init.vitals ?? { ...createVitals(), health: 40 };
    const events: { tick: number; type: string }[] = [];
    for (let t = 0; t < ticks; t++) {
      const step = stepItemUse(state, inputs(t), inventory, vitals, DT);
      ({ state, inventory, vitals } = step);
      events.push(...step.events.map((e) => ({ tick: t, type: e.type })));
    }
    return { state, inventory, vitals, events };
  }

  it("heals on completion after exactly the use time and consumes one item", () => {
    const start = (t: number): ItemUseInput => (t === 0 ? { ...idle, start: "bandage" } : idle);
    const almost = run(4 * 60 - 1, start);
    expect(almost.vitals.health).toBe(40);
    expect(itemUseProgress(almost.state)).toBeGreaterThan(0.99);
    const done = run(4 * 60, start);
    expect(done.events).toEqual([{ tick: 0, type: "useStarted" }, { tick: 239, type: "useCompleted" }]);
    expect(done.vitals.health).toBe(50);
    expect(countItem(done.inventory, "bandage")).toBe(4);
    expect(done.state.itemId).toBeNull();
  });

  it("is cancelled by sprint, fire/switch interrupts and being knocked, without healing", () => {
    const withCancel = (cancel: Partial<ItemUseInput>) => run(8 * 60, (t) => (t === 0 ? { ...idle, start: "medkit" } : t === 100 ? { ...idle, ...cancel } : idle));
    for (const cancel of [{ sprint: true }, { interrupt: true }]) {
      const result = withCancel(cancel);
      expect(result.events.map((e) => e.type)).toEqual(["useStarted", "useCancelled"]);
      expect(result.vitals.health).toBe(40);
      expect(countItem(result.inventory, "medkit")).toBe(1);
    }
    const knocked = run(10, (t) => (t === 0 ? { ...idle, start: "first_aid" } : idle));
    const downed = stepItemUse(knocked.state, idle, knocked.inventory, { ...knocked.vitals, life: "downed" }, DT);
    expect(downed.events).toEqual([{ type: "useCancelled", itemId: "first_aid", reason: "notAlive" }]);
  });

  it("rejects items that can't help or aren't carried", () => {
    const full = run(1, () => ({ ...idle, start: "bandage" }), { vitals: { ...createVitals(), health: 80 } });
    expect(full.events.map((e) => e.type)).toEqual(["useRejected"]);
    const none = run(1, () => ({ ...idle, start: "bandage" }), { inventory: createInventory() });
    expect(none.events.map((e) => e.type)).toEqual(["useRejected"]);
    expect(none.state.itemId).toBeNull();
  });

  it("switches to another item, restarting the timer", () => {
    const result = run(60 * 5, (t) => (t === 0 ? { ...idle, start: "medkit" } : t === 60 ? { ...idle, start: "energy_drink" } : idle));
    expect(result.events.map((e) => e.type)).toEqual(["useStarted", "useCancelled", "useStarted", "useCompleted"]);
    expect(result.vitals.boost).toBe(40);
    expect(countItem(result.inventory, "medkit")).toBe(1);
  });
});
