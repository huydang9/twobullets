import type { NoiseKind } from "../bots/types";
import type { Stance } from "../movement/types";
import type { WeaponId } from "../weapons/types";

// Audibility radii (ADR 0207, docs/bots/design.md §4): what the match emits as NoiseEvents for bot hearing. Radii are
// before a listener's `hearingScale`. Pure data and helpers.

export const NOISE_RADII = {
  footstep: { crouch: 8, walk: 20, sprint: 40 },
  /** Landing faster than `landMinFallSpeed`. */
  land: 25,
  landMinFallSpeed: 6,
  /** Reload, heal and pin pull. */
  reload: 12,
  heal: 12,
  pin: 12,
  shot: { pistol: 350, shotgun: 450, rifle: 800, sniper: 1000 } satisfies Readonly<Record<WeaponId, number>>,
  explosion: 300,
  /** A bullet impact is heard around the impact point. */
  impact: 40,
} as const;

/** Footsteps are emitted every this many ticks while moving on the ground (one noise per stride, not per tick). */
export const FOOTSTEP_INTERVAL_TICKS = 20;
/** Below this horizontal speed nobody hears steps, m/s. */
export const FOOTSTEP_MIN_SPEED = 1;

/** Footstep radius for a moving actor, 0 when silent (airborne, downed crawl, standing still). */
export function footstepRadius(stance: Stance, sprinting: boolean, horizontalSpeed: number, grounded: boolean): number {
  if (!grounded || stance === "prone" || horizontalSpeed < FOOTSTEP_MIN_SPEED) return 0;
  if (sprinting) return NOISE_RADII.footstep.sprint;
  return stance === "crouch" ? NOISE_RADII.footstep.crouch : NOISE_RADII.footstep.walk;
}

export function shotNoiseRadius(weaponId: WeaponId): number {
  return NOISE_RADII.shot[weaponId];
}

export function landNoiseRadius(fallSpeed: number): number {
  return fallSpeed > NOISE_RADII.landMinFallSpeed ? NOISE_RADII.land : 0;
}

/** Default radius per noise kind (footsteps: walk; shots: rifle). */
export function noiseRadius(kind: NoiseKind): number {
  switch (kind) {
    case "shot":
      return NOISE_RADII.shot.rifle;
    case "footstep":
      return NOISE_RADII.footstep.walk;
    case "land":
      return NOISE_RADII.land;
    case "reload":
      return NOISE_RADII.reload;
    case "heal":
      return NOISE_RADII.heal;
    case "explosion":
      return NOISE_RADII.explosion;
    case "impact":
      return NOISE_RADII.impact;
  }
}

/** True when a listener at squared distance `distanceSq` hears a noise of `radius` with `hearingScale`. */
export function hears(radius: number, hearingScale: number, distanceSq: number): boolean {
  const r = radius * hearingScale;
  return distanceSq <= r * r;
}
