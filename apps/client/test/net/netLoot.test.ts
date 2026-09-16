import { Observable } from "@babylonjs/core";
import { createBitReader } from "@twobullets/protocol/bits";
import { decodePickupArg, encodePickupArg, LootUpdateWriter, NetInventoryOp } from "@twobullets/protocol/messages/loot";
import type { OwnerItemsBlock } from "@twobullets/protocol/messages/snapshot";
import { ITEM_IDS } from "@twobullets/shared/equipment/items";
import type { LootItem } from "@twobullets/shared/equipment/loot";
import { createVitals } from "@twobullets/shared/equipment/vitals";
import { PlayerActionType } from "@twobullets/shared/input";
import { decodeDropArg } from "@twobullets/shared/match/rules";
import type { RaycastFn, WeaponState } from "@twobullets/shared/weapons/types";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";
import { describe, expect, it } from "vitest";
import type { EquipmentView, ItemEvent, UseEvent } from "../../src/equipment/types";
import { createNetLocalInventory, NetEquipmentView, PICKUP_PENDING_MS, type NetLootTick } from "../../src/net/NetEquipmentView";
import { NetLoot } from "../../src/net/NetLoot";

// Networked ground loot on the client (protocol v7): the stream mirror, and the equipment view's loot interaction —
// nearby items and the F target against the server's loot, pickups/drops/swaps checked locally and sent as actions, and
// `picked` events only once the server's loot stream shows the item taken.

const item = (lootId: number, itemId: LootItem["itemId"], x: number, z: number, quantity = 1, extra: Partial<LootItem> = {}): LootItem => ({ lootId, pileId: 1, itemId, quantity, position: [x, 0, z], ...extra });

function send(loot: NetLoot, build: (w: LootUpdateWriter) => void): void {
  const w = new LootUpdateWriter();
  build(w);
  const bytes = w.finish()!;
  expect(loot.apply(createBitReader(bytes), bytes.length)).toBe(true);
}

function setup() {
  let now = 1000;
  let weapons: WeaponState = createWeaponState(["rifle", null, "pistol"]);
  const base = { onUse: new Observable<UseEvent>(), inventory: createNetLocalInventory(), vitals: createVitals(), autoPickup: true };
  const net = new NetEquipmentView(base as unknown as EquipmentView, () => now, () => weapons);
  const events: ItemEvent[] = [];
  net.view.onItem.add((e) => events.push(e));
  const items = (ammo: number[], backpack = 1, counts = [0, 0, 0, 0, 0]): void => net.setItems({ useItem: 0, useTicks: 0, counts, backpack, ammo } satisfies OwnerItemsBlock);
  items([60, 0, 24, 0]);
  let wall = false;
  const raycast: RaycastFn = () => (wall ? { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, fraction: 0.5, colliderId: null } : null);
  const tick = (overrides: Partial<NetLootTick> = {}) =>
    net.tickLoot({ eye: { x: 0, y: 1.6, z: 0 }, viewDir: { x: 0, y: -0.5, z: 0.87 }, feet: { x: 0, y: 0, z: 0 }, alive: true, interactPressed: false, reviveCandidate: false, raycast, ...overrides });
  /** Six ticks: one nearby refresh. */
  const refresh = (overrides: Partial<NetLootTick> = {}) => {
    for (let i = 0; i < 6; i++) tick(overrides);
  };
  return {
    net,
    events,
    items,
    tick,
    refresh,
    advance: (ms: number) => (now += ms),
    setWall: (v: boolean) => (wall = v),
    setWeapons: (w: WeaponState) => (weapons = w),
    actions: () => {
      const out = [];
      for (let a = net.takeAction(); a !== null; a = net.takeAction()) out.push(a);
      return out;
    },
  };
}

describe("NetLoot mirror", () => {
  it("applies spawns, quantity changes, removals, forgotten cells and clears; own drops are flagged", () => {
    const loot = new NetLoot();
    const taken: [number, number][] = [];
    loot.listener = { onTaken: (it, remaining) => taken.push([it.lootId, remaining]) };
    send(loot, (w) => {
      w.spawn(item(1, "weapon_rifle", 1.234, 5.678, 1, { magazine: 12 }));
      w.spawn(item(2, "vest_2", 1, 5, 1, { durability: 71.3 }));
      w.spawn(item(3, "ammo_556", 300, 0, 30), true);
    });
    expect(loot.ground.items.get(1)).toEqual({ lootId: 1, pileId: 1, itemId: "weapon_rifle", quantity: 1, magazine: 12, position: [1.23, 0, 5.68] });
    expect(loot.ground.items.get(2)).toMatchObject({ durability: 71.3 });
    expect(loot.ownDrops.has(3)).toBe(true);
    const version = loot.ground.version;
    send(loot, (w) => {
      w.quantity(3, 10);
      w.remove(1);
    });
    expect(loot.ground.items.get(3)).toMatchObject({ quantity: 10 });
    expect(loot.ground.items.has(1)).toBe(false);
    expect(taken).toEqual([
      [3, 10],
      [1, 0],
    ]);
    expect(loot.ground.version).toBeGreaterThan(version);
    // Forget the cell of item 3 (x = 300): item 2 stays.
    send(loot, (w) => w.forgetCell(Math.floor((0 + 1024) / 32) * 64 + Math.floor((300 + 1024) / 32)));
    expect([...loot.ground.items.keys()]).toEqual([2]);
    send(loot, (w) => w.clear());
    expect(loot.ground.items.size).toBe(0);
    // Malformed: nothing applied.
    expect(loot.apply(createBitReader(Uint8Array.from([0x4e])), 1)).toBe(false);
    expect(loot.stats.malformed).toBe(1);
  });
});

describe("NetEquipmentView loot", () => {
  it("inventory from the server: weapons from the predicted weapon state, ammo and backpack from the items group", () => {
    const { net, items, setWeapons } = setup();
    expect(net.view.inventory.weapons.map((w) => w?.weaponId ?? null)).toEqual(["rifle", null, "pistol"]);
    expect(net.view.inventory.stacks).toEqual([
      { itemId: "ammo_556", quantity: 60 },
      { itemId: "ammo_9mm", quantity: 24 },
      { itemId: "frag", quantity: 1 },
      { itemId: "smoke", quantity: 1 },
    ]);
    expect(net.view.inventory.backpack).toBe(1);
    items([30, 15, 24, 0], 2, [5, 0, 0, 0, 0]);
    expect(net.view.inventory.stacks.map((s) => [s.itemId, s.quantity])).toEqual([
      ["ammo_556", 30],
      ["ammo_762", 15],
      ["ammo_9mm", 24],
      ["frag", 1],
      ["smoke", 1],
      ["bandage", 5],
    ]);
    expect(net.view.capacity.max).toBe(250);
    const shown = net.view.inventory;
    expect(net.view.inventory).toBe(shown);
    setWeapons(createWeaponState(["sniper", "rifle", "pistol"]));
    expect(net.view.inventory.weapons.map((w) => w?.weaponId ?? null)).toEqual(["sniper", "rifle", "pistol"]);
    expect((net.view as unknown as { activeWeaponSlot: number | null }).activeWeaponSlot).toBe(0);
  });

  it("F picks up the target in reach and sight once; the picked event waits for the server; walls, revive and death hide loot", () => {
    const { net, events, tick, refresh, advance, setWall, actions } = setup();
    send(net.loot, (w) => {
      w.spawn(item(7, "vest_2", 0, 1.2, 1, { durability: 100 }));
      w.spawn(item(8, "backpack_3", 0.4, 6));
    });
    refresh();
    expect(net.view.nearbyLoot.map((it) => it.lootId)).toEqual([7]);
    expect(net.view.lootTarget?.lootId).toBe(7);
    expect(net.view.groundLoot!.items.size).toBe(2);

    tick({ interactPressed: true });
    tick({ interactPressed: true });
    expect(actions()).toEqual([{ type: PlayerActionType.pickup, arg: encodePickupArg(7) }]);
    expect(events).toEqual([]);
    // The server took it: picked (the HUD feed and pickup sound).
    send(net.loot, (w) => w.remove(7));
    expect(events).toEqual([{ type: "picked", item: { itemId: "vest_2", quantity: 1, durability: 100 }, lootId: 7, taken: 1 }]);
    refresh();
    expect(net.view.lootTarget).toBeNull();

    // A refused pickup can be retried after the pending window.
    send(net.loot, (w) => w.spawn(item(9, "helmet_1", 0.3, 1, 1, { durability: 40 })));
    tick({ interactPressed: true });
    expect(actions()).toHaveLength(1);
    tick({ interactPressed: true });
    expect(actions()).toHaveLength(0);
    advance(PICKUP_PENDING_MS);
    tick({ interactPressed: true });
    expect(actions()).toHaveLength(1);

    setWall(true);
    refresh();
    expect(net.view.lootTarget).toBeNull();
    setWall(false);
    refresh({ reviveCandidate: true });
    expect(net.view.lootTarget).toBeNull();
    refresh({ alive: false });
    expect(net.view.nearbyLoot).toEqual([]);
  });

  it("a full bag fails locally with no action; auto pickup takes ammo for a carried gun but not our own drops", () => {
    const { net, events, items, refresh, actions } = setup();
    // Pockets only, full of 9 mm.
    items([0, 0, 500, 0], 0);
    send(net.loot, (w) => w.spawn(item(20, "bandage", 0, 2, 5)));
    refresh();
    net.pickUp(20);
    expect(actions()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "pickupFailed", lootId: 20, error: "full" });

    items([0, 0, 24, 0], 1);
    send(net.loot, (w) => {
      w.spawn(item(21, "ammo_556", 0.3, 0.2, 30));
      w.spawn(item(22, "ammo_9mm", -0.3, 0.2, 25), true);
      w.spawn(item(23, "ammo_762", 0.2, -0.3, 15));
    });
    refresh();
    // 5.56 for the rifle; the 9 mm is our own drop; no sniper for 7.62.
    expect(actions()).toEqual([{ type: PlayerActionType.pickup, arg: encodePickupArg(21) }]);
  });

  it("drops: a whole stack as quantity 0, big splits in chunks of 255, gear by slot; swap primaries; inventory drag sends the slot", () => {
    const { net, items, setWeapons, actions, events } = setup();
    items([600, 0, 24, 0], 3);
    net.drop({ kind: "stack", itemId: "ammo_556", quantity: 600 });
    net.drop({ kind: "stack", itemId: "ammo_556", quantity: 300 });
    net.drop({ kind: "weapon", slot: 2 });
    const sent = actions().map((a) => ({ type: a.type, target: decodeDropArg(a.arg) }));
    const code = ITEM_IDS.indexOf("ammo_556");
    expect(sent).toEqual([
      { type: PlayerActionType.drop, target: { kind: "stack", code, quantity: 0 } },
      { type: PlayerActionType.drop, target: { kind: "stack", code, quantity: 255 } },
      { type: PlayerActionType.drop, target: { kind: "stack", code, quantity: 45 } },
      { type: PlayerActionType.drop, target: { kind: "weapon", slot: 2 } },
    ]);
    net.drop({ kind: "armor", slot: "vest" });
    expect(actions()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "dropFailed", error: "notCarried" });

    setWeapons(createWeaponState(["rifle", "shotgun", "pistol"]));
    net.swapPrimaries();
    expect(actions()).toEqual([{ type: PlayerActionType.equipAttach, arg: NetInventoryOp.swapPrimaries }]);

    send(net.loot, (w) => w.spawn(item(30, "weapon_sniper", 0, 1, 1, { magazine: 5 })));
    net.pickUp(30, 1);
    const [pickup] = actions();
    expect(decodePickupArg(pickup!.arg)).toEqual({ lootId: 30, replaceSlot: 1 });
  });
});
