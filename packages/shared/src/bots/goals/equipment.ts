import type { InventoryState } from "../../equipment/inventory";
import { ITEMS, type ConsumableItemId, type ItemId, type ThrowableKind } from "../../equipment/items";
import type { WeaponId, WeaponState } from "../../weapons/types";
import type { BotDifficulty, BotProfile } from "../types";

// Inventory reading for decisions: counts, weapon choice by range (design.md §5.4), heal choice (§5.2) and loot needs
// (§5.3). Allocation-free loops instead of the equipment helpers' closures.

export function countOf(inventory: InventoryState, itemId: ItemId): number {
  const stacks = inventory.stacks;
  for (let i = 0; i < stacks.length; i++) if (stacks[i]!.itemId === itemId) return stacks[i]!.quantity;
  return 0;
}

export function hasGun(weapon: WeaponState): boolean {
  for (let i = 0; i < weapon.slots.length; i++) if (weapon.slots[i]) return true;
  return false;
}

/** Any carried gun with rounds loaded or in the bag. */
export function hasAmmo(weapon: WeaponState): boolean {
  for (let i = 0; i < weapon.slots.length; i++) {
    const s = weapon.slots[i];
    if (s && s.magazine + s.reserve > 0) return true;
  }
  return false;
}

/** Longest `maxRange` among guns that can still shoot, or 0. */
export function bestUsableRange(weapon: WeaponState, profile: BotProfile): number {
  let best = 0;
  for (let i = 0; i < weapon.slots.length; i++) {
    const s = weapon.slots[i];
    if (s && s.magazine + s.reserve > 0) best = Math.max(best, profile.fire.maxRange[s.id]);
  }
  return best;
}

const CLOSE_ORDER: readonly WeaponId[] = ["shotgun", "rifle", "pistol", "sniper"];
const MID_ORDER: readonly WeaponId[] = ["rifle", "shotgun", "pistol", "sniper"];
const FAR_ORDER: readonly WeaponId[] = ["sniper", "rifle", "pistol", "shotgun"];

/**
 * Weapon slot index for a target at `distance`: sniper beyond 80 m, rifle 10–180 m, shotgun under 15 m, pistol as the
 * fallback; only guns with ammo, preferring ones whose max range covers the distance. -1 when nothing can shoot.
 */
export function chooseWeaponSlot(weapon: WeaponState, distance: number, profile: BotProfile): number {
  const order = distance < 12 ? CLOSE_ORDER : distance <= 80 ? MID_ORDER : FAR_ORDER;
  const active = weapon.slots[weapon.activeIndex];
  for (let pass = 0; pass < 2; pass++) {
    for (let o = 0; o < order.length; o++) {
      const id = order[o]!;
      if (pass === 0 && profile.fire.maxRange[id] < distance) continue;
      // The weapon in hand wins ties (two rifles).
      if (active && active.id === id && active.magazine + active.reserve > 0) return weapon.activeIndex;
      for (let i = 0; i < weapon.slots.length; i++) {
        const s = weapon.slots[i];
        if (s && s.id === id && s.magazine + s.reserve > 0) return i;
      }
    }
  }
  return -1;
}

/** Heal to use now: medkit under 40 HP, first aid under 75, else bandage. Null when nothing applies. */
export function chooseHeal(inventory: InventoryState, health: number): ConsumableItemId | null {
  if (health < 40 && countOf(inventory, "medkit") > 0) return "medkit";
  if (health < 75 && countOf(inventory, "first_aid") > 0) return "first_aid";
  if (health < 75 && countOf(inventory, "bandage") > 0) return "bandage";
  if (health < 100 && countOf(inventory, "medkit") > 0 && health < 60) return "medkit";
  return null;
}

export function chooseBoost(inventory: InventoryState, boost: number): ConsumableItemId | null {
  if (boost >= 60) return null;
  if (countOf(inventory, "painkiller") > 0) return "painkiller";
  if (countOf(inventory, "energy_drink") > 0) return "energy_drink";
  return null;
}

export function weaponQuality(id: WeaponId, difficulty: BotDifficulty, holdsRifle: boolean): number {
  switch (id) {
    case "rifle":
      return 1;
    case "shotgun":
      return difficulty === "hard" ? 0.4 : 0.7;
    case "sniper":
      return difficulty === "hard" && holdsRifle ? 0.9 : 0.6;
    case "pistol":
      return 0.3;
  }
}

const AMMO_TARGET: Readonly<Record<WeaponId, number>> = { rifle: 150, sniper: 30, pistol: 48, shotgun: 28 };

/** Result of a loot need evaluation. `replaceSlot` is set for weapons replacing a carried primary. */
export interface LootNeed {
  need: number;
  replaceSlot: -1 | 0 | 1 | 2;
}

/**
 * Need × quality of a ground item for this inventory (design.md §5.3), before distance. 0 = don't want it. Stack items
 * that don't fit count as 0.
 */
export function lootNeed(itemId: ItemId, inventory: InventoryState, difficulty: BotDifficulty, fits: number, out: LootNeed): LootNeed {
  out.need = 0;
  out.replaceSlot = -1;
  const def = ITEMS[itemId];
  const weapons = inventory.weapons;
  switch (def.category) {
    case "weapon": {
      const p0 = weapons[0];
      const p1 = weapons[1];
      const side = weapons[2];
      const holdsRifle = (p0 !== null && p0.weaponId === "rifle") || (p1 !== null && p1.weaponId === "rifle");
      const quality = weaponQuality(def.weaponId, difficulty, holdsRifle);
      if (def.weaponClass === "sidearm") {
        // Unarmed takes any pistol; with a primary it's a minor backup.
        out.need = side ? 0 : p0 || p1 ? 0.15 : 1;
        return clampNeed(out);
      }
      if (!p0 && !p1) {
        out.need = (side ? 0.8 : 1) * quality;
        return clampNeed(out);
      }
      if (!p0 || !p1) {
        const carried = (p0 ?? p1)!;
        out.need = carried.weaponId === def.weaponId ? 0.05 : 0.35 * quality;
        return clampNeed(out);
      }
      // Both primaries full: replace the worse one when this is clearly better.
      const q0 = weaponQuality(p0.weaponId, difficulty, holdsRifle);
      const q1 = weaponQuality(p1.weaponId, difficulty, holdsRifle);
      const worse: 0 | 1 = q0 <= q1 ? 0 : 1;
      const gain = quality - Math.min(q0, q1);
      if (gain > 0.15 && p0.weaponId !== def.weaponId && p1.weaponId !== def.weaponId) {
        out.need = gain * 0.5;
        out.replaceSlot = worse;
      }
      return clampNeed(out);
    }
    case "ammo": {
      if (fits <= 0) return out;
      for (let i = 0; i < 3; i++) {
        const w = weapons[i];
        if (w && ITEMS[`weapon_${w.weaponId}`].ammo === def.id) {
          out.need = Math.max(out.need, 1 - countOf(inventory, def.id) / AMMO_TARGET[w.weaponId]);
        }
      }
      return clampNeed(out);
    }
    case "helmet":
    case "vest": {
      const worn = inventory[def.category];
      out.need = worn === null ? 0.7 : def.level > worn.level ? 0.35 * (def.level - worn.level) : 0;
      return clampNeed(out);
    }
    case "backpack": {
      out.need = def.level > inventory.backpack ? 0.3 * (def.level - inventory.backpack) : 0;
      return clampNeed(out);
    }
    case "heal": {
      if (fits <= 0) return out;
      const c = countOf(inventory, def.id);
      out.need = def.id === "bandage" ? 0.6 * (1 - c / 10) : def.id === "first_aid" ? 0.6 * (1 - c / 3) : 0.5 * (1 - c);
      return clampNeed(out);
    }
    case "boost": {
      if (fits <= 0) return out;
      out.need = 0.25 * (1 - countOf(inventory, def.id) / 3);
      return clampNeed(out);
    }
    case "throwable": {
      if (fits <= 0) return out;
      out.need = throwableNeed(def.id, countOf(inventory, def.id), difficulty);
      return clampNeed(out);
    }
  }
  return out;
}

function throwableNeed(kind: ThrowableKind, count: number, difficulty: BotDifficulty): number {
  switch (kind) {
    case "frag":
      return 0.3 * (1 - count / 2);
    case "smoke":
      return difficulty === "easy" ? 0 : 0.25 * (1 - count / 2);
    case "flash":
      return difficulty === "hard" ? 0.15 * (1 - count / 2) : 0;
    case "molotov":
      return 0.2 * (1 - count);
  }
}

function clampNeed(out: LootNeed): LootNeed {
  if (!(out.need > 0)) out.need = 0;
  return out;
}
