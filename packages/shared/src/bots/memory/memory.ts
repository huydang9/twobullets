import type { Vec3 } from "../../movement/types";
import type { BotMemory, MemoryEntry, MemorySource, NavAvoidCircle } from "../types";
import { copyVec, vec3, type MutVec3 } from "../brain/util";

// Fading memory of actors (design.md §4): a fixed pool of 8 entries, live ones packed at [0, count). Confidence decays
// linearly from its base over `forgetSeconds`; the lowest confidence is evicted when full.

export const MEMORY_CAPACITY = 8;
export const DANGER_CAPACITY = 6;
/** Remembered positions extrapolate along the last velocity for at most this long, s. */
export const MEMORY_EXTRAPOLATE_SECONDS = 1.5;
const HEARD_BLEND_TICKS = 180;
const HEARD_BLEND = 0.3;

export class MemoryEntryState implements MemoryEntry {
  slot = -1;
  hostile = false;
  readonly position: MutVec3 = vec3();
  readonly velocity: MutVec3 = vec3();
  tick = -1;
  confidence = 0;
  /** Confidence at `tick`; `confidence` fades from it. */
  base = 0;
  source: MemorySource = "seen";
}

class DangerCircle implements NavAvoidCircle {
  x = 0;
  z = 0;
  radius = 0;
  cost = 1;
  untilTick = 0;
}

export class BotMemoryState implements BotMemory {
  readonly entries: MemoryEntryState[] = [];
  count = 0;
  /** Live danger circles, packed; the array length is the live count. */
  readonly danger: DangerCircle[] = [];
  readonly skippedLoot = new Map<number, number>();
  private readonly dangerPool: DangerCircle[] = [];

  constructor() {
    for (let i = 0; i < MEMORY_CAPACITY; i++) this.entries.push(new MemoryEntryState());
    for (let i = 0; i < DANGER_CAPACITY; i++) this.dangerPool.push(new DangerCircle());
  }

  clear(): void {
    this.count = 0;
    for (let i = 0; i < MEMORY_CAPACITY; i++) {
      const e = this.entries[i]!;
      e.slot = -1;
      e.confidence = 0;
      e.base = 0;
    }
    this.danger.length = 0;
    this.skippedLoot.clear();
  }

  find(slot: number): MemoryEntryState | null {
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i]!;
      if (e.slot === slot) return e;
    }
    return null;
  }

  /**
   * Creates or refreshes the entry for `slot`. A weaker source never overwrites a fresher, more confident entry on the
   * same tick range (a noise estimate doesn't replace a sighting from 0.1 s ago).
   */
  observe(slot: number, hostile: boolean, position: Vec3, velocity: Vec3 | null, tick: number, source: MemorySource, confidence: number): MemoryEntryState {
    let e = this.find(slot);
    if (e && source !== "seen" && e.source === "seen" && e.confidence > confidence) {
      return e;
    }
    if (e && source === "heard" && e.source === "heard" && tick - e.tick < HEARD_BLEND_TICKS) {
      // Repeated noises from one source converge instead of jumping between independent error samples.
      e.position.x += (position.x - e.position.x) * HEARD_BLEND;
      e.position.y += (position.y - e.position.y) * HEARD_BLEND;
      e.position.z += (position.z - e.position.z) * HEARD_BLEND;
      e.tick = tick;
      e.base = Math.max(e.confidence, confidence);
      e.confidence = e.base;
      return e;
    }
    if (!e) e = this.allocate();
    e.slot = slot;
    e.hostile = hostile;
    copyVec(e.position, position);
    if (velocity) copyVec(e.velocity, velocity);
    else {
      e.velocity.x = 0;
      e.velocity.y = 0;
      e.velocity.z = 0;
    }
    e.tick = tick;
    e.base = confidence;
    e.confidence = confidence;
    e.source = source;
    return e;
  }

  forget(slot: number): void {
    for (let i = 0; i < this.count; i++) {
      if (this.entries[i]!.slot === slot) {
        this.removeAt(i);
        return;
      }
    }
  }

  /** Linear fade; entries at zero confidence are removed. Danger circles and skipped loot expire too. */
  decay(tick: number, forgetTicks: number): void {
    for (let i = this.count - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      const age = tick - e.tick;
      e.confidence = forgetTicks > 0 ? e.base * (1 - age / forgetTicks) : 0;
      if (e.confidence <= 0) this.removeAt(i);
    }
    for (let i = this.danger.length - 1; i >= 0; i--) {
      if (this.danger[i]!.untilTick <= tick) this.danger.splice(i, 1);
    }
  }

  /** Estimated current position of an entry: last position plus velocity for at most 1.5 s. */
  estimate(e: MemoryEntry, tick: number, dt: number, out: MutVec3): MutVec3 {
    const t = Math.min((tick - e.tick) * dt, MEMORY_EXTRAPOLATE_SECONDS);
    out.x = e.position.x + e.velocity.x * t;
    out.y = e.position.y;
    out.z = e.position.z + e.velocity.z * t;
    return out;
  }

  /** Most confident hostile entry, optionally only unseen sources and newer than `minTick`. */
  bestHostile(minTick: number, excludeSlot: number): MemoryEntryState | null {
    let best: MemoryEntryState | null = null;
    for (let i = 0; i < this.count; i++) {
      const e = this.entries[i]!;
      if (!e.hostile || e.slot === excludeSlot || e.tick < minTick) continue;
      if (!best || e.confidence > best.confidence) best = e;
    }
    return best;
  }

  addDanger(x: number, z: number, radius: number, cost: number, untilTick: number): void {
    let circle: DangerCircle | undefined;
    if (this.danger.length < DANGER_CAPACITY) {
      for (let i = 0; i < DANGER_CAPACITY; i++) {
        const c = this.dangerPool[i]!;
        if (this.danger.indexOf(c) < 0) {
          circle = c;
          break;
        }
      }
      if (circle) this.danger.push(circle);
    }
    if (!circle) {
      // Full: replace the one expiring first.
      circle = this.danger[0]!;
      for (let i = 1; i < this.danger.length; i++) if (this.danger[i]!.untilTick < circle.untilTick) circle = this.danger[i]!;
    }
    circle.x = x;
    circle.z = z;
    circle.radius = radius;
    circle.cost = cost;
    circle.untilTick = untilTick;
  }

  isLootSkipped(lootId: number, tick: number): boolean {
    const until = this.skippedLoot.get(lootId);
    if (until === undefined) return false;
    if (until <= tick) {
      this.skippedLoot.delete(lootId);
      return false;
    }
    return true;
  }

  skipLoot(lootId: number, untilTick: number): void {
    this.skippedLoot.set(lootId, untilTick);
  }

  private allocate(): MemoryEntryState {
    if (this.count < MEMORY_CAPACITY) return this.entries[this.count++]!;
    let weakest = 0;
    for (let i = 1; i < this.count; i++) if (this.entries[i]!.confidence < this.entries[weakest]!.confidence) weakest = i;
    return this.entries[weakest]!;
  }

  private removeAt(index: number): void {
    const last = this.count - 1;
    const removed = this.entries[index]!;
    this.entries[index] = this.entries[last]!;
    this.entries[last] = removed;
    removed.slot = -1;
    removed.confidence = 0;
    this.count = last;
  }
}
