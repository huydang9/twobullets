import { getMapProp, glassBlocksAt, glassPhaseBucket, isPhaseGlass, GLASS_PHASE, INSTANCE_STRIDE, type MapLayout, type Projectile } from "@twobullets/shared";
import type { Vec3Like } from "./acoustics";
import { FOLIAGE_RUSTLE, foliageVolume } from "./foliage";
import type { GameAudio } from "./GameAudio";
import { GLASS_PHASE_CLICK } from "./glassPhaseClick";

/**
 * Sounds that belong to placed map props rather than to anything the player did: a bullet going through a hedge, and a
 * glazed pane switching mode beside you.
 *
 * Both are read off the resolved map layout (`MapLayout.props`: the instances the client draws and the server
 * collides), so a map that moves its hedges or its panes moves these with it and nothing here knows what a maze is.
 * `MapRuntime.attach` hands it over; `AudioDirector` drives it once a frame.
 *
 * ## Why the hedge is not a raycast
 *
 * `wall_grass` has `collision: { kind: "none" }`. That is not "invisible to bullets" the way the shoot-through panes
 * are — those are on the blocker layer, which is what `combat/penetration.ts` re-walks each projectile segment against
 * to find the panes it crossed. A hedge has no Havok shape on any layer, so there is nothing for any ray to return,
 * and the cheapest honest fix is not to give it one: a sensor shape would be a few dozen more static bodies and one
 * more query per projectile per tick, in a file another agent owns, to rediscover geometry this side already has. The
 * crossing is solved analytically instead — the bullet's segment for this frame against the hedge's own oriented box,
 * looked up in a uniform grid. No rays, no shapes, no physics: a grid lookup and a slab test per bullet per frame.
 */

/** Grid cell for the hedge index, m. Two cells cover the longest one-frame bullet segment (a 900 m/s round). */
const CELL = 16;
/** Floats per hedge: x, y, z, cos(yaw), sin(yaw), halfX, halfZ, bottomY, topY. */
const HEDGE_STRIDE = 9;
/** Hedges tested for one bullet segment before we take what we have. A cell full of bushes must not cost a frame. */
const MAX_TESTS = 32;
/** Index offset so negative map coordinates key without a string. Covers ±8 km, far past any 1 km map. */
const KEY_BIAS = 512;

interface Track {
  x: number;
  y: number;
  z: number;
  seen: number;
}

export class MapPropAudio {
  private readonly hedges: Float32Array;
  private readonly cells = new Map<number, Int32Array>();
  /** Context time each hedge may rustle again, indexed like `hedges`. */
  private readonly hedgeQuiet: Float64Array;
  /** Pane positions per phase group, 3 floats each. */
  private readonly panes: Float32Array[] = [];
  /** Mode each phase group was in last frame; null until the first update, which never clicks. */
  private modes: boolean[] | null = null;
  private readonly tracks = new Map<number, Track>();
  private frame = 0;
  private readonly hit = { x: 0, y: 0, z: 0 };

  constructor(
    layout: Pick<MapLayout, "props">,
    /** Match time the panes switch on — the same clock `PropColliders.setPhaseTime` turns. */
    private readonly phaseSeconds: () => number,
  ) {
    const hedges: number[] = [];
    const panes: number[][] = Array.from({ length: GLASS_PHASE.buckets }, () => []);
    for (const set of layout.props) {
      const volume = FOLIAGE_RUSTLE.enabled ? foliageVolume(getMapProp(set.prop)) : null;
      const isPane = GLASS_PHASE_CLICK.enabled && isPhaseGlass(set.prop);
      if (!volume && !isPane) continue;
      for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
        const x = set.data[i] as number;
        const y = set.data[i + 1] as number;
        const z = set.data[i + 2] as number;
        if (isPane) {
          panes[glassPhaseBucket(x, z, set.data[i + 3] as number)]?.push(x, y + 1.3, z);
          continue;
        }
        const yaw = set.data[i + 3] as number;
        const scale = set.data[i + 4] as number;
        const v = volume as NonNullable<typeof volume>;
        hedges.push(x, y, z, Math.cos(yaw), Math.sin(yaw), v.halfX * scale, v.halfZ * scale, y + v.bottom * scale, y + v.top * scale);
      }
    }
    this.hedges = new Float32Array(hedges);
    this.hedgeQuiet = new Float64Array(hedges.length / HEDGE_STRIDE);
    for (const list of panes) this.panes.push(new Float32Array(list));
    this.buildCells();
  }

  /** Hedge instances indexed, for the debug readout. */
  get hedgeCount(): number {
    return this.hedgeQuiet.length;
  }

  /**
   * Once a render frame, after the listener moved. `lists` are the same projectile lists the near-miss detector
   * watches: the local player's bullets and every remote actor's.
   */
  update(audio: GameAudio, listener: Vec3Like, lists: readonly { readonly projectiles: readonly Projectile[] }[]): void {
    this.updatePanes(audio, listener);
    if (this.hedges.length === 0) return;
    this.frame++;
    let budget = FOLIAGE_RUSTLE.maxPerFrame;
    for (const list of lists) {
      for (const projectile of list.projectiles) {
        const track = this.track(projectile);
        if (!track) continue;
        const p = projectile.position;
        if (budget > 0 && this.rustle(audio, track.x, track.y, track.z, p.x, p.y, p.z)) budget--;
        track.x = p.x;
        track.y = p.y;
        track.z = p.z;
      }
    }
    for (const [id, track] of this.tracks) if (track.seen !== this.frame) this.tracks.delete(id);
  }

  /** Previous position of a bullet, or null the frame it appeared (there is no segment yet). */
  private track(projectile: Projectile): Track | null {
    const existing = this.tracks.get(projectile.id);
    if (existing) {
      existing.seen = this.frame;
      return existing;
    }
    const p = projectile.position;
    this.tracks.set(projectile.id, { x: p.x, y: p.y, z: p.z, seen: this.frame });
    return null;
  }

  /**
   * One bullet's segment against the hedges near it. Returns true when a rustle was started — the first hedge the
   * round crosses, not every one: a burst through a hedgerow is bushes shaking, not a count of leaves.
   */
  private rustle(audio: GameAudio, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const now = audio.now;
    if (now === null) return false;
    const minX = Math.floor(Math.min(ax, bx) / CELL);
    const maxX = Math.floor(Math.max(ax, bx) / CELL);
    const minZ = Math.floor(Math.min(az, bz) / CELL);
    const maxZ = Math.floor(Math.max(az, bz) / CELL);
    // A segment spanning more cells than a bullet can cross in a frame is a teleport (respawn, spectate): ignore it.
    if ((maxX - minX + 1) * (maxZ - minZ + 1) > 9) return false;
    let tests = 0;
    for (let cz = minZ; cz <= maxZ; cz++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const cell = this.cells.get(cellKey(cx, cz));
        if (!cell) continue;
        for (const index of cell) {
          if (++tests > MAX_TESTS) return false;
          if (now < (this.hedgeQuiet[index] as number)) continue;
          if (!this.crosses(index, ax, ay, az, bx, by, bz)) continue;
          this.hedgeQuiet[index] = now + FOLIAGE_RUSTLE.cooldownSeconds;
          audio.playFoliageHit(this.hit);
          return true;
        }
      }
    }
    return false;
  }

  /** Segment a→b against hedge `index`'s oriented box; writes the entry point into {@link hit}. */
  private crosses(index: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const h = index * HEDGE_STRIDE;
    const cos = this.hedges[h + 3] as number;
    const sin = this.hedges[h + 4] as number;
    const dx = ax - (this.hedges[h] as number);
    const dz = az - (this.hedges[h + 2] as number);
    // Into the hedge's own frame (Babylon yaw: world = local rotated by +yaw, so this is the inverse rotation).
    const lax = dx * cos - dz * sin;
    const laz = dx * sin + dz * cos;
    const ex = bx - ax;
    const ez = bz - az;
    const lex = ex * cos - ez * sin;
    const lez = ex * sin + ez * cos;

    const halfX = this.hedges[h + 5] as number;
    const halfZ = this.hedges[h + 6] as number;
    const ey = by - ay;
    // Slab test, three axes inline: each one narrows [tMin, tMax] and an empty interval means the segment misses.
    let tMin = 0;
    let tMax = 1;
    for (let axis = 0; axis < 3; axis++) {
      const origin = axis === 0 ? lax : axis === 1 ? laz : ay;
      const direction = axis === 0 ? lex : axis === 1 ? lez : ey;
      const min = axis === 0 ? -halfX : axis === 1 ? -halfZ : (this.hedges[h + 7] as number);
      const max = axis === 0 ? halfX : axis === 1 ? halfZ : (this.hedges[h + 8] as number);
      if (direction > -1e-6 && direction < 1e-6) {
        if (origin < min || origin > max) return false;
        continue;
      }
      const inverse = 1 / direction;
      const a = (min - origin) * inverse;
      const b = (max - origin) * inverse;
      const near = a < b ? a : b;
      const far = a < b ? b : a;
      if (near > tMin) tMin = near;
      if (far < tMax) tMax = far;
      if (tMin > tMax) return false;
    }
    const t = tMin > 0 ? tMin : 0;
    this.hit.x = ax + ex * t;
    this.hit.y = ay + (by - ay) * t;
    this.hit.z = az + ez * t;
    return true;
  }

  /** Phase groups that changed mode since the last frame click at the nearest few of their panes. */
  private updatePanes(audio: GameAudio, listener: Vec3Like): void {
    if (this.panes.length === 0) return;
    const seconds = this.phaseSeconds();
    const first = this.modes === null;
    const modes = this.modes ?? (this.modes = []);
    const rangeSq = GLASS_PHASE_CLICK.range * GLASS_PHASE_CLICK.range;
    for (let bucket = 0; bucket < this.panes.length; bucket++) {
      const blocking = glassBlocksAt(bucket, seconds);
      const changed = !first && modes[bucket] !== blocking;
      modes[bucket] = blocking;
      if (!changed) continue;
      const data = this.panes[bucket] as Float32Array;
      let played = 0;
      for (let i = 0; i < data.length && played < GLASS_PHASE_CLICK.maxPanes; i += 3) {
        const x = data[i] as number;
        const y = data[i + 1] as number;
        const z = data[i + 2] as number;
        const dx = x - listener.x;
        const dy = y - listener.y;
        const dz = z - listener.z;
        if (dx * dx + dy * dy + dz * dz > rangeSq) continue;
        this.hit.x = x;
        this.hit.y = y;
        this.hit.z = z;
        audio.playGlassPhaseClick(this.hit, blocking);
        played++;
      }
    }
  }

  private buildCells(): void {
    const lists = new Map<number, number[]>();
    for (let index = 0; index < this.hedgeQuiet.length; index++) {
      const h = index * HEDGE_STRIDE;
      // Conservative footprint: the longer half extent in both axes, so a rotated hedge is never clipped out.
      const reach = Math.max(this.hedges[h + 5] as number, this.hedges[h + 6] as number);
      const x = this.hedges[h] as number;
      const z = this.hedges[h + 2] as number;
      for (let cz = Math.floor((z - reach) / CELL); cz <= Math.floor((z + reach) / CELL); cz++) {
        for (let cx = Math.floor((x - reach) / CELL); cx <= Math.floor((x + reach) / CELL); cx++) {
          const key = cellKey(cx, cz);
          let list = lists.get(key);
          if (!list) lists.set(key, (list = []));
          list.push(index);
        }
      }
    }
    for (const [key, list] of lists) this.cells.set(key, new Int32Array(list));
  }
}

function cellKey(cx: number, cz: number): number {
  return (cx + KEY_BIAS) * 1024 + (cz + KEY_BIAS);
}
