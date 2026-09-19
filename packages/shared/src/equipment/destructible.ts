import type { MapLayout } from "../map/layout/mapLayout";
import { getMapProp } from "../map/layout/props";
import { INSTANCE_STRIDE } from "../map/layout/scatter";
import { sinCos } from "../map/terrain/math";
import { FIRE, FIRE_CELL_STRIDE, isCellBurning, type FirePatch } from "./fire";
import { smokeDensity, smokeRadius, type SmokeCloud } from "./smoke";

/**
 * Walls a throwable can take out of the maze (`map/mazeBr.ts`), and the rules that decide when.
 *
 * Three mechanics, one registry:
 *
 * - **A frag destroys a mirror pane.** Not a hole — the pane is gone, visual and collider, and the maze has a corridor
 *   it did not have. This is the one piece of map geometry a player can change.
 * - **Smoke repairs a shot-up mirror.** A cloud sitting on a pane that is still standing closes the apertures rounds
 *   punched through it (`world/props/MirrorWalls.ts`). It never brings a destroyed pane back: a wall re-closing under
 *   a bot already walking through it is a nav problem with no good answer, and a route you opened staying open is the
 *   better game.
 * - **A molotov burns a grass hedge away.** The hedge has no collider, so nothing about walking changes; what goes is
 *   the concealment it gave (`NavFlag.vegetation`), which is the whole reason to stand in one.
 *
 * Everything here is pure and tick-timed. Which pane a blast takes is a function of the blast point and the pane's
 * placement — no raycast, no RNG, no wall clock — so the headless server and every client reach the same answer from
 * the same tick. Coverage (smoke, fire) is counted in **ticks**, not accumulated seconds, so there is no float drift
 * between two runs of the same match.
 */
export const WALL_DAMAGE = {
  /**
   * A frag destroys a mirror pane whose box comes within this of the blast, m. The blast's full-damage radius is 2 m
   * (`EXPLOSION.frag.innerRadius`) and the maze's narrow lane is 2 m, so this takes the pane you bounced the grenade
   * off and the one across a narrow lane, and nothing a corner away.
   */
  fragRadius: 3,
  /** Seconds a cloud has to sit on a holed pane before its apertures close. Long enough to read as healing. */
  repairSeconds: 5,
  /** Seconds of fire on a hedge before it is gone. */
  burnSeconds: 2.5,
  /**
   * A cloud repairs a pane whose centre is inside `smokeRadius(age) + this`, m, while the cloud is over half density.
   * Half a pane width, so a cloud thrown against a wall heals the pane it is touching.
   */
  smokeReach: 2,
  /** Cloud base to pane base height difference that still counts as "the smoke is on this pane", m. */
  smokeHeight: 3,
  /** A burning fire cell within this of a hedge's footprint circle burns it, m. */
  fireReach: 0.5,
} as const;

/** The mirrored panes, in both lengths. A round goes through one and leaves a see-through aperture; a frag ends it. */
export const MIRROR_WALL_PROPS: readonly string[] = ["wall_mirror", "wall_mirror_2"];
/** The grass hedges, in both lengths: no collider, `NavFlag.vegetation` concealment, and they burn. */
export const HEDGE_WALL_PROPS: readonly string[] = ["wall_grass", "wall_grass_2"];

export function isMirrorWallProp(prop: string): boolean {
  return MIRROR_WALL_PROPS.includes(prop);
}

export function isHedgeWallProp(prop: string): boolean {
  return HEDGE_WALL_PROPS.includes(prop);
}

/** Pane (a mirrored wall with a collider) or hedge (a grass wall without one). */
export const WallKind = { pane: 0, hedge: 1 } as const;
export type WallKind = (typeof WallKind)[keyof typeof WallKind];

/** What happened to a wall. `destroyed` is permanent; `repaired` only ever clears a standing pane's holes. */
export const WallChange = { destroyed: 0, repaired: 1 } as const;
export type WallChange = (typeof WallChange)[keyof typeof WallChange];

/**
 * Every destructible wall on a map, flattened. Built once at match start from the layout, in layout order, so two
 * machines number the walls the same way and an index is all a future protocol message has to carry.
 */
export class DestructibleWalls {
  readonly count: number;
  /** Index into `layout.props` and instance index inside that set: how a host finds its own collider and visual. */
  readonly set: Int32Array;
  readonly instance: Int32Array;
  readonly kind: Uint8Array;
  /** Instance origin (its base on the ground) and yaw. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly yaw: Float64Array;
  /** Half extents of the footprint at this instance's scale, m: panes are boxes, hedges circles (halfX = halfZ = r). */
  readonly halfX: Float64Array;
  readonly halfZ: Float64Array;
  readonly height: Float64Array;
  /** 1 once the wall is gone. Never goes back to 0. */
  readonly destroyed: Uint8Array;
  /** Rounds that punched through this pane and have not been healed. The client's hole mask mirrors this count. */
  readonly holes: Uint16Array;
  /** Ticks of smoke (panes) or fire (hedges) counted so far; reset when the effect leaves or lands. */
  readonly ticks: Uint16Array;
  /** Standing panes with at least one aperture. A renderer polling for a heal can skip the scan while this is 0. */
  holedCount = 0;
  /**
   * Changes recorded since the match started, counted and never reset. Several parties watch the walls — the match
   * (colliders and nav), the renderer (meshes and hole masks), a future net layer — and none of them may consume the
   * others' notice, so this is an append log with a cursor each rather than a queue somebody drains. "Nothing
   * happened" is one compare, and a cursor that has fallen more than `logCapacity` behind resyncs off `destroyed`
   * and `holes` instead.
   */
  logged = 0;
  readonly logCapacity: number;

  /** Ring of `index * 2 + change`, holding the last `logCapacity` entries. */
  private readonly log: Int32Array;

  constructor(count: number) {
    this.count = count;
    this.set = new Int32Array(count);
    this.instance = new Int32Array(count);
    this.kind = new Uint8Array(count);
    this.x = new Float64Array(count);
    this.y = new Float64Array(count);
    this.z = new Float64Array(count);
    this.yaw = new Float64Array(count);
    this.halfX = new Float64Array(count);
    this.halfZ = new Float64Array(count);
    this.height = new Float64Array(count);
    this.destroyed = new Uint8Array(count);
    this.holes = new Uint16Array(count);
    this.ticks = new Uint16Array(count);
    this.logCapacity = Math.max(64, count * 2);
    this.log = new Int32Array(this.logCapacity);
  }

  /** A round punched through pane `index`. Only ever a count: smoke reads it, nothing else does. */
  addHole(index: number): void {
    if (index < 0 || index >= this.count || this.destroyed[index] === 1) return;
    if (this.holes[index] === 0) this.holedCount++;
    if (this.holes[index]! < 0xffff) this.holes[index] = this.holes[index]! + 1;
    this.ticks[index] = 0;
  }

  /** The change at `sequence` (`index * 2 + WallChange`), or -1 once the log has moved past it. */
  changeAt(sequence: number): number {
    if (sequence < 0 || sequence >= this.logged || this.logged - sequence > this.logCapacity) return -1;
    return this.log[sequence % this.logCapacity]!;
  }

  /** Index of the wall a prop instance is, or -1. */
  indexOf(setIndex: number, instance: number): number {
    for (let i = 0; i < this.count; i++) if (this.set[i] === setIndex && this.instance[i] === instance) return i;
    return -1;
  }

  /** @internal Appends a change to the log. */
  push(index: number, change: WallChange): void {
    this.log[this.logged % this.logCapacity] = index * 2 + change;
    this.logged++;
  }
}

/** Every mirrored pane and grass hedge on a map, in layout order. Pure: same layout in, same registry out. */
export function buildDestructibleWalls(layout: Pick<MapLayout, "props">): DestructibleWalls {
  let count = 0;
  for (const set of layout.props) {
    if (!isMirrorWallProp(set.prop) && !isHedgeWallProp(set.prop)) continue;
    count += set.data.length / INSTANCE_STRIDE;
  }
  const walls = new DestructibleWalls(count);
  let w = 0;
  for (let s = 0; s < layout.props.length; s++) {
    const set = layout.props[s]!;
    const pane = isMirrorWallProp(set.prop);
    if (!pane && !isHedgeWallProp(set.prop)) continue;
    const def = getMapProp(set.prop);
    const box = def.collision.kind === "box" ? def.collision : null;
    for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
      const scale = set.data[i + 4]!;
      walls.set[w] = s;
      walls.instance[w] = i / INSTANCE_STRIDE;
      walls.kind[w] = pane ? WallKind.pane : WallKind.hedge;
      walls.x[w] = set.data[i]!;
      walls.y[w] = set.data[i + 1]!;
      walls.z[w] = set.data[i + 2]!;
      walls.yaw[w] = set.data[i + 3]!;
      // A pane is its collider box; a hedge has none, so it is the circle its concealment already uses (buildNavGrid
      // step 3 flags `vegetation` over `footprint × scale`), which is exactly what burning has to take back.
      walls.halfX[w] = (box ? box.size[0] / 2 : def.footprint) * scale;
      walls.halfZ[w] = (box ? box.size[2] / 2 : def.footprint) * scale;
      walls.height[w] = (box ? box.size[1] : 2) * scale;
      w++;
    }
  }
  return walls;
}

/**
 * The standing pane a point lies on, or -1: what a round that just crossed a mirrored wall punched through. The
 * point is a surface hit, so it sits on the pane's face rather than its centre plane — `slack` is how far off the
 * plane still counts (the pane is 0.3 m thick).
 */
export function wallAtPoint(walls: DestructibleWalls, x: number, y: number, z: number, slack = 0.25): number {
  for (let i = 0; i < walls.count; i++) {
    if (walls.kind[i] !== WallKind.pane || walls.destroyed[i] === 1) continue;
    const base = walls.y[i]!;
    if (y < base - slack || y > base + walls.height[i]! + slack) continue;
    if (rectDistance(x - walls.x[i]!, z - walls.z[i]!, walls.yaw[i]!, walls.halfX[i]!, walls.halfZ[i]! + slack) > 0) continue;
    return i;
  }
  return -1;
}

/**
 * A frag went off at (x, y, z): destroys every standing pane within `fragRadius` of its box. Deterministic — closest
 * point on the pane's footprint rectangle to the blast, no raycast, walls visited in index order. Returns how many
 * went down.
 *
 * No line-of-sight test, on purpose: a grenade in a corridor takes that corridor's walls, and a pane round a corner is
 * out of range anyway. A raycast here would make destruction depend on which phase group the glass in between happened
 * to be in, which is a coin flip nobody can read.
 */
export function fragDestroysWalls(walls: DestructibleWalls, x: number, y: number, z: number): number {
  const reach = WALL_DAMAGE.fragRadius;
  let destroyed = 0;
  for (let i = 0; i < walls.count; i++) {
    if (walls.kind[i] !== WallKind.pane || walls.destroyed[i] === 1) continue;
    // Vertically: the blast has to be inside the pane's height band, widened by the reach.
    const base = walls.y[i]!;
    const top = base + walls.height[i]!;
    const dy = y < base ? base - y : y > top ? y - top : 0;
    if (dy > reach) continue;
    const d = rectDistance(x - walls.x[i]!, z - walls.z[i]!, walls.yaw[i]!, walls.halfX[i]!, walls.halfZ[i]!);
    if (d * d + dy * dy > reach * reach) continue;
    walls.destroyed[i] = 1;
    if (walls.holes[i]! > 0) walls.holedCount--;
    walls.holes[i] = 0;
    walls.ticks[i] = 0;
    walls.push(i, WallChange.destroyed);
    destroyed++;
  }
  return destroyed;
}

/**
 * One tick of smoke sitting on the panes: a standing, holed pane covered by a cloud over half density counts a tick,
 * and at `repairSeconds` worth of them its apertures close. A pane that loses its cloud loses its progress, so a
 * cloud drifting past does not slowly heal the map behind it.
 */
export function smokeRepairsWalls(walls: DestructibleWalls, clouds: readonly SmokeCloud[], dt: number): number {
  if (walls.holedCount === 0) return 0;
  if (clouds.length === 0) {
    clearTicks(walls, WallKind.pane);
    return 0;
  }
  const need = repairTicks(dt);
  let healed = 0;
  for (let i = 0; i < walls.count; i++) {
    if (walls.kind[i] !== WallKind.pane || walls.destroyed[i] === 1 || walls.holes[i] === 0) continue;
    if (!coveredBySmoke(walls, i, clouds)) {
      walls.ticks[i] = 0;
      continue;
    }
    const t = walls.ticks[i]! + 1;
    if (t < need) {
      walls.ticks[i] = t;
      continue;
    }
    walls.ticks[i] = 0;
    walls.holes[i] = 0;
    walls.holedCount--;
    walls.push(i, WallChange.repaired);
    healed++;
  }
  return healed;
}

/**
 * One tick of fire on the hedges: a hedge with a burning cell on it counts a tick, and at `burnSeconds` worth it is
 * gone, with the concealment it gave. Unlike a pane, nothing about walking changes: a hedge never had a collider.
 */
export function fireBurnsWalls(walls: DestructibleWalls, patches: readonly FirePatch[], dt: number): number {
  if (patches.length === 0) {
    clearTicks(walls, WallKind.hedge);
    return 0;
  }
  const need = burnTicks(dt);
  let burnt = 0;
  for (let i = 0; i < walls.count; i++) {
    if (walls.kind[i] !== WallKind.hedge || walls.destroyed[i] === 1) continue;
    if (!onFire(walls, i, patches)) {
      walls.ticks[i] = 0;
      continue;
    }
    const t = walls.ticks[i]! + 1;
    if (t < need) {
      walls.ticks[i] = t;
      continue;
    }
    walls.ticks[i] = 0;
    walls.destroyed[i] = 1;
    walls.push(i, WallChange.destroyed);
    burnt++;
  }
  return burnt;
}

/** 0..1 of the way through healing pane `index`, for the client to shrink its holes by. 0 when it isn't healing. */
export function wallRepairProgress(walls: DestructibleWalls, index: number, dt: number): number {
  if (index < 0 || index >= walls.count || walls.kind[index] !== WallKind.pane) return 0;
  return Math.min(1, walls.ticks[index]! / repairTicks(dt));
}

/** 0..1 of the way through burning hedge `index` away, for the client to wither it by. */
export function wallBurnProgress(walls: DestructibleWalls, index: number, dt: number): number {
  if (index < 0 || index >= walls.count || walls.kind[index] !== WallKind.hedge) return 0;
  return Math.min(1, walls.ticks[index]! / burnTicks(dt));
}

function repairTicks(dt: number): number {
  return Math.max(1, Math.round(WALL_DAMAGE.repairSeconds / dt));
}

function burnTicks(dt: number): number {
  return Math.max(1, Math.round(WALL_DAMAGE.burnSeconds / dt));
}

function clearTicks(walls: DestructibleWalls, kind: WallKind): void {
  for (let i = 0; i < walls.count; i++) if (walls.kind[i] === kind && walls.ticks[i] !== 0) walls.ticks[i] = 0;
}

function coveredBySmoke(walls: DestructibleWalls, i: number, clouds: readonly SmokeCloud[]): boolean {
  const x = walls.x[i]!;
  const z = walls.z[i]!;
  const y = walls.y[i]!;
  for (const cloud of clouds) {
    if (smokeDensity(cloud.age) <= 0.5) continue;
    if (Math.abs(cloud.base.y - y) > WALL_DAMAGE.smokeHeight) continue;
    const radius = smokeRadius(cloud.age) + WALL_DAMAGE.smokeReach;
    const dx = cloud.base.x + cloud.driftX * cloud.age - x;
    const dz = cloud.base.z + cloud.driftZ * cloud.age - z;
    if (dx * dx + dz * dz <= radius * radius) return true;
  }
  return false;
}

function onFire(walls: DestructibleWalls, i: number, patches: readonly FirePatch[]): boolean {
  const x = walls.x[i]!;
  const z = walls.z[i]!;
  const y = walls.y[i]!;
  const reach = walls.halfX[i]! + WALL_DAMAGE.fireReach;
  const reachSq = reach * reach;
  for (const patch of patches) {
    for (let k = 0; k < patch.cellCount; k++) {
      if (!isCellBurning(patch, k)) continue;
      const o = k * FIRE_CELL_STRIDE;
      const dy = patch.cells[o + 1]! - y;
      if (dy < -FIRE.burnHeight || dy > FIRE.burnHeight) continue;
      const dx = patch.cells[o]! - x;
      const dz = patch.cells[o + 2]! - z;
      if (dx * dx + dz * dz <= reachSq) return true;
    }
  }
  return false;
}

/** Distance from a point (relative to the rectangle's centre) to a yawed rectangle's outline; 0 inside it. */
function rectDistance(dx: number, dz: number, yaw: number, halfX: number, halfZ: number): number {
  // The instance's local X runs along the wall; props rotate about +Y (map/layout/collision.ts, buildNavGrid step 3).
  const { sin, cos } = sinCos(yaw);
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const ox = Math.abs(lx) - halfX;
  const oz = Math.abs(lz) - halfZ;
  if (ox <= 0 && oz <= 0) return 0;
  const px = ox > 0 ? ox : 0;
  const pz = oz > 0 ? oz : 0;
  return Math.sqrt(px * px + pz * pz);
}
