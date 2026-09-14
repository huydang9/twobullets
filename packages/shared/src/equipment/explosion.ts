import { MOVEMENT } from "../constants";
import type { Vec3 } from "../movement/types";
import type { RaycastFn } from "../weapons/types";
import { clamp01, len3, round1 } from "./math";

export const EXPLOSION = {
  frag: {
    /** Damage at or inside innerRadius, before armor and exposure. */
    damage: 140,
    /** Full damage radius, m. */
    innerRadius: 2,
    /** Damage falls linearly to zero here, m. */
    outerRadius: 9,
  },
  /** Blast origin is lifted off the contact surface so floor-level rays don't start inside the ground, m. */
  surfaceOffset: 0.15,
} as const;

export type Posture = "stand" | "crouch" | "downed";

/** Where a damageable entity is, for area effects: feet position and posture. */
export interface EntitySample {
  readonly id: number;
  readonly team: number;
  readonly feet: Vec3;
  readonly posture: Posture;
}

/** Heights above the feet sampled for exposure, per posture: head, chest, feet. m. */
export const EXPOSURE_HEIGHTS: Readonly<Record<Posture, readonly [number, number, number]>> = {
  stand: [MOVEMENT.standEyeHeight, 1.2, 0.2],
  crouch: [MOVEMENT.crouchEyeHeight, 0.7, 0.2],
  downed: [0.45, 0.3, 0.15],
};

export interface ExplosionHit {
  readonly targetId: number;
  /** Final damage before armor (the vest applies later in applyDamage). */
  readonly amount: number;
  /** 0..1: sample points with a clear line from the blast, weighted by their falloff. */
  readonly exposure: number;
  /** Distance from the blast to the nearest sample point, m. */
  readonly distance: number;
}

export interface ExplosionSpec {
  readonly damage: number;
  readonly innerRadius: number;
  readonly outerRadius: number;
}

/** Linear falloff: 1 inside innerRadius, 0 at outerRadius. */
export function explosionFalloff(spec: ExplosionSpec, distance: number): number {
  if (distance <= spec.innerRadius) return 1;
  return clamp01(1 - (distance - spec.innerRadius) / (spec.outerRadius - spec.innerRadius));
}

/** Blast origin for a detonation at `position` with contact `normal`. */
export function blastOrigin(position: Vec3, normal: Vec3): Vec3 {
  const k = EXPLOSION.surfaceOffset;
  return { x: position.x + normal.x * k, y: position.y + normal.y * k, z: position.z + normal.z * k };
}

/**
 * Explosion damage against entities: for each of three points on the target (head, chest, feet), falloff by that
 * point's distance, counted only when the world raycast from the blast to the point is clear. Damage is the mean
 * of the three, so a target half behind a low wall takes partial damage and one fully behind a wall takes none.
 * Friendly fire and self damage are the caller's policy (every entity in range is returned).
 */
export function computeExplosionHits(origin: Vec3, spec: ExplosionSpec, entities: readonly EntitySample[], raycast: RaycastFn): ExplosionHit[] {
  const hits: ExplosionHit[] = [];
  const outer = spec.outerRadius;
  for (const entity of entities) {
    const { feet } = entity;
    const dx = feet.x - origin.x;
    const dz = feet.z - origin.z;
    // Cheap reject on horizontal distance before any raycast.
    if (dx * dx + dz * dz > (outer + 0.5) * (outer + 0.5)) continue;

    let weighted = 0;
    let nearest = Infinity;
    for (const height of EXPOSURE_HEIGHTS[entity.posture]) {
      const point = { x: feet.x, y: feet.y + height, z: feet.z };
      const distance = len3(point.x - origin.x, point.y - origin.y, point.z - origin.z);
      nearest = Math.min(nearest, distance);
      const falloff = explosionFalloff(spec, distance);
      if (falloff <= 0) continue;
      if (raycast(origin, point) === null) weighted += falloff;
    }
    const exposure = weighted / 3;
    const amount = round1(spec.damage * exposure);
    if (amount > 0) hits.push({ targetId: entity.id, amount, exposure, distance: nearest });
  }
  return hits;
}
