import { WallUpdateWriter, WALL_HEAL_LEVELS } from "@twobullets/protocol";
import { asNavGridData } from "@twobullets/shared/bots/nav/navGrid";
import { NavPatcher } from "@twobullets/shared/bots/nav/navPatch";
import type { NavGrid } from "@twobullets/shared/bots/types";
import { buildDestructibleWalls, wallRepairProgress, WallChange, WallKind, type DestructibleWalls } from "@twobullets/shared/equipment/destructible";
import type { MapLayout } from "@twobullets/shared/map/layout/mapLayout";
import { sinCos } from "@twobullets/shared/map/terrain/math";
import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import type { Player } from "./Player";

// Server-authoritative destructible walls (protocol v10). The maze is the one map a player can change the shape of:
// a frag takes a mirror pane out, a molotov burns a grass hedge away, and a smoke cloud closes the apertures rounds
// punched through a pane that is still standing (`shared/equipment/destructible.ts`).
//
// Nothing here decides *when* any of that happens. The three mechanics are the shared pure resolvers, and they run
// inside `stepEquipmentWorld` because `ServerThrowables` installs this registry as its world's `walls` — the same
// wiring the offline `MatchSim` uses, so the two hosts cannot drift. What this owns is everything that follows:
//
//  - the Havok collider of a destroyed pane leaves the world, so bodies and bullets stop meeting a wall that is gone,
//  - the nav grid is patched where it stood, so the server's bots walk the corridor the blast opened,
//  - every client is told, by index, on the tick it happened.
//
// It also owns the **apertures**. A mirror is shoot-through on the collider layer, so the server's bullet ray goes
// straight past it and no world hit is reported; the crossing is found geometrically from the flight segment the
// projectiles already hand out (`wallsCrossedBy`). Only the 0 → 1 transition travels: `holes` is never read as a
// number anywhere, only as "this pane is holed", which is what decides when a cloud has finished healing one.
//
// A map with no mirrors and no hedges builds a registry of count 0 and every path below returns immediately, so Map v1,
// the real-world maps and the arena pay one comparison a tick.

/** Op codes inside the tick's pending list (see `packChange`). */
const DESTROYED = 0;
const REPAIRED = 1;
const HOLED = 2;
const HEALING = 3;

/** `index` (16 bits) · op (2 bits) · heal step (4 bits), so a tick's changes are one flat number array. */
function packChange(index: number, code: number, step: number): number {
  return index * 64 + code * 16 + step;
}

export interface ServerWallsOptions {
  readonly layout: Pick<MapLayout, "props">;
  /** Takes a destroyed pane's collider out of the match's Havok world (`MapCollision.removeInstance`). */
  removeCollider(prop: string, instance: number): boolean;
  /** Dense players (the match's active list). */
  readonly players: () => readonly Player[];
  readonly tickSeconds?: number;
}

export interface ServerWallStats {
  destroyed: number;
  repaired: number;
  holed: number;
  collidersRemoved: number;
  navPatched: number;
  messagesOut: number;
  bytesOut: number;
}

/** One client's wall stream state (lives on `Player.wallView`). */
export class WallViewer {
  readonly out = new WallUpdateWriter();
  /** The next replicate restates the whole world (join, reconnect, match reset). */
  resyncPending = true;
  bytesOut = 0;
  messagesOut = 0;

  reset(): void {
    this.resyncPending = true;
  }
}

export class ServerWalls {
  readonly walls: DestructibleWalls;
  readonly stats: ServerWallStats = { destroyed: 0, repaired: 0, holed: 0, collidersRemoved: 0, navPatched: 0, messagesOut: 0, bytesOut: 0 };
  private readonly o: ServerWallsOptions;
  private readonly layout: Pick<MapLayout, "props">;
  private readonly dt: number;
  private navPatcher: NavPatcher | null = null;
  /** This match's read position in the wall change log. */
  private cursor = 0;
  /** Packed changes made this tick, drained into every client's stream at the end of it. */
  private readonly pending: number[] = [];
  /** Heal step last put on the wire per holed pane, so only the steps a renderer would redraw on travel. */
  private readonly healStep = new Map<number, number>();
  private readonly scratch: number[] = [];

  constructor(options: ServerWallsOptions) {
    this.o = options;
    this.layout = options.layout;
    this.dt = options.tickSeconds ?? TICK_SECONDS;
    this.walls = buildDestructibleWalls(options.layout);
  }

  /** True when this map has nothing a throwable can take out; every caller can then skip the whole system. */
  get empty(): boolean {
    return this.walls.count === 0;
  }

  /**
   * Bot navigation follows the walls: a destroyed pane opens the cells it stood on, a burnt hedge loses its
   * concealment. Only ever called with a grid built for this match — a grid shared with later matches on the same map
   * would carry this match's holes into them, which is a wall bots walk through and players do not.
   */
  attachNav(grid: NavGrid): void {
    if (this.empty) return;
    this.navPatcher = new NavPatcher(asNavGridData(grid), this.layout, this.walls);
  }

  /**
   * After the equipment world stepped: apply everything the shared resolvers decided this tick. The collider goes and
   * the nav grid opens before anything is told about it, so nothing ever reads a half-applied world.
   */
  step(): void {
    const walls = this.walls;
    if (walls.count === 0) return;
    for (; this.cursor < walls.logged; this.cursor++) {
      const packed = walls.changeAt(this.cursor);
      if (packed < 0) continue;
      const index = packed >> 1;
      const change = (packed & 1) as WallChange;
      if (change === WallChange.destroyed) {
        this.stats.destroyed++;
        if (walls.kind[index] === WallKind.pane) {
          const prop = this.layout.props[walls.set[index]!]?.prop ?? "";
          if (this.o.removeCollider(prop, walls.instance[index]!)) this.stats.collidersRemoved++;
        }
        if (this.navPatcher !== null) {
          this.navPatcher.destroyed(index);
          this.stats.navPatched++;
        }
        this.healStep.delete(index);
        this.pending.push(packChange(index, DESTROYED, 0));
      } else {
        this.stats.repaired++;
        this.healStep.delete(index);
        this.pending.push(packChange(index, REPAIRED, 0));
      }
    }
    this.stepHealing();
  }

  /**
   * A bullet's flight segment for this tick: every standing pane it crossed counts an aperture. `tEnd` is the fraction
   * of the segment the bullet actually flew (it stopped there, on a wall or a body), so a round that died before the
   * glass never punches it.
   */
  segment(fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number, tEnd: number): void {
    const walls = this.walls;
    if (walls.count === 0 || tEnd <= 0) return;
    const ex = fromX + (toX - fromX) * tEnd;
    const ey = fromY + (toY - fromY) * tEnd;
    const ez = fromZ + (toZ - fromZ) * tEnd;
    const hits = this.scratch;
    if (wallsCrossedBy(walls, fromX, fromY, fromZ, ex, ey, ez, hits) === 0) return;
    for (let i = 0; i < hits.length; i++) {
      const index = hits[i]!;
      // Only the transition travels: everything downstream asks "is this pane holed", never how often.
      const fresh = walls.holes[index] === 0;
      walls.addHole(index);
      if (!fresh) continue;
      this.stats.holed++;
      this.pending.push(packChange(index, HOLED, 0));
    }
  }

  /** Everything standing again (match reset): clients re-stream from scratch. */
  reset(): void {
    for (const p of this.o.players()) p.wallView.reset();
  }

  /** End of tick: the tick's changes go out, and a joining or resyncing client gets the whole state first. */
  replicate(players: readonly Player[]): void {
    const walls = this.walls;
    if (walls.count === 0) return;
    const pending = this.pending;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.session === null) continue;
      const v = p.wallView;
      v.out.begin();
      if (v.resyncPending) {
        v.resyncPending = false;
        this.writeFullState(p, v);
      } else {
        for (let k = 0; k < pending.length; k++) this.write(p, v, pending[k]!);
      }
      this.flush(p, v);
    }
    pending.length = 0;
  }

  // ---- Internals ------------------------------------------------------------------------------------------------------

  /**
   * Panes a cloud is closing up: the progress goes on the wire on the steps the renderer redraws on, so the glass
   * grows back over the seconds the smoke sits there instead of popping shut. A pane nobody has shot costs nothing.
   */
  private stepHealing(): void {
    const walls = this.walls;
    if (walls.holedCount === 0 && this.healStep.size === 0) return;
    for (let i = 0; i < walls.count; i++) {
      if (walls.kind[i] !== WallKind.pane || walls.destroyed[i] === 1 || walls.holes[i] === 0) continue;
      const step = Math.round(wallRepairProgress(walls, i, this.dt) * WALL_HEAL_LEVELS);
      if (this.healStep.get(i) === step) continue;
      this.healStep.set(i, step);
      this.pending.push(packChange(i, HEALING, step));
    }
  }

  /**
   * A client that just joined (or resynced) rebuilds from the state, not the history: `destroyed` and `holes` are what
   * the world is, while the change log is a ring that a client who was never here cannot replay.
   */
  private writeFullState(p: Player, v: WallViewer): void {
    const walls = this.walls;
    v.out.clear();
    for (let i = 0; i < walls.count; i++) {
      if (walls.destroyed[i] !== 1) continue;
      this.room(p, v);
      v.out.destroyed(i);
    }
    if (walls.holedCount === 0) return;
    for (let i = 0; i < walls.count; i++) {
      if (walls.destroyed[i] === 1 || walls.holes[i] === 0) continue;
      this.room(p, v);
      v.out.holed(i);
      const step = this.healStep.get(i) ?? 0;
      if (step > 0) v.out.healing(i, step / WALL_HEAL_LEVELS);
    }
  }

  private write(p: Player, v: WallViewer, packed: number): void {
    this.room(p, v);
    const index = Math.floor(packed / 64);
    const code = (packed >> 4) & 3;
    switch (code) {
      case DESTROYED:
        v.out.destroyed(index);
        break;
      case REPAIRED:
        v.out.repaired(index);
        break;
      case HOLED:
        v.out.holed(index);
        break;
      default:
        v.out.healing(index, (packed & 15) / WALL_HEAL_LEVELS);
        break;
    }
  }

  private room(p: Player, v: WallViewer): void {
    if (v.out.full) this.flush(p, v);
  }

  private flush(p: Player, v: WallViewer): void {
    const bytes = v.out.finish();
    if (bytes !== null && p.session !== null) {
      p.session.sendStream(bytes);
      v.bytesOut += bytes.length;
      v.messagesOut++;
      this.stats.bytesOut += bytes.length;
      this.stats.messagesOut++;
    }
    v.out.begin();
  }
}

/**
 * Every standing mirror pane the segment (a → b) passes through, appended to `out` in wall order. Returns how many.
 *
 * A pane is an upright box: half extents `halfX` along its own X (the direction the wall runs), `halfZ` across, and
 * `height` up from its base. The test is the textbook slab intersection in the pane's own frame — pure, allocation
 * free and deterministic, which is what lets the server be the only machine that decides a pane is holed.
 */
export function wallsCrossedBy(walls: DestructibleWalls, ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: number[]): number {
  out.length = 0;
  for (let i = 0; i < walls.count; i++) {
    if (walls.kind[i] !== WallKind.pane || walls.destroyed[i] === 1) continue;
    const { sin, cos } = sinCos(walls.yaw[i]!);
    const cx = walls.x[i]!;
    const cz = walls.z[i]!;
    // Into the pane's frame — the same rotation `destructible.rectDistance` uses, so both agree on which way is across.
    const adx = ax - cx;
    const adz = az - cz;
    const alx = adx * cos - adz * sin;
    const alz = adx * sin + adz * cos;
    const blx = (bx - cx) * cos - (bz - cz) * sin;
    const blz = (bx - cx) * sin + (bz - cz) * cos;
    const base = walls.y[i]!;
    const halfX = walls.halfX[i]!;
    const halfZ = walls.halfZ[i]!;

    let t0 = 0;
    let t1 = 1;
    // X slab.
    let o = alx;
    let d = blx - alx;
    if (d > -EPS && d < EPS) {
      if (o < -halfX || o > halfX) continue;
    } else {
      const inv = 1 / d;
      let lo = (-halfX - o) * inv;
      let hi = (halfX - o) * inv;
      if (lo > hi) {
        const s = lo;
        lo = hi;
        hi = s;
      }
      if (lo > t0) t0 = lo;
      if (hi < t1) t1 = hi;
      if (t0 > t1) continue;
    }
    // Z slab.
    o = alz;
    d = blz - alz;
    if (d > -EPS && d < EPS) {
      if (o < -halfZ || o > halfZ) continue;
    } else {
      const inv = 1 / d;
      let lo = (-halfZ - o) * inv;
      let hi = (halfZ - o) * inv;
      if (lo > hi) {
        const s = lo;
        lo = hi;
        hi = s;
      }
      if (lo > t0) t0 = lo;
      if (hi < t1) t1 = hi;
      if (t0 > t1) continue;
    }
    // Y slab.
    o = ay;
    d = by - ay;
    const top = base + walls.height[i]!;
    if (d > -EPS && d < EPS) {
      if (o < base || o > top) continue;
    } else {
      const inv = 1 / d;
      let lo = (base - o) * inv;
      let hi = (top - o) * inv;
      if (lo > hi) {
        const s = lo;
        lo = hi;
        hi = s;
      }
      if (lo > t0) t0 = lo;
      if (hi < t1) t1 = hi;
      if (t0 > t1) continue;
    }
    out.push(i);
  }
  return out.length;
}

const EPS = 1e-9;
