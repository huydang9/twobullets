import { createArmorPiece } from "./armor";
import { createInventory, type InventoryState } from "./inventory";

/**
 * Offline sandbox kit until landing and looting replace spawning with gear: the current weapons (the sniper is the
 * second primary; the shotgun has no slot and spawns as loot in phase 2), level 2 armor and backpack, and a few of each
 * throwable and consumable so every feature can be tried at once.
 */
export function createOfflineInventory(): InventoryState {
  return createInventory({
    weapons: [
      { weaponId: "rifle", magazine: 30 },
      { weaponId: "sniper", magazine: 5 },
      { weaponId: "pistol", magazine: 12 },
    ],
    helmet: createArmorPiece("helmet", 2),
    vest: createArmorPiece("vest", 2),
    backpack: 2,
    stacks: [
      { itemId: "ammo_556", quantity: 120 },
      { itemId: "ammo_762", quantity: 20 },
      { itemId: "ammo_9mm", quantity: 48 },
      { itemId: "frag", quantity: 3 },
      { itemId: "smoke", quantity: 2 },
      { itemId: "flash", quantity: 2 },
      { itemId: "molotov", quantity: 2 },
      { itemId: "bandage", quantity: 5 },
      { itemId: "first_aid", quantity: 1 },
      { itemId: "medkit", quantity: 1 },
      { itemId: "energy_drink", quantity: 2 },
      { itemId: "painkiller", quantity: 1 },
    ],
  });
}
