import type { Vec3 } from "../movement/types";

export type WeaponId = "pistol" | "rifle" | "shotgun" | "sniper";
export type FireMode = "semi" | "auto" | "bolt";
export type HitZone = "head" | "body" | "limb";

/** Static weapon tuning. Angles in degrees, distances in meters, times in seconds. */
export interface WeaponDef {
  readonly id: WeaponId;
  readonly name: string;
  /** 1-based inventory slot; also the number key that selects it. */
  readonly slot: number;
  readonly fireMode: FireMode;
  readonly roundsPerMinute: number;
  readonly magazineSize: number;
  /** Spare ammo carried at spawn. */
  readonly reserveAmmo: number;
  readonly reloadSeconds: number;
  readonly equipSeconds: number;

  /** Damage per pellet before zone multiplier and range falloff. */
  readonly damage: number;
  readonly zoneMultipliers: Readonly<Record<HitZone, number>>;
  /** Projectiles per shot (shotguns > 1). */
  readonly pellets: number;
  readonly falloff: {
    readonly startMeters: number;
    readonly endMeters: number;
    /** Damage multiplier at and beyond endMeters. */
    readonly minMultiplier: number;
  };

  /** Ballistics: bullets are simulated projectiles with drop, not hitscan. */
  readonly muzzleVelocity: number;
  /** Multiplier on BALLISTICS.gravity (lets arcade weapons drop less than realistic). */
  readonly gravityScale: number;
  readonly maxRangeMeters: number;

  /** Spread cone half-angles. Final spread = base (hip/ads, lerped by ADS blend) + penalties + bloom. */
  readonly spread: {
    readonly hip: number;
    readonly ads: number;
    readonly moving: number;
    readonly airborne: number;
    readonly bloomPerShot: number;
    readonly maxBloom: number;
    /** Bloom recovered per second. */
    readonly bloomRecovery: number;
    /** Extra per-pellet cone for multi-pellet weapons. */
    readonly pelletCone: number;
  };

  /**
   * Recoil permanently rotates the aim (PUBG-like); the player compensates by pulling down.
   * Degrees here; FiredShot carries the resulting kick in radians.
   */
  readonly recoil: {
    readonly up: number;
    /** Random horizontal kick in [-yaw, +yaw]. */
    readonly yaw: number;
    readonly adsMultiplier: number;
  };

  readonly ads: {
    /** Horizontal FOV while fully aimed. */
    readonly fovDegrees: number;
    readonly seconds: number;
    readonly moveSpeedScale: number;
    readonly sensitivityScale: number;
    /** Uses a full-screen scope overlay instead of iron sights. */
    readonly scoped: boolean;
  };
  /** Ground speed multiplier while holding this weapon (not aiming). */
  readonly moveSpeedScale: number;
}

export interface WeaponSlotState {
  readonly id: WeaponId;
  readonly magazine: number;
  readonly reserve: number;
}

export type WeaponPhase = "ready" | "equipping" | "reloading";

/** Per-player weapon simulation state. Plain data: snapshot, send and replay like MoveState. */
export interface WeaponState {
  readonly slots: readonly WeaponSlotState[];
  /** Index into slots. */
  readonly activeIndex: number;
  readonly phase: WeaponPhase;
  /** Seconds left in the current equip/reload phase. */
  readonly phaseTimer: number;
  /** Seconds until the next shot is allowed (fire rate, bolt cycling). */
  readonly cooldown: number;
  /** Previous tick's fire input, for semi/bolt edge detection. */
  readonly triggerHeld: boolean;
  /** Current bloom, degrees. */
  readonly bloom: number;
  /** 0 = hip, 1 = fully aimed. */
  readonly adsBlend: number;
  /** Monotonic shot counter; seeds the deterministic spread/recoil RNG so server and client agree. */
  readonly shotCounter: number;
}

/** One tick of combat intent; sent alongside MoveInput in milestone 3. */
export interface CombatInput {
  /** Fire button held this tick (or tapped since the previous tick). */
  readonly fire: boolean;
  readonly aim: boolean;
  /** Reload requested this tick. */
  readonly reload: boolean;
  /** Slot index to switch to this tick, or null. */
  readonly selectIndex: number | null;
}

/** Movement/aim facts the weapon step needs; produced by the movement tick. */
export interface WeaponContext {
  readonly eye: Vec3;
  /** Radians, same convention as MoveInput. */
  readonly yaw: number;
  readonly pitch: number;
  readonly horizontalSpeed: number;
  readonly grounded: boolean;
  readonly sprinting: boolean;
}

export interface FiredShot {
  readonly weaponId: WeaponId;
  readonly shotId: number;
  readonly origin: Vec3;
  /** Unit direction per pellet, spread already applied. */
  readonly directions: readonly Vec3[];
  /** Aim rotation to apply via recoil, radians (up = raise aim, right = turn right). */
  readonly recoilUp: number;
  readonly recoilRight: number;
}

export type WeaponEvent =
  | { readonly type: "equipStarted"; readonly weaponId: WeaponId; readonly seconds: number }
  | { readonly type: "reloadStarted"; readonly weaponId: WeaponId; readonly seconds: number }
  | { readonly type: "reloadFinished"; readonly weaponId: WeaponId }
  | { readonly type: "reloadCancelled"; readonly weaponId: WeaponId }
  | { readonly type: "dryFire"; readonly weaponId: WeaponId };

export interface WeaponStepResult {
  readonly state: WeaponState;
  readonly shots: readonly FiredShot[];
  readonly events: readonly WeaponEvent[];
}

/** A bullet in flight. */
export interface Projectile {
  readonly id: number;
  readonly shotId: number;
  readonly weaponId: WeaponId;
  readonly position: Vec3;
  readonly velocity: Vec3;
  /** Meters travelled so far (for falloff and max range). */
  readonly distance: number;
  /** Seconds in flight (for the lifetime cap). */
  readonly age: number;
}

export interface RayHit {
  readonly point: Vec3;
  readonly normal: Vec3;
  /** 0..1 along the queried segment. */
  readonly fraction: number;
  /** Opaque collider id the caller maps to a target and hit zone; null for world geometry. */
  readonly colliderId: string | null;
}

/** Segment query supplied by the engine side (Havok on client and server). */
export type RaycastFn = (from: Vec3, to: Vec3) => RayHit | null;

export interface ProjectileImpact {
  readonly projectile: Projectile;
  readonly hit: RayHit;
  /** Total meters travelled at impact. */
  readonly distance: number;
}

export interface ProjectileStepResult {
  readonly alive: readonly Projectile[];
  readonly impacts: readonly ProjectileImpact[];
  /** Projectiles removed this step without hitting anything (max range, lifetime). */
  readonly expired: readonly Projectile[];
}
