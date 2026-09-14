/**
 * Pure acoustic model: distance attenuation, air absorption, gunshot layer weights, speed of sound and bullet
 * fly-by geometry. No WebAudio or Babylon here, so it can be unit-tested headlessly (tools/audio/verify.ts).
 */

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const SPEED_OF_SOUND = 343;

/** Below this linear gain a sound is culled instead of playing (-54 dB). */
export const CULL_GAIN = 0.002;

/**
 * Noise radii (m) used by the mixer. These mirror the server audibility table planned in
 * docs/backend/netcode.md §10.2 and should move to packages/shared/src/audio/audibility.ts with it.
 */
export const AUDIBLE_RANGE = {
  footstepCrouch: 8,
  footstepWalk: 20,
  footstepRun: 30,
  footstepSprint: 40,
  landing: 25,
  reload: 12,
  suppressedShot: 150,
  impact: 80,
  explosion: 300,
  pinPull: 10,
  heal: 12,
  throwableBounce: 35,
  smokePop: 90,
  molotov: 110,
} as const;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(1e-6, gain));
}

/**
 * Inverse-power falloff beyond `reference` (exponent 1 = physical inverse distance), faded to silence over the last
 * 25 % of `range` so nothing pops out at the culling edge. Exponents below 1 keep loud events (gunshots) audible
 * at long range, compensating for the limited dynamic range of a game mix.
 */
export function distanceGain(d: number, reference: number, range: number, exponent = 1): number {
  if (d >= range) return 0;
  const falloff = (reference / Math.max(d, reference)) ** exponent;
  const edge = 1 - smoothstep(range * 0.75, range, d);
  return falloff * edge;
}

/** Low-pass cutoff (Hz) approximating air absorption: ~5 kHz at 100 m, ~1.6 kHz at 400 m, ~900 Hz at 800 m. */
export function airAbsorptionCutoff(d: number): number {
  return clamp(20_000 / (1 + d / 28), 700, 20_000);
}

export interface GunshotLayers {
  /** Close recording (crack, body, mechanism). */
  readonly near: number;
  /** Down-range recording (boom and natural tail). */
  readonly far: number;
  /** Extra send into the outdoor echo, 0..1: distant shots are mostly reflections. */
  readonly echo: number;
  /** Playback rate for the far layer; very distant reports sound lower and duller. */
  readonly farRate: number;
}

/** Crossfade between the near and far recordings by distance. */
export function gunshotLayers(d: number): GunshotLayers {
  const near = 1 - smoothstep(6, 70, d);
  const far = smoothstep(3, 45, d);
  return {
    near,
    far: Math.max(far, 0.2),
    echo: clamp(0.2 + d / 350, 0.2, 0.9),
    farRate: 1 - 0.12 * smoothstep(150, 700, d),
  };
}

/** Seconds until sound emitted `age` seconds ago at distance `d` reaches the listener. */
export function arrivalDelay(d: number, age = 0): number {
  return Math.max(0, d / SPEED_OF_SOUND - age);
}

export interface ClosestApproach {
  /** Distance from the listener to the segment's closest point, m. */
  readonly distance: number;
  /** 0..1 along the segment. */
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Closest point of segment a→b to point p. */
export function closestApproach(ax: number, ay: number, az: number, bx: number, by: number, bz: number, p: Vec3Like): ClosestApproach {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  const t = lengthSq > 0 ? clamp(((p.x - ax) * dx + (p.y - ay) * dy + (p.z - az) * dz) / lengthSq, 0, 1) : 0;
  const x = ax + dx * t;
  const y = ay + dy * t;
  const z = az + dz * t;
  return { distance: Math.hypot(p.x - x, p.y - y, p.z - z), t, x, y, z };
}

/** A bullet cracks (sonic boom) above the speed of sound and whizzes below it. */
export function isSupersonic(speed: number): boolean {
  return speed > SPEED_OF_SOUND;
}

/** Footstep spacing (m per footfall) by horizontal speed: ~2.4 steps/s crouching, ~3 running, ~3.3 sprinting. */
export function strideLength(speed: number): number {
  return clamp(0.55 + 0.25 * speed, 0.7, 3);
}
