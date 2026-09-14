import type { Vec3 } from "../movement/types";
import type { FiredShot, RayHit, RaycastFn, WeaponId } from "./types";
import { BALLISTICS, WEAPONS } from "./weapons";

// Bullets in flight as a structure of arrays (refactor R7): the same arithmetic as the object `stepProjectiles`
// (semi-implicit Euler, segment clipped at max range, lifetime cap) with zero allocations per tick, and projectile ids
// that are identical on every machine (netcode.md §1.4 #5, `HitConfirm` references them).

/** Weapon ids by the index a buffer stores. Append only: the index may go on the wire. */
export const PROJECTILE_WEAPON_IDS: readonly WeaponId[] = ["pistol", "rifle", "shotgun", "sniper"];

const WEAPON_INDEX: Readonly<Record<WeaponId, number>> = { pistol: 0, rifle: 1, shotgun: 2, sniper: 3 };

export function projectileWeaponIndex(id: WeaponId): number {
  return WEAPON_INDEX[id];
}

/**
 * Stable projectile id: `slot << 20 | (shotId & 0xFFFF) << 4 | pellet`. Slot < 2048, pellet < 16. Unique per player while
 * the shot counter doesn't wrap 65 536 shots inside one bullet lifetime.
 */
export function projectileId(slot: number, shotId: number, pellet: number): number {
  return (slot << 20) | ((shotId & 0xffff) << 4) | (pellet & 0xf);
}

export function projectileSlotOf(id: number): number {
  return id >>> 20;
}

/** The low 16 bits of the shot id. */
export function projectileShotOf(id: number): number {
  return (id >>> 4) & 0xffff;
}

export function projectilePelletOf(id: number): number {
  return id & 0xf;
}

/** Segment layout written by `ProjectileBuffer.integrate`: [ax, ay, az, bx, by, bz, length]. */
export const SEGMENT_LENGTH = 7;

/**
 * Receives the outcome of `stepProjectiles(buffer, …)` while the bullet is still at `index`; the step removes it
 * afterwards (swap-remove, so indices of later bullets change).
 */
export interface ProjectileSink {
  /** Bullet `index` struck `hit`. The buffer already holds the impact position, the tick's velocity, distance and age. */
  impact(buffer: ProjectileBuffer, index: number, hit: RayHit): void;
  /** Bullet `index` expired (max range or lifetime) at its final position without hitting anything. */
  expired?(buffer: ProjectileBuffer, index: number): void;
}

export class ProjectileBuffer {
  count = 0;
  capacity: number;
  /** Stable ids (`projectileId`). */
  id: Int32Array;
  /** Full shot counter of the shot that spawned the bullet. */
  shotId: Int32Array;
  /** Shooter's player slot. */
  shooter: Int32Array;
  /** Index into PROJECTILE_WEAPON_IDS. */
  weapon: Uint8Array;
  /** Position and velocity, xyz per bullet. */
  position: Float64Array;
  velocity: Float64Array;
  /** Meters travelled. */
  distance: Float64Array;
  /** Seconds in flight. */
  age: Float64Array;
  /** Scratch segment of the last `integrate` done by `stepProjectiles`. */
  readonly segment = new Float64Array(SEGMENT_LENGTH);
  private readonly from: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly to: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };

  constructor(capacity = 256) {
    this.capacity = Math.max(1, capacity);
    this.id = new Int32Array(this.capacity);
    this.shotId = new Int32Array(this.capacity);
    this.shooter = new Int32Array(this.capacity);
    this.weapon = new Uint8Array(this.capacity);
    this.position = new Float64Array(this.capacity * 3);
    this.velocity = new Float64Array(this.capacity * 3);
    this.distance = new Float64Array(this.capacity);
    this.age = new Float64Array(this.capacity);
  }

  weaponId(index: number): WeaponId {
    return PROJECTILE_WEAPON_IDS[this.weapon[index]!]!;
  }

  /** Index of the bullet with stable id `id`, or -1 (linear scan). */
  indexOf(id: number): number {
    const ids = this.id;
    for (let i = 0; i < this.count; i++) if (ids[i] === id) return i;
    return -1;
  }

  /** One bullet per pellet at muzzle velocity, ids `projectileId(shooter, shot.shotId, pellet)`. */
  spawnShot(shot: FiredShot, shooter: number): void {
    const speed = WEAPONS[shot.weaponId].muzzleVelocity;
    const weapon = WEAPON_INDEX[shot.weaponId];
    const o = shot.origin;
    for (let p = 0; p < shot.directions.length; p++) {
      const dir = shot.directions[p]!;
      this.add(projectileId(shooter, shot.shotId, p), shot.shotId, shooter, weapon, o.x, o.y, o.z, dir.x * speed, dir.y * speed, dir.z * speed, 0, 0);
    }
  }

  /** Appends one bullet; returns its index. Grows (allocates) only past capacity. */
  add(id: number, shotId: number, shooter: number, weapon: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number, distance: number, age: number): number {
    if (this.count >= this.capacity) this.grow();
    const i = this.count++;
    const i3 = i * 3;
    this.id[i] = id;
    this.shotId[i] = shotId;
    this.shooter[i] = shooter;
    this.weapon[i] = weapon;
    this.position[i3] = px;
    this.position[i3 + 1] = py;
    this.position[i3 + 2] = pz;
    this.velocity[i3] = vx;
    this.velocity[i3 + 1] = vy;
    this.velocity[i3 + 2] = vz;
    this.distance[i] = distance;
    this.age[i] = age;
    return i;
  }

  /**
   * Integrates bullet `i` for dt and writes the flight segment into `seg` ([ax, ay, az, bx, by, bz, length]).
   * Velocity and age are updated in place; position/distance are committed by `advance` (no hit) or `commitHit`.
   * Returns true when the segment reaches max range (the bullet expires after it).
   */
  integrate(i: number, dt: number, seg: Float64Array): boolean {
    const def = WEAPONS[PROJECTILE_WEAPON_IDS[this.weapon[i]!]!];
    const i3 = i * 3;
    const vx = this.velocity[i3]!;
    const vy = this.velocity[i3 + 1]! - BALLISTICS.gravity * def.gravityScale * dt;
    const vz = this.velocity[i3 + 2]!;
    this.velocity[i3 + 1] = vy;
    let dx = vx * dt;
    let dy = vy * dt;
    let dz = vz * dt;
    let length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const remaining = Math.max(0, def.maxRangeMeters - this.distance[i]!);
    const reachesMaxRange = length >= remaining;
    if (reachesMaxRange && length > 0) {
      const s = remaining / length;
      dx *= s;
      dy *= s;
      dz *= s;
      length = remaining;
    }
    seg[0] = this.position[i3]!;
    seg[1] = this.position[i3 + 1]!;
    seg[2] = this.position[i3 + 2]!;
    seg[3] = seg[0] + dx;
    seg[4] = seg[1] + dy;
    seg[5] = seg[2] + dz;
    seg[6] = length;
    this.age[i] = this.age[i]! + dt;
    return reachesMaxRange;
  }

  /** Commits a hit-free segment. Returns false when the bullet expired (max range or lifetime). */
  advance(i: number, seg: Float64Array, reachesMaxRange: boolean): boolean {
    const i3 = i * 3;
    this.position[i3] = seg[3]!;
    this.position[i3 + 1] = seg[4]!;
    this.position[i3 + 2] = seg[5]!;
    this.distance[i] = this.distance[i]! + seg[6]!;
    return !(reachesMaxRange || this.age[i]! >= BALLISTICS.maxLifetimeSeconds);
  }

  /** Moves bullet `i` to its impact at `fraction` of the integrated segment and adds that much distance. */
  commitHit(i: number, seg: Float64Array, point: Vec3, fraction: number): void {
    const i3 = i * 3;
    this.position[i3] = point.x;
    this.position[i3 + 1] = point.y;
    this.position[i3 + 2] = point.z;
    this.distance[i] = this.distance[i]! + fraction * seg[6]!;
  }

  /** Swap-remove. */
  remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.id[i] = this.id[last]!;
    this.shotId[i] = this.shotId[last]!;
    this.shooter[i] = this.shooter[last]!;
    this.weapon[i] = this.weapon[last]!;
    this.position.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.velocity.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.distance[i] = this.distance[last]!;
    this.age[i] = this.age[last]!;
  }

  clear(): void {
    this.count = 0;
  }

  /**
   * Flies every bullet one tick against `raycast`: hits go to `sink.impact`, expiries to `sink.expired`, then both are
   * removed. Allocation-free apart from what `raycast` and the sink allocate. The ray endpoints are scratch objects
   * reused across calls: copy them if kept.
   */
  step(dt: number, raycast: RaycastFn, sink: ProjectileSink): void {
    const seg = this.segment;
    const from = this.from;
    const to = this.to;
    let i = 0;
    while (i < this.count) {
      const reachesMaxRange = this.integrate(i, dt, seg);
      const length = seg[6]!;
      let hit: RayHit | null = null;
      if (length > 0) {
        from.x = seg[0]!;
        from.y = seg[1]!;
        from.z = seg[2]!;
        to.x = seg[3]!;
        to.y = seg[4]!;
        to.z = seg[5]!;
        hit = raycast(from, to);
      }
      if (hit) {
        this.commitHit(i, seg, hit.point, hit.fraction);
        sink.impact(this, i, hit);
        this.remove(i);
      } else if (this.advance(i, seg, reachesMaxRange)) {
        i++;
      } else {
        sink.expired?.(this, i);
        this.remove(i);
      }
    }
  }

  private grow(): void {
    const capacity = this.capacity * 2;
    this.id = grown(this.id, new Int32Array(capacity));
    this.shotId = grown(this.shotId, new Int32Array(capacity));
    this.shooter = grown(this.shooter, new Int32Array(capacity));
    this.weapon = grown(this.weapon, new Uint8Array(capacity));
    this.position = grown(this.position, new Float64Array(capacity * 3));
    this.velocity = grown(this.velocity, new Float64Array(capacity * 3));
    this.distance = grown(this.distance, new Float64Array(capacity));
    this.age = grown(this.age, new Float64Array(capacity));
    this.capacity = capacity;
  }
}

function grown<T extends Int32Array | Uint8Array | Float64Array>(src: T, next: T): T {
  next.set(src);
  return next;
}
