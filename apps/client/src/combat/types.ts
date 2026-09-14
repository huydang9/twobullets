import type { Observable, Vector3 } from "@babylonjs/core";
import type { FiredShot, HitZone, Projectile, WeaponDef, WeaponEvent, WeaponState } from "@twobullets/shared";

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
  readonly activeWeapon: WeaponDef;
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

  /** Local player health; players can't take damage until milestone 4, but the HUD shows it. */
  readonly health: number;
  readonly maxHealth: number;
}
