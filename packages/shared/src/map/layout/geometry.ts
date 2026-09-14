import { sinCos } from "../terrain/math";
import type { Vec2Tuple } from "../types";

/**
 * 2D helpers for layout and validation, in the XZ plane. Only basic arithmetic and the deterministic `sinCos`, so
 * everything derived from them (scatter, footprints) is identical on the client and a Node server.
 */

/** Oriented rectangle: `halfExtents` along the local axes, local +Z turned toward world (sin yaw, cos yaw). */
export interface OrientedRect {
  readonly center: Vec2Tuple;
  readonly halfExtents: Vec2Tuple;
  readonly yaw: number;
}

export function rotate(localX: number, localZ: number, yaw: number): [number, number] {
  const { sin, cos } = sinCos(yaw);
  return [localX * cos + localZ * sin, -localX * sin + localZ * cos];
}

/** Local offset from a center and yaw to world XZ. */
export function offsetPoint(center: Vec2Tuple, yaw: number, localX: number, localZ: number): [number, number] {
  const [dx, dz] = rotate(localX, localZ, yaw);
  return [center[0] + dx, center[1] + dz];
}

export function rectCorners(rect: OrientedRect): [number, number][] {
  const [hx, hz] = rect.halfExtents;
  return [
    offsetPoint(rect.center, rect.yaw, -hx, -hz),
    offsetPoint(rect.center, rect.yaw, hx, -hz),
    offsetPoint(rect.center, rect.yaw, hx, hz),
    offsetPoint(rect.center, rect.yaw, -hx, hz),
  ];
}

/** Distance from a point outside the rect to its boundary; 0 inside. */
export function distanceToRect(rect: OrientedRect, x: number, z: number): number {
  const { sin, cos } = sinCos(rect.yaw);
  const dx = x - rect.center[0];
  const dz = z - rect.center[1];
  const ox = Math.abs(dx * cos - dz * sin) - rect.halfExtents[0];
  const oz = Math.abs(dx * sin + dz * cos) - rect.halfExtents[1];
  const px = ox > 0 ? ox : 0;
  const pz = oz > 0 ? oz : 0;
  return Math.sqrt(px * px + pz * pz);
}

/** Separating-axis test for two oriented rectangles, each grown by `margin`. Touching counts as no overlap. */
export function rectsOverlap(a: OrientedRect, b: OrientedRect, margin = 0): boolean {
  const grow = (r: OrientedRect): OrientedRect => ({ ...r, halfExtents: [r.halfExtents[0] + margin / 2, r.halfExtents[1] + margin / 2] });
  const ca = rectCorners(grow(a));
  const cb = rectCorners(grow(b));
  for (const corners of [ca, cb]) {
    for (let i = 0; i < 2; i++) {
      const [x0, z0] = corners[i]!;
      const [x1, z1] = corners[i + 1]!;
      const ax = -(z1 - z0);
      const az = x1 - x0;
      const project = (points: [number, number][]) => {
        let min = Infinity;
        let max = -Infinity;
        for (const [x, z] of points) {
          const p = x * ax + z * az;
          if (p < min) min = p;
          if (p > max) max = p;
        }
        return [min, max] as const;
      };
      const [minA, maxA] = project(ca);
      const [minB, maxB] = project(cb);
      if (maxA <= minB || maxB <= minA) return false;
    }
  }
  return true;
}

export function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
}

export function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const lengthSq = abx * abx + abz * abz;
  let t = lengthSq > 0 ? ((px - ax) * abx + (pz - az) * abz) / lengthSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + abx * t);
  const dz = pz - (az + abz * t);
  return Math.sqrt(dx * dx + dz * dz);
}

export function polylineDistance(points: readonly Vec2Tuple[], x: number, z: number): number {
  if (points.length === 1) return distance(x, z, points[0]![0], points[0]![1]);
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i++) {
    const d = segmentDistance(x, z, points[i]![0], points[i]![1], points[i + 1]![0], points[i + 1]![1]);
    if (d < best) best = d;
  }
  return best;
}

/** Even-odd point-in-polygon test. */
export function pointInPolygon(polygon: readonly Vec2Tuple[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!;
    const [xj, zj] = polygon[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance to the polygon's outline (inside or outside). */
export function polygonEdgeDistance(polygon: readonly Vec2Tuple[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const d = segmentDistance(x, z, polygon[j]![0], polygon[j]![1], polygon[i]![0], polygon[i]![1]);
    if (d < best) best = d;
  }
  return best;
}

export function polygonBounds(polygon: readonly Vec2Tuple[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

export function polygonArea(polygon: readonly Vec2Tuple[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) sum += polygon[j]![0] * polygon[i]![1] - polygon[i]![0] * polygon[j]![1];
  return Math.abs(sum) / 2;
}

export function polylineLength(points: readonly Vec2Tuple[]): number {
  let length = 0;
  for (let i = 0; i + 1 < points.length; i++) length += distance(points[i]![0], points[i]![1], points[i + 1]![0], points[i + 1]![1]);
  return length;
}

/**
 * Smooth curve through control points (uniform Catmull-Rom, ends clamped), resampled about every `step` meters.
 * Control points are kept exactly.
 */
export function catmullRom(points: readonly Vec2Tuple[], step: number): Vec2Tuple[] {
  if (points.length < 3) return [...points];
  const out: Vec2Tuple[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1]!;
    const length = distance(p1[0], p1[1], p2[0], p2[1]);
    const steps = Math.max(1, Math.ceil(length / step));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([round3(f(p0[0], p1[0], p2[0], p3[0])), round3(f(p0[1], p1[1], p2[1], p3[1]))]);
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

/**
 * Closed band polygon along one side of a polyline, between `inner` and `outer` meters from it. `side` +1 is to the
 * right of the direction of travel, -1 to the left. Meant for gentle curves (tree lines along roads).
 */
export function bandAlong(points: readonly Vec2Tuple[], inner: number, outer: number, side: 1 | -1): Vec2Tuple[] {
  const normals = points.map((_, i) => {
    const a = points[i === 0 ? 0 : i - 1]!;
    const b = points[i + 1 < points.length ? i + 1 : i]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.sqrt(dx * dx + dz * dz) || 1;
    // Right of travel direction (dx, dz) in the XZ plane (+X east, +Z north) is (dz, -dx).
    return [(dz / length) * side, (-dx / length) * side] as const;
  });
  const near = points.map((p, i): Vec2Tuple => [round3(p[0] + normals[i]![0] * inner), round3(p[1] + normals[i]![1] * inner)]);
  const far = points.map((p, i): Vec2Tuple => [round3(p[0] + normals[i]![0] * outer), round3(p[1] + normals[i]![1] * outer)]);
  return [...near, ...far.reverse()];
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Uniform grid of buckets for proximity queries over many small items. */
export class SpatialHash<T> {
  private readonly cells = new Map<number, T[]>();

  constructor(private readonly cellSize: number) {}

  private key(ix: number, iz: number): number {
    return (ix + 32768) * 65536 + (iz + 32768);
  }

  /** Inserts `item` into every cell overlapping the square of `radius` around (x, z). */
  insert(item: T, x: number, z: number, radius: number): void {
    const s = this.cellSize;
    for (let iz = Math.floor((z - radius) / s); iz <= Math.floor((z + radius) / s); iz++) {
      for (let ix = Math.floor((x - radius) / s); ix <= Math.floor((x + radius) / s); ix++) {
        const key = this.key(ix, iz);
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(item);
        else this.cells.set(key, [item]);
      }
    }
  }

  /** Calls `visit` for items in cells overlapping the square of `radius` around (x, z); return true to stop. */
  query(x: number, z: number, radius: number, visit: (item: T) => boolean | void): boolean {
    const s = this.cellSize;
    for (let iz = Math.floor((z - radius) / s); iz <= Math.floor((z + radius) / s); iz++) {
      for (let ix = Math.floor((x - radius) / s); ix <= Math.floor((x + radius) / s); ix++) {
        const bucket = this.cells.get(this.key(ix, iz));
        if (bucket) for (const item of bucket) if (visit(item)) return true;
      }
    }
    return false;
  }
}
