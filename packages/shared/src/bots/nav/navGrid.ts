import { MOVEMENT } from "../../constants";
import { NavFlag, type NavGrid, type NavGridInfo } from "../types";

// Built navigation data (docs/bots/design.md §3). Plain typed arrays so a worker can transfer it and the checksum is the
// same in Node and the browser. Node refs: terrain cells first (iz × width + ix), then building spans (placement base +
// prefab-local span index).

/** Bump when the build output changes for the same inputs. */
export const NAV_GRID_VERSION = 1;
export const MAX_SPANS_PER_COLUMN = 4;
/** Steps a capsule climbs automatically (stair rises are 0.3). */
export const NAV_STEP_HEIGHT = MOVEMENT.maxStepHeight;
/** Headroom for a standing / crouched capsule above a floor, m. */
export const STAND_CLEARANCE = MOVEMENT.standHeight;
export const CROUCH_CLEARANCE = 1.15;
/** Neighbour spans connect across at most this height difference. */
export const MAX_NEIGHBOUR_RISE = NAV_STEP_HEIGHT;

/** Passable = walkable (crouchOnly spans carry both bits). */
export const PASSABLE = NavFlag.walkable;

/** One prefab's span columns in prefab-local space, shared by every placement of it. */
export interface NavPrefabLayer {
  readonly prefab: string;
  /** Local X/Z of the column grid's min corner. */
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  /** CSR: spans of column c are [colStart[c], colStart[c + 1]), sorted by height. */
  readonly colStart: Int32Array;
  /** Local floor height of each span. */
  readonly spanY: Float32Array;
  readonly spanCol: Int32Array;
  /** Flags before placement (walkable, crouchOnly, indoor, stairs, door, nearObstacle). */
  readonly spanFlags: Uint8Array;
  readonly minY: number;
  readonly maxY: number;
}

export interface NavPlacement {
  readonly id: string;
  readonly layer: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly sin: number;
  readonly cos: number;
  /** First global building span index of this placement. */
  readonly base: number;
  readonly count: number;
  /** World XZ bounds of the column grid. */
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface NavBuildStats {
  readonly buildMs: number;
  readonly stageMs: Readonly<Record<string, number>>;
  readonly terrainWalkable: number;
  readonly terrainSlopeBlocked: number;
  readonly terrainPropBlocked: number;
  readonly terrainBuildingBlocked: number;
  readonly prefabSpans: number;
  readonly buildingSpans: number;
  readonly buildingWalkable: number;
  readonly overflowColumns: number;
  readonly links: number;
  readonly clearedIslands: number;
  readonly clearedIslandArea: number;
  readonly mainComponent: number;
  readonly mainComponentArea: number;
}

export interface NavGridArrays {
  readonly terrainFlags: Uint8Array;
  readonly terrainComp: Uint16Array;
  /** Heightfield samples covering the grid (same triangle split as Heightfield). */
  readonly heights: Float32Array;
  readonly spanFlags: Uint8Array;
  readonly spanComp: Uint16Array;
  readonly spanPlacement: Uint16Array;
  /** Symmetric links between terrain cells and building spans, sorted by `linkFrom`. */
  readonly linkFrom: Int32Array;
  readonly linkTo: Int32Array;
  readonly linkCost: Float32Array;
  /** Bit per node: has at least one link. */
  readonly linkBits: Uint8Array;
  /**
   * Coarse guide graph: each coarse cell splits into 4-connected regions of passable terrain cells (labelled by
   * `labelCoarseBlock` in scan order). Regions of cell c are [coarseRegionStart[c], coarseRegionStart[c + 1]).
   */
  readonly coarseRegionStart: Int32Array;
  /** Passable terrain cell of the region nearest the coarse cell center. */
  readonly regionRep: Int32Array;
  readonly regionComp: Uint16Array;
  /** Region area as a fraction of the coarse cell, 0..255. */
  readonly regionFrac: Uint8Array;
  /** CSR edges between regions of 4-neighbour coarse cells, with the open fraction of the shared border (0..255). */
  readonly regionEdgeStart: Int32Array;
  readonly regionEdgeTo: Int32Array;
  readonly regionEdgeOpen: Uint8Array;
}

export interface NavGridLayout {
  readonly cellSize: number;
  readonly buildingCellSize: number;
  readonly coarseCellSize: number;
  readonly agentRadius: number;
  readonly originX: number;
  readonly originZ: number;
  readonly width: number;
  readonly depth: number;
  readonly heightOriginX: number;
  readonly heightOriginZ: number;
  readonly heightSpacing: number;
  readonly heightCols: number;
  readonly heightRows: number;
  /** Fine cells per coarse cell side. */
  readonly coarseRatio: number;
  readonly coarseWidth: number;
  readonly coarseDepth: number;
  readonly mainComponent: number;
}

export class NavGridData implements NavGrid {
  readonly info: NavGridInfo;
  readonly layout: NavGridLayout;
  readonly arrays: NavGridArrays;
  readonly layers: readonly NavPrefabLayer[];
  readonly placements: readonly NavPlacement[];
  readonly stats: NavBuildStats | null;

  // Hot-path copies of layout fields.
  readonly cellSize: number;
  readonly buildingCellSize: number;
  readonly originX: number;
  readonly originZ: number;
  readonly width: number;
  readonly depth: number;
  readonly terrainNodes: number;
  readonly buildingNodes: number;
  readonly terrainFlags: Uint8Array;
  readonly terrainComp: Uint16Array;
  readonly spanFlags: Uint8Array;
  readonly spanComp: Uint16Array;
  readonly spanPlacement: Uint16Array;
  private readonly heights: Float32Array;
  private readonly hOx: number;
  private readonly hOz: number;
  private readonly hSpacing: number;
  private readonly hCols: number;
  private readonly hRows: number;

  constructor(info: NavGridInfo, layout: NavGridLayout, arrays: NavGridArrays, layers: readonly NavPrefabLayer[], placements: readonly NavPlacement[], stats: NavBuildStats | null) {
    this.info = info;
    this.layout = layout;
    this.arrays = arrays;
    this.layers = layers;
    this.placements = placements;
    this.stats = stats;
    this.cellSize = layout.cellSize;
    this.buildingCellSize = layout.buildingCellSize;
    this.originX = layout.originX;
    this.originZ = layout.originZ;
    this.width = layout.width;
    this.depth = layout.depth;
    this.terrainNodes = layout.width * layout.depth;
    this.buildingNodes = arrays.spanFlags.length;
    this.terrainFlags = arrays.terrainFlags;
    this.terrainComp = arrays.terrainComp;
    this.spanFlags = arrays.spanFlags;
    this.spanComp = arrays.spanComp;
    this.spanPlacement = arrays.spanPlacement;
    this.heights = arrays.heights;
    this.hOx = layout.heightOriginX;
    this.hOz = layout.heightOriginZ;
    this.hSpacing = layout.heightSpacing;
    this.hCols = layout.heightCols;
    this.hRows = layout.heightRows;
  }

  get nodeCount(): number {
    return this.terrainNodes + this.buildingNodes;
  }

  /** Terrain surface height (same triangle split as the physics heightfield). */
  terrainHeight(x: number, z: number): number {
    const n = this.hCols;
    const m = this.hRows;
    let gx = (x - this.hOx) / this.hSpacing;
    let gz = (z - this.hOz) / this.hSpacing;
    if (gx < 0) gx = 0;
    else if (gx > n - 1) gx = n - 1;
    if (gz < 0) gz = 0;
    else if (gz > m - 1) gz = m - 1;
    let ix = Math.floor(gx);
    let iz = Math.floor(gz);
    if (ix > n - 2) ix = n - 2;
    if (iz > m - 2) iz = m - 2;
    const fx = gx - ix;
    const fz = gz - iz;
    const h = this.heights;
    const row = iz * n;
    const h10 = h[row + ix + 1]!;
    const h01 = h[row + n + ix]!;
    if (fx + fz <= 1) {
      const h00 = h[row + ix]!;
      return h00 + fx * (h10 - h00) + fz * (h01 - h00);
    }
    const h11 = h[row + n + ix + 1]!;
    return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
  }

  /** Terrain cell containing (x, z), or -1 outside the grid. */
  cellAt(x: number, z: number): number {
    const ix = Math.floor((x - this.originX) / this.cellSize);
    const iz = Math.floor((z - this.originZ) / this.cellSize);
    if (ix < 0 || iz < 0 || ix >= this.width || iz >= this.depth) return -1;
    return iz * this.width + ix;
  }

  flagsOf(ref: number): number {
    if (ref < 0) return 0;
    if (ref < this.terrainNodes) return this.terrainFlags[ref]!;
    const g = ref - this.terrainNodes;
    return g < this.buildingNodes ? this.spanFlags[g]! : 0;
  }

  componentOf(ref: number): number {
    if (ref < 0) return 0;
    if (ref < this.terrainNodes) return this.terrainComp[ref]!;
    const g = ref - this.terrainNodes;
    return g < this.buildingNodes ? this.spanComp[g]! : 0;
  }

  /** Index of the placement owning a node, or -1 for terrain. */
  layerOf(ref: number): number {
    return ref < this.terrainNodes ? -1 : this.spanPlacement[ref - this.terrainNodes]!;
  }

  nodeX(ref: number): number {
    if (ref < this.terrainNodes) return this.originX + ((ref % this.width) + 0.5) * this.cellSize;
    const g = ref - this.terrainNodes;
    const p = this.placements[this.spanPlacement[g]!]!;
    const layer = this.layers[p.layer]!;
    const col = layer.spanCol[g - p.base]!;
    const cx = col % layer.cols;
    const lx = layer.minX + (cx + 0.5) * this.buildingCellSize;
    const lz = layer.minZ + ((col - cx) / layer.cols + 0.5) * this.buildingCellSize;
    return p.x + lx * p.cos + lz * p.sin;
  }

  nodeZ(ref: number): number {
    if (ref < this.terrainNodes) return this.originZ + (Math.floor(ref / this.width) + 0.5) * this.cellSize;
    const g = ref - this.terrainNodes;
    const p = this.placements[this.spanPlacement[g]!]!;
    const layer = this.layers[p.layer]!;
    const col = layer.spanCol[g - p.base]!;
    const cx = col % layer.cols;
    const lx = layer.minX + (cx + 0.5) * this.buildingCellSize;
    const lz = layer.minZ + ((col - cx) / layer.cols + 0.5) * this.buildingCellSize;
    return p.z - lx * p.sin + lz * p.cos;
  }

  nodeY(ref: number): number {
    if (ref < this.terrainNodes) return this.terrainHeight(this.nodeX(ref), this.nodeZ(ref));
    const g = ref - this.terrainNodes;
    const p = this.placements[this.spanPlacement[g]!]!;
    return p.y + this.layers[p.layer]!.spanY[g - p.base]!;
  }

  /**
   * Span of `layer` in column `col` that a capsule at local height `y` steps onto (walkable, |Δy| ≤ step), as a
   * prefab-local span index, or -1. `base` selects the placement's global flags.
   */
  matchSpan(layer: NavPrefabLayer, base: number, col: number, y: number): number {
    const end = layer.colStart[col + 1]!;
    let best = -1;
    let bestDy = MAX_NEIGHBOUR_RISE + 1e-4;
    for (let k = layer.colStart[col]!; k < end; k++) {
      if ((this.spanFlags[base + k]! & PASSABLE) === 0) continue;
      const dy = Math.abs(layer.spanY[k]! - y);
      if (dy <= bestDy) {
        bestDy = dy;
        best = k;
      }
    }
    return best;
  }

  /** First index in the link table for `ref`, or -1. */
  firstLink(ref: number): number {
    if ((this.arrays.linkBits[ref >> 3]! & (1 << (ref & 7))) === 0) return -1;
    const from = this.arrays.linkFrom;
    let lo = 0;
    let hi = from.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (from[mid]! < ref) lo = mid + 1;
      else hi = mid;
    }
    return lo < from.length && from[lo] === ref ? lo : -1;
  }

  /**
   * Passable neighbours of a passable node, written to `refs`/`costs` (capacity ≥ 8 + links). No corner cutting:
   * diagonals need both orthogonal neighbours. Returns the count.
   */
  neighbors(ref: number, refs: Int32Array, costs: Float32Array): number {
    let n = 0;
    if (ref < this.terrainNodes) {
      const w = this.width;
      const flags = this.terrainFlags;
      const cs = this.cellSize;
      const diag = cs * Math.SQRT2;
      const ix = ref % w;
      const iz = (ref - ix) / w;
      const e = ix + 1 < w && (flags[ref + 1]! & PASSABLE) !== 0;
      const west = ix > 0 && (flags[ref - 1]! & PASSABLE) !== 0;
      const north = iz + 1 < this.depth && (flags[ref + w]! & PASSABLE) !== 0;
      const south = iz > 0 && (flags[ref - w]! & PASSABLE) !== 0;
      if (e) (refs[n] = ref + 1), (costs[n++] = cs);
      if (west) (refs[n] = ref - 1), (costs[n++] = cs);
      if (north) (refs[n] = ref + w), (costs[n++] = cs);
      if (south) (refs[n] = ref - w), (costs[n++] = cs);
      if (e && north && (flags[ref + w + 1]! & PASSABLE) !== 0) (refs[n] = ref + w + 1), (costs[n++] = diag);
      if (west && north && (flags[ref + w - 1]! & PASSABLE) !== 0) (refs[n] = ref + w - 1), (costs[n++] = diag);
      if (e && south && (flags[ref - w + 1]! & PASSABLE) !== 0) (refs[n] = ref - w + 1), (costs[n++] = diag);
      if (west && south && (flags[ref - w - 1]! & PASSABLE) !== 0) (refs[n] = ref - w - 1), (costs[n++] = diag);
    } else {
      const g = ref - this.terrainNodes;
      const p = this.placements[this.spanPlacement[g]!]!;
      const layer = this.layers[p.layer]!;
      const local = g - p.base;
      const col = layer.spanCol[local]!;
      const cols = layer.cols;
      const cx = col % cols;
      const cz = (col - cx) / cols;
      const y = layer.spanY[local]!;
      const bcs = this.buildingCellSize;
      const base = p.base + this.terrainNodes;
      const e = cx + 1 < cols ? this.matchSpan(layer, p.base, col + 1, y) : -1;
      const west = cx > 0 ? this.matchSpan(layer, p.base, col - 1, y) : -1;
      const north = cz + 1 < layer.rows ? this.matchSpan(layer, p.base, col + cols, y) : -1;
      const south = cz > 0 ? this.matchSpan(layer, p.base, col - cols, y) : -1;
      if (e >= 0) n = pushSpan(refs, costs, n, base + e, bcs, layer.spanY[e]! - y);
      if (west >= 0) n = pushSpan(refs, costs, n, base + west, bcs, layer.spanY[west]! - y);
      if (north >= 0) n = pushSpan(refs, costs, n, base + north, bcs, layer.spanY[north]! - y);
      if (south >= 0) n = pushSpan(refs, costs, n, base + south, bcs, layer.spanY[south]! - y);
      const diag = bcs * Math.SQRT2;
      if (e >= 0 && north >= 0) {
        const k = this.matchSpan(layer, p.base, col + cols + 1, y);
        if (k >= 0) n = pushSpan(refs, costs, n, base + k, diag, layer.spanY[k]! - y);
      }
      if (west >= 0 && north >= 0) {
        const k = this.matchSpan(layer, p.base, col + cols - 1, y);
        if (k >= 0) n = pushSpan(refs, costs, n, base + k, diag, layer.spanY[k]! - y);
      }
      if (e >= 0 && south >= 0) {
        const k = this.matchSpan(layer, p.base, col - cols + 1, y);
        if (k >= 0) n = pushSpan(refs, costs, n, base + k, diag, layer.spanY[k]! - y);
      }
      if (west >= 0 && south >= 0) {
        const k = this.matchSpan(layer, p.base, col - cols - 1, y);
        if (k >= 0) n = pushSpan(refs, costs, n, base + k, diag, layer.spanY[k]! - y);
      }
    }
    const first = this.firstLink(ref);
    if (first >= 0) {
      const { linkFrom, linkTo, linkCost } = this.arrays;
      const capacity = refs.length;
      for (let i = first; i < linkFrom.length && linkFrom[i] === ref && n < capacity; i++) {
        const to = linkTo[i]!;
        if ((this.flagsOf(to) & PASSABLE) === 0) continue;
        refs[n] = to;
        costs[n++] = linkCost[i]!;
      }
    }
    return n;
  }
}

function pushSpan(refs: Int32Array, costs: Float32Array, n: number, ref: number, horizontal: number, dy: number): number {
  refs[n] = ref;
  costs[n] = Math.sqrt(horizontal * horizontal + dy * dy);
  return n + 1;
}

/** Narrows a contract NavGrid to the built data. */
export function asNavGridData(grid: NavGrid): NavGridData {
  if (!(grid instanceof NavGridData)) throw new Error("NavGrid was not built by buildNavGrid/deserializeNavGrid");
  return grid;
}

/**
 * Labels the 4-connected passable terrain regions of coarse block (cx, cz) in scan order. `labels` gets one entry per
 * block cell (row-major, −1 = not passable) and must hold ratio²; `stack` the same. Returns the region count.
 */
export function labelCoarseBlock(grid: Pick<NavGridData, "terrainFlags" | "width" | "depth">, ratio: number, cx: number, cz: number, labels: Int16Array, stack: Int32Array): number {
  const x0 = cx * ratio;
  const z0 = cz * ratio;
  const bw = Math.min(ratio, grid.width - x0);
  const bd = Math.min(ratio, grid.depth - z0);
  const flags = grid.terrainFlags;
  const w = grid.width;
  labels.fill(-2, 0, ratio * ratio);
  let regions = 0;
  for (let lz = 0; lz < bd; lz++) {
    for (let lx = 0; lx < bw; lx++) {
      const li = lz * ratio + lx;
      if (labels[li] !== -2) continue;
      if ((flags[(z0 + lz) * w + x0 + lx]! & PASSABLE) === 0) {
        labels[li] = -1;
        continue;
      }
      let top = 0;
      stack[top++] = li;
      labels[li] = regions;
      while (top > 0) {
        const cur = stack[--top]!;
        const ux = cur % ratio;
        const uz = (cur - ux) / ratio;
        for (let k = 0; k < 4; k++) {
          const nx = ux + (k === 0 ? 1 : k === 1 ? -1 : 0);
          const nz = uz + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || nz < 0 || nx >= bw || nz >= bd) continue;
          const ni = nz * ratio + nx;
          if (labels[ni] !== -2) continue;
          if ((flags[(z0 + nz) * w + x0 + nx]! & PASSABLE) === 0) {
            labels[ni] = -1;
            continue;
          }
          labels[ni] = regions;
          stack[top++] = ni;
        }
      }
      regions++;
    }
  }
  return regions;
}
