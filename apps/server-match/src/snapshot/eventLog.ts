import { createPlayerHitEvent, type Mutable, type PlayerHitEvent } from "@twobullets/protocol";
import { writePlayerHitEvent } from "@twobullets/netcode/replication";
import type { Vec3 } from "@twobullets/shared/movement/types";
import type { AimedShot, HitZone, WeaponId } from "@twobullets/shared/weapons/types";

// Tier-U events of recent ticks, shared by every recipient (netcode.md §6.2, §6.5). Each client's snapshot takes the
// entries newer than its last sent snapshot and at most MAX_EVENT_AGE ticks old (`Shot.tickOffset` is 2 bits), so an
// event goes out once per client unless its snapshot is lost. Rings of preallocated entries; no allocation per tick.

/** `Shot.tickOffset` range: snapshots at 20 Hz carry up to 3 ticks of events. */
export const MAX_EVENT_AGE = 3;

export interface ShotRecord {
  tick: number;
  shooter: number;
  weaponId: WeaponId;
  shotId: number;
  spreadDegrees: number;
  yawQ: number;
  pitchQ: number;
  readonly origin: Vec3 & { x: number; y: number; z: number };
}

export interface HitRecord {
  tick: number;
  readonly event: Mutable<PlayerHitEvent>;
}

class Ring<T extends { tick: number }> {
  readonly entries: T[] = [];
  private head = 0;
  count = 0;

  constructor(size: number, create: () => T) {
    for (let i = 0; i < size; i++) this.entries.push(create());
  }

  /** Oldest-first index k → entry. */
  at(k: number): T {
    return this.entries[(this.head + k) % this.entries.length]!;
  }

  /** Next entry to fill (overwrites the oldest when full). */
  push(): T {
    const size = this.entries.length;
    if (this.count === size) {
      this.head = (this.head + 1) % size;
      this.count--;
    }
    const e = this.entries[(this.head + this.count) % size]!;
    this.count++;
    return e;
  }

  /** Drops entries older than `minTick`. */
  trim(minTick: number): void {
    while (this.count > 0 && this.at(0).tick < minTick) {
      this.head = (this.head + 1) % this.entries.length;
      this.count--;
    }
  }
}

export class ShotLog {
  private readonly ring: Ring<ShotRecord>;

  constructor(size = 256) {
    this.ring = new Ring(size, () => ({ tick: -1, shooter: 0, weaponId: "rifle", shotId: 0, spreadDegrees: 0, yawQ: 0, pitchQ: 0, origin: { x: 0, y: 0, z: 0 } }));
  }

  get count(): number {
    return this.ring.count;
  }

  at(k: number): ShotRecord {
    return this.ring.at(k);
  }

  add(tick: number, shooter: number, shot: AimedShot, yawQ: number, pitchQ: number): void {
    const e = this.ring.push();
    e.tick = tick;
    e.shooter = shooter;
    e.weaponId = shot.weaponId;
    e.shotId = shot.shotId;
    e.spreadDegrees = shot.spreadDegrees;
    e.yawQ = yawQ;
    e.pitchQ = pitchQ;
    e.origin.x = shot.origin.x;
    e.origin.y = shot.origin.y;
    e.origin.z = shot.origin.z;
  }

  trim(tick: number): void {
    this.ring.trim(tick - MAX_EVENT_AGE);
  }
}

export class HitLog {
  private readonly ring: Ring<HitRecord>;

  constructor(size = 128) {
    this.ring = new Ring(size, () => ({ tick: -1, event: createPlayerHitEvent() }));
  }

  get count(): number {
    return this.ring.count;
  }

  at(k: number): HitRecord {
    return this.ring.at(k);
  }

  add(tick: number, victim: number, zone: HitZone | null, armor: boolean, dirX: number, dirZ: number): void {
    const e = this.ring.push();
    e.tick = tick;
    writePlayerHitEvent(victim, zone, armor, dirX, dirZ, e.event);
  }

  trim(tick: number): void {
    this.ring.trim(tick - MAX_EVENT_AGE);
  }
}
