import type { WeaponId } from "../weapons/types";

// Item catalog. Weights are PUBG-style capacity units; times in seconds; health/boost in points.
// Tuning rationale lives in docs/equipment/design.md §2.

export type ItemCategory = "weapon" | "ammo" | "throwable" | "heal" | "boost" | "helmet" | "vest" | "backpack" | "attachment";

export type ThrowableKind = "frag" | "smoke" | "flash" | "molotov";
export type AmmoItemId = "ammo_556" | "ammo_12g" | "ammo_9mm" | "ammo_762";
export type WeaponItemId = `weapon_${WeaponId}`;
export type HealItemId = "bandage" | "first_aid" | "medkit";
export type BoostItemId = "energy_drink" | "painkiller";
export type ConsumableItemId = HealItemId | BoostItemId;
export type ArmorLevel = 1 | 2 | 3;
export type HelmetItemId = `helmet_${ArmorLevel}`;
export type VestItemId = `vest_${ArmorLevel}`;
export type BackpackItemId = `backpack_${ArmorLevel}`;

export type ItemId = WeaponItemId | AmmoItemId | ThrowableKind | ConsumableItemId | HelmetItemId | VestItemId | BackpackItemId;

interface ItemDefBase {
  readonly id: ItemId;
  readonly name: string;
  /** Capacity used per unit in the bag. Slot items (weapons, armor, backpacks) weigh nothing. */
  readonly weight: number;
  /** Largest stack in one bag row or ground item (fits the u10 quantity on the wire). */
  readonly maxStack: number;
}

export interface WeaponItemDef extends ItemDefBase {
  readonly category: "weapon";
  readonly id: WeaponItemId;
  readonly weaponId: WeaponId;
  /** Primaries go in slots 1–2, sidearms in slot 3. */
  readonly weaponClass: "primary" | "sidearm";
  readonly ammo: AmmoItemId;
}

export interface AmmoItemDef extends ItemDefBase {
  readonly category: "ammo";
  readonly id: AmmoItemId;
  /** Rounds in one ground pickup. */
  readonly lootQuantity: number;
}

export interface ThrowableItemDef extends ItemDefBase {
  readonly category: "throwable";
  readonly id: ThrowableKind;
  /**
   * Frag: total fuse from cook start (or from release when not cooked). Smoke/flash: fuse from release.
   * Molotov: longest flight before it shatters in the air.
   */
  readonly fuseSeconds: number;
  /** R while the pin is pulled starts the fuse in hand. */
  readonly cookable: boolean;
  /** Shatters on its first impact instead of bouncing. */
  readonly detonateOnImpact: boolean;
  /** Normal velocity kept on a bounce. */
  readonly restitution: number;
  /** Tangential velocity lost on a bounce. */
  readonly friction: number;
}

export interface ConsumableItemDef extends ItemDefBase {
  readonly category: "heal" | "boost";
  readonly id: ConsumableItemId;
  readonly useSeconds: number;
  /** Health added on completion (null = heal straight to the cap). */
  readonly healAmount: number | null;
  /** Health the item can't heal beyond; the item can't be used at or above it. */
  readonly healCap: number;
  /** Boost points added on completion. */
  readonly boostAmount: number;
}

export interface ArmorItemDef extends ItemDefBase {
  readonly category: "helmet" | "vest";
  readonly id: HelmetItemId | VestItemId;
  readonly level: ArmorLevel;
  /** Fraction of zone damage absorbed while durability remains. */
  readonly reduction: number;
  /** Absorbed damage the piece can take before it is destroyed. */
  readonly durability: number;
}

export interface BackpackItemDef extends ItemDefBase {
  readonly category: "backpack";
  readonly id: BackpackItemId;
  readonly level: ArmorLevel;
  /** Capacity added to the base pockets. */
  readonly capacity: number;
}

export type ItemDef = WeaponItemDef | AmmoItemDef | ThrowableItemDef | ConsumableItemDef | ArmorItemDef | BackpackItemDef;

export const INVENTORY = {
  /** Pockets with no backpack or vest. */
  baseCapacity: 50,
  /** Any vest adds pouches. */
  vestCapacity: 50,
} as const;

const weapon = (weaponId: WeaponId, name: string, weaponClass: WeaponItemDef["weaponClass"], ammo: AmmoItemId): WeaponItemDef => ({
  id: `weapon_${weaponId}`,
  name,
  category: "weapon",
  weight: 0,
  maxStack: 1,
  weaponId,
  weaponClass,
  ammo,
});

const ammo = (id: AmmoItemId, name: string, weight: number, lootQuantity: number): AmmoItemDef => ({ id, name, category: "ammo", weight, maxStack: 999, lootQuantity });

const armor = (category: "helmet" | "vest", level: ArmorLevel, durability: number): ArmorItemDef => ({
  id: `${category}_${level}`,
  name: `${category === "helmet" ? "Helmet" : "Vest"} (Lv.${level})`,
  category,
  weight: 0,
  maxStack: 1,
  level,
  reduction: ARMOR_REDUCTION[level - 1]!,
  durability,
});

/** Same absorption for helmets and vests of a level. */
const ARMOR_REDUCTION = [0.3, 0.4, 0.55] as const;

const backpack = (level: ArmorLevel, capacity: number): BackpackItemDef => ({
  id: `backpack_${level}`,
  name: `Backpack (Lv.${level})`,
  category: "backpack",
  weight: 0,
  maxStack: 1,
  level,
  capacity,
});

export const ITEMS = {
  weapon_rifle: weapon("rifle", "AR-4", "primary", "ammo_556"),
  weapon_shotgun: weapon("shotgun", "S-12", "primary", "ammo_12g"),
  weapon_sniper: weapon("sniper", "K-98", "primary", "ammo_762"),
  weapon_pistol: weapon("pistol", "P-9", "sidearm", "ammo_9mm"),

  ammo_556: ammo("ammo_556", "5.56mm", 0.5, 30),
  ammo_762: ammo("ammo_762", "7.62mm", 0.7, 15),
  ammo_9mm: ammo("ammo_9mm", "9mm", 0.4, 25),
  ammo_12g: ammo("ammo_12g", "12 Gauge", 1.25, 10),

  frag: { id: "frag", name: "Frag Grenade", category: "throwable", weight: 12, maxStack: 99, fuseSeconds: 4.5, cookable: true, detonateOnImpact: false, restitution: 0.35, friction: 0.25 },
  smoke: { id: "smoke", name: "Smoke Grenade", category: "throwable", weight: 14, maxStack: 99, fuseSeconds: 2, cookable: false, detonateOnImpact: false, restitution: 0.3, friction: 0.3 },
  flash: { id: "flash", name: "Flashbang", category: "throwable", weight: 12, maxStack: 99, fuseSeconds: 2, cookable: false, detonateOnImpact: false, restitution: 0.4, friction: 0.25 },
  molotov: { id: "molotov", name: "Molotov Cocktail", category: "throwable", weight: 16, maxStack: 99, fuseSeconds: 4, cookable: false, detonateOnImpact: true, restitution: 0.2, friction: 0.4 },

  bandage: { id: "bandage", name: "Bandage", category: "heal", weight: 2, maxStack: 99, useSeconds: 4, healAmount: 10, healCap: 75, boostAmount: 0 },
  first_aid: { id: "first_aid", name: "First Aid Kit", category: "heal", weight: 10, maxStack: 99, useSeconds: 6, healAmount: null, healCap: 75, boostAmount: 0 },
  medkit: { id: "medkit", name: "Med Kit", category: "heal", weight: 20, maxStack: 99, useSeconds: 8, healAmount: null, healCap: 100, boostAmount: 0 },
  energy_drink: { id: "energy_drink", name: "Energy Drink", category: "boost", weight: 4, maxStack: 99, useSeconds: 4, healAmount: 0, healCap: 100, boostAmount: 40 },
  painkiller: { id: "painkiller", name: "Painkiller", category: "boost", weight: 10, maxStack: 99, useSeconds: 6, healAmount: 0, healCap: 100, boostAmount: 60 },

  // Durability is absorbed damage: an L2 vest soaks ~1.3 rifle kills' worth of body shots before breaking.
  helmet_1: armor("helmet", 1, 40),
  helmet_2: armor("helmet", 2, 70),
  helmet_3: armor("helmet", 3, 110),
  vest_1: armor("vest", 1, 60),
  vest_2: armor("vest", 2, 100),
  vest_3: armor("vest", 3, 150),

  backpack_1: backpack(1, 150),
  backpack_2: backpack(2, 200),
  backpack_3: backpack(3, 250),
} as const satisfies Readonly<Record<ItemId, ItemDef>>;

/**
 * Stable item order. The index is the u8 wire code (docs/backend/netcode.md §9.5), so only append.
 */
export const ITEM_IDS: readonly ItemId[] = [
  "weapon_rifle", "weapon_shotgun", "weapon_sniper", "weapon_pistol",
  "ammo_556", "ammo_762", "ammo_9mm", "ammo_12g",
  "frag", "smoke", "flash", "molotov",
  "bandage", "first_aid", "medkit", "energy_drink", "painkiller",
  "helmet_1", "helmet_2", "helmet_3", "vest_1", "vest_2", "vest_3", "backpack_1", "backpack_2", "backpack_3",
];

export const THROWABLE_KINDS: readonly ThrowableKind[] = ["frag", "smoke", "flash", "molotov"];

export function getItemDef<K extends ItemId>(id: K): (typeof ITEMS)[K] {
  return ITEMS[id];
}

export function itemCode(id: ItemId): number {
  const code = ITEM_IDS.indexOf(id);
  if (code < 0) throw new Error(`Item "${id}" has no wire code`);
  return code;
}

export function isItemId(value: string): value is ItemId {
  return Object.hasOwn(ITEMS, value);
}

export function weaponItemId(weaponId: WeaponId): WeaponItemId {
  return `weapon_${weaponId}`;
}

export function ammoForWeapon(weaponId: WeaponId): AmmoItemId {
  return ITEMS[weaponItemId(weaponId)].ammo;
}

export function throwableDef(kind: ThrowableKind): ThrowableItemDef {
  return ITEMS[kind];
}

export function consumableDef(id: ConsumableItemId): ConsumableItemDef {
  return ITEMS[id];
}

export function armorDef(id: HelmetItemId | VestItemId): ArmorItemDef {
  return ITEMS[id];
}

export function armorItemId(slot: "helmet" | "vest", level: ArmorLevel): HelmetItemId | VestItemId {
  return `${slot}_${level}`;
}
