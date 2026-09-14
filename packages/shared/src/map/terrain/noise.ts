/** Seeded integer-hash gradient noise. Deterministic across JS engines (see math.ts). */

const DIAGONAL = 0.7071067811865476;
const GRAD_X = [1, -1, 0, 0, DIAGONAL, -DIAGONAL, DIAGONAL, -DIAGONAL] as const;
const GRAD_Z = [0, 0, 1, -1, DIAGONAL, DIAGONAL, -DIAGONAL, -DIAGONAL] as const;
/** 2D gradient noise with unit gradients peaks at ±√0.5; this maps it to about ±1. */
const NOISE_SCALE = 1.4142135623730951;

/** 32-bit avalanche hash of a lattice point (murmur3 finalizer). */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ seed ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Derives an independent seed for a named noise layer. */
export function subSeed(seed: number, layer: number): number {
  return hash2(layer, 0x5bd1e995, seed);
}

function gradDot(ix: number, iz: number, seed: number, dx: number, dz: number): number {
  const g = hash2(ix, iz, seed) & 7;
  return GRAD_X[g]! * dx + GRAD_Z[g]! * dz;
}

/** Perlin-style gradient noise in about [-1, 1], zero at lattice points. */
export function gradientNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const n00 = gradDot(ix, iz, seed, fx, fz);
  const n10 = gradDot(ix + 1, iz, seed, fx - 1, fz);
  const n01 = gradDot(ix, iz + 1, seed, fx, fz - 1);
  const n11 = gradDot(ix + 1, iz + 1, seed, fx - 1, fz - 1);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * NOISE_SCALE;
}

// Each octave is rotated by a fixed rational rotation (0.8, 0.6) and doubled, so octave lattices never align.
const ROT_C = 0.8;
const ROT_S = 0.6;

/** Fractal sum of `octaves` noise layers, normalized to about [-1, 1]. Coordinates are in noise cycles. */
export function fbm(x: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  let px = x;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += gradientNoise(px, pz, seed + i * 1013) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    const rx = ROT_C * px - ROT_S * pz;
    pz = (ROT_S * px + ROT_C * pz) * 2 + 17.3;
    px = rx * 2 + 31.7;
  }
  return sum / norm;
}

/**
 * Ridged multifractal in about [0, 1]: sharp crests where the noise crosses zero, each octave weighted by the
 * previous one so detail concentrates on the ridges (mountain-like).
 */
export function ridged(x: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amplitude = 0.5;
  let weight = 1;
  let norm = 0;
  let px = x;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    let r = 1 - Math.abs(gradientNoise(px, pz, seed + i * 7919));
    r *= r;
    r *= weight;
    weight = r * 2 > 1 ? 1 : r * 2;
    sum += r * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    const rx = ROT_C * px - ROT_S * pz;
    pz = (ROT_S * px + ROT_C * pz) * 2 + 11.1;
    px = rx * 2 + 23.9;
  }
  return sum / norm;
}
