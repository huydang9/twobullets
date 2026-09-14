import { hash32 } from "../../equipment/math";
import { sinCos } from "../../map/terrain/math";
import type { Vec3 } from "../../movement/types";
import { NavFlag, type NavGrid, type NavPath, type NavQuery, type PathOptions, type PathStatus } from "../types";
import { NavGridData, PASSABLE, asNavGridData, labelCoarseBlock, type NavPrefabLayer } from "./navGrid";

// createNavQuery (docs/bots/design.md §3.3): time-sliced A* on typed arrays. Short routes run one fine search in a
// 320 × 320 cell window; long routes follow a coarse 4 m corridor and refine it leg by leg (each leg in its own window)
// inside the same request, so `found` is always a full fine path. Nothing allocates after construction.

export const NAV_QUERY_LIMITS = {
  /** Fine search window side, terrain cells. */
  window: 320,
  /** Concurrent path handles; the oldest finished handle is recycled when all are taken. */
  maxRequests: 64,
  /** Smoothed points kept per result. */
  maxPoints: 256,
  /** Raw (unsmoothed) nodes per request across all legs. */
  rawCapacity: 16384,
  /** Expansions per leg before the request gives up (partial or unreachable). */
  legExpansionCap: 40000,
  /** Routes up to this horizontal length search directly without the coarse corridor, m. */
  directMeters: 110,
  /** Coarse corridor leg length, m. */
  legMeters: 64,
  maxAvoid: 8,
  /** String pulling looks at most this many raw nodes ahead. */
  smoothLookahead: 96,
  /** Search radius `nearest` uses for request endpoints, m. */
  endpointSnap: 3,
  /** Building endpoints look this far for a terrain cell to anchor the coarse corridor, m. */
  anchorMeters: 40,
  /** `nearest` never scans farther than this, m. */
  maxNearest: 64,
} as const;

const Code = { Free: 0, Queued: 1, Running: 2, Found: 3, Partial: 4, Unreachable: 5 } as const;
type Code = (typeof Code)[keyof typeof Code];
const Phase = { Idle: 0, Coarse: 1, Fine: 2 } as const;
type Phase = (typeof Phase)[keyof typeof Phase];

const STATUS: readonly PathStatus[] = ["released", "pending", "pending", "found", "partial", "unreachable"];
const CLASS_BITS = NavFlag.door | NavFlag.stairs | NavFlag.crouchOnly;
const CLOSED = -2;
const INF = 3.4e38;
const OCTILE = Math.SQRT2 - 1;
const TIE_BREAK = 1 - 1e-4;
/** Unit directions for sampleRing (deterministic sin/cos, no per-call math). */
const RING_DIRECTIONS = 256;
const RING_SIN = new Float64Array(RING_DIRECTIONS);
const RING_COS = new Float64Array(RING_DIRECTIONS);
for (let i = 0; i < RING_DIRECTIONS; i++) {
  const { sin, cos } = sinCos(((i + 0.5) / RING_DIRECTIONS) * Math.PI * 2);
  RING_SIN[i] = sin;
  RING_COS[i] = cos;
}

/** Binary min-heap of scratch indices keyed by `key[idx]`, with positions for decrease-key. */
class IndexHeap {
  readonly heap: Int32Array;
  readonly key: Float32Array;
  /** Heap position per index, -1 not queued, CLOSED expanded. Valid only when the owner's stamp matches. */
  readonly pos: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.heap = new Int32Array(capacity);
    this.key = new Float32Array(capacity);
    this.pos = new Int32Array(capacity);
  }

  push(idx: number, key: number): void {
    this.key[idx] = key;
    let i = this.size++;
    this.heap[i] = idx;
    this.pos[idx] = i;
    this.up(i);
  }

  decrease(idx: number, key: number): void {
    this.key[idx] = key;
    this.up(this.pos[idx]!);
  }

  pop(): number {
    const heap = this.heap;
    const top = heap[0]!;
    const last = heap[--this.size]!;
    if (this.size > 0) {
      heap[0] = last;
      this.pos[last] = 0;
      this.down(0);
    }
    this.pos[top] = CLOSED;
    return top;
  }

  private up(i: number): void {
    const heap = this.heap;
    const key = this.key;
    const idx = heap[i]!;
    const k = key[idx]!;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = heap[parent]!;
      if (key[p]! <= k) break;
      heap[i] = p;
      this.pos[p] = i;
      i = parent;
    }
    heap[i] = idx;
    this.pos[idx] = i;
  }

  private down(i: number): void {
    const heap = this.heap;
    const key = this.key;
    const n = this.size;
    const idx = heap[i]!;
    const k = key[idx]!;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= n) break;
      if (child + 1 < n && key[heap[child + 1]!]! < key[heap[child]!]!) child++;
      const c = heap[child]!;
      if (key[c]! >= k) break;
      heap[i] = c;
      this.pos[c] = i;
      i = child;
    }
    heap[i] = idx;
    this.pos[idx] = i;
  }
}

/** Scratch search state over `size` indices with generation stamps (no clearing between searches). */
class SearchScratch {
  readonly g: Float32Array;
  readonly parent: Int32Array;
  readonly stamp: Uint16Array;
  readonly heap: IndexHeap;
  generation = 0;

  constructor(size: number) {
    this.g = new Float32Array(size);
    this.parent = new Int32Array(size);
    this.stamp = new Uint16Array(size);
    this.heap = new IndexHeap(size);
  }

  begin(): void {
    this.heap.size = 0;
    if (++this.generation > 65535) {
      this.stamp.fill(0);
      this.generation = 1;
    }
  }

  /** Makes `idx` current for this search; returns false when it was already closed. */
  touch(idx: number): boolean {
    if (this.stamp[idx] !== this.generation) {
      this.stamp[idx] = this.generation;
      this.g[idx] = INF;
      this.heap.pos[idx] = -1;
      this.parent[idx] = -1;
      return true;
    }
    return this.heap.pos[idx] !== CLOSED;
  }
}

export function createNavQuery(grid: NavGrid): NavQuery {
  return new GridNavQuery(asNavGridData(grid));
}

export class GridNavQuery implements NavQuery {
  readonly grid: NavGrid;
  private readonly data: NavGridData;
  private readonly winW: number;
  private readonly winD: number;
  private readonly winArea: number;
  private readonly fine: SearchScratch;
  private readonly coarse: SearchScratch;
  private readonly nbRefs = new Int32Array(64);
  private readonly nbCosts = new Float32Array(64);

  // Requests (structure of arrays).
  private readonly code = new Uint8Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly serial = new Int32Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly finishedAt = new Float64Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly ends = new Float64Array(NAV_QUERY_LIMITS.maxRequests * 6);
  private readonly optMaxLength = new Float64Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly optCrouch = new Uint8Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly optPartial = new Uint8Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly optCover = new Float32Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly optZone = new Float64Array(NAV_QUERY_LIMITS.maxRequests * 3);
  private readonly optHasZone = new Uint8Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly optAvoidCount = new Uint8Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly optAvoid = new Float64Array(NAV_QUERY_LIMITS.maxRequests * NAV_QUERY_LIMITS.maxAvoid * 4);
  private readonly resultPoints = new Float32Array(NAV_QUERY_LIMITS.maxRequests * NAV_QUERY_LIMITS.maxPoints * 3);
  private readonly resultFlags = new Uint8Array(NAV_QUERY_LIMITS.maxRequests * NAV_QUERY_LIMITS.maxPoints);
  private readonly resultCount = new Int32Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly resultLength = new Float64Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly resultTruncated = new Uint8Array(NAV_QUERY_LIMITS.maxRequests);
  private readonly queue = new Int32Array(NAV_QUERY_LIMITS.maxRequests);
  private queueHead = 0;
  private queueSize = 0;
  private nextSerial = 1;
  private finishCounter = 0;

  // Active request.
  private active = -1;
  private phase: Phase = Phase.Idle;
  private startRef = -1;
  private goalRef = -1;
  private goalComp = 0;
  private legStart = -1;
  private legTarget = -1;
  private legFinal = false;
  private legExpansions = 0;
  private legBest = -1;
  private legBestH = INF;
  private targetX = 0;
  private targetZ = 0;
  private wx0 = 0;
  private wz0 = 0;
  private hScale = 1;
  private readonly raw = new Int32Array(NAV_QUERY_LIMITS.rawCapacity);
  private rawCount = 0;
  private rawOverflow = false;
  private readonly corridor: Int32Array;
  private corridorCount = 0;
  private corridorIndex = 0;
  private coarseGoalRegion = -1;
  private readonly blockLabels: Int16Array;
  private readonly blockStack: Int32Array;
  private triedCoarse = false;
  // Active options (copied on activation).
  private aCrouch = false;
  private aCover = 0;
  private aHasZone = false;
  private aZoneX = 0;
  private aZoneZ = 0;
  private aZoneR2 = 0;
  private aAvoidCount = 0;
  private aAvoidBase = 0;

  // nearest() scratch.
  private nearX = 0;
  private nearY = 0;
  private nearZ = 0;

  /** Total expansions since construction (bench/debug). */
  expansions = 0;
  /** Scale on the A* heuristic (tests: 0 = Dijkstra). */
  heuristicWeight = 1;
  /** Search cost (weighted g) of the last finished request, summed over its legs. */
  lastCost = 0;
  private searchCost = 0;

  constructor(data: NavGridData) {
    this.grid = data;
    this.data = data;
    this.winW = Math.min(NAV_QUERY_LIMITS.window, data.width);
    this.winD = Math.min(NAV_QUERY_LIMITS.window, data.depth);
    this.winArea = this.winW * this.winD;
    this.fine = new SearchScratch(this.winArea + data.buildingNodes);
    const regions = data.arrays.regionRep.length;
    this.coarse = new SearchScratch(Math.max(1, regions));
    this.corridor = new Int32Array(Math.min(Math.max(1, regions), 8192));
    const ratio = data.layout.coarseRatio;
    this.blockLabels = new Int16Array(ratio * ratio);
    this.blockStack = new Int32Array(ratio * ratio);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Point queries
  // -------------------------------------------------------------------------------------------------------------

  nearest(p: Vec3, maxDistance: number, out: { x: number; y: number; z: number }): number {
    const ref = this.nearestRef(p.x, p.y, p.z, maxDistance);
    if (ref >= 0) {
      out.x = this.nearX;
      out.y = this.nearY;
      out.z = this.nearZ;
    }
    return ref;
  }

  flagsAt(ref: number): number {
    return this.data.flagsOf(ref);
  }

  reachable(a: number, b: number): boolean {
    const ca = this.data.componentOf(a);
    return ca !== 0 && ca === this.data.componentOf(b);
  }

  lineWalkable(from: Vec3, to: Vec3): boolean {
    const d = this.data;
    const ref = this.nearestRef(from.x, from.y, from.z, 1.5);
    if (ref < 0) return false;
    if (ref < d.terrainNodes) return this.terrainLine(from.x, from.z, to.x, to.z);
    const g = ref - d.terrainNodes;
    const p = d.placements[d.spanPlacement[g]!]!;
    const layer = d.layers[p.layer]!;
    const ax = (from.x - p.x) * p.cos - (from.z - p.z) * p.sin;
    const az = (from.x - p.x) * p.sin + (from.z - p.z) * p.cos;
    const bx = (to.x - p.x) * p.cos - (to.z - p.z) * p.sin;
    const bz = (to.x - p.x) * p.sin + (to.z - p.z) * p.cos;
    return this.spanLine(layer, p.base, g - p.base, ax, az, bx, bz, -1, true);
  }

  sampleRing(center: Vec3, minRadius: number, maxRadius: number, seed: number, out: Float32Array, max: number): number {
    const d = this.data;
    const c = this.nearestRef(center.x, center.y, center.z, NAV_QUERY_LIMITS.endpointSnap);
    if (c < 0) return 0;
    const comp = d.componentOf(c);
    const cap = Math.min(max, Math.floor(out.length / 3));
    const lo2 = minRadius * minRadius;
    const hi2 = maxRadius * maxRadius;
    let n = 0;
    for (let k = 0; k < cap * 4 && n < cap; k++) {
      const dir = hash32(seed, k, 0x51a7) & (RING_DIRECTIONS - 1);
      const u = hash32(seed, k, 0x9e37) / 4294967296;
      const r = Math.sqrt(lo2 + u * (hi2 - lo2));
      const ref = this.nearestRef(center.x + RING_SIN[dir]! * r, center.y, center.z + RING_COS[dir]! * r, 1.5);
      if (ref < 0 || d.componentOf(ref) !== comp || (d.flagsOf(ref) & NavFlag.crouchOnly) !== 0) continue;
      const dx = this.nearX - center.x;
      const dz = this.nearZ - center.z;
      const dist2 = dx * dx + dz * dz;
      if (dist2 < (minRadius - 0.5) * (minRadius - 0.5) && minRadius > 0.5) continue;
      out[n * 3] = this.nearX;
      out[n * 3 + 1] = this.nearY;
      out[n * 3 + 2] = this.nearZ;
      n++;
    }
    return n;
  }

  /** Nearest passable node by 3D distance; its position is left in nearX/Y/Z. */
  private nearestRef(px: number, py: number, pz: number, maxDistance: number): number {
    const d = this.data;
    const reach = Math.min(maxDistance, NAV_QUERY_LIMITS.maxNearest);
    let best2 = reach * reach;
    let best = -1;
    const placements = d.placements;
    const bcs = d.buildingCellSize;
    for (let pi = 0; pi < placements.length; pi++) {
      const p = placements[pi]!;
      if (px < p.minX - reach || px > p.maxX + reach || pz < p.minZ - reach || pz > p.maxZ + reach) continue;
      const layer = d.layers[p.layer]!;
      if (py < p.y + layer.minY - reach || py > p.y + layer.maxY + reach) continue;
      const lx = (px - p.x) * p.cos - (pz - p.z) * p.sin;
      const lz = (px - p.x) * p.sin + (pz - p.z) * p.cos;
      const r = Math.min(reach, 8);
      const cx0 = Math.max(0, Math.floor((lx - r - layer.minX) / bcs));
      const cx1 = Math.min(layer.cols - 1, Math.floor((lx + r - layer.minX) / bcs));
      const cz0 = Math.max(0, Math.floor((lz - r - layer.minZ) / bcs));
      const cz1 = Math.min(layer.rows - 1, Math.floor((lz + r - layer.minZ) / bcs));
      for (let cz = cz0; cz <= cz1; cz++) {
        const dz = layer.minZ + (cz + 0.5) * bcs - lz;
        if (dz * dz >= best2) continue;
        for (let cx = cx0; cx <= cx1; cx++) {
          const dx = layer.minX + (cx + 0.5) * bcs - lx;
          const h2 = dx * dx + dz * dz;
          if (h2 >= best2) continue;
          const col = cz * layer.cols + cx;
          for (let k = layer.colStart[col]!; k < layer.colStart[col + 1]!; k++) {
            if ((d.spanFlags[p.base + k]! & PASSABLE) === 0) continue;
            const dy = p.y + layer.spanY[k]! - py;
            const d2 = h2 + dy * dy;
            if (d2 < best2) {
              best2 = d2;
              best = d.terrainNodes + p.base + k;
            }
          }
        }
      }
    }
    const cs = d.cellSize;
    const gx = Math.floor((px - d.originX) / cs);
    const gz = Math.floor((pz - d.originZ) / cs);
    const rings = Math.ceil(reach / cs) + 1;
    for (let ring = 0; ring <= rings; ring++) {
      const ringDist = (ring - 1) * cs;
      if (ring > 0 && ringDist * ringDist >= best2) break;
      for (let iz = gz - ring; iz <= gz + ring; iz++) {
        if (iz < 0 || iz >= d.depth) continue;
        const edgeRow = iz === gz - ring || iz === gz + ring;
        const step = edgeRow ? 1 : 2 * ring;
        for (let ix = gx - ring; ix <= gx + ring; ix += step > 0 ? step : 1) {
          if (ix < 0 || ix >= d.width) continue;
          const cell = iz * d.width + ix;
          if ((d.terrainFlags[cell]! & PASSABLE) === 0) continue;
          const x = d.originX + (ix + 0.5) * cs;
          const z = d.originZ + (iz + 0.5) * cs;
          const dx = x - px;
          const dz = z - pz;
          const h2 = dx * dx + dz * dz;
          if (h2 >= best2) continue;
          const dy = d.terrainHeight(x, z) - py;
          const d2 = h2 + dy * dy;
          if (d2 < best2) {
            best2 = d2;
            best = cell;
          }
        }
      }
    }
    if (best >= 0) {
      this.nearX = d.nodeX(best);
      this.nearY = d.nodeY(best);
      this.nearZ = d.nodeZ(best);
    }
    return best;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------------------------------------------

  requestPath(from: Vec3, to: Vec3, options: PathOptions | null): number {
    const slot = this.allocSlot();
    if (slot < 0) return -1;
    const e = slot * 6;
    this.ends[e] = from.x;
    this.ends[e + 1] = from.y;
    this.ends[e + 2] = from.z;
    this.ends[e + 3] = to.x;
    this.ends[e + 4] = to.y;
    this.ends[e + 5] = to.z;
    this.optMaxLength[slot] = options?.maxLength ?? INF;
    this.optCrouch[slot] = options?.allowCrouchOnly === false ? 0 : 1;
    this.optPartial[slot] = options?.partial ? 1 : 0;
    this.optCover[slot] = Math.min(1, Math.max(0, options?.preferCover ?? 0));
    const zone = options?.zone;
    this.optHasZone[slot] = zone ? 1 : 0;
    if (zone) {
      this.optZone[slot * 3] = zone.cx;
      this.optZone[slot * 3 + 1] = zone.cz;
      this.optZone[slot * 3 + 2] = zone.r;
    }
    const avoid = options?.avoid;
    const count = avoid ? Math.min(avoid.length, NAV_QUERY_LIMITS.maxAvoid) : 0;
    this.optAvoidCount[slot] = count;
    for (let i = 0; i < count; i++) {
      const c = avoid![i]!;
      const b = (slot * NAV_QUERY_LIMITS.maxAvoid + i) * 4;
      this.optAvoid[b] = c.x;
      this.optAvoid[b + 1] = c.z;
      this.optAvoid[b + 2] = c.radius * c.radius;
      this.optAvoid[b + 3] = c.cost;
    }
    this.code[slot] = Code.Queued;
    this.resultCount[slot] = 0;
    this.resultLength[slot] = 0;
    this.resultTruncated[slot] = 0;
    this.queue[(this.queueHead + this.queueSize) % NAV_QUERY_LIMITS.maxRequests] = slot;
    this.queueSize++;
    return this.serial[slot]! * NAV_QUERY_LIMITS.maxRequests + slot;
  }

  readPath(handle: number, out: NavPath): PathStatus {
    const slot = this.slotOf(handle);
    if (slot < 0) return handle === -1 ? "unreachable" : "released";
    const code = this.code[slot]!;
    if (code === Code.Found || code === Code.Partial) {
      const cap = Math.min(out.flags.length, Math.floor(out.points.length / 3));
      const count = Math.min(cap, this.resultCount[slot]!);
      const pb = slot * NAV_QUERY_LIMITS.maxPoints;
      for (let i = 0; i < count; i++) {
        out.points[i * 3] = this.resultPoints[(pb + i) * 3]!;
        out.points[i * 3 + 1] = this.resultPoints[(pb + i) * 3 + 1]!;
        out.points[i * 3 + 2] = this.resultPoints[(pb + i) * 3 + 2]!;
        out.flags[i] = this.resultFlags[pb + i]!;
      }
      out.count = count;
      out.length = this.resultLength[slot]!;
      if (count < this.resultCount[slot]! || this.resultTruncated[slot]) return "partial";
    }
    return STATUS[code]!;
  }

  releasePath(handle: number): void {
    const slot = this.slotOf(handle);
    if (slot < 0) return;
    if (this.active === slot) {
      this.active = -1;
      this.phase = Phase.Idle;
    }
    if (this.code[slot] === Code.Queued) this.removeFromQueue(slot);
    this.code[slot] = Code.Free;
  }

  update(maxExpansions: number): number {
    let used = 0;
    while (used < maxExpansions) {
      if (this.active < 0) {
        if (this.queueSize === 0) break;
        const slot = this.queue[this.queueHead]!;
        this.queueHead = (this.queueHead + 1) % NAV_QUERY_LIMITS.maxRequests;
        this.queueSize--;
        this.activate(slot);
        continue;
      }
      const budget = maxExpansions - used;
      const spent = this.phase === Phase.Coarse ? this.stepCoarse(budget) : this.stepFine(budget);
      used += spent;
    }
    this.expansions += used;
    return used;
  }

  /** Pending (queued or running) request count. */
  get pendingCount(): number {
    return this.queueSize + (this.active >= 0 ? 1 : 0);
  }

  private slotOf(handle: number): number {
    if (handle < 0) return -1;
    const slot = handle % NAV_QUERY_LIMITS.maxRequests;
    const serial = (handle - slot) / NAV_QUERY_LIMITS.maxRequests;
    if (this.serial[slot] !== serial || this.code[slot] === Code.Free) return -1;
    return slot;
  }

  private allocSlot(): number {
    let slot = -1;
    for (let i = 0; i < NAV_QUERY_LIMITS.maxRequests; i++) {
      if (this.code[i] === Code.Free) {
        slot = i;
        break;
      }
    }
    if (slot < 0) {
      let oldest = INF;
      for (let i = 0; i < NAV_QUERY_LIMITS.maxRequests; i++) {
        const c = this.code[i]!;
        if ((c === Code.Found || c === Code.Partial || c === Code.Unreachable) && this.finishedAt[i]! < oldest) {
          oldest = this.finishedAt[i]!;
          slot = i;
        }
      }
    }
    if (slot < 0) return -1;
    this.serial[slot] = this.nextSerial++;
    if (this.nextSerial > 0x1fffff) this.nextSerial = 1;
    return slot;
  }

  private removeFromQueue(slot: number): void {
    const cap = NAV_QUERY_LIMITS.maxRequests;
    let write = 0;
    for (let i = 0; i < this.queueSize; i++) {
      const s = this.queue[(this.queueHead + i) % cap]!;
      if (s !== slot) this.queue[(this.queueHead + write++) % cap] = s;
    }
    this.queueSize = write;
  }

  private finish(code: Code): void {
    const slot = this.active;
    if (code === Code.Found || code === Code.Partial) {
      this.smooth(slot);
      if (this.resultLength[slot]! > this.optMaxLength[slot]!) {
        code = Code.Unreachable;
        this.resultCount[slot] = 0;
      }
    }
    this.code[slot] = code;
    this.lastCost = this.searchCost;
    this.finishedAt[slot] = ++this.finishCounter;
    this.active = -1;
    this.phase = Phase.Idle;
  }

  private activate(slot: number): void {
    const d = this.data;
    this.active = slot;
    this.code[slot] = Code.Running;
    this.aCrouch = this.optCrouch[slot] === 1;
    this.aCover = this.optCover[slot]!;
    this.aHasZone = this.optHasZone[slot] === 1;
    this.aZoneX = this.optZone[slot * 3]!;
    this.aZoneZ = this.optZone[slot * 3 + 1]!;
    this.aZoneR2 = this.optZone[slot * 3 + 2]! * this.optZone[slot * 3 + 2]!;
    this.aAvoidCount = this.optAvoidCount[slot]!;
    this.aAvoidBase = slot * NAV_QUERY_LIMITS.maxAvoid;
    // Octile distance is exact on open ground; road (×0.95) and cover discounts make it slightly inadmissible, which
    // trades ≤ 5 % path cost for far fewer expansions. The cover discount is honoured so cover routes stay attractive.
    this.hScale = (1 - 0.3 * this.aCover) * this.heuristicWeight;
    this.searchCost = 0;
    this.rawCount = 0;
    this.rawOverflow = false;
    const e = slot * 6;
    const snap = NAV_QUERY_LIMITS.endpointSnap;
    this.startRef = this.nearestRef(this.ends[e]!, this.ends[e + 1]!, this.ends[e + 2]!, snap);
    this.goalRef = this.nearestRef(this.ends[e + 3]!, this.ends[e + 4]!, this.ends[e + 5]!, snap);
    const partial = this.optPartial[slot] === 1;
    if (this.startRef < 0 || this.goalRef < 0) return this.finish(Code.Unreachable);
    if (!this.aCrouch && ((d.flagsOf(this.startRef) | d.flagsOf(this.goalRef)) & NavFlag.crouchOnly) !== 0 && !partial) return this.finish(Code.Unreachable);
    this.goalComp = d.componentOf(this.goalRef);
    const sameComp = d.componentOf(this.startRef) === this.goalComp;
    if (!sameComp && !partial) return this.finish(Code.Unreachable);
    const sx = d.nodeX(this.startRef);
    const sz = d.nodeZ(this.startRef);
    const gx = d.nodeX(this.goalRef);
    const gz = d.nodeZ(this.goalRef);
    const straight = Math.sqrt((gx - sx) * (gx - sx) + (gz - sz) * (gz - sz));
    if (straight > this.optMaxLength[slot]!) return this.finish(Code.Unreachable);
    this.legStart = this.startRef;
    this.corridorCount = 0;
    this.corridorIndex = 0;
    this.triedCoarse = false;
    if (straight <= NAV_QUERY_LIMITS.directMeters || !sameComp) {
      this.beginLeg(this.goalRef, true, false);
      return;
    }
    this.beginCoarse(gx, gz);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Costs
  // -------------------------------------------------------------------------------------------------------------

  private multiplier(flags: number, x: number, z: number): number {
    let m = 1;
    if ((flags & NavFlag.road) !== 0) m *= 0.95;
    if (this.aCover > 0 && (flags & (NavFlag.vegetation | NavFlag.nearObstacle)) !== 0) m *= 1 - 0.3 * this.aCover;
    if (this.aHasZone) {
      const dx = x - this.aZoneX;
      const dz = z - this.aZoneZ;
      if (dx * dx + dz * dz > this.aZoneR2) m *= 4;
    }
    for (let i = 0; i < this.aAvoidCount; i++) {
      const b = (this.aAvoidBase + i) * 4;
      const dx = x - this.optAvoid[b]!;
      const dz = z - this.optAvoid[b + 1]!;
      if (dx * dx + dz * dz <= this.optAvoid[b + 2]!) m *= this.optAvoid[b + 3]!;
    }
    return m;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Coarse corridor (regions of 4 m cells)
  // -------------------------------------------------------------------------------------------------------------

  private beginCoarse(gx: number, gz: number): void {
    this.triedCoarse = true;
    this.coarseGoalRegion = this.regionOf(this.goalRef);
    if (this.coarseGoalRegion >= 0 && this.data.arrays.regionComp[this.coarseGoalRegion] !== this.goalComp) this.coarseGoalRegion = -1;
    this.targetX = gx;
    this.targetZ = gz;
    const s = this.coarse;
    s.begin();
    // Building endpoints anchor to the nearest terrain cell of the goal component (their coarse cell may be all roof).
    const startRegion = this.regionOf(this.terrainAnchor(this.startRef));
    if (this.coarseGoalRegion < 0) this.coarseGoalRegion = this.regionOf(this.terrainAnchor(this.goalRef));
    if (startRegion >= 0 && this.coarseGoalRegion >= 0) {
      s.touch(startRegion);
      s.g[startRegion] = 0;
      s.parent[startRegion] = -1;
      s.heap.push(startRegion, this.coarseH(startRegion) * this.heuristicWeight);
    }
    this.phase = Phase.Coarse;
  }

  /** Coarse region of a terrain node (labels its block), or -1 for building spans. */
  private regionOf(ref: number): number {
    const d = this.data;
    if (ref < 0 || ref >= d.terrainNodes) return -1;
    const ratio = d.layout.coarseRatio;
    const ix = ref % d.width;
    const iz = (ref - ix) / d.width;
    const cx = Math.floor(ix / ratio);
    const cz = Math.floor(iz / ratio);
    labelCoarseBlock(d, ratio, cx, cz, this.blockLabels, this.blockStack);
    const label = this.blockLabels[(iz - cz * ratio) * ratio + ix - cx * ratio]!;
    return label < 0 ? -1 : d.arrays.coarseRegionStart[cz * d.layout.coarseWidth + cx]! + label;
  }

  private isCoarseGoal(r: number): boolean {
    return r === this.coarseGoalRegion;
  }

  /** The node itself for terrain; for a building span the nearest passable terrain cell on the goal component, or -1. */
  private terrainAnchor(ref: number): number {
    const d = this.data;
    if (ref < d.terrainNodes) return ref;
    const cs = d.cellSize;
    const gx = Math.floor((d.nodeX(ref) - d.originX) / cs);
    const gz = Math.floor((d.nodeZ(ref) - d.originZ) / cs);
    const rings = Math.ceil(NAV_QUERY_LIMITS.anchorMeters / cs);
    for (let ring = 0; ring <= rings; ring++) {
      let best = -1;
      let bestD = INF;
      for (let iz = gz - ring; iz <= gz + ring; iz++) {
        if (iz < 0 || iz >= d.depth) continue;
        const step = iz === gz - ring || iz === gz + ring ? 1 : 2 * ring;
        for (let ix = gx - ring; ix <= gx + ring; ix += step > 0 ? step : 1) {
          if (ix < 0 || ix >= d.width) continue;
          const cell = iz * d.width + ix;
          if ((d.terrainFlags[cell]! & PASSABLE) === 0 || d.terrainComp[cell] !== this.goalComp) continue;
          const dist = (ix - gx) * (ix - gx) + (iz - gz) * (iz - gz);
          if (dist < bestD) {
            bestD = dist;
            best = cell;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  private coarseH(r: number): number {
    const d = this.data;
    const rep = d.arrays.regionRep[r]!;
    const dx = Math.abs(d.nodeX(rep) - this.targetX);
    const dz = Math.abs(d.nodeZ(rep) - this.targetZ);
    return dx > dz ? dx + OCTILE * dz : dz + OCTILE * dx;
  }

  private stepCoarse(budget: number): number {
    const d = this.data;
    const A = d.arrays;
    const size = d.layout.coarseCellSize;
    const s = this.coarse;
    const heap = s.heap;
    let used = 0;
    while (used < budget) {
      if (heap.size === 0) {
        // No corridor: try the direct search toward the goal (partial when requested).
        this.corridorCount = 0;
        this.beginLeg(this.goalRef, true, false);
        return used;
      }
      const r = heap.pop();
      used++;
      if (this.isCoarseGoal(r)) {
        this.buildCorridor(r);
        this.nextLeg();
        return used;
      }
      const g = s.g[r]!;
      const end = A.regionEdgeStart[r + 1]!;
      for (let e = A.regionEdgeStart[r]!; e < end; e++) {
        const to = A.regionEdgeTo[e]!;
        if (A.regionComp[to] !== this.goalComp) continue;
        if (!s.touch(to)) continue;
        const rep = A.regionRep[to]!;
        const cost = size * (1 + 2 * (1 - A.regionEdgeOpen[e]! / 255)) * (1 + (1 - A.regionFrac[to]! / 255)) * this.multiplier(0, d.nodeX(rep), d.nodeZ(rep));
        const ng = g + cost;
        if (ng >= s.g[to]!) continue;
        s.g[to] = ng;
        s.parent[to] = r;
        const f = ng * TIE_BREAK + this.coarseH(to) * this.heuristicWeight;
        if (heap.pos[to]! >= 0) heap.decrease(to, f);
        else heap.push(to, f);
      }
    }
    return used;
  }

  private buildCorridor(goal: number): void {
    const s = this.coarse;
    let n = 0;
    for (let r = goal; r >= 0; r = s.parent[r]!) n++;
    const skip = Math.max(0, n - this.corridor.length);
    n -= skip;
    let i = n;
    let r = goal;
    for (let k = 0; k < skip; k++) r = s.parent[r]!;
    for (; r >= 0 && i > 0; r = s.parent[r]!) this.corridor[--i] = r;
    this.corridorCount = n;
    this.corridorIndex = 0;
  }

  /**
   * Picks the next leg target: the farthest corridor region whose representative cell is within `legMeters` (straight
   * line) of the leg start, or the goal once the corridor's end is in range. Starts its fine search.
   */
  private nextLeg(): void {
    const d = this.data;
    const A = d.arrays;
    if (this.corridorCount === 0) {
      this.beginLeg(this.goalRef, true, false);
      return;
    }
    const sx = d.nodeX(this.legStart);
    const sz = d.nodeZ(this.legStart);
    const leg2 = NAV_QUERY_LIMITS.legMeters * NAV_QUERY_LIMITS.legMeters;
    let pick = this.corridorIndex;
    for (let i = this.corridorIndex + 1; i < this.corridorCount; i++) {
      const rep = A.regionRep[this.corridor[i]!]!;
      const x = d.nodeX(rep);
      const z = d.nodeZ(rep);
      if ((x - sx) * (x - sx) + (z - sz) * (z - sz) > leg2) break;
      pick = i;
    }
    if (pick >= this.corridorCount - 1) {
      this.corridorIndex = this.corridorCount;
      this.beginLeg(this.goalRef, true, true);
      return;
    }
    if (pick === this.corridorIndex) pick++;
    this.corridorIndex = pick;
    const target = A.regionRep[this.corridor[pick]!]!;
    if (target === this.legStart) {
      this.nextLeg();
      return;
    }
    this.beginLeg(target, false, true);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Fine search
  // -------------------------------------------------------------------------------------------------------------

  /** `anchored`: corridor legs center the window on the leg start so the corridor prefix around it stays inside. */
  private beginLeg(target: number, final: boolean, anchored: boolean): void {
    const d = this.data;
    this.legTarget = target;
    this.legFinal = final;
    this.legExpansions = 0;
    this.legBest = this.legStart;
    this.targetX = d.nodeX(target);
    this.targetZ = d.nodeZ(target);
    const sx = d.nodeX(this.legStart);
    const sz = d.nodeZ(this.legStart);
    const cs = d.cellSize;
    // Centered on the leg, or reaching from the start toward a target that doesn't fit the window.
    const halfX = (this.winW * cs) / 2 - 12;
    const halfZ = (this.winD * cs) / 2 - 12;
    const dxLeg = this.targetX - sx;
    const dzLeg = this.targetZ - sz;
    const midX = anchored ? sx : Math.abs(dxLeg) <= 2 * halfX ? sx + dxLeg / 2 : sx + (dxLeg > 0 ? halfX : -halfX);
    const midZ = anchored ? sz : Math.abs(dzLeg) <= 2 * halfZ ? sz + dzLeg / 2 : sz + (dzLeg > 0 ? halfZ : -halfZ);
    this.wx0 = Math.min(d.width - this.winW, Math.max(0, Math.floor((midX - d.originX) / cs) - (this.winW >> 1)));
    this.wz0 = Math.min(d.depth - this.winD, Math.max(0, Math.floor((midZ - d.originZ) / cs) - (this.winD >> 1)));
    const s = this.fine;
    s.begin();
    const idx = this.indexOf(this.legStart);
    this.legBestH = this.fineH(this.legStart);
    if (idx < 0) {
      this.phase = Phase.Fine;
      this.failLeg();
      return;
    }
    s.touch(idx);
    s.g[idx] = 0;
    s.heap.push(idx, this.legBestH * this.hScale);
    this.phase = Phase.Fine;
  }

  /** Scratch index of a node in the current window, or -1 outside it. */
  private indexOf(ref: number): number {
    const d = this.data;
    if (ref >= d.terrainNodes) return this.winArea + ref - d.terrainNodes;
    const ix = ref % d.width;
    const iz = (ref - ix) / d.width;
    const lx = ix - this.wx0;
    const lz = iz - this.wz0;
    if (lx < 0 || lz < 0 || lx >= this.winW || lz >= this.winD) return -1;
    return lz * this.winW + lx;
  }

  private refOf(idx: number): number {
    if (idx >= this.winArea) return this.data.terrainNodes + idx - this.winArea;
    const lx = idx % this.winW;
    return (this.wz0 + (idx - lx) / this.winW) * this.data.width + this.wx0 + lx;
  }

  private fineH(ref: number): number {
    const d = this.data;
    const dx = Math.abs(d.nodeX(ref) - this.targetX);
    const dz = Math.abs(d.nodeZ(ref) - this.targetZ);
    return dx > dz ? dx + OCTILE * dz : dz + OCTILE * dx;
  }

  private stepFine(budget: number): number {
    const d = this.data;
    const s = this.fine;
    const heap = s.heap;
    const refs = this.nbRefs;
    const costs = this.nbCosts;
    let used = 0;
    while (used < budget) {
      if (heap.size === 0) {
        this.failLeg();
        return used;
      }
      const idx = heap.pop();
      const ref = this.refOf(idx);
      if (ref === this.legTarget) {
        this.legBest = ref;
        this.completeLeg(idx);
        return used;
      }
      used++;
      if (++this.legExpansions > NAV_QUERY_LIMITS.legExpansionCap) {
        this.failLeg();
        return used;
      }
      const h = this.fineH(ref);
      if (h < this.legBestH) {
        this.legBestH = h;
        this.legBest = ref;
      }
      const g = s.g[idx]!;
      const n = d.neighbors(ref, refs, costs);
      for (let i = 0; i < n; i++) {
        const nb = refs[i]!;
        const flags = d.flagsOf(nb);
        if (!this.aCrouch && (flags & NavFlag.crouchOnly) !== 0) continue;
        const ni = this.indexOf(nb);
        if (ni < 0 || !s.touch(ni)) continue;
        const x = d.nodeX(nb);
        const z = d.nodeZ(nb);
        const ng = g + costs[i]! * this.multiplier(flags, x, z);
        if (ng >= s.g[ni]!) continue;
        s.g[ni] = ng;
        s.parent[ni] = idx;
        const dx = Math.abs(x - this.targetX);
        const dz = Math.abs(z - this.targetZ);
        // Ties on f prefer the deeper node (open ground has wide plateaus of equal f).
        const f = ng * TIE_BREAK + (dx > dz ? dx + OCTILE * dz : dz + OCTILE * dx) * this.hScale;
        if (heap.pos[ni]! >= 0) heap.decrease(ni, f);
        else heap.push(ni, f);
      }
    }
    return used;
  }

  private completeLeg(idx: number): void {
    this.searchCost += this.fine.g[idx]!;
    this.appendLeg(idx);
    if (this.rawOverflow) return this.finish(Code.Partial);
    if (this.legFinal) return this.finish(Code.Found);
    this.legStart = this.legTarget;
    this.nextLeg();
  }

  private failLeg(): void {
    const d = this.data;
    // A direct search that ran out of window or budget retries once through the coarse corridor.
    if (!this.triedCoarse && this.rawCount === 0 && d.componentOf(this.startRef) === this.goalComp) {
      this.legStart = this.startRef;
      this.beginCoarse(d.nodeX(this.goalRef), d.nodeZ(this.goalRef));
      return;
    }
    const partial = this.optPartial[this.active] === 1;
    const best = this.indexOf(this.legBest);
    if (partial && best >= 0 && this.fine.stamp[best] === this.fine.generation && (this.legBest !== this.legStart || this.rawCount > 0)) {
      this.appendLeg(best);
      this.finish(Code.Partial);
      return;
    }
    if (partial && this.rawCount > 0) return this.finish(Code.Partial);
    this.finish(Code.Unreachable);
  }

  /** Appends the parent chain ending at `idx` (skipping its first node when it continues a previous leg). */
  private appendLeg(idx: number): void {
    const s = this.fine;
    let n = 0;
    for (let i = idx; i >= 0; i = s.parent[i]!) n++;
    const skip = this.rawCount > 0 ? 1 : 0;
    const add = n - skip;
    const room = this.raw.length - this.rawCount;
    const write = Math.min(add, room);
    if (write < add) this.rawOverflow = true;
    // Walk back from the end, keeping only the first `write` nodes of the leg.
    let pos = add - 1;
    for (let i = idx; i >= 0 && pos >= 0; i = s.parent[i]!, pos--) {
      if (pos < write) this.raw[this.rawCount + pos] = this.refOf(i);
    }
    this.rawCount += write;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Smoothing and lines
  // -------------------------------------------------------------------------------------------------------------

  private smooth(slot: number): void {
    const raw = this.raw;
    const n = this.rawCount;
    this.resultCount[slot] = 0;
    this.resultLength[slot] = 0;
    if (n === 0) return;
    this.emit(slot, raw[0]!, n === 1);
    let i = 0;
    const look = NAV_QUERY_LIMITS.smoothLookahead;
    while (i < n - 1) {
      const a = raw[i]!;
      const cls = this.classOf(a);
      let j = i + 1;
      if (this.classOf(raw[j]!) === cls) {
        const limit = Math.min(n - 1, i + look);
        for (let k = i + 2; k <= limit; k++) {
          if (this.classOf(raw[k]!) !== cls || !this.nodeLine(a, raw[k]!)) break;
          j = k;
        }
      }
      this.emit(slot, raw[j]!, j === n - 1);
      i = j;
    }
  }

  private emit(slot: number, ref: number, last: boolean): void {
    const d = this.data;
    const count = this.resultCount[slot]!;
    if (count >= NAV_QUERY_LIMITS.maxPoints) {
      this.resultTruncated[slot] = 1;
      return;
    }
    let x = d.nodeX(ref);
    const y = d.nodeY(ref);
    let z = d.nodeZ(ref);
    if (last && ref === this.goalRef) {
      const e = slot * 6;
      const tx = this.ends[e + 3]!;
      const tz = this.ends[e + 5]!;
      if ((tx - x) * (tx - x) + (tz - z) * (tz - z) <= d.cellSize * d.cellSize) {
        x = tx;
        z = tz;
      }
    }
    const pb = slot * NAV_QUERY_LIMITS.maxPoints;
    const o = (pb + count) * 3;
    if (count > 0) {
      const px = this.resultPoints[o - 3]!;
      const py = this.resultPoints[o - 2]!;
      const pz = this.resultPoints[o - 1]!;
      this.resultLength[slot] = this.resultLength[slot]! + Math.sqrt((x - px) * (x - px) + (y - py) * (y - py) + (z - pz) * (z - pz));
    }
    this.resultPoints[o] = x;
    this.resultPoints[o + 1] = y;
    this.resultPoints[o + 2] = z;
    this.resultFlags[pb + count] = d.flagsOf(ref);
    this.resultCount[slot] = count + 1;
  }

  /** Layer (terrain −1 or placement) and door/stairs/crouch bits, packed. */
  private classOf(ref: number): number {
    return (this.data.layerOf(ref) + 1) * 256 + (this.data.flagsOf(ref) & CLASS_BITS);
  }

  /** Straight line between two nodes of the same layer. */
  private nodeLine(a: number, b: number): boolean {
    const d = this.data;
    if (a < d.terrainNodes) {
      const w = d.width;
      return this.terrainCellLine(a % w, Math.floor(a / w), b % w, Math.floor(b / w));
    }
    const ga = a - d.terrainNodes;
    const p = d.placements[d.spanPlacement[ga]!]!;
    const layer = d.layers[p.layer]!;
    const la = ga - p.base;
    const lb = b - d.terrainNodes - p.base;
    const bcs = d.buildingCellSize;
    const ca = layer.spanCol[la]!;
    const cb = layer.spanCol[lb]!;
    const ax = layer.minX + ((ca % layer.cols) + 0.5) * bcs;
    const az = layer.minZ + (Math.floor(ca / layer.cols) + 0.5) * bcs;
    const bx = layer.minX + ((cb % layer.cols) + 0.5) * bcs;
    const bz = layer.minZ + (Math.floor(cb / layer.cols) + 0.5) * bcs;
    return this.spanLine(layer, p.base, la, ax, az, bx, bz, lb, this.aCrouch);
  }

  /** Supercover walk between two terrain cells; ties check both side cells. */
  private terrainCellLine(ax: number, az: number, bx: number, bz: number): boolean {
    const d = this.data;
    const flags = d.terrainFlags;
    const w = d.width;
    const dx = bx - ax;
    const dz = bz - az;
    const nx = Math.abs(dx);
    const nz = Math.abs(dz);
    const sx = dx > 0 ? 1 : -1;
    const sz = dz > 0 ? 1 : -1;
    let x = ax;
    let z = az;
    let ix = 0;
    let iz = 0;
    while (ix < nx || iz < nz) {
      const decision = (1 + 2 * ix) * nz - (1 + 2 * iz) * nx;
      if (decision === 0) {
        if ((flags[z * w + x + sx]! & PASSABLE) === 0 || (flags[(z + sz) * w + x]! & PASSABLE) === 0) return false;
        x += sx;
        z += sz;
        ix++;
        iz++;
      } else if (decision < 0) {
        x += sx;
        ix++;
      } else {
        z += sz;
        iz++;
      }
      if ((flags[z * w + x]! & PASSABLE) === 0) return false;
    }
    return true;
  }

  /** Grid traversal over terrain cells between world points (public lineWalkable). */
  private terrainLine(x0: number, z0: number, x1: number, z1: number): boolean {
    const d = this.data;
    const cs = d.cellSize;
    return gridWalk(
      (x0 - d.originX) / cs,
      (z0 - d.originZ) / cs,
      (x1 - d.originX) / cs,
      (z1 - d.originZ) / cs,
      d.width,
      d.depth,
      this.terrainVisitor,
    );
  }

  private readonly terrainVisitor = (ix: number, iz: number): boolean => (this.data.terrainFlags[iz * this.data.width + ix]! & PASSABLE) !== 0;

  // Span line state (the visitor reads it; set before gridWalk).
  private lineLayer: NavPrefabLayer | null = null;
  private lineBase = 0;
  private lineSpan = -1;
  private lineCrouch = true;
  private readonly spanVisitor = (cx: number, cz: number): boolean => {
    const layer = this.lineLayer!;
    const col = cz * layer.cols + cx;
    if (layer.spanCol[this.lineSpan] === col) return true;
    const k = this.data.matchSpan(layer, this.lineBase, col, layer.spanY[this.lineSpan]!);
    if (k < 0) return false;
    if (!this.lineCrouch && (this.data.spanFlags[this.lineBase + k]! & NavFlag.crouchOnly) !== 0) return false;
    this.lineSpan = k;
    return true;
  };

  /** Walks building columns from local (ax, az) on span `start`; must end on `end` when end ≥ 0. */
  private spanLine(layer: NavPrefabLayer, base: number, start: number, ax: number, az: number, bx: number, bz: number, end: number, crouch: boolean): boolean {
    const bcs = this.data.buildingCellSize;
    this.lineLayer = layer;
    this.lineBase = base;
    this.lineSpan = start;
    this.lineCrouch = crouch;
    const ok = gridWalk((ax - layer.minX) / bcs, (az - layer.minZ) / bcs, (bx - layer.minX) / bcs, (bz - layer.minZ) / bcs, layer.cols, layer.rows, this.spanVisitor);
    return ok && (end < 0 || this.lineSpan === end);
  }
}

/**
 * Amanatides–Woo traversal of unit cells from (gx0, gz0) to (gx1, gz1) in grid units, calling `visit` for every cell
 * including both ends; exact corner crossings visit both side cells first. False when a cell leaves the grid or
 * `visit` refuses it.
 */
function gridWalk(gx0: number, gz0: number, gx1: number, gz1: number, cols: number, rows: number, visit: (ix: number, iz: number) => boolean): boolean {
  let ix = Math.floor(gx0);
  let iz = Math.floor(gz0);
  const ex = Math.floor(gx1);
  const ez = Math.floor(gz1);
  if (ix < 0 || iz < 0 || ix >= cols || iz >= rows || !visit(ix, iz)) return false;
  const dx = gx1 - gx0;
  const dz = gz1 - gz0;
  const stepX = dx > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : INF;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : INF;
  let tMaxX = dx !== 0 ? (dx > 0 ? ix + 1 - gx0 : gx0 - ix) * tDeltaX : INF;
  let tMaxZ = dz !== 0 ? (dz > 0 ? iz + 1 - gz0 : gz0 - iz) * tDeltaZ : INF;
  let guard = Math.abs(ex - ix) + Math.abs(ez - iz) + 2;
  while ((ix !== ex || iz !== ez) && guard-- > 0) {
    if (Math.abs(tMaxX - tMaxZ) < 1e-9) {
      const nx = ix + stepX;
      const nz = iz + stepZ;
      if (nx < 0 || nz < 0 || nx >= cols || nz >= rows || !visit(nx, iz) || !visit(ix, nz)) return false;
      ix = nx;
      iz = nz;
      tMaxX += tDeltaX;
      tMaxZ += tDeltaZ;
    } else if (tMaxX < tMaxZ) {
      ix += stepX;
      tMaxX += tDeltaX;
    } else {
      iz += stepZ;
      tMaxZ += tDeltaZ;
    }
    if (ix < 0 || iz < 0 || ix >= cols || iz >= rows || !visit(ix, iz)) return false;
  }
  return true;
}
