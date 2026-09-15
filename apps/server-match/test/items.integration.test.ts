import { consumableCode, type OwnerItemsBlock } from "@twobullets/protocol";
import { NET_RESPAWN_SECONDS } from "@twobullets/contracts";
import { createInventory } from "@twobullets/shared/equipment/inventory";
import { itemCode, ITEMS, type ConsumableItemId } from "@twobullets/shared/equipment/items";
import { createOfflineInventory } from "@twobullets/shared/equipment/presets";
import { Btn, PlayerActionType } from "@twobullets/shared/input";
import type { HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import { createHarness } from "./harness";

// Networked consumables (plan.md B5): the `use` input action runs the shared timed use on the server's vitals, the
// same interrupts as offline cancel it, and the owner items group reports use progress and counts. Heals come from loot
// now, so each test hands the player the offline kit's consumables.

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
});

async function setup() {
  const h = await createHarness(havok);
  const client = h.connect({ team: 0, seed: 51, interpDelayMs: 25 });
  const pending: { action: { type: 3 | 4; arg: number } | null; buttons: number } = { action: null, buttons: 0 };
  client.script = (_tick, e) => {
    e.forward = 0;
    e.right = 0;
    e.select = 0;
    e.buttons = pending.buttons;
    e.action = pending.action;
    pending.action = null;
  };
  let items: OwnerItemsBlock | null = null;
  client.onSnapshot = (snap) => {
    if (snap.items) items = { useItem: snap.items.useItem, useTicks: snap.items.useTicks, counts: [...snap.items.counts] };
  };
  h.run(300);
  const player = h.match.player(client.playerSlot)!;
  const heals = createOfflineInventory().stacks.filter((stack) => ITEMS[stack.itemId].category === "heal" || ITEMS[stack.itemId].category === "boost");
  player.inventory = createInventory({ ...player.inventory, stacks: [...player.inventory.stacks, ...heals] });
  h.run(100);
  const use = (id: ConsumableItemId) => (pending.action = { type: PlayerActionType.use, arg: itemCode(id) });
  const cancel = () => (pending.action = { type: PlayerActionType.cancel, arg: 0 });
  const count = (id: ConsumableItemId) => items!.counts[consumableCode(id) - 1];
  return { h, player, pending, use, cancel, count, items: () => items };
}

describe("networked consumables", () => {
  it("medkit: 40 → 100 after its 8 s, one used, progress and counts in the owner items group; count 0 is rejected", async () => {
    const { h, player, use, count, items } = await setup();
    expect(count("medkit")).toBe(1);
    expect(count("bandage")).toBe(5);
    h.match.combat!.zoneDamage(player, 60);
    expect(player.vitals.health).toBe(40);

    use("medkit");
    h.run(4000);
    expect(player.use.itemId).toBe("medkit");
    expect(player.vitals.health).toBe(40);
    expect(items()!.useItem).toBe(consumableCode("medkit"));
    expect(items()!.useTicks).toBeGreaterThan(200);
    h.run(4300);
    expect(player.use.itemId).toBeNull();
    expect(player.vitals.health).toBe(100);
    expect(items()!.useItem).toBe(0);
    expect(count("medkit")).toBe(0);
    expect(h.match.items.stats).toMatchObject({ started: 1, completed: 1 });

    h.match.combat!.zoneDamage(player, 30);
    const rejected = h.match.items.stats.rejected;
    use("medkit");
    h.run(9000);
    expect(h.match.items.stats.rejected).toBe(rejected + 1);
    expect(player.use.itemId).toBeNull();
    expect(player.vitals.health).toBe(70);
    await h.dispose();
  }, 60_000);

  it("interrupts cancel without using the item: the cancel action, a jump press, sprinting forward", async () => {
    const { h, player, pending, use, cancel, count } = await setup();
    h.match.combat!.zoneDamage(player, 50);
    use("bandage");
    h.run(1000);
    expect(player.use.itemId).toBe("bandage");
    cancel();
    h.run(100);
    expect(player.use.itemId).toBeNull();

    use("bandage");
    h.run(1000);
    pending.buttons = Btn.jump;
    h.run(100);
    pending.buttons = 0;
    expect(player.use.itemId).toBeNull();

    use("first_aid");
    h.run(1000);
    expect(player.use.itemId).toBe("first_aid");
    h.run(1000);
    expect(player.use.itemId).toBe("first_aid");
    h.run(5000);
    expect(player.vitals.health).toBe(75);
    expect(count("first_aid")).toBe(0);
    expect(count("bandage")).toBe(5);
    expect(h.match.items.stats.cancelled).toBe(2);
    await h.dispose();
  }, 60_000);

  it("energy drink: +40 boost after 4 s, then heals over time while the boost decays", async () => {
    const { h, player, use, count } = await setup();
    h.match.combat!.zoneDamage(player, 50);
    use("energy_drink");
    h.run(4200);
    expect(count("energy_drink")).toBe(1);
    expect(player.vitals.boost).toBeGreaterThan(39);
    expect(player.vitals.health).toBe(50);
    h.run(13_000);
    // Two 6 s pulses at 2 HP (boost above 20).
    expect(player.vitals.health).toBe(54);
    expect(player.vitals.boost).toBeLessThan(35);
    await h.dispose();
  }, 60_000);

  it("starting kit at join and respawn: AR-4 and P-9 loaded with 60/24 spare rounds, a level 1 backpack, no grenades or heals", async () => {
    const { h, player, count } = await setup();
    const expectKit = () => {
      expect(player.state.weapon.slots.map((slot) => (slot ? { id: slot.id, magazine: slot.magazine } : null))).toEqual([
        { id: "rifle", magazine: 30 },
        null,
        { id: "pistol", magazine: 12 },
      ]);
      expect(player.state.weapon.slots[0]!.reserve).toBe(60);
      expect(player.state.weapon.slots[2]!.reserve).toBe(24);
      expect(player.inventory.stacks).toEqual([
        { itemId: "ammo_556", quantity: 60 },
        { itemId: "ammo_9mm", quantity: 24 },
      ]);
      expect(player.inventory.backpack).toBe(1);
    };
    h.match.respawn(player);
    h.run(100);
    expectKit();
    expect(count("medkit")).toBe(0);

    h.match.combat!.zoneDamage(player, 100);
    expect(player.life).toBe("dead");
    expect(player.inventory.stacks).toEqual([]);
    h.run(NET_RESPAWN_SECONDS * 1000 + 500);
    expect(player.life).toBe("alive");
    expectKit();
    await h.dispose();
  }, 60_000);
});
