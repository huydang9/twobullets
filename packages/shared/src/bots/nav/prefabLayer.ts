import { MOVEMENT } from "../../constants";
import { wedgePlane } from "../../map/buildings/raycast";
import { sinCos } from "../../map/terrain/math";
import type { BuildingPrefab, PartRole } from "../../map/buildings/types";
import { NavFlag } from "../types";
import { CROUCH_CLEARANCE, MAX_NEIGHBOUR_RISE, MAX_SPANS_PER_COLUMN, NAV_STEP_HEIGHT, STAND_CLEARANCE, type NavPrefabLayer } from "./navGrid";

// Building layer of one prefab (design §3.2 item 2): columns of standable spans in prefab-local space.

const BUCKET = 1;
const EPS = 1e-4;
const WEDGE_SLOPE = sinCos((MOVEMENT.maxSlopeDegrees * Math.PI) / 180);
const MAX_WEDGE_TAN = WEDGE_SLOPE.sin / WEDGE_SLOPE.cos;
/** Dedupe floor tops closer than this, m. */
const TOP_MERGE = 0.02;
/** Parts thinner than this in X or Z aren't floors (rails, frames, balustrade panels), m. */
const MIN_SUPPORT_WIDTH = 0.12;

/** A part with its wedge plane resolved: solid below y = (w − nx·x − nz·z) / ny. */
export interface NavPart {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  readonly wedge: boolean;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly w: number;
  readonly role: PartRole;
}

/** Uniform 1 m bucket grid over a prefab's parts, each part registered with a margin so box queries up to it are exact. */
export class PartBuckets {
  readonly parts: readonly NavPart[];
  private readonly minX: number;
  private readonly minZ: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;

  constructor(prefab: BuildingPrefab, margin: number) {
    this.parts = prefab.parts.map((part): NavPart => {
      const plane = part.kind === "wedge" ? wedgePlane(part) : null;
      return {
        minX: part.min[0],
        minY: part.min[1],
        minZ: part.min[2],
        maxX: part.max[0],
        maxY: part.max[1],
        maxZ: part.max[2],
        wedge: plane !== null,
        nx: plane ? plane[0] : 0,
        ny: plane ? plane[1] : 1,
        nz: plane ? plane[2] : 0,
        w: plane ? plane[3] : 0,
        role: part.role,
      };
    });
    const b = prefab.bounds;
    this.minX = b.min[0] - margin - BUCKET;
    this.minZ = b.min[2] - margin - BUCKET;
    this.cols = Math.ceil((b.max[0] + margin + BUCKET - this.minX) / BUCKET) + 1;
    this.rows = Math.ceil((b.max[2] + margin + BUCKET - this.minZ) / BUCKET) + 1;
    const lists: number[][] = Array.from({ length: this.cols * this.rows }, () => []);
    this.parts.forEach((p, i) => {
      const x0 = Math.max(0, Math.floor((p.minX - margin - this.minX) / BUCKET));
      const x1 = Math.min(this.cols - 1, Math.floor((p.maxX + margin - this.minX) / BUCKET));
      const z0 = Math.max(0, Math.floor((p.minZ - margin - this.minZ) / BUCKET));
      const z1 = Math.min(this.rows - 1, Math.floor((p.maxZ + margin - this.minZ) / BUCKET));
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) lists[z * this.cols + x]!.push(i);
    });
    this.start = new Int32Array(lists.length + 1);
    let total = 0;
    lists.forEach((list, i) => {
      this.start[i] = total;
      total += list.length;
    });
    this.start[lists.length] = total;
    this.items = new Int32Array(total);
    lists.forEach((list, i) => this.items.set(list, this.start[i]!));
  }

  /** [first, end) range into `item()` for the bucket holding (x, z); empty outside. */
  bucket(x: number, z: number): number {
    const bx = Math.floor((x - this.minX) / BUCKET);
    const bz = Math.floor((z - this.minZ) / BUCKET);
    if (bx < 0 || bz < 0 || bx >= this.cols || bz >= this.rows) return -1;
    return bz * this.cols + bx;
  }

  first(bucket: number): number {
    return bucket < 0 ? 0 : this.start[bucket]!;
  }

  end(bucket: number): number {
    return bucket < 0 ? 0 : this.start[bucket + 1]!;
  }

  item(i: number): NavPart {
    return this.parts[this.items[i]!]!;
  }

  /**
   * True when a part overlaps the open box [x ± r] × (y0, y1) × [z ± r], using the true wedge height over the box. `r`
   * must not exceed the bucket margin.
   */
  blocks(x: number, z: number, r: number, y0: number, y1: number): boolean {
    const bucket = this.bucket(x, z);
    const end = this.end(bucket);
    for (let i = this.first(bucket); i < end; i++) {
      const p = this.item(i);
      if (p.minX >= x + r - EPS || p.maxX <= x - r + EPS || p.minZ >= z + r - EPS || p.maxZ <= z - r + EPS) continue;
      if (p.minY >= y1 - EPS) continue;
      const top = p.wedge ? wedgeMaxInRect(p, x - r, x + r, z - r, z + r) : p.maxY;
      if (top > y0 + EPS) return true;
    }
    return false;
  }
}

/**
 * True when a square capsule of half-width `r` swept along the segment (ax, az) → (bx, bz) overlaps a part in the
 * height band (y0, y1), start and end included. Exact for boxes (segment against the part rect grown by `r`); wedges use
 * their highest point over the swept rect.
 */
export function sweepBlocks(parts: readonly NavPart[], ax: number, az: number, bx: number, bz: number, r: number, y0: number, y1: number): boolean {
  const minX = (ax < bx ? ax : bx) - r;
  const maxX = (ax > bx ? ax : bx) + r;
  const minZ = (az < bz ? az : bz) - r;
  const maxZ = (az > bz ? az : bz) + r;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.minX >= maxX - EPS || p.maxX <= minX + EPS || p.minZ >= maxZ - EPS || p.maxZ <= minZ + EPS) continue;
    if (p.minY >= y1 - EPS) continue;
    const top = p.wedge ? wedgeMaxInRect(p, minX, maxX, minZ, maxZ) : p.maxY;
    if (top <= y0 + EPS) continue;
    if (segmentHitsRect(ax, az, bx, bz, p.minX - r + EPS, p.minZ - r + EPS, p.maxX + r - EPS, p.maxZ + r - EPS)) return true;
  }
  return false;
}

/** Segment against an open rect (slab clipping). */
function segmentHitsRect(ax: number, az: number, bx: number, bz: number, x0: number, z0: number, x1: number, z1: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  if (Math.abs(dx) < 1e-12) {
    if (ax <= x0 || ax >= x1) return false;
  } else {
    let a = (x0 - ax) / dx;
    let b = (x1 - ax) / dx;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 >= t1) return false;
  }
  if (Math.abs(dz) < 1e-12) return az > z0 && az < z1;
  let a = (z0 - az) / dz;
  let b = (z1 - az) / dz;
  if (a > b) [a, b] = [b, a];
  if (a > t0) t0 = a;
  if (b < t1) t1 = b;
  return t0 < t1;
}

export function partTopAt(p: NavPart, x: number, z: number): number {
  if (!p.wedge) return p.maxY;
  const y = (p.w - p.nx * x - p.nz * z) / p.ny;
  return y < p.minY ? p.minY : y > p.maxY ? p.maxY : y;
}

function wedgeMaxInRect(p: NavPart, x0: number, x1: number, z0: number, z1: number): number {
  const ax = x0 < p.minX ? p.minX : x0;
  const bx = x1 > p.maxX ? p.maxX : x1;
  const az = z0 < p.minZ ? p.minZ : z0;
  const bz = z1 > p.maxZ ? p.maxZ : z1;
  return Math.max(partTopAt(p, ax, az), partTopAt(p, bx, az), partTopAt(p, ax, bz), partTopAt(p, bx, bz));
}

export interface PrefabLayerBuild {
  readonly layer: NavPrefabLayer;
  readonly buckets: PartBuckets;
  readonly overflowColumns: number;
}

/** Builds the span columns of one prefab at `cell` spacing with obstacle inflation `agentRadius`. Deterministic. */
export function buildPrefabLayer(prefab: BuildingPrefab, cell: number, agentRadius: number): PrefabLayerBuild {
  const buckets = new PartBuckets(prefab, agentRadius + cell);
  const { min, max } = prefab.bounds;
  const minX = min[0];
  const minZ = min[2];
  const cols = Math.max(1, Math.ceil((max[0] - minX) / cell - 1e-9));
  const rows = Math.max(1, Math.ceil((max[2] - minZ) / cell - 1e-9));
  const colStart = new Int32Array(cols * rows + 1);
  const spanY: number[] = [];
  const spanCol: number[] = [];
  const spanFlags: number[] = [];
  const tops: number[] = [];
  const supports: NavPart[] = [];
  let overflowColumns = 0;
  const wedgeSteep = (p: NavPart) => p.wedge && Math.abs(p.ny) > 0 && Math.sqrt(p.nx * p.nx + p.nz * p.nz) / p.ny > MAX_WEDGE_TAN;

  for (let cz = 0; cz < rows; cz++) {
    const z = minZ + (cz + 0.5) * cell;
    for (let cx = 0; cx < cols; cx++) {
      const x = minX + (cx + 0.5) * cell;
      const col = cz * cols + cx;
      colStart[col] = spanY.length;
      const bucket = buckets.bucket(x, z);
      const end = buckets.end(bucket);
      tops.length = 0;
      supports.length = 0;
      for (let i = buckets.first(bucket); i < end; i++) {
        const p = buckets.item(i);
        if (x < p.minX - EPS || x > p.maxX + EPS || z < p.minZ - EPS || z > p.maxZ + EPS) continue;
        if (p.maxX - p.minX < MIN_SUPPORT_WIDTH || p.maxZ - p.minZ < MIN_SUPPORT_WIDTH) continue;
        if (wedgeSteep(p)) continue;
        tops.push(partTopAt(p, x, z));
        supports.push(p);
      }
      const order = tops.map((_, i) => i).sort((a, b) => tops[a]! - tops[b]! || a - b);
      let lastTop = -Infinity;
      let added = 0;
      for (const i of order) {
        const t = tops[i]!;
        if (t - lastTop < TOP_MERGE && added > 0) continue;
        // Buried: another part covering the center starts at or below this top and continues above it (a slab resting on
        // a wall top, a tread on the foundation).
        let buried = false;
        for (let j = buckets.first(bucket); j < end && !buried; j++) {
          const q = buckets.item(j);
          if (x <= q.minX || x >= q.maxX || z <= q.minZ || z >= q.maxZ) continue;
          if (q.minY <= t + 1e-3 && partTopAt(q, x, z) > t + 1e-3) buried = true;
        }
        if (buried) continue;
        const crouchBlocked = buckets.blocks(x, z, agentRadius, t + NAV_STEP_HEIGHT, t + CROUCH_CLEARANCE);
        if (crouchBlocked) continue;
        const standBlocked = buckets.blocks(x, z, agentRadius, t + NAV_STEP_HEIGHT, t + STAND_CLEARANCE);
        if (added >= MAX_SPANS_PER_COLUMN) {
          overflowColumns++;
          break;
        }
        let flags = NavFlag.walkable | (standBlocked ? NavFlag.crouchOnly : 0);
        if (supports[i]!.role === "stairs") flags |= NavFlag.stairs;
        flags |= spanFlagsAt(prefab, x, z, t);
        spanY.push(t);
        spanCol.push(col);
        spanFlags.push(flags);
        lastTop = t;
        added++;
      }
    }
  }
  colStart[cols * rows] = spanY.length;

  const layer: NavPrefabLayer = {
    prefab: prefab.id,
    minX,
    minZ,
    cols,
    rows,
    colStart,
    spanY: new Float32Array(spanY),
    spanCol: new Int32Array(spanCol),
    spanFlags: new Uint8Array(spanFlags),
    minY: min[1],
    maxY: max[1],
  };
  markNearObstacle(layer);
  return { layer, buckets, overflowColumns };
}

function spanFlagsAt(prefab: BuildingPrefab, x: number, z: number, t: number): number {
  let flags = 0;
  for (const room of prefab.rooms) {
    if (!room.indoor) continue;
    if (x >= room.min[0] && x <= room.max[0] && z >= room.min[1] && z <= room.max[1] && t >= room.floorY - 0.5 && t < room.floorY + 2.5) {
      flags |= NavFlag.indoor;
      break;
    }
  }
  for (const o of prefab.openings) {
    if (o.kind !== "door") continue;
    const along = o.axis === "x" ? x : z;
    const across = o.axis === "x" ? z : x;
    if (along < o.u[0] || along > o.u[1]) continue;
    if (across < o.through[0] - 0.35 || across > o.through[1] + 0.35) continue;
    if (t < o.y[0] - 0.4 || t > o.y[0] + 0.4) continue;
    flags |= NavFlag.door;
    break;
  }
  return flags;
}

/** nearObstacle: a passable span with an orthogonal neighbour column it can't step to. */
function markNearObstacle(layer: NavPrefabLayer): void {
  const { cols, rows, colStart, spanY, spanCol, spanFlags } = layer;
  const has = (col: number, y: number) => {
    for (let k = colStart[col]!; k < colStart[col + 1]!; k++) if (Math.abs(spanY[k]! - y) <= MAX_NEIGHBOUR_RISE + 1e-4) return true;
    return false;
  };
  for (let k = 0; k < spanY.length; k++) {
    const col = spanCol[k]!;
    const cx = col % cols;
    const cz = (col - cx) / cols;
    const y = spanY[k]!;
    const open = cx > 0 && cx < cols - 1 && cz > 0 && cz < rows - 1 && has(col + 1, y) && has(col - 1, y) && has(col + cols, y) && has(col - cols, y);
    if (!open) spanFlags[k] = spanFlags[k]! | NavFlag.nearObstacle;
  }
}
