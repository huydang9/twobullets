/**
 * Arithmetic helpers for terrain generation. Only IEEE-754 basic operations, Math.floor/round/abs/min/max/sqrt and
 * Math.imul are used here: those are correctly rounded in every JS engine, so results match bit for bit between
 * browsers and Node. Transcendental Math functions (sin, exp, pow, hypot...) are not guaranteed to, so terrain code
 * uses the polynomial versions below instead.
 */

export const TWO_PI = 6.283185307179586;
const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite smoothstep; edges may be given in either order. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Squared distance from (px, pz) to segment a-b, and the segment parameter of the closest point. */
export function segmentDistanceSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number, out: { t: number }): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lengthSq = abx * abx + abz * abz;
  const t = lengthSq > 0 ? clamp(((px - ax) * abx + (pz - az) * abz) / lengthSq, 0, 1) : 0;
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  out.t = t;
  return dx * dx + dz * dz;
}

/** Deterministic sine and cosine (Taylor series after reducing to |x| ≤ π/4; error < 1e-15). */
export function sinCos(angle: number): { sin: number; cos: number } {
  let x = angle - Math.round(angle / TWO_PI) * TWO_PI; // [-π, π]
  let sign = 1;
  if (x < 0) {
    x = -x;
    sign = -1;
  }
  // Fold to [0, π/2]: sin(π - x) = sin x, cos(π - x) = -cos x.
  let cosSign = 1;
  if (x > HALF_PI) {
    x = PI - x;
    cosSign = -1;
  }
  // Swap to [0, π/4]: sin(π/2 - x) = cos x.
  const swap = x > HALF_PI / 2;
  if (swap) x = HALF_PI - x;
  const x2 = x * x;
  const s = x * (1 - (x2 / 6) * (1 - (x2 / 20) * (1 - (x2 / 42) * (1 - (x2 / 72) * (1 - (x2 / 110) * (1 - (x2 / 156) * (1 - x2 / 210)))))));
  const c = 1 - (x2 / 2) * (1 - (x2 / 12) * (1 - (x2 / 30) * (1 - (x2 / 56) * (1 - (x2 / 90) * (1 - (x2 / 132) * (1 - x2 / 182))))));
  return swap ? { sin: sign * c, cos: cosSign * s } : { sin: sign * s, cos: cosSign * c };
}
