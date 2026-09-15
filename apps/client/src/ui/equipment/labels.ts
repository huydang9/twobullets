import {
  ITEM_IDS,
  ITEMS,
  WEAPONS,
  type AmmoItemId,
  type DamageKind,
  type InventoryError,
  type ItemId,
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

/** Throwable effect lines for tooltips. */
const THROWABLE_EFFECT: Readonly<Record<ThrowableKind, string>> = {
  frag: "Explodes when the fuse runs out",
  smoke: "Thick smoke screen",
  flash: "Blinds and deafens nearby players",
  molotov: "Bursts into fire on impact",
};

/** One short line under an item's name in the inventory: "+10 HP · 4 s", "Primary · 5.56mm", "Absorbs 40%". */
export function itemSummary(itemId: ItemId): string {
  const def = ITEMS[itemId];
  switch (def.category) {
    case "weapon":
      return `${def.weaponClass === "primary" ? "Primary" : "Sidearm"} · ${ITEMS[def.ammo].name}`;
    case "ammo":
      return weaponsUsing(def.id);
    case "throwable":
      return def.cookable ? `Fuse ${def.fuseSeconds} s · cookable` : def.detonateOnImpact ? "Impact" : `Fuse ${def.fuseSeconds} s`;
    case "heal":
      return `${def.healAmount === null ? `To ${def.healCap} HP` : `+${def.healAmount} HP`} · ${def.useSeconds} s`;
    case "boost":
      return `+${def.boostAmount} boost · ${def.useSeconds} s`;
    case "helmet":
    case "vest":
      return `Absorbs ${Math.round(def.reduction * 100)}%`;
    case "backpack":
      return `+${def.capacity} capacity`;
  }
}

export interface ItemTooltip {
  readonly title: string;
  readonly lines: readonly string[];
}

/** Hover card: effect, use time, heal cap, weight. `durability` is the piece's remaining durability for armor. */
export function itemTooltip(itemId: ItemId, durability?: number): ItemTooltip {
  const def = ITEMS[itemId];
  const weight = def.weight > 0 ? [`Weight ${def.weight}${def.maxStack > 1 ? " each" : ""}`] : [];
  switch (def.category) {
    case "weapon": {
      const weapon = WEAPONS[def.weaponId];
      return {
        title: def.name,
        lines: [`${def.weaponClass === "primary" ? "Primary" : "Sidearm"} · ${ITEMS[def.ammo].name}`, `Damage ${weapon.damage}${weapon.pellets > 1 ? ` × ${weapon.pellets}` : ""} · ${weapon.roundsPerMinute} RPM`, `Magazine ${weapon.magazineSize} · Reload ${weapon.reloadSeconds} s`],
      };
    }
    case "ammo":
      return { title: def.name, lines: [`Ammo for ${weaponsUsing(def.id)}`, ...weight] };
    case "throwable":
      return { title: def.name, lines: [THROWABLE_EFFECT[def.id], def.detonateOnImpact ? "No fuse" : `Fuse ${def.fuseSeconds} s${def.cookable ? " · cook with R" : ""}`, ...weight] };
    case "heal":
      return {
        title: def.name,
        lines: [def.healAmount === null ? `Heals to ${def.healCap} HP` : `Heals ${def.healAmount} HP`, `Heal cap ${def.healCap} HP`, `Use time ${def.useSeconds} s`, ...weight],
      };
    case "boost":
      return { title: def.name, lines: [`+${def.boostAmount} boost (heals over time, raises speed)`, `Use time ${def.useSeconds} s`, ...weight] };
    case "helmet":
    case "vest":
      return {
        title: def.name,
        lines: [`Absorbs ${Math.round(def.reduction * 100)}% of ${def.category === "helmet" ? "head" : "body"} damage`, `Durability ${Math.ceil(durability ?? def.durability)} / ${def.durability}`],
      };
    case "backpack":
      return { title: def.name, lines: [`+${def.capacity} capacity`] };
  }
}

function weaponsUsing(ammo: AmmoItemId): string {
  return ITEM_IDS.flatMap((id) => {
    const def = ITEMS[id];
    return def.category === "weapon" && def.ammo === ammo ? [def.name] : [];
  }).join(", ");
}

/** What dealt area damage, for the kill feed and the death recap. */
export function areaWeaponName(kind: DamageKind): string | null {
  return kind === "explosion" ? ITEMS.frag.name : kind === "fire" ? ITEMS.molotov.name : null;
}
