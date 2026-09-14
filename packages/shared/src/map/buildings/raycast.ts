import type { Vec3Tuple } from "../../level/types";
import type { BuildingPart, WedgePart } from "./types";

/** Solid side of a wedge's slope plane: nx*x + ny*y + nz*z <= w. */
export function wedgePlane(part: WedgePart): readonly [nx: number, ny: number, nz: number, w: number] {
  const [x0, y0, z0] = part.min;
  const [x1, y1, z1] = part.max;
  const h = y1 - y0;
  switch (part.rises) {
    case "+z":
      return [0, z1 - z0, -h, (z1 - z0) * y0 - h * z0];
    case "-z":
      return [0, z1 - z0, h, (z1 - z0) * y0 + h * z1];
    case "+x":
      return [-h, x1 - x0, 0, (x1 - x0) * y0 - h * x0];
    case "-x":
      return [h, x1 - x0, 0, (x1 - x0) * y0 + h * x1];
  }
}

interface Node {
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
  /** Leaf part indices, or null for inner nodes. */
  readonly parts: readonly number[] | null;
  readonly left: number;
  readonly right: number;
}

const LEAF_SIZE = 4;
const T_EPS = 1e-5;

/** Bounding volume hierarchy over a prefab's parts for ray and box queries (AO baking, loot clearance, tests). */
export class PartBvh {
  private readonly nodes: Node[] = [];
  private readonly planes: (readonly [number, number, number, number] | null)[];
  private readonly stack: number[] = [];

  constructor(readonly parts: readonly BuildingPart[]) {
    this.planes = parts.map((p) => (p.kind === "wedge" ? wedgePlane(p) : null));
    if (parts.length > 0) this.build(parts.map((_, i) => i));
  }

  /**
   * Nearest hit distance along a ray (direction need not be normalized; distance is in units of it), or null.
   * With `any`, returns the first hit found, for occlusion queries.
   */
  raycast(o: Vec3Tuple, d: Vec3Tuple, tMax: number, any = false): number | null {
    if (this.nodes.length === 0) return null;
    const inv: Vec3Tuple = [1 / d[0], 1 / d[1], 1 / d[2]];
    let best = tMax;
    let hit = false;
    const stack = this.stack;
    stack.length = 0;
    stack.push(0);
    while (stack.length > 0) {
      const node = this.nodes[stack.pop()!]!;
      if (slab(node.min, node.max, o, inv, best) === null) continue;
      if (node.parts === null) {
        stack.push(node.left, node.right);
        continue;
      }
      for (const index of node.parts) {
        const t = this.rayPart(index, o, d, inv, best);
        if (t === null) continue;
        best = t;
        hit = true;
        if (any) return t;
      }
    }
    return hit ? best : null;
  }

  /** True when the open box (min, max) overlaps any part's bounding box. Touching faces don't count. */
  overlapsBox(min: Vec3Tuple, max: Vec3Tuple): boolean {
    const stack = [0];
    while (stack.length > 0 && this.nodes.length > 0) {
      const node = this.nodes[stack.pop()!]!;
      if (!boxesOverlap(node.min, node.max, min, max)) continue;
      if (node.parts === null) stack.push(node.left, node.right);
      else if (node.parts.some((i) => boxesOverlap(this.parts[i]!.min, this.parts[i]!.max, min, max))) return true;
    }
    return false;
  }

  private rayPart(index: number, o: Vec3Tuple, d: Vec3Tuple, inv: Vec3Tuple, tMax: number): number | null {
    const part = this.parts[index]!;
    const range = slab(part.min, part.max, o, inv, tMax);
    if (range === null) return null;
    let [t0, t1] = range;
    const plane = this.planes[index];
    if (plane) {
      const denom = plane[0] * d[0] + plane[1] * d[1] + plane[2] * d[2];
      const num = plane[3] - (plane[0] * o[0] + plane[1] * o[1] + plane[2] * o[2]);
      if (Math.abs(denom) < 1e-12) {
        if (num < 0) return null;
      } else if (denom > 0) t1 = Math.min(t1, num / denom);
      else t0 = Math.max(t0, num / denom);
      if (t0 > t1 || t1 <= T_EPS) return null;
    }
    return Math.max(t0, 0);
  }

  private build(indices: number[]): number {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const i of indices) {
      const p = this.parts[i]!;
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, p.min[a]!);
        max[a] = Math.max(max[a]!, p.max[a]!);
      }
    }
    const slot = this.nodes.length;
    if (indices.length <= LEAF_SIZE) {
      this.nodes.push({ min, max, parts: indices, left: -1, right: -1 });
      return slot;
    }
    const axis = [0, 1, 2].reduce((best, a) => (max[a]! - min[a]! > max[best]! - min[best]! ? a : best), 0);
    const center = (i: number) => this.parts[i]!.min[axis]! + this.parts[i]!.max[axis]!;
    indices.sort((a, b) => center(a) - center(b));
    const half = indices.length >> 1;
    this.nodes.push({ min, max, parts: null, left: -1, right: -1 });
    const left = this.build(indices.slice(0, half));
    const right = this.build(indices.slice(half));
    this.nodes[slot] = { min, max, parts: null, left, right };
    return slot;
  }
}

/** Ray/AABB slab test. Returns the [enter, exit] interval clipped to [0, tMax], or null. */
function slab(min: Vec3Tuple, max: Vec3Tuple, o: Vec3Tuple, inv: Vec3Tuple, tMax: number): [number, number] | null {
  let t0 = -Infinity;
  let t1 = tMax;
  for (let a = 0; a < 3; a++) {
    const ia = inv[a]!;
    if (!Number.isFinite(ia)) {
      // Parallel to this slab: inside or on its boundary planes counts as within.
      if (o[a]! < min[a]! || o[a]! > max[a]!) return null;
      continue;
    }
    let near = (min[a]! - o[a]!) * ia;
    let far = (max[a]! - o[a]!) * ia;
    if (near > far) [near, far] = [far, near];
    if (near > t0) t0 = near;
    if (far < t1) t1 = far;
    if (t0 > t1) return null;
  }
  if (t1 <= T_EPS) return null;
  return [t0, t1];
}

const OVERLAP_EPS = 1e-4;

export function boxesOverlap(aMin: Vec3Tuple, aMax: Vec3Tuple, bMin: Vec3Tuple, bMax: Vec3Tuple): boolean {
  for (let i = 0; i < 3; i++) {
    if (aMax[i]! <= bMin[i]! + OVERLAP_EPS || bMax[i]! <= aMin[i]! + OVERLAP_EPS) return false;
  }
  return true;
}
