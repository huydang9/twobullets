import {
  copyReliableEvent,
  createReliableEventStore,
  MAX_RELIABLE_PER_SNAPSHOT,
  RELIABLE_SEQ_BITS,
  RELIABLE_SEQ_MASK,
  RELIABLE_TYPE_BITS,
  reliablePayloadBits,
  type ReliableEvent,
  type ReliableEventStore,
} from "@twobullets/protocol/messages/events";

// Tier R: reliable-over-unreliable events inside snapshots (netcode.md §6.2, §11.2). The server queues events per
// client with a u32 sequence (12 bits on the wire), puts every unacked one into snapshots within a bit budget (the first
// two sends back to back, then every `resendInterval`-th snapshot), and drops them once acked: either a snapshot that
// carried them is acked (`Input.ackSnapshotTick`) or the client's cumulative in-order ack covers them
// (`Input.ackEventSeq`). The client delivers each seq exactly once, in order.

const HALF_SEQ = 1 << (RELIABLE_SEQ_BITS - 1);
/** Snapshot-tick inclusion records (matches the baseline ring: an ack older than this can't be matched anyway). */
const RECORD_RING = 128;

export interface ReliableSenderOptions {
  /** Queued (unacked) events; `push` fails beyond it. ≤ 2048 so 12-bit seqs stay unambiguous. Default 256. */
  readonly capacity?: number;
  /** After the first two sends, resend every Nth snapshot (netcode.md §6.2: 2). */
  readonly resendInterval?: number;
  /** Events per snapshot, ≤ 63. */
  readonly maxPerSnapshot?: number;
}

export interface ReliableSenderStats {
  pushed: number;
  acked: number;
  /** Event transmissions (an event in three snapshots counts three). */
  transmissions: number;
  /** `push` refused because the queue was full (the session should resync). */
  overflows: number;
  maxPending: number;
}

export class ReliableEventSender {
  readonly capacity: number;
  readonly resendInterval: number;
  readonly maxPerSnapshot: number;
  readonly stats: ReliableSenderStats = { pushed: 0, acked: 0, transmissions: 0, overflows: 0, maxPending: 0 };

  // Queue ring: entry k (0 = oldest) lives at (head + k) % capacity and has seq headSeq + k.
  private readonly events: ReliableEventStore[] = [];
  private readonly ackedFlag: Uint8Array;
  private readonly sends: Uint16Array;
  private readonly lastSentSnapshot: Float64Array;
  private head = 0;
  private count = 0;
  private headSeq = 0;
  private snapshotIndex = 0;

  // Current selection (valid until the next select), and per-tick inclusion records.
  private readonly selection: ReliableEvent[] = [];
  private readonly selectionSeqs: Float64Array;
  private readonly recordTick = new Float64Array(RECORD_RING).fill(-1);
  private readonly recordCount = new Uint8Array(RECORD_RING);
  private readonly recordSeqs: Float64Array;

  constructor(options: ReliableSenderOptions = {}) {
    const capacity = options.capacity ?? 256;
    if (capacity < 1 || capacity > HALF_SEQ) throw new RangeError(`capacity must be 1..${HALF_SEQ}`);
    this.capacity = capacity;
    this.resendInterval = Math.max(1, options.resendInterval ?? 2);
    this.maxPerSnapshot = Math.min(MAX_RELIABLE_PER_SNAPSHOT, Math.max(1, options.maxPerSnapshot ?? MAX_RELIABLE_PER_SNAPSHOT));
    this.ackedFlag = new Uint8Array(capacity);
    this.sends = new Uint16Array(capacity);
    this.lastSentSnapshot = new Float64Array(capacity);
    for (let i = 0; i < capacity; i++) this.events.push(createReliableEventStore());
    this.selectionSeqs = new Float64Array(this.maxPerSnapshot);
    this.recordSeqs = new Float64Array(RECORD_RING * this.maxPerSnapshot);
  }

  /** Unacked events. */
  get pending(): number {
    return this.count;
  }

  /** u32 seq the next `push` gets (its wire seq is the low 12 bits). */
  get nextSeq(): number {
    return this.headSeq + this.count;
  }

  /** Queues a copy of `event` (its `seq` is ignored). Returns the 12-bit wire seq, or −1 when the queue is full. */
  push(event: ReliableEvent): number {
    if (this.count >= this.capacity) {
      this.stats.overflows++;
      return -1;
    }
    const index = (this.head + this.count) % this.capacity;
    const seq = this.headSeq + this.count;
    const store = this.events[index]!;
    copyReliableEvent(event, store);
    store.seq = seq & RELIABLE_SEQ_MASK;
    this.ackedFlag[index] = 0;
    this.sends[index] = 0;
    this.lastSentSnapshot[index] = -Infinity;
    this.count++;
    this.stats.pushed++;
    if (this.count > this.stats.maxPending) this.stats.maxPending = this.count;
    return store.seq;
  }

  /**
   * Events to put in the next snapshot, ascending seq, within `budgetBits` of reliable section (count field included).
   * The list is reused; call `markSent(tick)` once the snapshot actually went out.
   */
  select(budgetBits: number): readonly ReliableEvent[] {
    const out = this.selection;
    out.length = 0;
    let bits = 6;
    let prevSeq = -2;
    for (let k = 0; k < this.count && out.length < this.maxPerSnapshot; k++) {
      const index = (this.head + k) % this.capacity;
      if (this.ackedFlag[index] === 1) continue;
      const sends = this.sends[index]!;
      if (sends >= 2 && this.snapshotIndex - this.lastSentSnapshot[index]! < this.resendInterval) continue;
      const seq = this.headSeq + k;
      const e = this.events[index]!;
      const seqBits = out.length === 0 ? RELIABLE_SEQ_BITS : seq === prevSeq + 1 ? 1 : 1 + RELIABLE_SEQ_BITS;
      const cost = seqBits + RELIABLE_TYPE_BITS + reliablePayloadBits(e.type);
      if (bits + cost > budgetBits) break;
      bits += cost;
      this.selectionSeqs[out.length] = seq;
      out.push(e as ReliableEvent);
      prevSeq = seq;
    }
    return out;
  }

  /** The last selection went out in the snapshot for `tick` (call once per sent snapshot; skipped snapshots don't). */
  markSent(tick: number): void {
    const n = this.selection.length;
    const r = tick & (RECORD_RING - 1);
    this.recordTick[r] = n > 0 ? tick : -1;
    this.recordCount[r] = n;
    const base = r * this.maxPerSnapshot;
    for (let i = 0; i < n; i++) {
      const seq = this.selectionSeqs[i]!;
      this.recordSeqs[base + i] = seq;
      const k = seq - this.headSeq;
      if (k < 0 || k >= this.count) continue;
      const index = (this.head + k) % this.capacity;
      this.sends[index] = Math.min(0xffff, this.sends[index]! + 1);
      this.lastSentSnapshot[index] = this.snapshotIndex;
    }
    this.stats.transmissions += n;
    this.snapshotIndex++;
  }

  /**
   * From each `Input`: `ackSnapshotTick` acks the events that snapshot carried; `ackEventSeq` (12-bit, −1 = none) acks
   * everything up to it. Stale, duplicate or unknown acks are ignored.
   */
  onAck(ackSnapshotTick: number, ackEventSeq: number): void {
    if (ackSnapshotTick >= 0) {
      const r = ackSnapshotTick & (RECORD_RING - 1);
      if (this.recordTick[r] === ackSnapshotTick) {
        const base = r * this.maxPerSnapshot;
        for (let i = 0; i < this.recordCount[r]!; i++) this.ackSeq(this.recordSeqs[base + i]!);
        this.recordTick[r] = -1;
      }
    }
    if (ackEventSeq >= 0 && this.count > 0) {
      const k = (ackEventSeq - (this.headSeq & RELIABLE_SEQ_MASK)) & RELIABLE_SEQ_MASK;
      if (k < this.count) for (let i = 0; i <= k; i++) this.ackSeq(this.headSeq + i);
    }
    while (this.count > 0 && this.ackedFlag[this.head] === 1) {
      this.head = (this.head + 1) % this.capacity;
      this.headSeq++;
      this.count--;
    }
  }

  /** New session or Resync: forget everything; the client's receiver must reset too. */
  reset(): void {
    this.head = 0;
    this.count = 0;
    this.headSeq = 0;
    this.snapshotIndex = 0;
    this.selection.length = 0;
    this.recordTick.fill(-1);
  }

  private ackSeq(seq: number): void {
    const k = seq - this.headSeq;
    if (k < 0 || k >= this.count) return;
    const index = (this.head + k) % this.capacity;
    if (this.ackedFlag[index] === 1) return;
    this.ackedFlag[index] = 1;
    this.stats.acked++;
  }
}

export interface ReliableReceiverStats {
  delivered: number;
  duplicates: number;
  /** Arrived ahead of a missing seq and waited in the reorder window. */
  outOfOrder: number;
  /** Beyond the reorder window (a sender bug or a missed reset). */
  dropped: number;
}

/**
 * Client side: dedupes by 12-bit seq and delivers in order. Events that arrive ahead of a gap wait (copied into a
 * preallocated window) until the gap fills; the sender resends the gap within a snapshot or two.
 */
export class ReliableEventReceiver {
  readonly window: number;
  readonly stats: ReliableReceiverStats = { delivered: 0, duplicates: 0, outOfOrder: 0, dropped: 0 };
  private readonly buffer: ReliableEventStore[] = [];
  private readonly present: Uint8Array;
  private base = 0;
  /** u32 seq expected next. */
  private expected = 0;

  constructor(window = 256) {
    if ((window & (window - 1)) !== 0 || window > HALF_SEQ) throw new RangeError("window must be a power of two ≤ 2048");
    this.window = window;
    this.present = new Uint8Array(window);
    for (let i = 0; i < window; i++) this.buffer.push(createReliableEventStore());
  }

  /** `Input.ackEventSeq`: newest seq delivered in order (12 bits), or −1 before the first. */
  get ackSeq(): number {
    return this.expected === 0 ? -1 : (this.expected - 1) & RELIABLE_SEQ_MASK;
  }

  /**
   * Accepts a snapshot's reliable events (any order, duplicates allowed) and calls `deliver` for each newly deliverable
   * one in seq order. The event passed to `deliver` is only valid during the call. Returns the number delivered.
   */
  receive(events: readonly ReliableEvent[], deliver: (event: ReliableEvent) => void): number {
    let delivered = 0;
    const mask = this.window - 1;
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      const d = ((((e.seq & RELIABLE_SEQ_MASK) - (this.expected & RELIABLE_SEQ_MASK) + HALF_SEQ) & RELIABLE_SEQ_MASK) - HALF_SEQ) | 0;
      if (d < 0) {
        this.stats.duplicates++;
        continue;
      }
      if (d >= this.window) {
        this.stats.dropped++;
        continue;
      }
      const index = (this.base + d) & mask;
      if (this.present[index] === 1) {
        this.stats.duplicates++;
        continue;
      }
      copyReliableEvent(e, this.buffer[index]!);
      this.present[index] = 1;
      if (d > 0) this.stats.outOfOrder++;
      while (this.present[this.base] === 1) {
        this.present[this.base] = 0;
        const ready = this.buffer[this.base] as ReliableEvent;
        this.base = (this.base + 1) & mask;
        this.expected++;
        this.stats.delivered++;
        delivered++;
        deliver(ready);
      }
    }
    return delivered;
  }

  reset(): void {
    this.present.fill(0);
    this.base = 0;
    this.expected = 0;
  }
}
