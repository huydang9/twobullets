import type { BitReader } from "@twobullets/protocol/bits";
import {
  BASELINE_RING,
  copySnapshot,
  createSnapshotBuffer,
  decodeSnapshotInto,
  type MutableSnapshot,
  type Snapshot,
} from "@twobullets/protocol/messages/snapshot";

// Ack-based delta baselines (netcode.md §6.6). The server keeps the last 128 snapshots it sent to a client and encodes
// against the newest one the client acked; the client keeps the last 128 it decoded. Both rings hold copies in
// preallocated storage, indexed by tick.

class SnapshotRing {
  readonly slots: MutableSnapshot[] = [];
  readonly ticks: Float64Array;
  readonly mask: number;
  private readonly copyEvents: boolean;

  constructor(size: number, copyEvents: boolean) {
    this.copyEvents = copyEvents;
    if ((size & (size - 1)) !== 0) throw new RangeError("ring size must be a power of two");
    this.mask = size - 1;
    this.ticks = new Float64Array(size).fill(-1);
    for (let i = 0; i < size; i++) this.slots.push(createSnapshotBuffer());
  }

  put(snapshot: Snapshot): MutableSnapshot {
    const tick = snapshot.header.serverTick;
    const index = tick & this.mask;
    const slot = this.slots[index]!;
    copySnapshot(snapshot, slot, this.copyEvents);
    this.ticks[index] = tick;
    return slot;
  }

  get(tick: number): MutableSnapshot | null {
    if (tick < 0) return null;
    const index = tick & this.mask;
    return this.ticks[index] === tick ? this.slots[index]! : null;
  }

  clear(): void {
    this.ticks.fill(-1);
  }
}

export class ServerSnapshotBaselines {
  private readonly ring: SnapshotRing;
  private readonly size: number;
  private acked = -1;

  constructor(size = BASELINE_RING) {
    this.size = size;
    // Baselines only need state; events are never delta-coded.
    this.ring = new SnapshotRing(size, false);
  }

  /** Newest acked tick still usable, or −1. */
  get ackedTick(): number {
    return this.acked;
  }

  /** Stores what was just sent (quantized values, exactly as encoded). */
  record(snapshot: Snapshot): void {
    this.ring.put(snapshot);
  }

  /** From `InputPacket.ackSnapshotTick`: only ticks we actually sent, never moving backwards. */
  ack(tick: number): void {
    if (tick <= this.acked || this.ring.get(tick) === null) return;
    this.acked = tick;
  }

  /** Baseline for encoding `tick`, or null (full snapshot) when nothing usable is acked. */
  baselineFor(tick: number): Snapshot | null {
    const a = this.acked;
    if (a < 0 || tick - a >= this.size || tick <= a || (a & 0xffff) === 0xffff) return null;
    return this.ring.get(a);
  }

  /** After `Resync` or a session resume: forget acks so the next snapshot is full. */
  reset(): void {
    this.acked = -1;
    this.ring.clear();
  }
}

export class ClientSnapshotStore {
  private readonly ring: SnapshotRing;
  private readonly size: number;
  private readonly scratch = createSnapshotBuffer();
  private readonly lookup = (tick: number): Snapshot | null => this.ring.get(tick);
  private newest = -1;
  private eventsOnlyValid = false;

  constructor(size = BASELINE_RING) {
    this.size = size;
    this.ring = new SnapshotRing(size, true);
  }

  /**
   * After `decode` returned null for a snapshot whose event sections parsed (its baseline was gone, or the body after
   * the events was bad): that snapshot with only `header`, `shots`, `hits` and `reliable` valid — never read its owner,
   * weapon, vitals or entities. Null otherwise. Valid until the next `decode`.
   */
  get eventsOnly(): Snapshot | null {
    return this.eventsOnlyValid ? this.scratch : null;
  }

  /** Newest decoded tick: the `ackSnapshotTick` of the next input packet (−1 = none). */
  get newestTick(): number {
    return this.newest;
  }

  /**
   * Decodes a snapshot datagram against the stored baselines and keeps a copy. Returns the stored snapshot (valid
   * until its ring slot is reused 128 ticks later), or null when malformed or the baseline is gone.
   * `referenceTick` is the client's estimate of the server tick (or the newest received) for u16 unwrap.
   */
  decode(r: BitReader, referenceTick: number): Snapshot | null {
    this.eventsOnlyValid = false;
    if (!decodeSnapshotInto(r, referenceTick, this.lookup, this.scratch)) {
      this.eventsOnlyValid = this.scratch.eventsValid && this.scratch.header.serverTick > this.newest - this.size;
      return null;
    }
    // A very late snapshot would evict a newer baseline sharing its ring slot.
    if (this.scratch.header.serverTick <= this.newest - this.size) return null;
    const stored = this.ring.put(this.scratch);
    if (stored.header.serverTick > this.newest) this.newest = stored.header.serverTick;
    return stored;
  }

  get(tick: number): Snapshot | null {
    return this.ring.get(tick);
  }

  reset(): void {
    this.ring.clear();
    this.newest = -1;
    this.eventsOnlyValid = false;
  }
}
