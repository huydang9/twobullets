import type { HitZone, WeaponId } from "@twobullets/shared";
import type { Vec3Like } from "./acoustics";
import type { MechanicalCueKind } from "../viewmodel/timelines";

/**
 * Audio events. Positions are plain {x, y, z} (Babylon Vector3 satisfies them) so network events
 * (docs/backend/netcode.md §10: `Shot`, `AudioShot`, derived footsteps, `Detonate`) map onto them without conversion.
 */

/** Sound family for footsteps and bullet impacts. */
export type AcousticSurface = "concrete" | "dirt" | "grass" | "gravel" | "wood" | "metal";

/** Locomotion loudness class. "run" is the default movement speed; "walk" is slowed (ADS) movement. */
export type FootstepStance = "crouch" | "walk" | "run" | "sprint";

export type AudioBusId = "weapons" | "impacts" | "footsteps" | "foley" | "ambience" | "ui";

export interface GunshotAudioEvent {
  readonly weaponId: WeaponId;
  /** Muzzle position. */
  readonly position: Vec3Like;
  /** The listener fired it: plays the stereo first-person layers instead of the spatial ones. */
  readonly shooterIsLocal: boolean;
  readonly suppressed?: boolean;
  /**
   * Seconds since the shot happened (network latency); subtracted from the speed-of-sound delay so remote shots
   * aren't delayed twice.
   */
  readonly age?: number;
}

export interface FootstepAudioEvent {
  /** Feet position. */
  readonly position: Vec3Like;
  /** Resolved from the world under `position` when omitted. */
  readonly surface?: AcousticSurface;
  readonly stance: FootstepStance;
  readonly isLocal: boolean;
}

export interface LandingAudioEvent {
  readonly position: Vec3Like;
  /** Downward speed at touchdown, m/s. */
  readonly fallSpeed: number;
  readonly surface?: AcousticSurface;
  readonly isLocal: boolean;
}

export interface JumpAudioEvent {
  readonly position: Vec3Like;
  readonly surface?: AcousticSurface;
  readonly isLocal: boolean;
}

export interface ImpactAudioEvent {
  readonly position: Vec3Like;
  /** Surface normal, used to find the hit material when `surface` is omitted. */
  readonly normal?: Vec3Like;
  /** "flesh" for hits on characters. */
  readonly surface?: AcousticSurface | "flesh";
  /** Flesh only: head hits are sharper and brighter, limbs a little softer. */
  readonly zone?: HitZone;
  readonly weaponId?: WeaponId;
  readonly age?: number;
}

/** Frag or flashbang detonation (netcode `Detonate`). */
export interface ExplosionAudioEvent {
  readonly position: Vec3Like;
  /** Recording and mix: frag (default) or the sharper, lighter flashbang bang. */
  readonly kind?: "frag" | "flash";
  /** Level and range scale; 1 = one grenade. */
  readonly power?: number;
  readonly age?: number;
}

export type ThrowableAudioKind = "frag" | "smoke" | "flash" | "molotov";

/** A thrown grenade or canister hitting the world (derived from the local `stepThrowables` bounce flag). */
export interface ThrowableBounceAudioEvent {
  readonly kind: ThrowableAudioKind;
  readonly position: Vec3Like;
  readonly normal?: Vec3Like;
  /** Speed into the surface, m/s. */
  readonly impactSpeed: number;
  readonly surface?: AcousticSurface;
}

/**
 * Handling a throwable. `position` null = the listener's own hands (first person); otherwise spatial (remote pin
 * pull from `flags.cooking`, throw whoosh from `ThrowStart`).
 */
export interface ThrowActionAudioEvent {
  readonly action: "draw" | "pinPull" | "spoon" | "throw" | "pinReturn" | "holster";
  readonly kind: ThrowableAudioKind;
  readonly style?: "overhand" | "underhand";
  readonly position: Vec3Like | null;
}

/** A smoke canister going off or a molotov bursting (`Detonate` / `AreaEffectStart`). */
export interface AreaStartAudioEvent {
  readonly position: Vec3Like;
  readonly age?: number;
}

export type UseItemAudioId = "bandage" | "first_aid" | "medkit" | "energy_drink" | "painkiller";

/** Healing or boosting foley timed across the use (netcode: derived from `actionKind` + `phaseStart`). */
export interface ItemUseAudioEvent {
  readonly itemId: UseItemAudioId;
  /** Total use time, s; cues are spread across it. */
  readonly seconds: number;
  /** Seconds already elapsed (late join for remote players). */
  readonly elapsed?: number;
  /** null = the listener (first person). */
  readonly position: Vec3Like | null;
  /** Cancellation tag for {@link GameAudio.stopItemUse}. */
  readonly tag: string;
}

export type PickupAudioKind = "ammo" | "weapon" | "armor" | "backpack" | "consumable" | "throwable";

export interface ArmorHitAudioEvent {
  /** Damage the piece absorbed. */
  readonly absorbed: number;
  readonly destroyed: boolean;
  /** null = the listener's own armor. */
  readonly position: Vec3Like | null;
}

/** A bullet passing the listener (derived client-side from `Shot` trajectories). */
export interface NearMissAudioEvent {
  /** Closest point of the trajectory to the listener's head. */
  readonly position: Vec3Like;
  /** Bullet velocity at that point, m/s. */
  readonly velocity: Vec3Like;
  readonly weaponId: WeaponId;
}

/** Weapon handling sounds. `position` null = the listener's own weapon (first person). */
export interface MechanicalAudioEvent {
  readonly kind: MechanicalCueKind | "dryFire" | "equip";
  readonly weaponId: WeaponId;
  readonly position: Vec3Like | null;
  /** Seconds from now. */
  readonly delay?: number;
  /** Duration of multi-part motions (pump, bolt), s. */
  readonly span?: number;
  /** Cancellation tag (e.g. a reload that gets interrupted). */
  readonly tag?: string;
}

export interface HitConfirmAudioEvent {
  readonly zone: HitZone;
  readonly killed: boolean;
}
