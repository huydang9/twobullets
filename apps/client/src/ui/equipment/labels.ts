import {
  ITEMS,
  type DamageKind,
  type InventoryError,
  type ItemInstance,
  type ThrowableKind,
  type UseCancelReason,
  type UseRejectReason,
} from "@twobullets/shared";

/** Short HUD names for throwables (slot 5). */
export const THROWABLE_SHORT: Readonly<Record<ThrowableKind, string>> = {
  frag: "FRAG",
  smoke: "SMOKE",
  flash: "FLASH",
  molotov: "MOLOTOV",
};

/** "AR-4", "5.56mm (30)", "Bandage ×5", "Vest (Lv.2)". */
export function itemLabel(item: ItemInstance): string {
  const def = ITEMS[item.itemId];
  if (def.category === "ammo") return `${def.name} (${item.quantity})`;
  return item.quantity > 1 ? `${def.name} ×${item.quantity}` : def.name;
}

/** Pickup feed line body: "60 5.56mm", "Bandage ×5", "AR-4". */
export function pickupLabel(item: ItemInstance, taken: number): string {
  const def = ITEMS[item.itemId];
  if (def.category === "ammo") return `${taken} ${def.name}`;
  return taken > 1 ? `${def.name} ×${taken}` : def.name;
}

export const INVENTORY_ERROR_TEXT: Readonly<Record<InventoryError, string>> = {
  full: "Not enough space",
  overCapacity: "Not enough space for your items",
  notCarried: "Item not carried",
  invalidSlot: "Can't equip that here",
  invalidQuantity: "Invalid quantity",
};

export const USE_REJECT_TEXT: Readonly<Record<UseRejectReason, string>> = {
  healthFull: "Health is already full",
  boostFull: "Boost is already full",
  notAlive: "Can't use items now",
  notCarried: "You don't have that item",
};

export const USE_CANCEL_TEXT: Readonly<Record<UseCancelReason, string>> = {
  interrupted: "CANCELLED",
  sprint: "CANCELLED · SPRINTING",
  notAlive: "CANCELLED",
  itemGone: "CANCELLED · ITEM DROPPED",
};

export const DEATH_CAUSE_TEXT: Readonly<Record<DamageKind | "teamWipe", string>> = {
  bullet: "Gunfire",
  explosion: "Explosion",
  fire: "Burned",
  fall: "Fall damage",
  zone: "Outside the zone",
  bleed: "Bled out",
  teamWipe: "Squad eliminated",
};

/** What dealt area damage, for the kill feed and the death recap. */
export function areaWeaponName(kind: DamageKind): string | null {
  return kind === "explosion" ? ITEMS.frag.name : kind === "fire" ? ITEMS.molotov.name : null;
}
