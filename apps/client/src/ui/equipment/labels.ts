import {
  ITEM_IDS,
  ITEMS,
  WEAPONS,
  type AmmoItemId,
  type DamageKind,
  type InventoryError,
  type ItemId,
  type ItemInstance,
  type KillCause,
  type ThrowableKind,
  type UseCancelReason,
  type UseRejectReason,
} from "@twobullets/shared";
import { getLanguage, onLanguageChange, t, type MessageKey } from "../../i18n";

/** Short HUD names for throwables (slot 5). */
const THROWABLE_SHORT_KEY: Readonly<Record<ThrowableKind, MessageKey>> = {
  frag: "throwable.short.frag",
  smoke: "throwable.short.smoke",
  flash: "throwable.short.flash",
  molotov: "throwable.short.molotov",
};

export function throwableShort(kind: ThrowableKind): string {
  return t(THROWABLE_SHORT_KEY[kind]);
}

const ITEM_NAME_KEY: Partial<Readonly<Record<ItemId, MessageKey>>> = {
  frag: "item.frag",
  smoke: "item.smoke",
  flash: "item.flash",
  molotov: "item.molotov",
  bandage: "item.bandage",
  first_aid: "item.first_aid",
  medkit: "item.medkit",
  energy_drink: "item.energy_drink",
  painkiller: "item.painkiller",
};

const names = new Map<ItemId, string>();
const upperNames = new Map<ItemId, string>();
onLanguageChange(() => {
  names.clear();
  upperNames.clear();
});

/** Display name, cached per language. Weapon code names and calibers ("AR-4", "5.56mm") stay untranslated. */
export function itemName(itemId: ItemId): string {
  let name = names.get(itemId);
  if (name === undefined) {
    const def = ITEMS[itemId];
    const key = ITEM_NAME_KEY[itemId];
    if (key) name = t(key);
    else if (def.category === "helmet" || def.category === "vest" || def.category === "backpack") name = t(`item.${def.category}`, { level: def.level });
    else name = def.name;
    names.set(itemId, name);
  }
  return name;
}

/** Upper-case display name for the use ring (read every frame while an item is in use, so cached). */
export function itemNameUpper(itemId: ItemId): string {
  let name = upperNames.get(itemId);
  if (name === undefined) {
    name = itemName(itemId).toLocaleUpperCase(getLanguage());
    upperNames.set(itemId, name);
  }
  return name;
}

/** "AR-4", "5.56mm (30)", "Băng gạc ×5", "Áo giáp cấp 2". */
export function itemLabel(item: ItemInstance): string {
  const def = ITEMS[item.itemId];
  const name = itemName(item.itemId);
  if (def.category === "ammo") return t("item.ammoCount", { name, count: item.quantity });
  return item.quantity > 1 ? t("item.stack", { name, count: item.quantity }) : name;
}

/** Pickup feed line body: "60 5.56mm", "Băng gạc ×5", "AR-4". */
export function pickupLabel(item: ItemInstance, taken: number): string {
  const def = ITEMS[item.itemId];
  const name = itemName(item.itemId);
  if (def.category === "ammo") return t("item.ammoTaken", { name, count: taken });
  return taken > 1 ? t("item.stack", { name, count: taken }) : name;
}

const INVENTORY_ERROR_KEY: Readonly<Record<InventoryError, MessageKey>> = {
  full: "inventory.error.full",
  overCapacity: "inventory.error.overCapacity",
  notCarried: "inventory.error.notCarried",
  invalidSlot: "inventory.error.invalidSlot",
  invalidQuantity: "inventory.error.invalidQuantity",
};

export function inventoryErrorText(error: InventoryError): string {
  return t(INVENTORY_ERROR_KEY[error]);
}

const USE_REJECT_KEY: Readonly<Record<UseRejectReason, MessageKey>> = {
  healthFull: "use.reject.healthFull",
  boostFull: "use.reject.boostFull",
  notAlive: "use.reject.notAlive",
  notCarried: "use.reject.notCarried",
};

export function useRejectText(reason: UseRejectReason): string {
  return t(USE_REJECT_KEY[reason]);
}

const USE_CANCEL_KEY: Readonly<Record<UseCancelReason, MessageKey>> = {
  interrupted: "use.cancel.interrupted",
  sprint: "use.cancel.sprint",
  notAlive: "use.cancel.notAlive",
  itemGone: "use.cancel.itemGone",
};

export function useCancelText(reason: UseCancelReason): string {
  return t(USE_CANCEL_KEY[reason]);
}

const DEATH_CAUSE_KEY: Readonly<Record<DamageKind | "teamWipe", MessageKey>> = {
  bullet: "recap.cause.bullet",
  explosion: "recap.cause.explosion",
  fire: "recap.cause.fire",
  fall: "recap.cause.fall",
  zone: "recap.cause.zone",
  bleed: "recap.cause.bleed",
  teamWipe: "recap.cause.teamWipe",
};

export function deathCauseText(cause: DamageKind | "teamWipe"): string {
  return t(DEATH_CAUSE_KEY[cause]);
}

/** What killed someone, as it reads inside a feed line: a weapon or throwable name, or "the zone", "a fall"… */
export function killCauseLabel(cause: KillCause): string {
  switch (cause) {
    case "rifle":
    case "pistol":
    case "shotgun":
    case "sniper":
      return itemName(`weapon_${cause}`);
    case "frag":
    case "molotov":
      return itemName(cause);
    case "zone":
      return t("cause.zone");
    case "fall":
      return t("cause.fall");
    case "bleedOut":
      return t("cause.bleedOut");
    case "teamWipe":
      return t("cause.teamWipe");
    case "outOfBounds":
      return t("cause.outOfBounds");
    case "unknown":
      return t("cause.unknown");
  }
}

/** Throwable effect lines for tooltips. */
const THROWABLE_EFFECT_KEY: Readonly<Record<ThrowableKind, MessageKey>> = {
  frag: "throwable.effect.frag",
  smoke: "throwable.effect.smoke",
  flash: "throwable.effect.flash",
  molotov: "throwable.effect.molotov",
};

function weaponClassText(weaponClass: "primary" | "sidearm"): string {
  return t(weaponClass === "primary" ? "weaponClass.primary" : "weaponClass.sidearm");
}

/** One short line under an item's name in the inventory: "+10 HP · 4 s", "Súng chính · 5.56mm", "Giảm 40% sát thương". */
export function itemSummary(itemId: ItemId): string {
  const def = ITEMS[itemId];
  switch (def.category) {
    case "weapon":
      return t("summary.weapon", { class: weaponClassText(def.weaponClass), ammo: itemName(def.ammo) });
    case "ammo":
      return weaponsUsing(def.id);
    case "throwable":
      return def.cookable ? t("summary.fuseCookable", { seconds: def.fuseSeconds }) : def.detonateOnImpact ? t("summary.impact") : t("summary.fuse", { seconds: def.fuseSeconds });
    case "heal":
      return t("summary.withTime", { effect: def.healAmount === null ? t("summary.healTo", { cap: def.healCap }) : t("summary.healAmount", { amount: def.healAmount }), seconds: def.useSeconds });
    case "boost":
      return t("summary.withTime", { effect: t("summary.boost", { amount: def.boostAmount }), seconds: def.useSeconds });
    case "helmet":
    case "vest":
      return t("summary.absorbs", { percent: Math.round(def.reduction * 100) });
    case "backpack":
      return t("summary.capacity", { capacity: def.capacity });
  }
}

export interface ItemTooltip {
  readonly title: string;
  readonly lines: readonly string[];
}

/** Hover card: effect, use time, heal cap, weight. `durability` is the piece's remaining durability for armor. */
export function itemTooltip(itemId: ItemId, durability?: number): ItemTooltip {
  const def = ITEMS[itemId];
  const title = itemName(itemId);
  const weight = def.weight > 0 ? [t(def.maxStack > 1 ? "tooltip.weightEach" : "tooltip.weight", { weight: def.weight })] : [];
  switch (def.category) {
    case "weapon": {
      const weapon = WEAPONS[def.weaponId];
      const damage = weapon.pellets > 1 ? t("tooltip.damagePellets", { damage: weapon.damage, pellets: weapon.pellets, rpm: weapon.roundsPerMinute }) : t("tooltip.damage", { damage: weapon.damage, rpm: weapon.roundsPerMinute });
      return {
        title,
        lines: [t("summary.weapon", { class: weaponClassText(def.weaponClass), ammo: itemName(def.ammo) }), damage, t("tooltip.magazine", { size: weapon.magazineSize, seconds: weapon.reloadSeconds })],
      };
    }
    case "ammo":
      return { title, lines: [t("tooltip.ammoFor", { weapons: weaponsUsing(def.id) }), ...weight] };
    case "throwable":
      return {
        title,
        lines: [t(THROWABLE_EFFECT_KEY[def.id]), def.detonateOnImpact ? t("tooltip.noFuse") : t(def.cookable ? "tooltip.fuseCook" : "tooltip.fuse", { seconds: def.fuseSeconds }), ...weight],
      };
    case "heal":
      return {
        title,
        lines: [
          def.healAmount === null ? t("tooltip.healsTo", { cap: def.healCap }) : t("tooltip.heals", { amount: def.healAmount }),
          t("tooltip.healCap", { cap: def.healCap }),
          t("tooltip.useTime", { seconds: def.useSeconds }),
          ...weight,
        ],
      };
    case "boost":
      return { title, lines: [t("tooltip.boost", { amount: def.boostAmount }), t("tooltip.useTime", { seconds: def.useSeconds }), ...weight] };
    case "helmet":
    case "vest":
      return {
        title,
        lines: [
          t(def.category === "helmet" ? "tooltip.absorbsHead" : "tooltip.absorbsBody", { percent: Math.round(def.reduction * 100) }),
          t("tooltip.durability", { current: Math.ceil(durability ?? def.durability), max: def.durability }),
        ],
      };
    case "backpack":
      return { title, lines: [t("summary.capacity", { capacity: def.capacity })] };
  }
}

function weaponsUsing(ammo: AmmoItemId): string {
  return ITEM_IDS.flatMap((id) => {
    const def = ITEMS[id];
    return def.category === "weapon" && def.ammo === ammo ? [itemName(id)] : [];
  }).join(", ");
}

/** What dealt area damage, for the kill feed and the death recap. */
export function areaWeaponName(kind: DamageKind): string | null {
  return kind === "explosion" ? itemName("frag") : kind === "fire" ? itemName("molotov") : null;
}
