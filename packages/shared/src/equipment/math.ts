import type { Vec3 } from "../movement/types";

// Small numeric helpers for the equipment sim. Math.sqrt instead of Math.hypot: it is correctly rounded (identical on
// every engine) and allocation-free (docs/backend/architecture.md R6).

export function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function dist3(a: Vec3, b: Vec3): number {
  return len3(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Rounds to one decimal, the precision health and damage are displayed and compared at. */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Timers within this of zero count as elapsed, so float accumulation at 60 Hz doesn't cost an extra tick. */
export const TIMER_EPSILON = 1e-6;

/** Unit aim direction for yaw/pitch (yaw 0 = +Z, +yaw toward +X, +pitch looks down), same basis as weaponStep. */
export function aimDirection(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return { x: Math.sin(yaw) * cosPitch, y: -Math.sin(pitch), z: Math.cos(yaw) * cosPitch };
}

/** splitmix32-style integer hash of up to three values; stable across engines. */
export function hash32(a: number, b = 0, c = 0): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16) ^ Math.imul(c, 0x27d4eb2f), 0x165667b1);
  h ^= h >>> 15;
  return h >>> 0;
}

/** FNV-1a hash of a string, for mixing ids like building names into seeds. */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32 stream from a 32-bit seed. */
export function createRng(seed: number): () => number {
  let a = hash32(seed) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks a key from positive weights using one uniform sample in [0, 1). Zero-weight entries are never chosen. */
export function pickWeighted<K extends string>(weights: Readonly<Partial<Record<K, number>>>, sample: number): K {
  let total = 0;
  for (const key in weights) total += weights[key] ?? 0;
  let target = sample * total;
  let last: K | undefined;
  for (const key in weights) {
    const w = weights[key] ?? 0;
    if (w <= 0) continue;
    last = key;
    if (target < w) return key;
    target -= w;
  }
  if (last === undefined) throw new Error("pickWeighted: no positive weights");
  return last;
}
