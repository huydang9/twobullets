import { Observable } from "@babylonjs/core";
import { consumableCode } from "@twobullets/protocol/codes";
import { countItem, createInventory, cycleThrowable } from "@twobullets/shared/equipment/inventory";
import { itemCode } from "@twobullets/shared/equipment/items";
import { createOfflineInventory } from "@twobullets/shared/equipment/presets";
import { createVitals } from "@twobullets/shared/equipment/vitals";
import { PlayerActionType } from "@twobullets/shared/input";
import { describe, expect, it } from "vitest";
import type { EquipmentView, UseEvent } from "../../src/equipment/types";
import type { NetOwnerVitals } from "../../src/net/NetCombat";
import { NetEquipmentView, USE_PENDING_MS } from "../../src/net/NetEquipmentView";

// Networked consumables on the client: the local equipment's use attempts become server `use` actions, the hands stay
// busy until the server's use ends, and the use ring, use events and counts follow the owner items group.

function setup() {
  const base = { onUse: new Observable<UseEvent>(), inventory: createOfflineInventory(), vitals: createVitals() };
  let now = 1000;
  const net = new NetEquipmentView(base as unknown as EquipmentView, () => now);
  const events: UseEvent[] = [];
  net.view.onUse.add((e) => events.push(e));
  const vitals = (health: number, boost = 0): NetOwnerVitals => ({ life: "alive", health, downedHealth: 0, boost, reviveSeconds: 0, helmetLevel: 0, helmetDurability: 0, vestLevel: 0, vestDurability: 0 });
  const counts = [5, 1, 1, 2, 1];
  const items = (useItem: number, useTicks: number) => net.setItems({ useItem, useTicks, counts: [...counts] });
  return { base, net, events, vitals, counts, items, advance: (ms: number) => (now += ms) };
}

describe("NetEquipmentView consumables", () => {
  it("a locally refused medkit becomes a server use; progress from the server; completion; counts follow the server", () => {
    const { base, net, events, vitals, counts, items } = setup();
    net.setVitals(vitals(40));
    items(0, 0);
    base.onUse.notifyObservers({ type: "rejected", itemId: "medkit", reason: "healthFull" });
    expect(net.takeAction()).toEqual({ type: PlayerActionType.use, arg: itemCode("medkit") });
    expect(net.takeAction()).toBeNull();
    expect(net.usingItem).toBe(true);
    expect(net.view.use).toBeNull();

    items(consumableCode("medkit"), 240);
    expect(events).toEqual([{ type: "started", itemId: "medkit", seconds: 8 }]);
    expect(net.view.use).toMatchObject({ itemId: "medkit", progress: 0.5, seconds: 8 });
    expect(net.usingItem).toBe(true);

    counts[2] = 0;
    items(0, 0);
    expect(events.at(-1)).toEqual({ type: "completed", itemId: "medkit" });
    expect(net.usingItem).toBe(false);
    expect(countItem(net.view.inventory, "medkit")).toBe(0);
    expect(countItem(net.view.inventory, "bandage")).toBe(5);

    // No medkit left on the server: refused locally, nothing sent.
    net.setVitals(vitals(60));
    base.onUse.notifyObservers({ type: "rejected", itemId: "medkit", reason: "healthFull" });
    expect(net.takeAction()).toBeNull();
    expect(events.at(-1)).toEqual({ type: "rejected", itemId: "medkit", reason: "notCarried" });
    // Full health by the server's vitals.
    net.setVitals(vitals(100));
    net.requestUse("bandage");
    expect(net.takeAction()).toBeNull();
    expect(events.at(-1)).toEqual({ type: "rejected", itemId: "bandage", reason: "healthFull" });
  });

  it("interrupt sends cancel and frees the hands at once; a lost use frees them after the pending window", () => {
    const { net, events, vitals, items, advance } = setup();
    net.setVitals(vitals(50));
    items(0, 0);
    net.requestUse("bandage");
    net.takeAction();
    items(consumableCode("bandage"), 30);
    net.interrupt();
    expect(net.takeAction()).toEqual({ type: PlayerActionType.cancel, arg: 0 });
    expect(net.usingItem).toBe(false);
    expect(net.view.use).toBeNull();
    // The server's older snapshots still show the use; then it reports idle with the bandage kept.
    items(consumableCode("bandage"), 40);
    expect(net.usingItem).toBe(false);
    items(0, 0);
    expect(events.at(-1)).toEqual({ type: "cancelled", itemId: "bandage", reason: "interrupted" });
    // Not in use: nothing to cancel.
    net.interrupt();
    expect(net.takeAction()).toBeNull();

    net.requestUse("first_aid");
    expect(net.takeAction()?.type).toBe(PlayerActionType.use);
    advance(USE_PENDING_MS - 1);
    expect(net.usingItem).toBe(true);
    advance(1);
    expect(net.usingItem).toBe(false);
  });

  it("the boost hotkey falls back to the carried boost by the server's counts", () => {
    const { net, vitals, counts, items } = setup();
    net.setVitals(vitals(80, 10));
    counts[3] = 0;
    items(0, 0);
    net.requestUse("energy_drink");
    expect(net.takeAction()).toEqual({ type: PlayerActionType.use, arg: itemCode("painkiller") });
  });
});

describe("NetEquipmentView throwables", () => {
  it("the selected throwable follows the local equipment's selection (HUD slot 5, inventory chips)", () => {
    const base = { onUse: new Observable<UseEvent>(), inventory: createInventory({ stacks: [{ itemId: "frag", quantity: 2 }, { itemId: "smoke", quantity: 1 }] }), vitals: createVitals() };
    const net = new NetEquipmentView(base as unknown as EquipmentView, () => 1000);
    expect(base.inventory.selectedThrowable).toBe("frag");
    expect(net.view.inventory.selectedThrowable).toBe("frag");
    // The server's items group rebuilds the stacks; the selection is kept.
    net.setItems({ useItem: 0, useTicks: 0, counts: [1, 0, 0, 0, 0] });
    expect(net.view.inventory.selectedThrowable).toBe("frag");
    // G on the local equipment.
    base.inventory = cycleThrowable(base.inventory);
    expect(net.view.inventory.selectedThrowable).toBe("smoke");
    expect(countItem(net.view.inventory, "smoke")).toBe(1);
  });
});
