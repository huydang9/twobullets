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
  readonly weaponId?: WeaponId;
  readonly age?: number;
}

/** Placeholder for grenades (M4 `Detonate`). */
export interface ExplosionAudioEvent {
  readonly position: Vec3Like;
  /** 1 = frag grenade. */
  readonly power?: number;
  readonly age?: number;
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
