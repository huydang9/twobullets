import { hash32 } from "../../equipment/math";
import type { Vec3 } from "../../movement/types";

// Small allocation-free helpers shared by the brain layers. Angles follow MoveInput: yaw 0 = +Z, +yaw toward +X,
// +pitch looks down.

export interface MutVec3 {
  x: number;
  y: number;
  z: number;
}

export const TWO_PI = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
const U32 = 4294967296;

export function vec3(x = 0, y = 0, z = 0): MutVec3 {
  return { x, y, z };
}

export function setVec(out: MutVec3, x: number, y: number, z: number): MutVec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copyVec(out: MutVec3, v: Vec3): MutVec3 {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
  return out;
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distVec2(a: Vec3, b: Vec3): number {
  return dist2(a.x, a.z, b.x, b.z);
}

export function distVec3(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Wraps to (-π, π]. */
export function wrapAngle(a: number): number {
  a = a % TWO_PI;
  if (a > Math.PI) a -= TWO_PI;
  else if (a <= -Math.PI) a += TWO_PI;
  return a;
}

/** Yaw that looks from (fromX, fromZ) toward (toX, toZ). */
export function yawTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

/** Pitch (+ down) that looks from `from` to `to`. */
export function pitchTo(from: Vec3, toX: number, toY: number, toZ: number): number {
  const horizontal = dist2(from.x, from.z, toX, toZ);
  return Math.atan2(from.y - toY, horizontal);
}

export function clampNum(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function ticksFor(seconds: number, dt: number): number {
  return Math.max(0, Math.round(seconds / dt));
}

/**
 * Counter-based RNG: every sample is hash32(base, counter++, stream), where base = hash32(matchSeed, slot). Streams keep
 * subsystems independent so adding a roll in one never reshuffles another.
 */
export class BotRandom {
  private base = 0;
  private counter = 0;
  private readonly stream: number;

  constructor(seed: number, slot: number, stream: number) {
    this.stream = stream;
    this.reseed(seed, slot);
  }

  reseed(seed: number, slot: number): void {
    this.base = hash32(seed >>> 0, slot >>> 0, 0x6b6f7473);
    this.counter = 0;
  }

  /** Uniform [0, 1). */
  next(): number {
    return hash32(this.base, this.counter++, this.stream) / U32;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  span(span: readonly [number, number]): number {
    return span[0] + (span[1] - span[0]) * this.next();
  }

  /** Integer in [min, max]. */
  int(span: readonly [number, number]): number {
    return Math.floor(span[0] + (span[1] - span[0] + 1) * this.next());
  }

  chance(p: number): boolean {
    return p > 0 && this.next() < p;
  }

  /** Standard normal sample (Box–Muller, one value per call). */
  gauss(): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
  }

  /** Stateless sample for a key (value noise lattice). Uniform [-1, 1). */
  lattice(key: number, axis: number): number {
    return (hash32(this.base ^ 0x51ed270b, key | 0, this.stream + axis * 7919) / U32) * 2 - 1;
  }
}

/** Streams per subsystem. */
export const RNG_STREAM = { perception: 1, aim: 2, goals: 3, motor: 4, combat: 5, loot: 6, noise: 7 } as const;
