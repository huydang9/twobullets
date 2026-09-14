import { hash32 } from "../../equipment/math";
import type { Vec3 } from "../../movement/types";
import { NavFlag, type NavBuildingPlacement, type NavGrid, type NavPath, type NavQuery, type PathOptions, type PathStatus } from "../types";

// Fake NavQuery for brain tests and early match-sim wiring: a flat open world at `groundY` with optional solid 2D
// boxes. Paths go straight when the line is clear, otherwise around the blocking box's nearest corner. Searches resolve
// after `pendingUpdates` calls to `update`, like the time-sliced real query.

export interface FakeNavBox {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface FakeNavOptions {
  readonly groundY?: number;
  readonly halfExtent?: number;
  readonly boxes?: readonly FakeNavBox[];
  /** `update` calls before a request resolves (default 1). */
  readonly pendingUpdates?: number;
  /** Flags for a position (default walkable). */
  readonly flags?: (x: number, z: number) => number;
  /** Goals for which paths fail. */
  readonly unreachable?: (x: number, z: number) => boolean;
  /** Buildings exposed as `grid.placements` (search tests). */
  readonly placements?: readonly NavBuildingPlacement[];
  /** `requestPath` returns -1 (queue full) for goals matching this. */
  readonly refuse?: (x: number, z: number) => boolean;
}

interface Request {
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  status: PathStatus;
  waited: number;
  options: PathOptions | null;
}

const FAKE_GRID: NavGrid = {
  info: {
    version: 0,
    cellSize: 0.5,
    buildingCellSize: 0.25,
    coarseCellSize: 4,
    originX: -500,
    originZ: -500,
    width: 2000,
    depth: 2000,
    terrainNodes: 4_000_000,
    buildingNodes: 0,
    components: 1,
    byteLength: 0,
    checksum: "fake",
  },
};

export class FakeNavQuery implements NavQuery {
  readonly grid: NavGrid;
  readonly groundY: number;
  readonly halfExtent: number;
  readonly boxes: FakeNavBox[];
  /** Every requestPath call (tests assert on options). */
  readonly requests: Request[] = [];
  private readonly pendingUpdates: number;
  private readonly flagFn: ((x: number, z: number) => number) | null;
  private readonly unreachableFn: ((x: number, z: number) => boolean) | null;
  private readonly refuseFn: ((x: number, z: number) => boolean) | null;

  constructor(options: FakeNavOptions = {}) {
    this.groundY = options.groundY ?? 0;
    this.halfExtent = options.halfExtent ?? 500;
    this.boxes = [...(options.boxes ?? [])];
    this.pendingUpdates = options.pendingUpdates ?? 1;
    this.flagFn = options.flags ?? null;
    this.unreachableFn = options.unreachable ?? null;
    this.refuseFn = options.refuse ?? null;
    this.grid = options.placements ? { info: FAKE_GRID.info, placements: options.placements } : FAKE_GRID;
  }

  nearest(p: Vec3, _maxDistance: number, out: { x: number; y: number; z: number }): number {
    out.x = p.x;
    out.y = this.groundY;
    out.z = p.z;
    if (!this.walkable(p.x, p.z)) return -1;
    return this.ref(p.x, p.z);
  }

  flagsAt(ref: number): number {
    if (ref < 0) return 0;
    if (!this.flagFn) return NavFlag.walkable;
    const x = (ref % 2000) * 0.5 - 500;
    const z = Math.floor(ref / 2000) * 0.5 - 500;
    return this.flagFn(x, z) | NavFlag.walkable;
  }

  reachable(a: number, b: number): boolean {
    return a >= 0 && b >= 0;
  }

  lineWalkable(from: Vec3, to: Vec3): boolean {
    if (!this.walkable(to.x, to.z)) return false;
    for (const box of this.boxes) if (segmentHitsBox(from.x, from.z, to.x, to.z, box)) return false;
    return true;
  }

  requestPath(from: Vec3, to: Vec3, options: PathOptions | null): number {
    if (this.refuseFn?.(to.x, to.z)) return -1;
    this.requests.push({ fromX: from.x, fromZ: from.z, toX: to.x, toZ: to.z, status: "pending", waited: 0, options });
    return this.requests.length - 1;
  }

  readPath(handle: number, out: NavPath): PathStatus {
    const request = this.requests[handle];
    if (!request) return "released";
    if (request.status !== "found") {
      out.count = 0;
      out.length = 0;
      return request.status;
    }
    const y = this.groundY;
    let count = 0;
    const write = (x: number, z: number): void => {
      if (count * 3 + 2 >= out.points.length) return;
      out.points[count * 3] = x;
      out.points[count * 3 + 1] = y;
      out.points[count * 3 + 2] = z;
      out.flags[count] = this.flagsAt(this.ref(x, z));
      count++;
    };
    write(request.fromX, request.fromZ);
    const from = { x: request.fromX, y, z: request.fromZ };
    const to = { x: request.toX, y, z: request.toZ };
    if (!this.lineWalkable(from, to)) {
      const corner = this.detour(request.fromX, request.fromZ, request.toX, request.toZ);
      if (corner) write(corner[0], corner[1]);
    }
    write(request.toX, request.toZ);
    out.count = count;
    let length = 0;
    for (let i = 1; i < count; i++) {
      const dx = out.points[i * 3]! - out.points[(i - 1) * 3]!;
      const dz = out.points[i * 3 + 2]! - out.points[(i - 1) * 3 + 2]!;
      length += Math.sqrt(dx * dx + dz * dz);
    }
    out.length = length;
    return "found";
  }

  releasePath(handle: number): void {
    const request = this.requests[handle];
    if (request) request.status = "released";
  }

  update(maxExpansions: number): number {
    let used = 0;
    for (const request of this.requests) {
      if (request.status !== "pending") continue;
      request.waited++;
      used += 10;
      if (request.waited >= this.pendingUpdates) {
        const blocked = !this.walkable(request.toX, request.toZ) || (this.unreachableFn?.(request.toX, request.toZ) ?? false);
        request.status = blocked ? "unreachable" : "found";
      }
      if (used >= maxExpansions) break;
    }
    return Math.min(used, maxExpansions);
  }

  sampleRing(center: Vec3, minRadius: number, maxRadius: number, seed: number, out: Float32Array, max: number): number {
    let n = 0;
    for (let i = 0; i < max * 4 && n < max && (n + 1) * 3 <= out.length; i++) {
      const a = (hash32(seed, i, 1) / 4294967296) * Math.PI * 2;
      const r = minRadius + (maxRadius - minRadius) * (hash32(seed, i, 2) / 4294967296);
      const x = center.x + Math.sin(a) * r;
      const z = center.z + Math.cos(a) * r;
      if (!this.walkable(x, z)) continue;
      out[n * 3] = x;
      out[n * 3 + 1] = this.groundY;
      out[n * 3 + 2] = z;
      n++;
    }
    return n;
  }

  /** Resolves every pending request now (tests that don't call `update`). */
  flush(): void {
    this.update(Number.MAX_SAFE_INTEGER);
  }

  private walkable(x: number, z: number): boolean {
    if (Math.abs(x) > this.halfExtent || Math.abs(z) > this.halfExtent) return false;
    for (const box of this.boxes) if (x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ) return false;
    return true;
  }

  private ref(x: number, z: number): number {
    const ix = Math.max(0, Math.min(1999, Math.floor((x + 500) / 0.5)));
    const iz = Math.max(0, Math.min(1999, Math.floor((z + 500) / 0.5)));
    return iz * 2000 + ix;
  }

  private detour(fx: number, fz: number, tx: number, tz: number): [number, number] | null {
    let best: [number, number] | null = null;
    let bestLength = Infinity;
    const margin = 0.8;
    for (const box of this.boxes) {
      if (!segmentHitsBox(fx, fz, tx, tz, box)) continue;
      const corners: [number, number][] = [
        [box.minX - margin, box.minZ - margin],
        [box.maxX + margin, box.minZ - margin],
        [box.minX - margin, box.maxZ + margin],
        [box.maxX + margin, box.maxZ + margin],
      ];
      for (const c of corners) {
        const length = Math.sqrt((c[0] - fx) ** 2 + (c[1] - fz) ** 2) + Math.sqrt((tx - c[0]) ** 2 + (tz - c[1]) ** 2);
        if (length < bestLength) {
          bestLength = length;
          best = c;
        }
      }
    }
    return best;
  }
}

function segmentHitsBox(ax: number, az: number, bx: number, bz: number, box: FakeNavBox): boolean {
  // Slab test in 2D.
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  const axes: [number, number, number, number][] = [
    [ax, dx, box.minX, box.maxX],
    [az, dz, box.minZ, box.maxZ],
  ];
  for (const [p, d, min, max] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (p <= min || p >= max) return false;
      continue;
    }
    let ta = (min - p) / d;
    let tb = (max - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 >= t1) return false;
  }
  return true;
}
