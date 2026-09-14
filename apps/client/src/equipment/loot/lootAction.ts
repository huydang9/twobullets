import { ITEMS, pickUp, type InventoryError, type InventoryState, type ItemInstance, type LootItem, type WeaponSlot } from "@twobullets/shared";

export interface LootActionPreview {
  /** Prompt verb: "Pick up", "Swap", "Equip". */
  readonly verb: "Pick up" | "Swap" | "Equip";
  /** What a swap drops (the weapon in hand, the worn helmet...), or null. */
  readonly replaces: ItemInstance | null;
  /** Units that fit (stack items may be partial). */
  readonly taken: number;
  /** Why F would fail right now, or null. */
  readonly blocked: InventoryError | null;
}

/**
 * What F on a ground item would do, for the interaction prompt ("F  Swap AR-4 → S-12", "F  Pick up 5.56mm (30)").
 * Runs the same inventory rule as the pickup, with the same replace slot the pickup uses.
 */
export function previewLootAction(inventory: InventoryState, item: LootItem, activeWeaponSlot: WeaponSlot | null): LootActionPreview {
  const def = ITEMS[item.itemId];
  const gear = def.category === "helmet" || def.category === "vest" || def.category === "backpack";
  const result = pickUp(inventory, item, activeWeaponSlot === 1 ? 1 : 0);
  if (!result.ok) return { verb: gear ? "Equip" : "Pick up", replaces: null, taken: 0, blocked: result.error };
  const replaces = result.dropped[0] ?? null;
  return { verb: replaces ? "Swap" : gear ? "Equip" : "Pick up", replaces, taken: result.taken, blocked: null };
}
