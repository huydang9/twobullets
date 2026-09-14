import { getBuildingPrefab } from "../../map/buildings/prefabs";
import { propColliderGroups } from "../../map/layout/collision";
import { getMapProp } from "../../map/layout/props";
import { INSTANCE_STRIDE } from "../../map/layout/scatter";
import { checksumBytes } from "../../map/terrain/heightfield";
import { sinCos } from "../../map/terrain/math";
import { NavFlag, type NavBuildInput, type NavGridInfo } from "../types";
import {
  CROUCH_CLEARANCE,
  NAV_GRID_VERSION,
  NAV_STEP_HEIGHT,
  NavGridData,
  PASSABLE,
  STAND_CLEARANCE,
  labelCoarseBlock,
  type NavBuildStats,
  type NavGridArrays,
  type NavGridLayout,
  type NavPlacement,
  type NavPrefabLayer,
} from "./navGrid";
import { buildPrefabLayer, sweepBlocks, type PartBuckets } from "./prefabLayer";
import { MOVEMENT } from "../../constants";

// buildNavGrid (docs/bots/design.md §3.2): terrain layer 0.5 m, per-prefab building span layers 0.25 m, links between
// them, connected components with small islands cleared, and the 4 m coarse guide grid. Pure and deterministic.

export const NAV_DEFAULTS = {
  cellSize: 0.5,
  buildingCellSize: 0.25,
  coarseCellSize: 4,
  agentRadius: 0.3,
  maxSlopeDegrees: 40,
  /** Walkable islands smaller than this are cleared, m². */
  minIslandArea: 8,
  /** Prop colliders whose top is at most this far above the ground are stepped over, m. */
  propStepHeight: 0.26,
  /** How far a building edge span looks outward for terrain to link to, m. */
  linkReach: 1.5,
  /** Links are swept with the full controller capsule radius, so a link never grazes a door frame or wall. */
  linkRadius: MOVEMENT.capsuleRadius,
} as const;

/** Temporary terrain flag bits during the build (cleared before the grid is returned). */
const TMP_OBSTACLE = NavFlag.indoor;
const TMP_PROP = NavFlag.stairs;
const ORTHO = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export function buildNavGrid(input: NavBuildInput): NavGridData {
  const started = performance.now();
  const stageMs: Record<string, number> = {};
  let stageStart = started;
  const stage = (name: string) => {
    const now = performance.now();
    stageMs[name] = Math.round((now - stageStart) * 10) / 10;
    stageStart = now;
  };

  const { map, terrain, layout } = input;
  const o = input.options ?? {};
  const cs = o.cellSize ?? NAV_DEFAULTS.cellSize;
  const bcs = o.buildingCellSize ?? NAV_DEFAULTS.buildingCellSize;
  const coarseSize = o.coarseCellSize ?? NAV_DEFAULTS.coarseCellSize;
  const agentRadius = o.agentRadius ?? NAV_DEFAULTS.agentRadius;
  const slope = sinCos(((o.maxSlopeDegrees ?? NAV_DEFAULTS.maxSlopeDegrees) * Math.PI) / 180);
  const maxSlopeTan = slope.sin / slope.cos;
  const half = map.terrain.playableHalfExtent;
  const width = Math.round((2 * half) / cs);
  const depth = width;
  const originX = -half;
  const originZ = -half;
  const T = width * depth;

  // Heightfield samples covering the grid, plus one sample of margin.
  const field = terrain.field;
  const hx0 = Math.max(0, Math.floor((originX - field.minX) / field.spacing) - 1);
  const hz0 = Math.max(0, Math.floor((originZ - field.minZ) / field.spacing) - 1);
  const hx1 = Math.min(field.resolution - 1, Math.ceil((originX + width * cs - field.minX) / field.spacing) + 1);
  const hz1 = Math.min(field.resolution - 1, Math.ceil((originZ + depth * cs - field.minZ) / field.spacing) + 1);
  const heightCols = hx1 - hx0 + 1;
  const heightRows = hz1 - hz0 + 1;
  const heights = new Float32Array(heightCols * heightRows);
  for (let iz = 0; iz < heightRows; iz++) {
    const srcRow = (hz0 + iz) * field.resolution + hx0;
    heights.set(field.heights.subarray(srcRow, srcRow + heightCols), iz * heightCols);
  }

  const coarseRatio = Math.max(1, Math.round(coarseSize / cs));
  const coarseWidth = Math.ceil(width / coarseRatio);
  const coarseDepth = Math.ceil(depth / coarseRatio);

  // Layers and placements.
  const layerIndex = new Map<string, number>();
  const layers: NavPrefabLayer[] = [];
  const buckets: PartBuckets[] = [];
  let overflowColumns = 0;
  const placements: NavPlacement[] = [];
  let buildingNodes = 0;
  for (const b of layout.buildings) {
    let li = layerIndex.get(b.prefab);
    if (li === undefined) {
      const built = buildPrefabLayer(getBuildingPrefab(b.prefab), bcs, agentRadius);
      li = layers.length;
      layers.push(built.layer);
      buckets.push(built.buckets);
      overflowColumns += built.overflowColumns;
      layerIndex.set(b.prefab, li);
    }
    const layer = layers[li]!;
    const { sin, cos } = sinCos(b.yaw);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const lx of [layer.minX, layer.minX + layer.cols * bcs]) {
      for (const lz of [layer.minZ, layer.minZ + layer.rows * bcs]) {
        const wx = b.position[0] + lx * cos + lz * sin;
        const wz = b.position[2] - lx * sin + lz * cos;
        minX = Math.min(minX, wx);
        maxX = Math.max(maxX, wx);
        minZ = Math.min(minZ, wz);
        maxZ = Math.max(maxZ, wz);
      }
    }
    const count = layer.spanY.length;
    placements.push({ id: b.id, layer: li, x: b.position[0], y: b.position[1], z: b.position[2], yaw: b.yaw, sin, cos, base: buildingNodes, count, minX, minZ, maxX, maxZ });
    buildingNodes += count;
  }
  if (placements.length > 65535) throw new Error("nav: too many building placements");
  const prefabSpans = layers.reduce((n, l) => n + l.spanY.length, 0);
  stage("prefabLayers");

  const terrainFlags = new Uint8Array(T);
  const terrainComp = new Uint16Array(T);
  const spanFlags = new Uint8Array(buildingNodes);
  const spanComp = new Uint16Array(buildingNodes);
  const spanPlacement = new Uint16Array(buildingNodes);
  placements.forEach((p, i) => {
    spanPlacement.fill(i, p.base, p.base + p.count);
    spanFlags.set(layers[p.layer]!.spanFlags, p.base);
  });

  // A temporary grid object for height sampling during the build (arrays are filled in place).
  const layoutInfo: NavGridLayout = {
    cellSize: cs,
    buildingCellSize: bcs,
    coarseCellSize: coarseRatio * cs,
    agentRadius,
    originX,
    originZ,
    width,
    depth,
    heightOriginX: field.minX + hx0 * field.spacing,
    heightOriginZ: field.minZ + hz0 * field.spacing,
    heightSpacing: field.spacing,
    heightCols,
    heightRows,
    coarseRatio,
    coarseWidth,
    coarseDepth,
    mainComponent: 0,
  };
  const empty = {
    linkFrom: new Int32Array(0),
    linkTo: new Int32Array(0),
    linkCost: new Float32Array(0),
    linkBits: new Uint8Array((T + buildingNodes + 7) >> 3),
    coarseRegionStart: new Int32Array(0),
    regionRep: new Int32Array(0),
    regionComp: new Uint16Array(0),
    regionFrac: new Uint8Array(0),
    regionEdgeStart: new Int32Array(0),
    regionEdgeTo: new Int32Array(0),
    regionEdgeOpen: new Uint8Array(0),
  };
  const draftInfo = { version: NAV_GRID_VERSION, cellSize: cs, buildingCellSize: bcs, coarseCellSize: coarseRatio * cs, originX, originZ, width, depth, terrainNodes: T, buildingNodes, components: 0, byteLength: 0, checksum: "" };
  let grid = new NavGridData(draftInfo, layoutInfo, { terrainFlags, terrainComp, heights, spanFlags, spanComp, spanPlacement, ...empty }, layers, placements, null);

  // 1. Terrain slope and heights (rolling three rows of cell-center heights).
  let slopeBlocked = 0;
  {
    const rows = [new Float32Array(width), new Float32Array(width), new Float32Array(width)];
    const fill = (row: Float32Array, iz: number) => {
      const z = originZ + (Math.min(depth - 1, Math.max(0, iz)) + 0.5) * cs;
      for (let ix = 0; ix < width; ix++) row[ix] = grid.terrainHeight(originX + (ix + 0.5) * cs, z);
    };
    fill(rows[0]!, -1);
    fill(rows[1]!, 0);
    for (let iz = 0; iz < depth; iz++) {
      fill(rows[2]!, iz + 1);
      const s = rows[0]!;
      const c = rows[1]!;
      const nrow = rows[2]!;
      const dz = (iz === 0 || iz === depth - 1 ? 1 : 2) * cs;
      const rowBase = iz * width;
      for (let ix = 0; ix < width; ix++) {
        const e = c[ix + 1 < width ? ix + 1 : ix]!;
        const w = c[ix > 0 ? ix - 1 : ix]!;
        const dx = (ix === 0 || ix === width - 1 ? 1 : 2) * cs;
        const gx = (e - w) / dx;
        const gz = (nrow[ix]! - s[ix]!) / dz;
        if (gx * gx + gz * gz <= maxSlopeTan * maxSlopeTan) terrainFlags[rowBase + ix] = NavFlag.walkable;
        else slopeBlocked++;
      }
      const t = rows[0]!;
      rows[0] = rows[1]!;
      rows[1] = rows[2]!;
      rows[2] = t;
    }
  }
  stage("terrainSlope");

  // 2. Road flag from the surface mask (bilinear road weight > 50 %).
  {
    const weights = terrain.surface.weights;
    const n = field.resolution;
    for (let iz = 0; iz < depth; iz++) {
      const gz = (originZ + (iz + 0.5) * cs - field.minZ) / field.spacing;
      const jz = Math.min(n - 2, Math.max(0, Math.floor(gz)));
      const fz = Math.min(1, Math.max(0, gz - jz));
      for (let ix = 0; ix < width; ix++) {
        const gx = (originX + (ix + 0.5) * cs - field.minX) / field.spacing;
        const jx = Math.min(n - 2, Math.max(0, Math.floor(gx)));
        const fx = Math.min(1, Math.max(0, gx - jx));
        const i00 = (jz * n + jx) * 4 + 3;
        const top = weights[i00]! + (weights[i00 + 4]! - weights[i00]!) * fx;
        const bottom = weights[i00 + n * 4]! + (weights[i00 + n * 4 + 4]! - weights[i00 + n * 4]!) * fx;
        if (top + (bottom - top) * fz > 127.5) terrainFlags[iz * width + ix]! |= NavFlag.road;
      }
    }
  }
  stage("terrainRoad");

  // 3. Props: colliders block (inflated), bushes flag vegetation.
  let propBlocked = 0;
  {
    const block = (cell: number) => {
      if ((terrainFlags[cell]! & TMP_PROP) === 0 && (terrainFlags[cell]! & PASSABLE) !== 0) propBlocked++;
      terrainFlags[cell] = (terrainFlags[cell]! & ~PASSABLE) | TMP_OBSTACLE | TMP_PROP;
    };
    for (const group of propColliderGroups(layout)) {
      const t = group.transforms;
      const shape = group.shape;
      for (let i = 0; i < t.length; i += 4) {
        const px = t[i]!;
        const py = t[i + 1]!;
        const pz = t[i + 2]!;
        const yaw = t[i + 3]!;
        let reach: number;
        let bottom: number;
        let top: number;
        let hx = 0;
        let hz = 0;
        if (shape.kind === "cylinder") {
          reach = shape.radius + agentRadius;
          bottom = py;
          top = py + shape.height;
        } else {
          hx = shape.size[0] / 2 + agentRadius;
          hz = shape.size[2] / 2 + agentRadius;
          reach = Math.sqrt(hx * hx + hz * hz);
          bottom = py + shape.centerY - shape.size[1] / 2;
          top = py + shape.centerY + shape.size[1] / 2;
        }
        const { sin: s, cos: c } = sinCos(yaw);
        const ix0 = Math.max(0, Math.floor((px - reach - originX) / cs));
        const ix1 = Math.min(width - 1, Math.floor((px + reach - originX) / cs));
        const iz0 = Math.max(0, Math.floor((pz - reach - originZ) / cs));
        const iz1 = Math.min(depth - 1, Math.floor((pz + reach - originZ) / cs));
        for (let iz = iz0; iz <= iz1; iz++) {
          const z = originZ + (iz + 0.5) * cs;
          for (let ix = ix0; ix <= ix1; ix++) {
            const x = originX + (ix + 0.5) * cs;
            const dx = x - px;
            const dz = z - pz;
            if (shape.kind === "cylinder") {
              if (dx * dx + dz * dz > reach * reach) continue;
            } else {
              const lx = dx * c - dz * s;
              const lz = dx * s + dz * c;
              if (Math.abs(lx) > hx || Math.abs(lz) > hz) continue;
            }
            const h = grid.terrainHeight(x, z);
            if (top <= h + NAV_DEFAULTS.propStepHeight || bottom >= h + STAND_CLEARANCE) continue;
            block(iz * width + ix);
          }
        }
      }
    }
    for (const set of layout.props) {
      const def = getMapProp(set.prop);
      if (def.category !== "bush") continue;
      const d = set.data;
      for (let i = 0; i < d.length; i += INSTANCE_STRIDE) {
        const px = d[i]!;
        const pz = d[i + 2]!;
        const r = def.footprint * d[i + 4]!;
        const ix0 = Math.max(0, Math.floor((px - r - originX) / cs));
        const ix1 = Math.min(width - 1, Math.floor((px + r - originX) / cs));
        const iz0 = Math.max(0, Math.floor((pz - r - originZ) / cs));
        const iz1 = Math.min(depth - 1, Math.floor((pz + r - originZ) / cs));
        for (let iz = iz0; iz <= iz1; iz++) {
          for (let ix = ix0; ix <= ix1; ix++) {
            const dx = originX + (ix + 0.5) * cs - px;
            const dz = originZ + (iz + 0.5) * cs - pz;
            if (dx * dx + dz * dz <= r * r) terrainFlags[iz * width + ix]! |= NavFlag.vegetation;
          }
        }
      }
    }
  }
  stage("props");

  // 4. Buildings block the terrain under and around their parts (their floors are span layers).
  let buildingBlocked = 0;
  for (const p of placements) {
    const layer = layers[p.layer]!;
    const bk = buckets[p.layer]!;
    const ix0 = Math.max(0, Math.floor((p.minX - agentRadius - originX) / cs));
    const ix1 = Math.min(width - 1, Math.floor((p.maxX + agentRadius - originX) / cs));
    const iz0 = Math.max(0, Math.floor((p.minZ - agentRadius - originZ) / cs));
    const iz1 = Math.min(depth - 1, Math.floor((p.maxZ + agentRadius - originZ) / cs));
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = originZ + (iz + 0.5) * cs;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = originX + (ix + 0.5) * cs;
        const dx = x - p.x;
        const dz = z - p.z;
        const lx = dx * p.cos - dz * p.sin;
        const lz = dx * p.sin + dz * p.cos;
        if (lx < layer.minX - agentRadius - 1 || lz < layer.minZ - agentRadius - 1 || lx > layer.minX + layer.cols * bcs + agentRadius + 1 || lz > layer.minZ + layer.rows * bcs + agentRadius + 1) continue;
        const hl = grid.terrainHeight(x, z) - p.y;
        if (!bk.blocks(lx, lz, agentRadius, hl + 0.02, hl + STAND_CLEARANCE)) continue;
        const cell = iz * width + ix;
        if ((terrainFlags[cell]! & PASSABLE) !== 0) buildingBlocked++;
        terrainFlags[cell] = (terrainFlags[cell]! & ~PASSABLE) | TMP_OBSTACLE;
      }
    }
  }
  // Placements that overlap (stacked containers): spans blocked by the other placement's parts.
  for (let a = 0; a < placements.length; a++) {
    for (let b = 0; b < placements.length; b++) {
      if (a === b) continue;
      const pa = placements[a]!;
      const pb = placements[b]!;
      if (pa.maxX < pb.minX || pb.maxX < pa.minX || pa.maxZ < pb.minZ || pb.maxZ < pa.minZ) continue;
      const la = layers[pa.layer]!;
      const bk = buckets[pb.layer]!;
      for (let k = 0; k < pa.count; k++) {
        const g = pa.base + k;
        if ((spanFlags[g]! & PASSABLE) === 0) continue;
        const ref = T + g;
        const wx = grid.nodeX(ref);
        const wz = grid.nodeZ(ref);
        const dx = wx - pb.x;
        const dz = wz - pb.z;
        const lx = dx * pb.cos - dz * pb.sin;
        const lz = dx * pb.sin + dz * pb.cos;
        const t = pa.y + la.spanY[k]! - pb.y;
        if (bk.blocks(lx, lz, agentRadius, t - 0.02, t + CROUCH_CLEARANCE)) spanFlags[g] = spanFlags[g]! & ~(PASSABLE | NavFlag.crouchOnly);
        else if ((spanFlags[g]! & NavFlag.crouchOnly) === 0 && bk.blocks(lx, lz, agentRadius, t + NAV_STEP_HEIGHT, t + STAND_CLEARANCE)) spanFlags[g] = spanFlags[g]! | NavFlag.crouchOnly;
      }
    }
  }
  stage("buildingsOnTerrain");

  // 5. nearObstacle on terrain: next to a prop or building obstacle.
  for (let iz = 0; iz < depth; iz++) {
    for (let ix = 0; ix < width; ix++) {
      const cell = iz * width + ix;
      if ((terrainFlags[cell]! & PASSABLE) === 0) continue;
      let near = false;
      for (let dz = -1; dz <= 1 && !near; dz++) {
        const jz = iz + dz;
        if (jz < 0 || jz >= depth) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const jx = ix + dx;
          if (jx < 0 || jx >= width) continue;
          if ((terrainFlags[jz * width + jx]! & TMP_OBSTACLE) !== 0) {
            near = true;
            break;
          }
        }
      }
      if (near) terrainFlags[cell]! |= NavFlag.nearObstacle;
    }
  }
  stage("nearObstacle");

  // 6. Links: building edge spans at ground level to the first walkable terrain cell outward.
  const linkPairs: number[] = [];
  for (let pi = 0; pi < placements.length; pi++) {
    const p = placements[pi]!;
    const layer = layers[p.layer]!;
    const bk = buckets[p.layer]!;
    for (let k = 0; k < p.count; k++) {
      const g = p.base + k;
      if ((spanFlags[g]! & PASSABLE) === 0) continue;
      const col = layer.spanCol[k]!;
      const cx = col % layer.cols;
      const cz = (col - cx) / layer.cols;
      const t = layer.spanY[k]!;
      const lx0 = layer.minX + (cx + 0.5) * bcs;
      const lz0 = layer.minZ + (cz + 0.5) * bcs;
      const wy = p.y + t;
      const wx0 = p.x + lx0 * p.cos + lz0 * p.sin;
      const wz0 = p.z - lx0 * p.sin + lz0 * p.cos;
      if (wy - grid.terrainHeight(wx0, wz0) > NAV_DEFAULTS.linkReach + NAV_STEP_HEIGHT) continue;
      const headroom = t + ((spanFlags[g]! & NavFlag.crouchOnly) !== 0 ? CROUCH_CLEARANCE : STAND_CLEARANCE);
      for (const [ddx, ddz] of ORTHO) {
        const ncx = cx + ddx;
        const ncz = cz + ddz;
        if (ncx >= 0 && ncz >= 0 && ncx < layer.cols && ncz < layer.rows && grid.matchSpan(layer, p.base, ncz * layer.cols + ncx, t) >= 0) continue;
        for (let d = bcs; d <= NAV_DEFAULTS.linkReach + 1e-6; d += bcs) {
          const lx = lx0 + ddx * d;
          const lz = lz0 + ddz * d;
          const wx = p.x + lx * p.cos + lz * p.sin;
          const wz = p.z - lx * p.sin + lz * p.cos;
          const cell = grid.cellAt(wx, wz);
          if (cell < 0) break;
          const f = terrainFlags[cell]!;
          if ((f & TMP_PROP) !== 0) break;
          if ((f & PASSABLE) === 0) continue;
          const cellX = grid.nodeX(cell);
          const cellZ = grid.nodeZ(cell);
          const hc = grid.terrainHeight(cellX, cellZ);
          if (Math.abs(hc - wy) > NAV_STEP_HEIGHT + 0.05) break;
          // Sweep the capsule from the span center to the terrain cell center in prefab-local space.
          const ex = cellX - p.x;
          const ez = cellZ - p.z;
          if (sweepBlocks(bk.parts, lx0, lz0, ex * p.cos - ez * p.sin, ex * p.sin + ez * p.cos, NAV_DEFAULTS.linkRadius, t + NAV_STEP_HEIGHT, headroom)) break;
          const cost = Math.sqrt((cellX - wx0) * (cellX - wx0) + (cellZ - wz0) * (cellZ - wz0) + (hc - wy) * (hc - wy));
          linkPairs.push(cell, T + g, cost);
          break;
        }
      }
    }
  }
  const linkCount = linkPairs.length / 3;
  const linkOrder = Array.from({ length: linkCount * 2 }, (_, i) => i).sort((a, b) => {
    const fa = linkPairs[(a >> 1) * 3 + (a & 1)]!;
    const fb = linkPairs[(b >> 1) * 3 + (b & 1)]!;
    return fa - fb || a - b;
  });
  const linkFrom = new Int32Array(linkCount * 2);
  const linkTo = new Int32Array(linkCount * 2);
  const linkCost = new Float32Array(linkCount * 2);
  const linkBits = empty.linkBits;
  linkOrder.forEach((entry, i) => {
    const base = (entry >> 1) * 3;
    const from = linkPairs[base + (entry & 1)]!;
    linkFrom[i] = from;
    linkTo[i] = linkPairs[base + 1 - (entry & 1)]!;
    linkCost[i] = linkPairs[base + 2]!;
    linkBits[from >> 3]! |= 1 << (from & 7);
  });
  grid = new NavGridData(draftInfo, layoutInfo, { terrainFlags, terrainComp, heights, spanFlags, spanComp, spanPlacement, ...empty, linkFrom, linkTo, linkCost, linkBits }, layers, placements, null);
  stage("links");

  // Clear the temporary bits.
  for (let i = 0; i < T; i++) terrainFlags[i] = terrainFlags[i]! & ~(TMP_OBSTACLE | TMP_PROP);

  // 7. Components: union-find over terrain row runs and building spans.
  const runX0: number[] = [];
  const runX1: number[] = [];
  const rowStart = new Int32Array(depth + 1);
  for (let iz = 0; iz < depth; iz++) {
    rowStart[iz] = runX0.length;
    const rowBase = iz * width;
    let ix = 0;
    while (ix < width) {
      if ((terrainFlags[rowBase + ix]! & PASSABLE) === 0) {
        ix++;
        continue;
      }
      const start = ix;
      while (ix < width && (terrainFlags[rowBase + ix]! & PASSABLE) !== 0) ix++;
      runX0.push(start);
      runX1.push(ix - 1);
    }
  }
  rowStart[depth] = runX0.length;
  const R = runX0.length;
  const parent = new Int32Array(R + buildingNodes);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[i] !== r) {
      const next = parent[i]!;
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };
  for (let iz = 1; iz < depth; iz++) {
    let a = rowStart[iz - 1]!;
    const aEnd = rowStart[iz]!;
    let b = rowStart[iz]!;
    const bEnd = rowStart[iz + 1]!;
    while (a < aEnd && b < bEnd) {
      if (runX0[a]! <= runX1[b]! && runX0[b]! <= runX1[a]!) union(a, b);
      if (runX1[a]! < runX1[b]!) a++;
      else b++;
    }
  }
  const runOfCell = (cell: number): number => {
    const ix = cell % width;
    const iz = (cell - ix) / width;
    let lo = rowStart[iz]!;
    let hi = rowStart[iz + 1]! - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (runX1[mid]! < ix) lo = mid + 1;
      else if (runX0[mid]! > ix) hi = mid - 1;
      else return mid;
    }
    return -1;
  };
  for (const p of placements) {
    const layer = layers[p.layer]!;
    for (let k = 0; k < p.count; k++) {
      const g = p.base + k;
      if ((spanFlags[g]! & PASSABLE) === 0) continue;
      const col = layer.spanCol[k]!;
      const cx = col % layer.cols;
      const cz = (col - cx) / layer.cols;
      const t = layer.spanY[k]!;
      if (cx + 1 < layer.cols) {
        const e = grid.matchSpan(layer, p.base, col + 1, t);
        if (e >= 0) union(R + g, R + p.base + e);
      }
      if (cz + 1 < layer.rows) {
        const nn = grid.matchSpan(layer, p.base, col + layer.cols, t);
        if (nn >= 0) union(R + g, R + p.base + nn);
      }
    }
  }
  for (let i = 0; i < linkFrom.length; i++) {
    const from = linkFrom[i]!;
    if (from >= T) continue;
    const run = runOfCell(from);
    if (run >= 0 && (spanFlags[linkTo[i]! - T]! & PASSABLE) !== 0) union(run, R + linkTo[i]! - T);
  }
  const area = new Float64Array(R + buildingNodes);
  for (let r = 0; r < R; r++) area[find(r)]! += (runX1[r]! - runX0[r]! + 1) * cs * cs;
  for (let g = 0; g < buildingNodes; g++) if ((spanFlags[g]! & PASSABLE) !== 0) area[find(R + g)]! += bcs * bcs;
  const compOfRoot = new Int32Array(R + buildingNodes);
  let components = 0;
  let clearedIslands = 0;
  let clearedIslandArea = 0;
  const minIsland = NAV_DEFAULTS.minIslandArea;
  const compArea: number[] = [0];
  const assign = (node: number): number => {
    const root = find(node);
    let id = compOfRoot[root]!;
    if (id === 0) {
      if (area[root]! < minIsland) {
        id = -1;
        clearedIslands++;
        clearedIslandArea += area[root]!;
      } else {
        id = ++components;
        compArea.push(area[root]!);
      }
      compOfRoot[root] = id;
    }
    return id;
  };
  for (let iz = 0; iz < depth; iz++) {
    for (let r = rowStart[iz]!; r < rowStart[iz + 1]!; r++) {
      const id = assign(r);
      const rowBase = iz * width;
      for (let ix = runX0[r]!; ix <= runX1[r]!; ix++) {
        if (id < 0) terrainFlags[rowBase + ix] = terrainFlags[rowBase + ix]! & ~PASSABLE;
        else terrainComp[rowBase + ix] = id;
      }
    }
  }
  for (let g = 0; g < buildingNodes; g++) {
    if ((spanFlags[g]! & PASSABLE) === 0) continue;
    const id = assign(R + g);
    if (id < 0) spanFlags[g] = spanFlags[g]! & ~(PASSABLE | NavFlag.crouchOnly);
    else spanComp[g] = id;
  }
  if (components > 65535) throw new Error(`nav: ${components} components exceed the Uint16 component ids`);
  let mainComponent = 0;
  for (let c = 1; c <= components; c++) if (compArea[c]! > (compArea[mainComponent] ?? 0)) mainComponent = c;
  stage("components");

  // 8. Coarse guide graph: per 4 m cell, 4-connected regions of passable terrain, joined across cell borders. Labels of
  // the current and previous block rows are kept so every block is labelled once.
  const coarseCells = coarseWidth * coarseDepth;
  const coarseRegionStart = new Int32Array(coarseCells + 1);
  const regionRepList: number[] = [];
  const regionCompList: number[] = [];
  const regionFracList: number[] = [];
  const edgeA: number[] = [];
  const edgeB: number[] = [];
  const edgeOpen: number[] = [];
  {
    const per = coarseRatio * coarseRatio;
    let rowLabels = new Int16Array(coarseWidth * per);
    let prevLabels = new Int16Array(coarseWidth * per);
    const stack = new Int32Array(per);
    const counts = new Int32Array(per);
    const bestD = new Float64Array(per);
    const mid = (coarseRatio - 1) / 2;
    const pairKeys: number[] = [];
    const pairCounts: number[] = [];
    const addPair = (a: number, b: number) => {
      for (let i = 0; i < pairCounts.length; i++) {
        if (pairKeys[i * 2] === a && pairKeys[i * 2 + 1] === b) {
          pairCounts[i]!++;
          return;
        }
      }
      pairKeys.push(a, b);
      pairCounts.push(1);
    };
    const flush = () => {
      for (let i = 0; i < pairCounts.length; i++) {
        const open = Math.min(255, Math.round((255 * pairCounts[i]!) / coarseRatio));
        edgeA.push(pairKeys[i * 2]!, pairKeys[i * 2 + 1]!);
        edgeB.push(pairKeys[i * 2 + 1]!, pairKeys[i * 2]!);
        edgeOpen.push(open, open);
      }
      pairKeys.length = 0;
      pairCounts.length = 0;
    };
    for (let cz = 0; cz < coarseDepth; cz++) {
      for (let cx = 0; cx < coarseWidth; cx++) {
        const ci = cz * coarseWidth + cx;
        const base = regionRepList.length;
        coarseRegionStart[ci] = base;
        const labels = rowLabels.subarray(cx * per, (cx + 1) * per);
        const n = labelCoarseBlock(grid, coarseRatio, cx, cz, labels, stack);
        counts.fill(0, 0, n);
        bestD.fill(Infinity, 0, n);
        for (let r = 0; r < n; r++) {
          regionRepList.push(-1);
          regionCompList.push(0);
        }
        for (let li = 0; li < per; li++) {
          const r = labels[li]!;
          if (r < 0) continue;
          const lx = li % coarseRatio;
          const lz = (li - lx) / coarseRatio;
          const cell = (cz * coarseRatio + lz) * width + cx * coarseRatio + lx;
          counts[r]!++;
          const dist = (lx - mid) * (lx - mid) + (lz - mid) * (lz - mid);
          if (dist < bestD[r]!) {
            bestD[r] = dist;
            regionRepList[base + r] = cell;
            regionCompList[base + r] = terrainComp[cell]!;
          }
        }
        for (let r = 0; r < n; r++) regionFracList.push(Math.round((255 * counts[r]!) / per));
        if (cx > 0) {
          const west = rowLabels.subarray((cx - 1) * per, cx * per);
          const wbase = coarseRegionStart[ci - 1]!;
          for (let lz = 0; lz < coarseRatio; lz++) {
            const a = west[lz * coarseRatio + coarseRatio - 1]!;
            const b = labels[lz * coarseRatio]!;
            if (a >= 0 && b >= 0) addPair(wbase + a, base + b);
          }
          flush();
        }
        if (cz > 0) {
          const south = prevLabels.subarray(cx * per, (cx + 1) * per);
          const sbase = coarseRegionStart[ci - coarseWidth]!;
          for (let lx = 0; lx < coarseRatio; lx++) {
            const a = south[(coarseRatio - 1) * coarseRatio + lx]!;
            const b = labels[lx]!;
            if (a >= 0 && b >= 0) addPair(sbase + a, base + b);
          }
          flush();
        }
      }
      const t = prevLabels;
      prevLabels = rowLabels;
      rowLabels = t;
    }
    coarseRegionStart[coarseCells] = regionRepList.length;
  }
  const regionCount = regionRepList.length;
  const edgeOrder = Array.from({ length: edgeA.length }, (_, i) => i).sort((x, y) => edgeA[x]! - edgeA[y]! || edgeB[x]! - edgeB[y]!);
  const regionEdgeStart = new Int32Array(regionCount + 1);
  const regionEdgeTo = new Int32Array(edgeA.length);
  const regionEdgeOpen = new Uint8Array(edgeA.length);
  edgeOrder.forEach((e, i) => {
    regionEdgeTo[i] = edgeB[e]!;
    regionEdgeOpen[i] = edgeOpen[e]!;
    regionEdgeStart[edgeA[e]! + 1]!++;
  });
  for (let r = 0; r < regionCount; r++) regionEdgeStart[r + 1]! += regionEdgeStart[r]!;
  const coarseArrays = {
    coarseRegionStart,
    regionRep: new Int32Array(regionRepList),
    regionComp: new Uint16Array(regionCompList),
    regionFrac: new Uint8Array(regionFracList),
    regionEdgeStart,
    regionEdgeTo,
    regionEdgeOpen,
  };
  stage("coarse");

  const arrays: NavGridArrays = { terrainFlags, terrainComp, heights, spanFlags, spanComp, spanPlacement, linkFrom, linkTo, linkCost, linkBits, ...coarseArrays };
  const finalLayout: NavGridLayout = { ...layoutInfo, mainComponent };
  const info = finishInfo(draftInfo, finalLayout, arrays, layers, placements, components);
  let terrainWalkable = 0;
  for (let i = 0; i < T; i++) if ((terrainFlags[i]! & PASSABLE) !== 0) terrainWalkable++;
  let buildingWalkable = 0;
  for (let g = 0; g < buildingNodes; g++) if ((spanFlags[g]! & PASSABLE) !== 0) buildingWalkable++;
  stage("checksum");
  const stats: NavBuildStats = {
    buildMs: Math.round((performance.now() - started) * 10) / 10,
    stageMs,
    terrainWalkable,
    terrainSlopeBlocked: slopeBlocked,
    terrainPropBlocked: propBlocked,
    terrainBuildingBlocked: buildingBlocked,
    prefabSpans,
    buildingSpans: buildingNodes,
    buildingWalkable,
    overflowColumns,
    links: linkCount,
    clearedIslands,
    clearedIslandArea: Math.round(clearedIslandArea * 100) / 100,
    mainComponent,
    mainComponentArea: compArea[mainComponent] ?? 0,
  };
  return new NavGridData(info, finalLayout, arrays, layers, placements, stats);
}

/** Byte length and checksum over every array plus the layout and placement tables. */
export function finishInfo(
  draft: Omit<NavGridInfo, "components" | "byteLength" | "checksum">,
  layout: NavGridLayout,
  arrays: NavGridArrays,
  layers: readonly NavPrefabLayer[],
  placements: readonly NavPlacement[],
  components: number,
): NavGridInfo {
  const views: ArrayBufferView[] = [...Object.values(arrays)];
  for (const l of layers) views.push(l.colStart, l.spanY, l.spanCol, l.spanFlags);
  let byteLength = 0;
  for (const v of views) byteLength += v.byteLength;
  const meta = JSON.stringify({ layout, layers: layers.map((l) => [l.prefab, l.minX, l.minZ, l.cols, l.rows, l.minY, l.maxY]), placements: placements.map((p) => [p.id, p.layer, p.x, p.y, p.z, p.yaw, p.base, p.count]) });
  const parts = [checksumBytes(new TextEncoder().encode(meta)), ...views.map((v) => checksumBytes(v))];
  const checksum = checksumBytes(new TextEncoder().encode(parts.join("|")));
  return { version: draft.version, cellSize: draft.cellSize, buildingCellSize: draft.buildingCellSize, coarseCellSize: draft.coarseCellSize, originX: draft.originX, originZ: draft.originZ, width: draft.width, depth: draft.depth, terrainNodes: draft.terrainNodes, buildingNodes: draft.buildingNodes, components, byteLength, checksum };
}
