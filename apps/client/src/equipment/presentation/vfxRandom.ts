import { Vector3 } from "@babylonjs/core";

/**
 * Small seeded PRNG (mulberry32) for effect variation. Detonations reseed from their position and a counter, and smoke
 * layouts from the cloud seed, so the same event looks the same wherever it is replayed. Allocation-free.
 */
export class VfxRandom {
  private state: number;

  constructor(seed = 0x2f6b1d) {
    this.state = seed >>> 0;
  }

  reseed(seed: number): this {
    this.state = seed >>> 0;
    return this;
  }

  /** 0 ≤ x < 1. */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** -1 ≤ x < 1. */
  signed(): number {
    return this.next() * 2 - 1;
  }

  /** Integer 0 ≤ i < n. */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** Seed from a world position (cm grid) and a counter. */
export function positionSeed(x: number, y: number, z: number, counter: number): number {
  let h = Math.imul(Math.round(x * 100) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(y * 100) | 0, 0x165667b1) ^ Math.imul(Math.round(z * 100) | 0, 0x1b873593);
  h = Math.imul(h ^ counter, 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

/** Random unit vector in a cone around unit `axis` (spread 0 = along it, ~1.5 = nearly flat). */
export function coneToRef(axis: Vector3, spread: number, random: VfxRandom, result: Vector3, tangent: Vector3, bitangent: Vector3): Vector3 {
  const reference = Math.abs(axis.y) < 0.95 ? Vector3.UpReadOnly : Vector3.RightReadOnly;
  Vector3.CrossToRef(reference, axis, tangent);
  tangent.normalize();
  Vector3.CrossToRef(axis, tangent, bitangent);
  const angle = random.next() * Math.PI * 2;
  const radius = random.next() * spread;
  const c = Math.cos(angle) * radius;
  const s = Math.sin(angle) * radius;
  result.set(axis.x + tangent.x * c + bitangent.x * s, axis.y + tangent.y * c + bitangent.y * s, axis.z + tangent.z * c + bitangent.z * s);
  return result.normalize();
}
