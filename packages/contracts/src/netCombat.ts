// Networked combat constants shared by server-match (authority) and client prediction (M4, T4.3/T4.6). Plain data:
// this package imports nothing, so weapon ids are the shared `WeaponId` strings. M5 replaces the fixed loadout with
// networked equipment.

/**
 * Weapon slots every player spawns (and respawns) with: primary 1 rifle, primary 2 empty, sidearm pistol, full
 * magazines and `WeaponDef.reserveAmmo`. Client prediction must start from `createWeaponState(NET_WEAPON_LOADOUT)`;
 * `PlayerInput.select` is slot index + 1 (1 = rifle, 3 = pistol).
 */
export const NET_WEAPON_LOADOUT = ["rifle", null, "pistol"] as const;

/** A dead player respawns at a server spawn with a fresh loadout this long after death (M4 warmup rule). */
export const NET_RESPAWN_SECONDS = 5;

/** Interact may drop out for this many ticks (lost or late inputs) before a revive in progress is cancelled. */
export const NET_REVIVE_GRACE_TICKS = 6;
