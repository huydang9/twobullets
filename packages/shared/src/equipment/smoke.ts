import type { Vec3 } from "../movement/types";
import type { RaycastFn } from "../weapons/types";
import { clamp01, createRng, len2, lerp } from "./math";

export const SMOKE = {
  lifetime: 35,
  /** Time to reach full size; growth eases out. */
  growSeconds: 3,
  /** Density ramps up while the canister starts emitting. */
  fadeInSeconds: 1,
  /** Density fades to zero over the last seconds of the lifetime. */
  fadeSeconds: 6,
  /** Horizontal radius of the full cloud, m. */
  radius: 6.5,
  puffCount: 10,
  /** Puff radius range at full growth, m. */
  puffRadius: [1.9, 2.8],
  /** Puff center heights above the base, m. */
  puffHeight: [0.9, 2.6],
  /** Drift speed range, m/s, in a seeded direction; puffs also rise slowly. */
  driftSpeed: [0.04, 0.12],
  riseSpeed: 0.015,
  /** Optical depth per meter through a puff at full density. Three meters of smoke ≈ 1 % transmittance. */
  extinction: 1.5,
  /** Lines of sight with less transmittance than this count as blocked. */
  blockTransmittance: 0.1,
  /** Horizontal rays probed at spawn so the cloud doesn't spill through walls. */
  extentRays: 8,
  /** Height of those probes above the base, m. */
  extentProbeHeight: 1.2,
} as const;

/** Floats per puff in smokePuffs output: x, y, z, radius, density (0..1). */
export const SMOKE_PUFF_STRIDE = 5;

export interface SmokeCloud {
  readonly id: number;
  /** Ground point the cloud grows from. */
  readonly base: Vec3;
  readonly seed: number;
  readonly age: number;
  /** Drift velocity, m/s (horizontal). */
  readonly driftX: number;
  readonly driftZ: number;
  /** Free distance from the base in each extentRays direction (index k at angle 2πk/n from +Z toward +X), m. */
  readonly extents: readonly number[];
}

/** Starts a smoke cloud at a detonation point; probes walls once so puffs stay on the open side. */
export function createSmokeCloud(id: number, position: Vec3, seed: number, raycast: RaycastFn): SmokeCloud {
  const base = { x: position.x, y: position.y + 0.05, z: position.z };
  const random = createRng(seed);
  const angle = random() * Math.PI * 2;
  const speed = lerp(SMOKE.driftSpeed[0], SMOKE.driftSpeed[1], random());
  const probeY = base.y + SMOKE.extentProbeHeight;
  const extents: number[] = [];
  for (let k = 0; k < SMOKE.extentRays; k++) {
    const a = (k / SMOKE.extentRays) * Math.PI * 2;
    const to = { x: base.x + Math.sin(a) * SMOKE.radius, y: probeY, z: base.z + Math.cos(a) * SMOKE.radius };
    const hit = raycast({ x: base.x, y: probeY, z: base.z }, to);
    extents.push(hit ? Math.max(0.5, hit.fraction * SMOKE.radius - 0.3) : SMOKE.radius);
  }
  return { id, base, seed, age: 0, driftX: Math.sin(angle) * speed, driftZ: Math.cos(angle) * speed, extents };
}

export function stepSmokeCloud(cloud: SmokeCloud, dt: number): SmokeCloud {
  return { ...cloud, age: cloud.age + dt };
}

export function isSmokeExpired(cloud: SmokeCloud): boolean {
  return cloud.age >= SMOKE.lifetime;
}

/** 0..1 size: eases out to full over growSeconds. */
export function smokeGrowth(age: number): number {
  const t = clamp01(age / SMOKE.growSeconds);
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

/** 0..1 density: ramps in while emitting, full until the fade, then linear to zero at the end of the lifetime. */
export function smokeDensity(age: number): number {
  return Math.min(clamp01(age / SMOKE.fadeInSeconds), clamp01((SMOKE.lifetime - age) / SMOKE.fadeSeconds));
}

/** Effective cloud radius for relevance culling and bots, m. */
export function smokeRadius(age: number): number {
  return age >= SMOKE.lifetime ? 0 : SMOKE.radius * smokeGrowth(age);
}

/**
 * Writes the cloud's puffs (x, y, z, radius, density) into `out` and returns the puff count. Offsets are seeded, so
 * the client renders the same volume the server tests sight lines against.
 */
export function smokePuffs(cloud: SmokeCloud, out: Float32Array, offset = 0): number {
  const random = createRng(cloud.seed ^ 0x5eed);
  const growth = smokeGrowth(cloud.age);
  const density = smokeDensity(cloud.age);
  const cx = cloud.base.x + cloud.driftX * cloud.age;
  const cz = cloud.base.z + cloud.driftZ * cloud.age;
  const rise = SMOKE.riseSpeed * cloud.age;
  const n = SMOKE.puffCount;
  const count = Math.min(n, Math.floor((out.length - offset) / SMOKE_PUFF_STRIDE));
  for (let k = 0; k < count; k++) {
    const angle = ((k + random() * 0.8) / n) * Math.PI * 2;
    const reach = k === 0 ? 0 : Math.sqrt(random());
    const puffRadius = lerp(SMOKE.puffRadius[0], SMOKE.puffRadius[1], random()) * lerp(0.2, 1, growth);
    const height = lerp(SMOKE.puffHeight[0], SMOKE.puffHeight[1], random());
    const free = extentAt(cloud.extents, angle);
    // Keep each puff's center inside the probed free space, leaving part of its radius as margin.
    const distance = Math.min(reach * (SMOKE.radius - SMOKE.puffRadius[0]) * growth, Math.max(0, free - puffRadius * 0.6));
    const o = offset + k * SMOKE_PUFF_STRIDE;
    out[o] = cx + Math.sin(angle) * distance;
    out[o + 1] = cloud.base.y + height * lerp(0.5, 1, growth) + rise;
    out[o + 2] = cz + Math.cos(angle) * distance;
    out[o + 3] = puffRadius;
    out[o + 4] = density;
  }
  return count;
}

function extentAt(extents: readonly number[], angle: number): number {
  const n = extents.length;
  const f = ((angle / (Math.PI * 2)) * n + n) % n;
  const i = Math.floor(f);
  return lerp(extents[i]!, extents[(i + 1) % n]!, f - i);
}

const puffScratch = new Float32Array(SMOKE.puffCount * SMOKE_PUFF_STRIDE);

/**
 * Fraction of light passing along a segment through all clouds (1 = clear), from chord lengths through each puff
 * sphere. Smoke never stops bullets; this is for vision (bots, relevance, flash occlusion).
 */
export function smokeTransmittance(clouds: readonly SmokeCloud[], from: Vec3, to: Vec3): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq <= 0) return 1;
  let depth = 0;
  for (const cloud of clouds) {
    // Skip clouds whose bounding circle the segment can't reach.
    const reach = SMOKE.radius + SMOKE.puffRadius[1] + 1 + SMOKE.driftSpeed[1] * cloud.age;
    if (segmentPointDistance2D(from, to, cloud.base.x, cloud.base.z) > reach) continue;
    const count = smokePuffs(cloud, puffScratch);
    for (let k = 0; k < count; k++) {
      const o = k * SMOKE_PUFF_STRIDE;
      const chord = segmentSphereChord(from, dx, dy, dz, lengthSq, puffScratch[o]!, puffScratch[o + 1]!, puffScratch[o + 2]!, puffScratch[o + 3]!);
      depth += chord * SMOKE.extinction * puffScratch[o + 4]!;
    }
  }
  return Math.exp(-depth);
}

export function smokeBlocksSight(clouds: readonly SmokeCloud[], from: Vec3, to: Vec3): boolean {
  return clouds.length > 0 && smokeTransmittance(clouds, from, to) < SMOKE.blockTransmittance;
}

/** Length of the part of segment from→from+d inside a sphere, m. */
function segmentSphereChord(from: Vec3, dx: number, dy: number, dz: number, lengthSq: number, cx: number, cy: number, cz: number, r: number): number {
  const fx = from.x - cx;
  const fy = from.y - cy;
  const fz = from.z - cz;
  const b = fx * dx + fy * dy + fz * dz;
  const c = fx * fx + fy * fy + fz * fz - r * r;
  const disc = b * b - lengthSq * c;
  if (disc <= 0) return 0;
  const root = Math.sqrt(disc);
  const t0 = Math.max(0, (-b - root) / lengthSq);
  const t1 = Math.min(1, (-b + root) / lengthSq);
  return t1 > t0 ? (t1 - t0) * Math.sqrt(lengthSq) : 0;
}

function segmentPointDistance2D(from: Vec3, to: Vec3, px: number, pz: number): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? clamp01(((px - from.x) * dx + (pz - from.z) * dz) / lengthSq) : 0;
  return len2(from.x + dx * t - px, from.z + dz * t - pz);
}
