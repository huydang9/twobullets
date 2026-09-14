import type { CombatInput, WeaponEvent, WeaponSlotState, WeaponState } from "../weapons/types";
import { WEAPONS } from "../weapons/weapons";
import { createWeaponState } from "../weapons/weaponStep";
import { consumeAmmo, reserveFor, setMagazine, type InventoryState, type WeaponSlot } from "./inventory";

// Bridge between the inventory (source of truth for which weapons are carried, their magazines and ammo items) and the
// per-tick WeaponState that stepWeapon simulates (docs/equipment/inventory.md §2). Pure, so the server can run it too.

export interface WeaponLoadoutOptions {
  /** Reserve = rounds of the weapon's ammo item in the bag, and reloads consume them. False: WeaponSlotState.reserve. */
  readonly ammoFromInventory: boolean;
}

export interface WeaponSyncResult {
  readonly state: WeaponState;
  /** equipStarted / reloadCancelled caused by the loadout changing under the active slot. */
  readonly events: readonly WeaponEvent[];
}

/** A fresh WeaponState for the inventory's weapons: loaded magazines as carried, starting on the first filled slot. */
export function weaponStateFromInventory(inventory: InventoryState, options: WeaponLoadoutOptions): WeaponState {
  const synced = syncWeaponsFromInventory(createWeaponState(inventory.weapons.map(() => null)), inventory, options).state;
  // Spawn drawn and ready rather than mid-equip.
  return { ...synced, phase: "ready", phaseTimer: 0 };
}

/**
 * Before a weapon tick: slot i mirrors `inventory.weapons[i]`. A slot keeps its simulation state while the same weapon
 * (id and magazine) is there; anything else counts as a different weapon (picked up, swapped, dropped). When the active
 * slot's weapon changes, a reload is cancelled and the new weapon is drawn; when it empties, the first filled slot is
 * drawn instead; while unarmed, the first weapon to appear is drawn.
 */
export function syncWeaponsFromInventory(state: WeaponState, inventory: InventoryState, options: WeaponLoadoutOptions): WeaponSyncResult {
  const carried = inventory.weapons;
  let changed = state.slots.length !== carried.length;
  const slots: (WeaponSlotState | null)[] = [];
  for (let i = 0; i < carried.length; i++) {
    const weapon = carried[i]!;
    const current = state.slots[i] ?? null;
    let next: WeaponSlotState | null = null;
    if (weapon) {
      const same = current !== null && current.id === weapon.weaponId && current.magazine === weapon.magazine;
      const reserve = options.ammoFromInventory ? reserveFor(inventory, weapon.weaponId) : same ? current.reserve : WEAPONS[weapon.weaponId].reserveAmmo;
      next = same && current.reserve === reserve ? current : { id: weapon.weaponId, magazine: weapon.magazine, reserve };
    }
    if (next !== current) changed = true;
    slots.push(next);
  }
  if (!changed) return { state, events: [] };

  const events: WeaponEvent[] = [];
  const previous = state.slots[state.activeIndex] ?? null;
  const current = slots[state.activeIndex] ?? null;
  const sameWeapon = previous !== null && current !== null && previous.id === current.id && previous.magazine === current.magazine;
  const activeIndex = current ? state.activeIndex : slots.findIndex((slot) => slot !== null);
  if (sameWeapon || (previous === null && activeIndex < 0)) {
    return { state: { ...state, slots, activeIndex: Math.max(0, Math.min(state.activeIndex, slots.length - 1)) }, events };
  }

  if (previous && state.phase === "reloading") events.push({ type: "reloadCancelled", weaponId: previous.id });
  const drawn = slots[activeIndex] ?? null;
  if (!drawn) {
    // Unarmed: stay on the emptied slot; the next weapon picked up is drawn.
    return { state: { ...state, slots, phase: "ready", phaseTimer: 0, adsBlend: 0, bloom: 0 }, events };
  }
  const seconds = WEAPONS[drawn.id].equipSeconds;
  events.push({ type: "equipStarted", weaponId: drawn.id, seconds });
  return { state: { ...state, slots, activeIndex, phase: "equipping", phaseTimer: seconds, adsBlend: 0, bloom: 0 }, events };
}

/**
 * After a weapon tick: magazines go back to the inventory weapons, and rounds a reload moved into the magazine leave the
 * bag (reserve before the tick minus reserve after). Returns the same inventory object when nothing changed.
 */
export function commitWeaponsToInventory(before: WeaponState, after: WeaponState, inventory: InventoryState, options: WeaponLoadoutOptions): InventoryState {
  let next = inventory;
  for (let i = 0; i < next.weapons.length; i++) {
    const weapon = next.weapons[i];
    const was = before.slots[i];
    const now = after.slots[i];
    if (!weapon || !was || !now || now.id !== weapon.weaponId || was.id !== now.id) continue;
    if (now.magazine !== weapon.magazine) next = setMagazine(next, i as WeaponSlot, now.magazine);
    if (options.ammoFromInventory && was.reserve > now.reserve) next = consumeAmmo(next, now.id, was.reserve - now.reserve);
  }
  return next;
}

export interface GatedCombatInput {
  readonly input: CombatInput;
  /** Carry to the next tick. */
  readonly fireLatched: boolean;
}

/**
 * Weapon gate (docs/equipment/design.md §10.2.1): while guns are blocked (throwable in hand, using an item, downed,
 * reviving) fire, aim and reload are dropped; switching still works. Fire stays blocked after the gate lifts until the
 * trigger is released, so the click that throws a grenade or cancels a heal never also fires the gun.
 */
export function gateCombatInput(input: CombatInput, allowWeapons: boolean, fireLatched: boolean): GatedCombatInput {
  if (!allowWeapons) return { input: { ...input, fire: false, aim: false, reload: false }, fireLatched: true };
  if (fireLatched && input.fire) return { input: { ...input, fire: false }, fireLatched: true };
  return { input, fireLatched: false };
}
