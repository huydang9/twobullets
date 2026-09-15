import { distance, round3, segmentDistance } from "../../layout/geometry";
import type { Vec2Tuple } from "../../types";

// Planar helpers for OSM geometry: simplification, clipping to the map square, hulls and minimum-area rectangles,
// multipolygon ring assembly. Basic arithmetic and sqrt only.

export function signedArea(ring: readonly Vec2Tuple[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  return sum / 2;
}

export function centroid(ring: readonly Vec2Tuple[]): Vec2Tuple {
  const a = signedArea(ring);
  if (Math.abs(a) < 1e-9) {
    let x = 0;
    let z = 0;
    for (const p of ring) [x, z] = [x + p[0], z + p[1]];
    return [x / Math.max(1, ring.length), z / Math.max(1, ring.length)];
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
    cx += (ring[j]![0] + ring[i]![0]) * f;
    cz += (ring[j]![1] + ring[i]![1]) * f;
  }
  return [cx / (6 * a), cz / (6 * a)];
}

/** Drops a closing point equal to the first. */
export function openRing(ring: readonly Vec2Tuple[]): Vec2Tuple[] {
  const out = [...ring];
  if (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out;
}

/** Douglas–Peucker simplification of an open polyline; endpoints are kept. */
export function simplifyPolyline(points: readonly Vec2Tuple[], tolerance: number): Vec2Tuple[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = segmentDistance(points[i]![0], points[i]![1], points[a]![0], points[a]![1], points[b]![0], points[b]![1]);
      if (d > worstDistance) [worst, worstDistance] = [i, d];
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** Simplifies a closed ring (no repeated closing point), keeping at least a triangle. */
export function simplifyRing(ring: readonly Vec2Tuple[], tolerance: number): Vec2Tuple[] {
  if (ring.length <= 4) return [...ring];
  // Split at the vertex farthest from the first so both halves keep their shape.
  let far = 1;
  let farDistance = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = distance(ring[0]![0], ring[0]![1], ring[i]![0], ring[i]![1]);
    if (d > farDistance) [far, farDistance] = [i, d];
  }
  const first = simplifyPolyline(ring.slice(0, far + 1), tolerance);
  const second = simplifyPolyline([...ring.slice(far), ring[0]!], tolerance);
  const out = [...first, ...second.slice(1, -1)];
  return out.length >= 3 ? out : [...ring];
}

/** Clips an open polyline to the square |x|, |z| ≤ half; returns the pieces inside (Liang–Barsky per segment). */
export function clipPolylineToSquare(points: readonly Vec2Tuple[], half: number): Vec2Tuple[][] {
  const pieces: Vec2Tuple[][] = [];
  let current: Vec2Tuple[] = [];
  const flush = () => {
    if (current.length >= 2) pieces.push(current);
    current = [];
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i]!;
    const [bx, bz] = points[i + 1]!;
    const dx = bx - ax;
    const dz = bz - az;
    let t0 = 0;
    let t1 = 1;
    let visible = true;
    for (const [p, q] of [[-dx, ax + half], [dx, half - ax], [-dz, az + half], [dz, half - az]] as const) {
      if (p === 0) {
        if (q < 0) visible = false;
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) visible = false;
        else if (r > t0) t0 = r;
      } else if (r < t0) visible = false;
      else if (r < t1) t1 = r;
    }
    if (!visible) {
      flush();
      continue;
    }
    const start: Vec2Tuple = [round3(ax + dx * t0), round3(az + dz * t0)];
    const end: Vec2Tuple = [round3(ax + dx * t1), round3(az + dz * t1)];
    if (current.length === 0 || t0 > 0) {
      flush();
      current.push(start);
    }
    current.push(end);
    if (t1 < 1) flush();
  }
  flush();
  return pieces;
}

/** Sutherland–Hodgman clip of a ring to the square |x|, |z| ≤ half. May return an empty ring. */
export function clipRingToSquare(ring: readonly Vec2Tuple[], half: number): Vec2Tuple[] {
  let out: Vec2Tuple[] = [...ring];
  const edges: readonly ((p: Vec2Tuple) => number)[] = [(p) => half - p[0], (p) => p[0] + half, (p) => half - p[1], (p) => p[1] + half];
  for (const inside of edges) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[(i + input.length - 1) % input.length]!;
      const b = input[i]!;
      const da = inside(a);
      const db = inside(b);
      if (db >= 0) {
        if (da < 0) out.push(lerpPoint(a, b, da / (da - db)));
        out.push(b);
      } else if (da >= 0) {
        out.push(lerpPoint(a, b, da / (da - db)));
      }
    }
  }
  return out.map((p): Vec2Tuple => [round3(p[0]), round3(p[1])]);
}

function lerpPoint(a: Vec2Tuple, b: Vec2Tuple, t: number): Vec2Tuple {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Convex hull (monotone chain), counter-clockwise, no repeated point. */
export function convexHull(points: readonly Vec2Tuple[]): Vec2Tuple[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length <= 2) return sorted;
  const cross = (o: Vec2Tuple, a: Vec2Tuple, b: Vec2Tuple) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2Tuple[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2Tuple[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Minimum-area enclosing rectangle: center, unit axis `u` (the long side), and half extents along u and its normal. */
export interface MinRect {
  readonly center: Vec2Tuple;
  /** Unit direction of the long side. */
  readonly axis: Vec2Tuple;
  /** Half length along `axis`, half width across it (length ≥ width). */
  readonly halfLength: number;
  readonly halfWidth: number;
}

export function minAreaRect(points: readonly Vec2Tuple[]): MinRect {
  const hull = convexHull(points);
  let best: MinRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const length = distance(a[0], a[1], b[0], b[1]);
    if (length < 1e-6) continue;
    const ux = (b[0] - a[0]) / length;
    const uz = (b[1] - a[1]) / length;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uz;
      const v = -p[0] * uz + p[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea - 1e-9) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      const center: Vec2Tuple = [cu * ux - cv * uz, cu * uz + cv * ux];
      const hu = (maxU - minU) / 2;
      const hv = (maxV - minV) / 2;
      best = hu >= hv ? { center, axis: [ux, uz], halfLength: hu, halfWidth: hv } : { center, axis: [-uz, ux], halfLength: hv, halfWidth: hu };
    }
  }
  if (!best) {
    const c = hull[0] ?? [0, 0];
    return { center: c, axis: [1, 0], halfLength: 0, halfWidth: 0 };
  }
  return best;
}

/**
 * Joins open way pieces into closed rings by matching endpoints (multipolygon members). Pieces that never close are
 * dropped.
 */
export function assembleRings(pieces: readonly (readonly Vec2Tuple[])[]): Vec2Tuple[][] {
  const same = (a: Vec2Tuple, b: Vec2Tuple) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  const open = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  const rings: Vec2Tuple[][] = [];
  while (open.length > 0) {
    let ring = open.shift()!;
    let grew = true;
    while (!same(ring[0]!, ring[ring.length - 1]!) && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const piece = open[i]!;
        const tail = ring[ring.length - 1]!;
        if (same(tail, piece[0]!)) ring = [...ring, ...piece.slice(1)];
        else if (same(tail, piece[piece.length - 1]!)) ring = [...ring, ...[...piece].reverse().slice(1)];
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (ring.length >= 4 && same(ring[0]!, ring[ring.length - 1]!)) rings.push(openRing(ring));
  }
  return rings;
}

/** Polyline length inside the square |x|, |z| ≤ half. */
export function lengthInside(points: readonly Vec2Tuple[], half: number): number {
  let total = 0;
  for (const piece of clipPolylineToSquare(points, half)) {
    for (let i = 0; i + 1 < piece.length; i++) total += distance(piece[i]![0], piece[i]![1], piece[i + 1]![0], piece[i + 1]![1]);
  }
  return total;
}

/** Point along a polyline at `along` meters, with the unit direction there. */
export function pointAlong(points: readonly Vec2Tuple[], along: number): { at: Vec2Tuple; dir: Vec2Tuple } {
  let remaining = along;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i]!;
    const [bx, bz] = points[i + 1]!;
    const length = distance(ax, az, bx, bz);
    if (length <= 0) continue;
    if (remaining <= length || i + 2 === points.length) {
      const t = Math.min(1, Math.max(0, remaining / length));
      return { at: [ax + (bx - ax) * t, az + (bz - az) * t], dir: [(bx - ax) / length, (bz - az) / length] };
    }
    remaining -= length;
  }
  const p = points[0] ?? [0, 0];
  return { at: p, dir: [1, 0] };
}

/** Nearest point on a polyline to (x, z), its distance and the segment direction there. */
export function nearestOnPolyline(points: readonly Vec2Tuple[], x: number, z: number): { at: Vec2Tuple; distance: number; dir: Vec2Tuple } {
  let best = { at: points[0] ?? ([0, 0] as Vec2Tuple), distance: Infinity, dir: [1, 0] as Vec2Tuple };
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i]!;
    const [bx, bz] = points[i + 1]!;
    const abx = bx - ax;
    const abz = bz - az;
    const lengthSq = abx * abx + abz * abz;
    if (lengthSq <= 0) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * abx + (z - az) * abz) / lengthSq));
    const px = ax + abx * t;
    const pz = az + abz * t;
    const d = distance(x, z, px, pz);
    if (d < best.distance) {
      const length = Math.sqrt(lengthSq);
      best = { at: [px, pz], distance: d, dir: [abx / length, abz / length] };
    }
  }
  return best;
}
