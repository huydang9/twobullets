import type { SpawnPoint } from "../level/types";
import { WEAPONS } from "../weapons/weapons";
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

/** Starting kit amounts: two spare magazines per gun and a level 1 backpack to carry them and what gets looted. */
export const STARTING_KIT = {
  rifleReserve: 60,
  pistolReserve: 24,
  frags: 1,
  smokes: 1,
  backpack: 1,
} as const;

/**
 * What every player and bot starts a match with (offline practice, plain offline, respawns): the AR-4 and the P-9
 * with loaded magazines and two spare magazines each, one frag and one smoke, in a level 1 backpack (weight 65.6 of 200).
 * `throwables: false` leaves the grenades out and the backpack off (networked play: the server doesn't simulate
 * throwables yet, and its kit is separate).
 */
export function createStartingInventory(options: { readonly throwables?: boolean } = {}): InventoryState {
  const throwables = options.throwables ?? true;
  return createInventory({
    weapons: [{ weaponId: "rifle", magazine: WEAPONS.rifle.magazineSize }, null, { weaponId: "pistol", magazine: WEAPONS.pistol.magazineSize }],
    backpack: throwables ? STARTING_KIT.backpack : 0,
    stacks: [
      { itemId: "ammo_556", quantity: STARTING_KIT.rifleReserve },
      { itemId: "ammo_9mm", quantity: STARTING_KIT.pistolReserve },
      ...(throwables
        ? [
            { itemId: "frag", quantity: STARTING_KIT.frags },
            { itemId: "smoke", quantity: STARTING_KIT.smokes },
          ] as const
        : []),
    ],
  });
}

/**
 * Networked starting kit (protocol v7): the practice kit without throwables (the server doesn't simulate them), keeping
 * the level 1 backpack: AR-4 and P-9 with loaded magazines, 60 5.56 mm and 24 9 mm spare rounds.
 */
export function createNetStartingInventory(): InventoryState {
  return createInventory({ ...createStartingInventory({ throwables: false }), backpack: STARTING_KIT.backpack });
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
