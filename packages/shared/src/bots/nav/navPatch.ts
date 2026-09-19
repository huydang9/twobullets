import { WallKind, type DestructibleWalls } from "../../equipment/destructible";
import { propColliderGroups, COLLIDER_STRIDE } from "../../map/layout/collision";
import type { MapLayout } from "../../map/layout/mapLayout";
import { getMapProp } from "../../map/layout/props";
import { INSTANCE_STRIDE } from "../../map/layout/scatter";
import { sinCos } from "../../map/terrain/math";
import { NavFlag } from "../types";
import { NAV_DEFAULTS } from "./buildNavGrid";
import { PASSABLE, STAND_CLEARANCE, type NavGridData } from "./navGrid";

/**
 * Runtime patches to a built nav grid, for the walls a throwable takes out of the maze
 * (`equipment/destructible.ts`).
 *
 * `buildNavGrid` runs once, at match start, and knows nothing about a corridor that opens ten minutes in. A rebuild
 * is out of the question (seconds, and every bot's path invalid at once), so this re-runs the build's own per-cell
 * tests over the handful of 0.5 m cells one 4 m × 0.3 m pane covers — about thirty of them — and stitches the result
 * into the grid in place:
 *
 * - **A destroyed pane opens its cells.** A cell is opened only if the terrain slope allows it *and* nothing else
 *   stands there: every other live prop collider and every building is re-tested, so two panes crossing at a corner
 *   need both destroyed before the corner opens.
 * - **No new islands.** Cells are opened outward from ones that are already walkable, and a cell with no walkable
 *   4-neighbour is left shut. Opening can only ever add area onto existing area, which is what keeps
 *   `clearedIslands === 0` meaning what it meant at build time.
 * - **Components merge, they never split.** The opened cells take a neighbour's component; if the two sides of the
 *   pane were different components the smaller id wins and the other is relabelled across the grid — one pass over
 *   `terrainComp`, and only on the rare destruction that actually joins two halves of the map.
 * - **A burnt hedge loses its `vegetation` cells**, so a player cannot hide in a hedge that is not there. Nothing
 *   about walking changes: a hedge never had a collider.
 *
 * What it does **not** patch is the coarse 4 m guide graph (`coarseRegion*`, `regionEdge*`), whose CSR arrays cannot
 * take a new region or edge without a rebuild. A stale coarse graph is conservative, never wrong: it still describes
 * the map as it was, so a route longer than `NAV_QUERY_LIMITS.directMeters` (110 m) takes the old way round rather
 * than the new gap. On the maze — 184 m across — nearly every route is inside that radius and searched fine-grained
 * from the first tick after the blast.
 */
export interface NavPatchStats {
  /** Terrain cells made walkable. */
  readonly opened: number;
  /** Cells inside a destroyed pane that stayed shut (another wall, a building, a slope, or nothing to attach to). */
  readonly kept: number;
  /** Cells that lost `NavFlag.vegetation`. */
  readonly bared: number;
  /** Destructions that joined two connected components (a full relabel pass). */
  readonly merges: number;
}

/** One static collider instance, flattened for the overlap re-test. */
interface Colliders {
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly yaw: Float64Array;
  /** Box half extents inflated by the agent radius; a cylinder carries its inflated radius in both. */
  readonly halfX: Float64Array;
  readonly halfZ: Float64Array;
  readonly bottom: Float64Array;
  readonly top: Float64Array;
  readonly round: Uint8Array;
  /** Index in `DestructibleWalls`, or -1 for a collider nothing can destroy. */
  readonly wall: Int32Array;
  readonly count: number;
}

/** One bush instance (a hedge included): the circle it flags `vegetation` over. */
interface Bushes {
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly radius: Float64Array;
  readonly wall: Int32Array;
  readonly count: number;
}

export class NavPatcher {
  private readonly counts = { opened: 0, kept: 0, bared: 0, merges: 0 };

  private readonly grid: NavGridData;
  private readonly walls: DestructibleWalls;
  private readonly colliders: Colliders;
  private readonly bushes: Bushes;
  /** Building footprints inflated by the agent radius: minX, minZ, maxX, maxZ. */
  private readonly buildings: Float64Array;
  private readonly agentRadius: number;
  private readonly maxSlopeTan: number;
  /** Candidate cells of the patch being applied, and the scratch marking which of them another collider blocks. */
  private readonly candidates: number[] = [];
  private readonly blocked = new Set<number>();

  constructor(grid: NavGridData, layout: Pick<MapLayout, "props">, walls: DestructibleWalls) {
    this.grid = grid;
    this.walls = walls;
    this.agentRadius = grid.layout.agentRadius;
    // sinCos, not Math.tan: these sources must stay bit-identical across engines (nav.test.ts pins it).
    const slope = sinCos((NAV_DEFAULTS.maxSlopeDegrees * Math.PI) / 180);
    this.maxSlopeTan = slope.sin / slope.cos;

    // The same shapes buildNavGrid blocked cells with, keyed back to the wall registry so a destroyed one stops
    // counting. Built once: a destruction must not walk the layout again.
    const byInstance = new Map<string, number>();
    for (let w = 0; w < walls.count; w++) byInstance.set(`${walls.set[w]}/${walls.instance[w]}`, w);
    const setIndexOf = new Map<string, number>();
    layout.props.forEach((set, i) => setIndexOf.set(set.prop, i));

    let total = 0;
    const groups = propColliderGroups(layout);
    for (const group of groups) total += group.transforms.length / COLLIDER_STRIDE;
    const c: Colliders = {
      x: new Float64Array(total),
      z: new Float64Array(total),
      yaw: new Float64Array(total),
      halfX: new Float64Array(total),
      halfZ: new Float64Array(total),
      bottom: new Float64Array(total),
      top: new Float64Array(total),
      round: new Uint8Array(total),
      wall: new Int32Array(total).fill(-1),
      count: total,
    };
    let k = 0;
    for (const group of groups) {
      const shape = group.shape;
      const setIndex = setIndexOf.get(group.prop) ?? -1;
      const count = group.transforms.length / COLLIDER_STRIDE;
      for (let i = 0; i < count; i++) {
        const t = i * COLLIDER_STRIDE;
        const py = group.transforms[t + 1]!;
        c.x[k] = group.transforms[t]!;
        c.z[k] = group.transforms[t + 2]!;
        c.yaw[k] = group.transforms[t + 3]!;
        if (shape.kind === "cylinder") {
          c.round[k] = 1;
          c.halfX[k] = shape.radius + this.agentRadius;
          c.halfZ[k] = shape.radius + this.agentRadius;
          c.bottom[k] = py;
          c.top[k] = py + shape.height;
        } else {
          c.halfX[k] = shape.size[0] / 2 + this.agentRadius;
          c.halfZ[k] = shape.size[2] / 2 + this.agentRadius;
          c.bottom[k] = py + shape.centerY - shape.size[1] / 2;
          c.top[k] = py + shape.centerY + shape.size[1] / 2;
        }
        c.wall[k] = byInstance.get(`${setIndex}/${group.instances[i]}`) ?? -1;
        k++;
      }
    }
    this.colliders = c;

    let bushCount = 0;
    for (const set of layout.props) if (getMapProp(set.prop).category === "bush") bushCount += set.data.length / INSTANCE_STRIDE;
    const b: Bushes = {
      x: new Float64Array(bushCount),
      z: new Float64Array(bushCount),
      radius: new Float64Array(bushCount),
      wall: new Int32Array(bushCount).fill(-1),
      count: bushCount,
    };
    let n = 0;
    layout.props.forEach((set, s) => {
      const def = getMapProp(set.prop);
      if (def.category !== "bush") return;
      for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
        b.x[n] = set.data[i]!;
        b.z[n] = set.data[i + 2]!;
        b.radius[n] = def.footprint * set.data[i + 4]!;
        b.wall[n] = byInstance.get(`${s}/${i / INSTANCE_STRIDE}`) ?? -1;
        n++;
      }
    });
    this.bushes = b;

    this.buildings = new Float64Array(grid.placements.length * 4);
    grid.placements.forEach((placement, i) => {
      this.buildings[i * 4] = placement.minX - this.agentRadius;
      this.buildings[i * 4 + 1] = placement.minZ - this.agentRadius;
      this.buildings[i * 4 + 2] = placement.maxX + this.agentRadius;
      this.buildings[i * 4 + 3] = placement.maxZ + this.agentRadius;
    });
  }

  /** Cells opened, cells kept shut, cells bared of vegetation, and component merges so far. */
  get stats(): NavPatchStats {
    return this.counts;
  }

  /**
   * Applies the patch a destroyed wall calls for: a pane opens the cells it stood on, a hedge takes its concealment
   * with it. Safe to call twice for the same wall (the second call finds nothing to do). Returns the cells changed.
   */
  destroyed(index: number): number {
    if (index < 0 || index >= this.walls.count) return 0;
    return this.walls.kind[index] === WallKind.pane ? this.openPane(index) : this.bareHedge(index);
  }

  // ---- Panes -------------------------------------------------------------------------------------------------------

  /** Re-runs buildNavGrid's per-cell tests over the pane's footprint, then opens outward from walkable ground. */
  private openPane(index: number): number {
    const grid = this.grid;
    const cs = grid.cellSize;
    const walls = this.walls;
    const hx = walls.halfX[index]! + this.agentRadius;
    const hz = walls.halfZ[index]! + this.agentRadius;
    const px = walls.x[index]!;
    const pz = walls.z[index]!;
    const reach = Math.sqrt(hx * hx + hz * hz);
    const { sin, cos } = sinCos(walls.yaw[index]!);

    const candidates = this.candidates;
    candidates.length = 0;
    const ix0 = Math.max(0, Math.floor((px - reach - grid.originX) / cs));
    const ix1 = Math.min(grid.width - 1, Math.floor((px + reach - grid.originX) / cs));
    const iz0 = Math.max(0, Math.floor((pz - reach - grid.originZ) / cs));
    const iz1 = Math.min(grid.depth - 1, Math.floor((pz + reach - grid.originZ) / cs));
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = grid.originZ + (iz + 0.5) * cs;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = grid.originX + (ix + 0.5) * cs;
        const dx = x - px;
        const dz = z - pz;
        if (Math.abs(dx * cos - dz * sin) > hx || Math.abs(dx * sin + dz * cos) > hz) continue;
        const cell = iz * grid.width + ix;
        if ((grid.terrainFlags[cell]! & PASSABLE) !== 0) continue;
        if (!this.slopeWalkable(ix, iz)) continue;
        if (this.insideBuilding(x, z)) continue;
        candidates.push(cell);
      }
    }
    if (candidates.length === 0) return 0;

    // Anything else still standing on a candidate keeps it shut: two panes crossing at a corner need both gone.
    this.markBlocked(px, pz, reach + cs, index);
    let kept = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (!this.blocked.has(candidates[i]!)) continue;
      candidates[i] = candidates[candidates.length - 1]!;
      candidates.pop();
      kept++;
    }

    // Open outward from ground that is already walkable, so a cell can never become an island of its own.
    let opened = 0;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = candidates.length - 1; i >= 0; i--) {
        const cell = candidates[i]!;
        const component = this.attachComponent(cell);
        if (component === 0) continue;
        grid.terrainFlags[cell] = (grid.terrainFlags[cell]! | NavFlag.walkable) & ~NavFlag.crouchOnly;
        grid.terrainComp[cell] = component;
        candidates[i] = candidates[candidates.length - 1]!;
        candidates.pop();
        opened++;
        progressed = true;
      }
    }
    kept += candidates.length;
    this.counts.opened += opened;
    this.counts.kept += kept;
    // A cover hint, not a gate: the new cells sit in a gap between walls, so they are all next to one.
    for (const cell of this.openedCells(ix0, ix1, iz0, iz1)) grid.terrainFlags[cell] = grid.terrainFlags[cell]! | NavFlag.nearObstacle;
    return opened;
  }

  /**
   * Component the cell should join: the smallest id among its walkable 4-neighbours, 0 when it has none. Neighbours in
   * a different component are relabelled into it, which is the only way a patch can change the rest of the grid.
   */
  private attachComponent(cell: number): number {
    const grid = this.grid;
    const w = grid.width;
    const ix = cell % w;
    const iz = (cell - ix) / w;
    let best = 0;
    const neighbours = [ix + 1 < w ? cell + 1 : -1, ix > 0 ? cell - 1 : -1, iz + 1 < grid.depth ? cell + w : -1, iz > 0 ? cell - w : -1];
    for (const n of neighbours) {
      if (n < 0 || (grid.terrainFlags[n]! & PASSABLE) === 0) continue;
      const component = grid.terrainComp[n]!;
      if (component === 0) continue;
      if (best === 0 || component < best) best = component;
    }
    if (best === 0) return 0;
    for (const n of neighbours) {
      if (n < 0 || (grid.terrainFlags[n]! & PASSABLE) === 0) continue;
      const component = grid.terrainComp[n]!;
      if (component !== 0 && component !== best) this.mergeComponents(component, best);
    }
    return best;
  }

  /** Relabels every node of `from` into `to`. One pass over the grid, only when a gap actually joins two halves. */
  private mergeComponents(from: number, to: number): void {
    const { terrainComp, spanComp } = this.grid;
    for (let i = 0; i < terrainComp.length; i++) if (terrainComp[i] === from) terrainComp[i] = to;
    for (let i = 0; i < spanComp.length; i++) if (spanComp[i] === from) spanComp[i] = to;
    const regionComp = this.grid.arrays.regionComp;
    for (let i = 0; i < regionComp.length; i++) if (regionComp[i] === from) regionComp[i] = to;
    this.counts.merges++;
  }

  /** Marks every cell within `radius` of (x, z) that a live collider other than `skip` blocks. */
  private markBlocked(x: number, z: number, radius: number, skip: number): void {
    const grid = this.grid;
    const cs = grid.cellSize;
    const c = this.colliders;
    this.blocked.clear();
    for (let i = 0; i < c.count; i++) {
      const wall = c.wall[i]!;
      if (wall === skip) continue;
      if (wall >= 0 && this.walls.destroyed[wall] === 1) continue;
      const cx = c.x[i]!;
      const cz = c.z[i]!;
      const span = Math.sqrt(c.halfX[i]! * c.halfX[i]! + c.halfZ[i]! * c.halfZ[i]!);
      if (Math.abs(cx - x) > radius + span || Math.abs(cz - z) > radius + span) continue;
      const { sin, cos } = sinCos(c.yaw[i]!);
      const ix0 = Math.max(0, Math.floor((cx - span - grid.originX) / cs));
      const ix1 = Math.min(grid.width - 1, Math.floor((cx + span - grid.originX) / cs));
      const iz0 = Math.max(0, Math.floor((cz - span - grid.originZ) / cs));
      const iz1 = Math.min(grid.depth - 1, Math.floor((cz + span - grid.originZ) / cs));
      for (let iz = iz0; iz <= iz1; iz++) {
        const wz = grid.originZ + (iz + 0.5) * cs;
        for (let ix = ix0; ix <= ix1; ix++) {
          const wx = grid.originX + (ix + 0.5) * cs;
          const dx = wx - cx;
          const dz = wz - cz;
          if (c.round[i] === 1) {
            if (dx * dx + dz * dz > c.halfX[i]! * c.halfX[i]!) continue;
          } else if (Math.abs(dx * cos - dz * sin) > c.halfX[i]! || Math.abs(dx * sin + dz * cos) > c.halfZ[i]!) continue;
          const h = grid.terrainHeight(wx, wz);
          if (c.top[i]! <= h + NAV_DEFAULTS.propStepHeight || c.bottom[i]! >= h + STAND_CLEARANCE) continue;
          this.blocked.add(iz * grid.width + ix);
        }
      }
    }
  }

  /** Cells of the window that are walkable right now (the `nearObstacle` touch-up after a patch). */
  private *openedCells(ix0: number, ix1: number, iz0: number, iz1: number): Generator<number> {
    const grid = this.grid;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const cell = iz * grid.width + ix;
        if ((grid.terrainFlags[cell]! & PASSABLE) !== 0) yield cell;
      }
    }
  }

  /**
   * The build's slope test for one cell, as `buildNavGrid` step 1 runs it: central differences over neighbouring cell
   * centre heights, clamped at the border. `navPatch.test.ts` pins it against a freshly built grid.
   */
  private slopeWalkable(ix: number, iz: number): boolean {
    return navSlopeWalkable(this.grid, ix, iz, this.maxSlopeTan);
  }

  private insideBuilding(x: number, z: number): boolean {
    const b = this.buildings;
    for (let i = 0; i < b.length; i += 4) {
      if (x >= b[i]! && x <= b[i + 2]! && z >= b[i + 1]! && z <= b[i + 3]!) return true;
    }
    return false;
  }

  // ---- Hedges ------------------------------------------------------------------------------------------------------

  /** A burnt hedge: its cells lose `NavFlag.vegetation` unless another hedge or bush still stands on them. */
  private bareHedge(index: number): number {
    const grid = this.grid;
    const cs = grid.cellSize;
    const px = this.walls.x[index]!;
    const pz = this.walls.z[index]!;
    const r = this.walls.halfX[index]!;
    const ix0 = Math.max(0, Math.floor((px - r - grid.originX) / cs));
    const ix1 = Math.min(grid.width - 1, Math.floor((px + r - grid.originX) / cs));
    const iz0 = Math.max(0, Math.floor((pz - r - grid.originZ) / cs));
    const iz1 = Math.min(grid.depth - 1, Math.floor((pz + r - grid.originZ) / cs));
    let bared = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = grid.originZ + (iz + 0.5) * cs;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = grid.originX + (ix + 0.5) * cs;
        const dx = x - px;
        const dz = z - pz;
        if (dx * dx + dz * dz > r * r) continue;
        const cell = iz * grid.width + ix;
        if ((grid.terrainFlags[cell]! & NavFlag.vegetation) === 0) continue;
        if (this.stillVegetated(x, z, index)) continue;
        grid.terrainFlags[cell] = grid.terrainFlags[cell]! & ~NavFlag.vegetation;
        bared++;
      }
    }
    this.counts.bared += bared;
    return bared;
  }

  private stillVegetated(x: number, z: number, skip: number): boolean {
    const b = this.bushes;
    for (let i = 0; i < b.count; i++) {
      const wall = b.wall[i]!;
      if (wall === skip) continue;
      if (wall >= 0 && this.walls.destroyed[wall] === 1) continue;
      const dx = x - b.x[i]!;
      const dz = z - b.z[i]!;
      if (dx * dx + dz * dz <= b.radius[i]! * b.radius[i]!) return true;
    }
    return false;
  }
}

/**
 * `buildNavGrid` step 1's slope test for one cell: central differences over neighbouring cell-centre heights, with
 * the gradient one-sided at the grid border. The build bakes its answer into `terrainFlags` and then covers it with
 * props, so a cell being opened again has to ask afresh — `navPatch.test.ts` pins this against a freshly built grid,
 * which is what keeps the duplication honest.
 */
export function navSlopeWalkable(grid: NavGridData, ix: number, iz: number, maxSlopeTan: number): boolean {
  const cs = grid.cellSize;
  const cx = (i: number) => grid.originX + (i + 0.5) * cs;
  const cz = (j: number) => grid.originZ + (Math.min(grid.depth - 1, Math.max(0, j)) + 0.5) * cs;
  const dx = (ix === 0 || ix === grid.width - 1 ? 1 : 2) * cs;
  const dz = (iz === 0 || iz === grid.depth - 1 ? 1 : 2) * cs;
  const z = cz(iz);
  const gx = (grid.terrainHeight(cx(ix + 1 < grid.width ? ix + 1 : ix), z) - grid.terrainHeight(cx(ix > 0 ? ix - 1 : ix), z)) / dx;
  const gz = (grid.terrainHeight(cx(ix), cz(iz + 1)) - grid.terrainHeight(cx(ix), cz(iz - 1))) / dz;
  return gx * gx + gz * gz <= maxSlopeTan * maxSlopeTan;
}
