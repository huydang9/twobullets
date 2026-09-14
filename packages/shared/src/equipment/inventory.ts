import type { WeaponId } from "../weapons/types";
import type { ArmorLoadout, ArmorPiece, ArmorSlot } from "./armor";
import {
  ITEM_IDS,
  ITEMS,
  INVENTORY,
  THROWABLE_KINDS,
  ammoForWeapon,
  armorDef,
  armorItemId,
  weaponItemId,
  type AmmoItemId,
  type ArmorLevel,
  type ConsumableItemId,
  type ItemDef,
  type ItemId,
  type ThrowableKind,
} from "./items";

// PUBG-style inventory: three weapon slots (primary 1, primary 2, sidearm), helmet/vest/backpack slots, and a bag of
// stacks limited by weight. Every operation is pure and returns a validated result.

/** Index into InventoryState.weapons. */
export type WeaponSlot = 0 | 1 | 2;
export const WEAPON_SLOT_NAMES = ["primary1", "primary2", "sidearm"] as const;
export const SIDEARM_SLOT: WeaponSlot = 2;

export type BackpackLevel = 0 | ArmorLevel;
export type StackItemId = AmmoItemId | ThrowableKind | ConsumableItemId;

export interface WeaponItemState {
  readonly weaponId: WeaponId;
  /** Rounds loaded; travels with the weapon when it is dropped. */
  readonly magazine: number;
}

export interface InventoryStack {
  readonly itemId: StackItemId;
  readonly quantity: number;
}

export interface InventoryState {
  readonly weapons: readonly [WeaponItemState | null, WeaponItemState | null, WeaponItemState | null];
  readonly helmet: ArmorPiece | null;
  readonly vest: ArmorPiece | null;
  readonly backpack: BackpackLevel;
  /** One stack per item id, in ITEM_IDS order. */
  readonly stacks: readonly InventoryStack[];
  /** Throwable armed by the throwable key; null when none are carried. */
  readonly selectedThrowable: ThrowableKind | null;
}

/** An item outside a slot or bag: on the ground, in a loot pile, or being dropped. */
export interface ItemInstance {
  readonly itemId: ItemId;
  readonly quantity: number;
  /** Armor only: remaining durability. */
  readonly durability?: number;
  /** Weapons only: loaded rounds. */
  readonly magazine?: number;
}

export type InventoryError =
  /** Nothing of it fits (weight or stack limit). */
  | "full"
  /** Removing a vest/backpack would leave more weight than the remaining capacity. */
  | "overCapacity"
  | "notCarried"
  | "invalidSlot"
  | "invalidQuantity";

export type InventoryResult<T = object> = ({ readonly ok: true; readonly inventory: InventoryState } & T) | { readonly ok: false; readonly error: InventoryError };

export interface PickupOutcome {
  /** Quantity taken from the ground item. */
  readonly taken: number;
  /** What stays on the ground (partial stack pickup), or null. */
  readonly remainder: ItemInstance | null;
  /** Items swapped out and dropped (old weapon, armor or backpack). */
  readonly dropped: readonly ItemInstance[];
}

export function createInventory(init: Partial<Omit<InventoryState, "stacks">> & { readonly stacks?: readonly InventoryStack[] } = {}): InventoryState {
  const inventory: InventoryState = {
    weapons: init.weapons ?? [null, null, null],
    helmet: init.helmet ?? null,
    vest: init.vest ?? null,
    backpack: init.backpack ?? 0,
    stacks: normalizeStacks(init.stacks ?? []),
    selectedThrowable: init.selectedThrowable ?? null,
  };
  return withThrowableSelection(inventory);
}

export function capacityOf(backpack: BackpackLevel, hasVest: boolean): number {
  return INVENTORY.baseCapacity + (hasVest ? INVENTORY.vestCapacity : 0) + (backpack > 0 ? ITEMS[`backpack_${backpack as ArmorLevel}`].capacity : 0);
}

export function inventoryCapacity(inventory: InventoryState): number {
  return capacityOf(inventory.backpack, inventory.vest !== null);
}

export function inventoryWeight(inventory: InventoryState): number {
  let weight = 0;
  for (const stack of inventory.stacks) weight += ITEMS[stack.itemId].weight * stack.quantity;
  return Math.round(weight * 1000) / 1000;
}

export function countItem(inventory: InventoryState, itemId: ItemId): number {
  return inventory.stacks.find((s) => s.itemId === itemId)?.quantity ?? 0;
}

export function armorLoadout(inventory: InventoryState): ArmorLoadout {
  return { helmet: inventory.helmet, vest: inventory.vest };
}

export function withArmor(inventory: InventoryState, armor: ArmorLoadout): InventoryState {
  if (armor.helmet === inventory.helmet && armor.vest === inventory.vest) return inventory;
  return { ...inventory, helmet: armor.helmet, vest: armor.vest };
}

export function isStackItem(itemId: ItemId): itemId is StackItemId {
  const category = ITEMS[itemId].category;
  return category === "ammo" || category === "throwable" || category === "heal" || category === "boost";
}

/** Units of a stack item that fit right now (weight and stack cap). */
export function maxAddable(inventory: InventoryState, itemId: StackItemId): number {
  const def = ITEMS[itemId];
  const free = inventoryCapacity(inventory) - inventoryWeight(inventory);
  const byWeight = def.weight > 0 ? Math.floor((free + 1e-9) / def.weight) : def.maxStack;
  return Math.max(0, Math.min(byWeight, def.maxStack - countItem(inventory, itemId)));
}

/** Adds as much of a stack item as fits. */
export function addStack(inventory: InventoryState, itemId: StackItemId, quantity: number): InventoryResult<{ readonly added: number }> {
  if (!Number.isInteger(quantity) || quantity <= 0) return { ok: false, error: "invalidQuantity" };
  const added = Math.min(quantity, maxAddable(inventory, itemId));
  if (added <= 0) return { ok: false, error: "full" };
  return { ok: true, inventory: setCount(inventory, itemId, countItem(inventory, itemId) + added), added };
}

export function removeStack(inventory: InventoryState, itemId: StackItemId, quantity: number): InventoryResult {
  if (!Number.isInteger(quantity) || quantity <= 0) return { ok: false, error: "invalidQuantity" };
  const count = countItem(inventory, itemId);
  if (count < quantity) return { ok: false, error: "notCarried" };
  return { ok: true, inventory: setCount(inventory, itemId, count - quantity) };
}

/**
 * Picks up a ground item.
 * - Stack items: as much as fits; the rest stays on the ground.
 * - Weapons: the first empty slot of the right class; otherwise replaces `replaceSlot` (a primary for primaries,
 *   default primary 1; always the sidearm slot for sidearms) and drops the old weapon with its magazine.
 * - Helmet/vest/backpack: equips and drops the worn one. A smaller backpack can't replace a bigger one while its
 *   contents wouldn't fit.
 */
export function pickUp(inventory: InventoryState, item: ItemInstance, replaceSlot?: WeaponSlot): InventoryResult<PickupOutcome> {
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) return { ok: false, error: "invalidQuantity" };
  const def: ItemDef = ITEMS[item.itemId];

  switch (def.category) {
    case "ammo":
    case "throwable":
    case "heal":
    case "boost": {
      const result = addStack(inventory, def.id, item.quantity);
      if (!result.ok) return result;
      const left = item.quantity - result.added;
      return { ok: true, inventory: result.inventory, taken: result.added, remainder: left > 0 ? { ...item, quantity: left } : null, dropped: [] };
    }
    case "weapon": {
      const weapon: WeaponItemState = { weaponId: def.weaponId, magazine: item.magazine ?? 0 };
      const candidates: WeaponSlot[] = def.weaponClass === "sidearm" ? [SIDEARM_SLOT] : [0, 1];
      const empty = candidates.find((slot) => inventory.weapons[slot] === null);
      const slot = empty ?? (def.weaponClass === "sidearm" ? SIDEARM_SLOT : replaceSlot === 1 ? 1 : 0);
      const old = inventory.weapons[slot];
      const weapons = replaceWeapon(inventory.weapons, slot, weapon);
      return { ok: true, inventory: { ...inventory, weapons }, taken: 1, remainder: null, dropped: old ? [weaponInstance(old)] : [] };
    }
    case "helmet":
    case "vest": {
      const slot: ArmorSlot = def.category;
      const piece: ArmorPiece = { level: def.level, durability: item.durability ?? def.durability };
      const old = inventory[slot];
      return { ok: true, inventory: { ...inventory, [slot]: piece }, taken: 1, remainder: null, dropped: old ? [armorInstance(slot, old)] : [] };
    }
    case "backpack": {
      const next: InventoryState = { ...inventory, backpack: def.level };
      if (inventoryWeight(next) > inventoryCapacity(next)) return { ok: false, error: "overCapacity" };
      const old = inventory.backpack;
      return { ok: true, inventory: next, taken: 1, remainder: null, dropped: old > 0 ? [{ itemId: `backpack_${old as ArmorLevel}`, quantity: 1 }] : [] };
    }
  }
}

export type DropTarget =
  | { readonly kind: "stack"; readonly itemId: StackItemId; readonly quantity: number }
  | { readonly kind: "weapon"; readonly slot: WeaponSlot }
  | { readonly kind: "armor"; readonly slot: ArmorSlot }
  | { readonly kind: "backpack" };

/** Drops something to the ground. Removing a vest or backpack is refused if the bag contents would no longer fit. */
export function drop(inventory: InventoryState, target: DropTarget): InventoryResult<{ readonly dropped: ItemInstance }> {
  switch (target.kind) {
    case "stack": {
      const result = removeStack(inventory, target.itemId, target.quantity);
      return result.ok ? { ok: true, inventory: result.inventory, dropped: { itemId: target.itemId, quantity: target.quantity } } : result;
    }
    case "weapon": {
      if (!isWeaponSlot(target.slot)) return { ok: false, error: "invalidSlot" };
      const weapon = inventory.weapons[target.slot];
      if (!weapon) return { ok: false, error: "notCarried" };
      return { ok: true, inventory: { ...inventory, weapons: replaceWeapon(inventory.weapons, target.slot, null) }, dropped: weaponInstance(weapon) };
    }
    case "armor": {
      const piece = inventory[target.slot];
      if (!piece) return { ok: false, error: "notCarried" };
      const next: InventoryState = { ...inventory, [target.slot]: null };
      if (inventoryWeight(next) > inventoryCapacity(next)) return { ok: false, error: "overCapacity" };
      return { ok: true, inventory: next, dropped: armorInstance(target.slot, piece) };
    }
    case "backpack": {
      if (inventory.backpack === 0) return { ok: false, error: "notCarried" };
      const next: InventoryState = { ...inventory, backpack: 0 };
      if (inventoryWeight(next) > inventoryCapacity(next)) return { ok: false, error: "overCapacity" };
      return { ok: true, inventory: next, dropped: { itemId: `backpack_${inventory.backpack as ArmorLevel}`, quantity: 1 } };
    }
  }
}

/** Swaps the two primaries (the sidearm slot only holds sidearms). */
export function swapWeapons(inventory: InventoryState, a: WeaponSlot, b: WeaponSlot): InventoryResult {
  if (a === b || !isWeaponSlot(a) || !isWeaponSlot(b) || a === SIDEARM_SLOT || b === SIDEARM_SLOT) return { ok: false, error: "invalidSlot" };
  const weapons = replaceWeapon(replaceWeapon(inventory.weapons, a, inventory.weapons[b]), b, inventory.weapons[a]);
  return { ok: true, inventory: { ...inventory, weapons } };
}

export function setMagazine(inventory: InventoryState, slot: WeaponSlot, magazine: number): InventoryState {
  const weapon = inventory.weapons[slot];
  if (!weapon || weapon.magazine === magazine) return inventory;
  return { ...inventory, weapons: replaceWeapon(inventory.weapons, slot, { ...weapon, magazine }) };
}

/** Next carried throwable kind after the selected one (G), or null when none are carried. */
export function cycleThrowable(inventory: InventoryState): InventoryState {
  const kinds = THROWABLE_KINDS;
  const start = inventory.selectedThrowable ? kinds.indexOf(inventory.selectedThrowable) : -1;
  for (let i = 1; i <= kinds.length; i++) {
    const kind = kinds[(start + i) % kinds.length]!;
    if (countItem(inventory, kind) > 0) return kind === inventory.selectedThrowable ? inventory : { ...inventory, selectedThrowable: kind };
  }
  return inventory.selectedThrowable === null ? inventory : { ...inventory, selectedThrowable: null };
}

export function throwableCounts(inventory: InventoryState): Readonly<Record<ThrowableKind, number>> {
  return { frag: countItem(inventory, "frag"), smoke: countItem(inventory, "smoke"), flash: countItem(inventory, "flash"), molotov: countItem(inventory, "molotov") };
}

// ---------------------------------------------------------------------------------------------------------------
// Ammo items ↔ WeaponState.reserve (migration bridge, see docs/equipment/design.md §4.3)
// ---------------------------------------------------------------------------------------------------------------

/** Rounds in the bag for a weapon's ammo type: what WeaponSlotState.reserve should show once ammo items are live. */
export function reserveFor(inventory: InventoryState, weaponId: WeaponId): number {
  return countItem(inventory, ammoForWeapon(weaponId));
}

/** Removes rounds a reload loaded (reserve before minus reserve after) from the bag. */
export function consumeAmmo(inventory: InventoryState, weaponId: WeaponId, rounds: number): InventoryState {
  if (rounds <= 0) return inventory;
  const ammo = ammoForWeapon(weaponId);
  return setCount(inventory, ammo, Math.max(0, countItem(inventory, ammo) - rounds));
}

export function weaponSlotOf(inventory: InventoryState, weaponId: WeaponId): WeaponSlot | null {
  const index = inventory.weapons.findIndex((w) => w?.weaponId === weaponId);
  return index < 0 ? null : (index as WeaponSlot);
}

// ---------------------------------------------------------------------------------------------------------------

function isWeaponSlot(slot: number): slot is WeaponSlot {
  return slot === 0 || slot === 1 || slot === 2;
}

function replaceWeapon(weapons: InventoryState["weapons"], slot: WeaponSlot, weapon: WeaponItemState | null): InventoryState["weapons"] {
  const copy = [...weapons] as [WeaponItemState | null, WeaponItemState | null, WeaponItemState | null];
  copy[slot] = weapon;
  return copy;
}

function weaponInstance(weapon: WeaponItemState): ItemInstance {
  return { itemId: weaponItemId(weapon.weaponId), quantity: 1, magazine: weapon.magazine };
}

function armorInstance(slot: ArmorSlot, piece: ArmorPiece): ItemInstance {
  const id = armorItemId(slot, piece.level);
  return { itemId: id, quantity: 1, durability: Math.min(piece.durability, armorDef(id).durability) };
}

function setCount(inventory: InventoryState, itemId: StackItemId, quantity: number): InventoryState {
  const others = inventory.stacks.filter((s) => s.itemId !== itemId);
  const stacks = quantity > 0 ? normalizeStacks([...others, { itemId, quantity }]) : others;
  return withThrowableSelection({ ...inventory, stacks });
}

function normalizeStacks(stacks: readonly InventoryStack[]): InventoryStack[] {
  const merged = new Map<StackItemId, number>();
  for (const s of stacks) if (s.quantity > 0) merged.set(s.itemId, (merged.get(s.itemId) ?? 0) + s.quantity);
  return [...merged]
    .map(([itemId, quantity]) => ({ itemId, quantity: Math.min(quantity, ITEMS[itemId].maxStack) }))
    .sort((a, b) => ITEM_IDS.indexOf(a.itemId) - ITEM_IDS.indexOf(b.itemId));
}

/** Keeps the selection on a carried throwable: picks the first carried kind when the selected one runs out. */
function withThrowableSelection(inventory: InventoryState): InventoryState {
  const selected = inventory.selectedThrowable;
  if (selected && countItem(inventory, selected) > 0) return inventory;
  const first = THROWABLE_KINDS.find((kind) => countItem(inventory, kind) > 0) ?? null;
  return first === selected ? inventory : { ...inventory, selectedThrowable: first };
}
