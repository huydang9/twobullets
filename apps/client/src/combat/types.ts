import type { Observable, Vector3 } from "@babylonjs/core";
import type { ArmorSlot, FiredShot, HitZone, InventoryState, Projectile, WeaponDef, WeaponEvent, WeaponSlot, WeaponState } from "@twobullets/shared";

export interface ShotEvent {
  readonly weapon: WeaponDef;
  readonly shot: FiredShot;
}

export interface ImpactEvent {
  readonly weapon: WeaponDef;
  readonly point: Vector3;
  readonly normal: Vector3;
  /** "world" = level geometry; "target" = a damageable target. */
  readonly surface: "world" | "target";
  readonly targetId: string | null;
  readonly zone: HitZone | null;
}

export interface DamageEvent {
  readonly weapon: WeaponDef;
  readonly targetId: string;
  /** Display name of the target when it has one ("Soldier"); otherwise derive one from `targetId`. */
  readonly targetName?: string;
  readonly zone: HitZone;
  readonly amount: number;
  readonly remainingHealth: number;
  readonly killed: boolean;
  /** World-space hit point (for damage numbers). */
  readonly point: Vector3;
  /** Distance travelled by the bullet, m. */
  readonly distance: number;
  /** Damage the target's helmet or vest soaked up (0 without armor), and which piece. */
  readonly armorAbsorbed: number;
  readonly armorSlot: ArmorSlot | null;
  /** The piece broke on this hit. */
  readonly armorDestroyed: boolean;
}

/**
 * Read-only view of local combat, consumed by presentation (viewmodel, effects, audio) and the HUD.
 * Events fire during the fixed tick; state getters are safe to read every render frame.
 */
export interface CombatView {
  readonly onShot: Observable<ShotEvent>;
  readonly onWeaponEvent: Observable<WeaponEvent>;
  readonly onImpact: Observable<ImpactEvent>;
  readonly onDamage: Observable<DamageEvent>;

  readonly weaponState: WeaponState;
  /**
   * Weapon in hand. While unarmed (every slot empty) it stays the last weapon held, so check `armed` before drawing a
   * viewmodel or ammo readout.
   */
  readonly activeWeapon: WeaponDef;
  /** A weapon is in the active slot. False when every inventory weapon slot is empty. */
  readonly armed: boolean;
  /** Current spread half-angle, degrees (dynamic crosshair). */
  readonly spreadDegrees: number;
  /** 0..1 progress of the current reload or equip, or null when ready. */
  readonly phaseProgress: number | null;
  /**
   * ADS blend smoothed for rendering, 0..1. weaponState.adsBlend only changes at the 60 Hz tick rate; prefer this for
   * anything drawn every frame (viewmodel pose, crosshair fade, scope overlay). Camera zoom already uses it.
   */
  readonly adsBlend: number;
  /** Bullets in flight (tracers). */
  readonly projectiles: readonly Projectile[];

  /** Local player health: equipment vitals once equipment is attached (one source for the HUD), else a full placeholder. */
  readonly health: number;
  readonly maxHealth: number;
}

/**
 * What CombatSystem needs from the equipment side; EquipmentSystem implements it. Weapons and their magazines live in
 * the inventory; combat mirrors them into WeaponState every tick and writes magazines and spent ammo back.
 */
export interface CombatEquipmentLink {
  readonly inventory: InventoryState;
  /** Tick-derived gates; `allowWeapons` false blocks fire, aim and reload. */
  readonly modifiers: { readonly allowWeapons: boolean };
  readonly vitals: { readonly health: number };
  readonly maxHealth: number;
  /** Changes when the whole kit is replaced (respawn), so the weapon state restarts from the new inventory. */
  readonly loadoutVersion: number;
  /** Tick-time write-back: magazines and consumed ammo, plus the active slot (null while unarmed) for pickup swaps. */
  commitWeapons(inventory: InventoryState, activeSlot: WeaponSlot | null): void;
}
