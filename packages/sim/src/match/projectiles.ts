import type { FiredShot, WeaponId } from "@twobullets/shared/weapons/types";
import { BALLISTICS, WEAPONS } from "@twobullets/shared/weapons/weapons";

const WEAPON_IDS: readonly WeaponId[] = ["pistol", "rifle", "shotgun", "sniper"];

/**
 * Bullets in flight as struct-of-arrays, stepped with exactly the arithmetic of shared `stepProjectiles` (semi-implicit
 * Euler, segment clipped at max range, lifetime cap) but without allocating per tick. The caller casts each segment.
 */
export class ProjectilePool {
  count = 0;
  capacity: number;
  id: Int32Array;
  owner: Int16Array;
  weapon: Uint8Array;
  /** Position and velocity, xyz per bullet. */
  position: Float64Array;
  velocity: Float64Array;
  distance: Float64Array;
  age: Float64Array;

  constructor(capacity = 256) {
    this.capacity = capacity;
    this.id = new Int32Array(capacity);
    this.owner = new Int16Array(capacity);
    this.weapon = new Uint8Array(capacity);
    this.position = new Float64Array(capacity * 3);
    this.velocity = new Float64Array(capacity * 3);
    this.distance = new Float64Array(capacity);
    this.age = new Float64Array(capacity);
  }

  weaponId(index: number): WeaponId {
    return WEAPON_IDS[this.weapon[index]!]!;
  }

  /** One bullet per pellet. Ids: `slot << 20 | shotCounter << 4 | pellet` (design.md §2.3). */
  spawnShot(shot: FiredShot, owner: number): void {
    const speed = WEAPONS[shot.weaponId].muzzleVelocity;
    const weapon = WEAPON_IDS.indexOf(shot.weaponId);
    for (let p = 0; p < shot.directions.length; p++) {
      if (this.count >= this.capacity) this.grow();
      const i = this.count++;
      const i3 = i * 3;
      const dir = shot.directions[p]!;
      this.id[i] = (owner << 20) | ((shot.shotId & 0xffff) << 4) | (p & 0xf);
      this.owner[i] = owner;
      this.weapon[i] = weapon;
      this.position[i3] = shot.origin.x;
      this.position[i3 + 1] = shot.origin.y;
      this.position[i3 + 2] = shot.origin.z;
      this.velocity[i3] = dir.x * speed;
      this.velocity[i3 + 1] = dir.y * speed;
      this.velocity[i3 + 2] = dir.z * speed;
      this.distance[i] = 0;
      this.age[i] = 0;
    }
  }

  /**
   * Integrates bullet `i` for dt and writes the flight segment into `seg` ([ax, ay, az, bx, by, bz, length]).
   * Velocity is updated in place; position/distance/age are committed by `advance` (no hit) or read at the hit.
   * Returns true when the segment reaches max range (the bullet expires after it).
   */
  integrate(i: number, dt: number, seg: Float64Array): boolean {
    const def = WEAPONS[WEAPON_IDS[this.weapon[i]!]!];
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

  /** Swap-remove. */
  remove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    this.id[i] = this.id[last]!;
    this.owner[i] = this.owner[last]!;
    this.weapon[i] = this.weapon[last]!;
    this.position.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.velocity.copyWithin(i * 3, last * 3, last * 3 + 3);
    this.distance[i] = this.distance[last]!;
    this.age[i] = this.age[last]!;
  }

  clear(): void {
    this.count = 0;
  }

  private grow(): void {
    const capacity = this.capacity * 2;
    const copy = <T extends Int32Array | Int16Array | Uint8Array | Float64Array>(src: T, size: number): T => {
      const next = new (src.constructor as new (n: number) => T)(size);
      next.set(src);
      return next;
    };
    this.id = copy(this.id, capacity);
    this.owner = copy(this.owner, capacity);
    this.weapon = copy(this.weapon, capacity);
    this.position = copy(this.position, capacity * 3);
    this.velocity = copy(this.velocity, capacity * 3);
    this.distance = copy(this.distance, capacity);
    this.age = copy(this.age, capacity);
    this.capacity = capacity;
  }
}
