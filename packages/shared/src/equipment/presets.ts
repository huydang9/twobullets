import type { SpawnPoint } from "../level/types";
import { createArmorPiece } from "./armor";
import { createInventory, type InventoryState, type ItemInstance } from "./inventory";
import type { LootItem } from "./loot";

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

/** What each arena test pile holds: the shotgun (no longer in the kit), its shells and one of each gear family. */
const TEST_PILE: readonly ItemInstance[] = [
  { itemId: "weapon_shotgun", quantity: 1, magazine: 0 },
  { itemId: "ammo_12g", quantity: 20 },
  { itemId: "ammo_556", quantity: 60 },
  { itemId: "weapon_pistol", quantity: 1, magazine: 12 },
  { itemId: "helmet_3", quantity: 1, durability: 110 },
  { itemId: "vest_1", quantity: 1, durability: 60 },
  { itemId: "backpack_3", quantity: 1 },
  { itemId: "bandage", quantity: 5 },
  { itemId: "medkit", quantity: 1 },
  { itemId: "frag", quantity: 2 },
  { itemId: "smoke", quantity: 1 },
  { itemId: "energy_drink", quantity: 1 },
];

/**
 * Offline arena loot: one pile 3 m in front of every spawn point (toward where the spawn faces), laid out in a 0.55 m
 * grid on the spawn's floor height, so whichever spawn the player gets has something to try pickups with.
 */
export function createTestLoot(spawns: readonly SpawnPoint[], distance = 3): LootItem[] {
  const items: LootItem[] = [];
  const columns = 4;
  const spacing = 0.55;
  spawns.forEach((spawn, pileId) => {
    const [x, y, z] = spawn.position;
    const forward = { x: Math.sin(spawn.yaw), z: Math.cos(spawn.yaw) };
    const right = { x: forward.z, z: -forward.x };
    const rows = Math.ceil(TEST_PILE.length / columns);
    TEST_PILE.forEach((instance, k) => {
      const across = ((k % columns) - (columns - 1) / 2) * spacing;
      const along = distance + (Math.floor(k / columns) - (rows - 1) / 2) * spacing;
      const position: LootItem["position"] = [round3(x + forward.x * along + right.x * across), y, round3(z + forward.z * along + right.z * across)];
      items.push({ ...instance, lootId: items.length, pileId, position });
    });
  });
  return items;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
