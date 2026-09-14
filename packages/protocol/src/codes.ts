import type { DamageKind } from "@twobullets/shared/equipment/armor";
import type { LifeState } from "@twobullets/shared/equipment/vitals";
import type { HitZone, WeaponId, WeaponPhase } from "@twobullets/shared/weapons/types";

// Stable wire codes for shared string unions (netcode.md §6.5). Codes are never reused or reordered; only append.

/** Slot field value meaning "the world" (zone, fall, bleed-out) in 5-bit actor fields. */
export const WORLD_SLOT_CODE = 31;
/** 5-bit actor field: slot 0..15, or WORLD_SLOT_CODE for -1. */
export const ACTOR_BITS = 5;

export function actorCode(slot: number): number {
  return slot < 0 || slot > 15 ? WORLD_SLOT_CODE : slot;
}
export function actorFromCode(code: number): number {
  return code === WORLD_SLOT_CODE || code > 15 ? -1 : code;
}

/** 3 bits; 0 = no weapon. */
export const WEAPON_CODE_BITS = 3;
export const WEAPON_IDS_BY_CODE: readonly (WeaponId | null)[] = [null, "pistol", "rifle", "shotgun", "sniper"];

export function weaponCode(id: WeaponId | null | undefined): number {
  switch (id) {
    case "pistol":
      return 1;
    case "rifle":
      return 2;
    case "shotgun":
      return 3;
    case "sniper":
      return 4;
    default:
      return 0;
  }
}
export function weaponIdOfCode(code: number): WeaponId | null {
  return WEAPON_IDS_BY_CODE[code] ?? null;
}

/** 2 bits. */
export const WeaponPhaseCode = { ready: 0, equipping: 1, reloading: 2 } as const;
export function weaponPhaseCode(phase: WeaponPhase): number {
  return phase === "equipping" ? WeaponPhaseCode.equipping : phase === "reloading" ? WeaponPhaseCode.reloading : WeaponPhaseCode.ready;
}
export function weaponPhaseOfCode(code: number): WeaponPhase {
  return code === WeaponPhaseCode.equipping ? "equipping" : code === WeaponPhaseCode.reloading ? "reloading" : "ready";
}

/** 2 bits. */
export const LifeCode = { alive: 0, downed: 1, dead: 2 } as const;
export function lifeCode(life: LifeState): number {
  return life === "downed" ? LifeCode.downed : life === "dead" ? LifeCode.dead : LifeCode.alive;
}
export function lifeOfCode(code: number): LifeState {
  return code === LifeCode.downed ? "downed" : code === LifeCode.dead ? "dead" : "alive";
}

/** 2 bits; 0 = none (zone-less damage). */
export const HitZoneCode = { none: 0, head: 1, body: 2, limb: 3 } as const;
export function hitZoneCode(zone: HitZone | null | undefined): number {
  return zone === "head" ? HitZoneCode.head : zone === "body" ? HitZoneCode.body : zone === "limb" ? HitZoneCode.limb : HitZoneCode.none;
}
export function hitZoneOfCode(code: number): HitZone | null {
  return code === HitZoneCode.head ? "head" : code === HitZoneCode.body ? "body" : code === HitZoneCode.limb ? "limb" : null;
}
/** 3-bit zone mask of an aggregated hit (HitConfirm). */
export const HitZoneMask = { head: 1, body: 2, limb: 4 } as const;
export function hitZoneMaskBit(zone: HitZone): number {
  return zone === "head" ? HitZoneMask.head : zone === "body" ? HitZoneMask.body : HitZoneMask.limb;
}

/** 3 bits. */
export const DAMAGE_KINDS_BY_CODE: readonly DamageKind[] = ["bullet", "explosion", "fire", "fall", "zone", "bleed"];
export function damageKindCode(kind: DamageKind): number {
  const i = DAMAGE_KINDS_BY_CODE.indexOf(kind);
  return i < 0 ? 0 : i;
}
export function damageKindOfCode(code: number): DamageKind | null {
  return DAMAGE_KINDS_BY_CODE[code] ?? null;
}

/**
 * Same union as `KillCause` in shared/match/types (not imported: that module's import graph reaches map code that
 * breaks this package's erasableSyntaxOnly typecheck).
 */
export type KillCause = WeaponId | "frag" | "molotov" | "zone" | "fall" | "bleedOut" | "teamWipe" | "outOfBounds" | "unknown";

/** 5 bits. Weapon causes share the weapon codes (1..4). */
export const KILL_CAUSES_BY_CODE: readonly KillCause[] = [
  "unknown",
  "pistol",
  "rifle",
  "shotgun",
  "sniper",
  "frag",
  "molotov",
  "zone",
  "fall",
  "bleedOut",
  "teamWipe",
  "outOfBounds",
];
export function killCauseCode(cause: KillCause): number {
  const i = KILL_CAUSES_BY_CODE.indexOf(cause);
  return i < 0 ? 0 : i;
}
export function killCauseOfCode(code: number): KillCause | null {
  return KILL_CAUSES_BY_CODE[code] ?? null;
}
