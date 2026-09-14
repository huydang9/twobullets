import type { Session } from "@twobullets/netcode";
import { ReliableEventSender, ServerSnapshotBaselines, type ServerInputBuffer } from "@twobullets/netcode";
import {
  createEntityState,
  createOwnerBlock,
  writeOwnerMove,
  writeOwnerVitals,
  writeOwnerWeapon,
  writeRemoteEntity,
  writeShotEvent,
} from "@twobullets/netcode/replication";
import {
  createBitWriter,
  createOwnerVitalsBlock,
  createOwnerWeaponBlock,
  createShotEvent,
  createSnapshotCapResult,
  encodeSnapshotCapped,
  NO_TICK,
  SNAPSHOT_MAX_BYTES,
  type BitWriter,
  type CappableSnapshot,
  type EntityState,
  type Mutable,
  type MutableOwnerWeaponBlock,
  type OwnerMoveBlock,
  type OwnerVitalsBlock,
  type PlayerHitEvent,
  type ReliableEvent,
  type ShotEvent,
  type SnapshotCapResult,
  type SnapshotHeader,
} from "@twobullets/protocol";
import type { ArmorLoadout } from "@twobullets/shared/equipment/armor";
import type { LifeState, Vitals } from "@twobullets/shared/equipment/vitals";
import type { PlayerState } from "@twobullets/shared/input";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { MAX_EVENT_AGE, type HitLog, type ShotLog } from "./eventLog";

// Per-client snapshots (netcode.md §2.3, §6.2, §6.5–6.7; architecture.md §6.4). M4: every player is sent to every client
// (relevance is M5). The owner block carries the recipient's move, weapon and vitals groups; remote entities carry
// weapon, life and armor flags. Tier-U `Shot`/`PlayerHit` events come from the match's shared logs, tier-R events from
// the recipient's ReliableEventSender within a bit budget; `encodeSnapshotCapped` enforces the size cap (drops U events,
// then far entities, never R events or the owner block) and the reliable selection is marked sent only after the
// datagram went out. Backpressure (C18): skip when the send queue backs up, then drop to 30 Hz, then 20 Hz; step back up
// after 5 s clean.

export const SNAPSHOT_DIVISORS = [1, 2, 3] as const;
const DEGRADE_HOLD_MS = 1000;
const RECOVER_AFTER_MS = 5000;
/** A WS client is backlogged when more than this many snapshots sit in `bufferedAmount` (netcode.md §2.3). */
const QUEUED_SNAPSHOTS_LIMIT = 4;
/** WebTransport datagrams don't queue; a large `queuedBytes` there means the session itself is congested. */
const WT_QUEUED_BYTES_LIMIT = 16 * 1024;
/** Bytes kept for header, owner block and entities when budgeting reliable events (measured combat max 244 B). */
const NON_RELIABLE_RESERVE_BYTES = 420;
/** Send-time ring for RTT samples (matches the baseline ring). */
const SENT_RING = 128;

/** What the builder needs from a player; the match owns the rest. */
export interface ReplicatedPlayer {
  readonly slot: number;
  readonly feet: Readonly<Vec3>;
  readonly state: PlayerState;
  readonly vitals: Vitals;
  readonly armor: ArmorLoadout;
  readonly life: LifeState;
  readonly yawQ: number;
  readonly pitchQ: number;
  readonly buttons: number;
  readonly inputs: ServerInputBuffer;
  /** null while disconnected (the character stays in the world). */
  readonly session: Session | null;
  readonly net: ClientReplication;
}

/** The builder's per-client snapshot; lists are trimmed in place by the capped encoder. */
interface MutableSnapshotView extends CappableSnapshot {
  readonly header: Mutable<SnapshotHeader>;
  readonly owner: Mutable<OwnerMoveBlock>;
  readonly entities: EntityState[];
  readonly weapon: MutableOwnerWeaponBlock;
  readonly vitals: Mutable<OwnerVitalsBlock>;
  readonly shots: ShotEvent[];
  readonly hits: PlayerHitEvent[];
  reliable: readonly ReliableEvent[];
}

export class ClientReplication {
  readonly baselines = new ServerSnapshotBaselines();
  readonly events = new ReliableEventSender();
  readonly writer: BitWriter = createBitWriter(SNAPSHOT_MAX_BYTES);
  readonly snapshot: MutableSnapshotView = {
    header: { serverTick: 0, baselineTick: null, lastProcessedInputTick: NO_TICK, clientTimeEcho: 0, serverHoldMs: 0, inputBufferDepthQ: 0, sections: 0 },
    owner: createOwnerBlock(),
    entities: [],
    weapon: createOwnerWeaponBlock(),
    vitals: createOwnerVitalsBlock(),
    shots: [],
    hits: [],
    reliable: [],
  };
  readonly cap: SnapshotCapResult = createSnapshotCapResult();
  /** Pools behind `snapshot.shots` (grows to the busiest snapshot, then stays). */
  private readonly shotPool: Mutable<ShotEvent>[] = [];
  private readonly sentTicks = new Float64Array(SENT_RING).fill(-1);
  private readonly sentMs = new Float64Array(SENT_RING);
  /** `clientTimeMs` of the newest input packet (by newest tick) and when it arrived; −1 before any. */
  echoTimeMs = -1;
  echoTick = -1;
  echoRecvMs = 0;
  /** Tier-U events up to this tick went out in a sent snapshot. */
  lastEventTick = -1;
  divisorIndex = 0;
  lastDegradeMs = -Infinity;
  lastSnapshotBytes = 0;
  bytesOut = 0;
  snapshotsSent = 0;
  snapshotsSkipped = 0;
  encodeErrors = 0;
  droppedShots = 0;
  droppedHits = 0;
  droppedEntities = 0;
  /** Reliable queue overflows (the client should resync). */
  reliableOverflows = 0;

  get divisor(): number {
    return SNAPSHOT_DIVISORS[this.divisorIndex]!;
  }

  /** Records an input packet's echo fields (called from the datagram handler). */
  onInputPacket(newestTick: number, clientTimeMs: number, recvMs: number): void {
    if (newestTick <= this.echoTick) return;
    this.echoTick = newestTick;
    this.echoTimeMs = clientTimeMs;
    this.echoRecvMs = recvMs;
  }

  /** Send time of the snapshot for `tick`, or NaN when unknown. */
  sentTimeOf(tick: number): number {
    if (tick < 0) return NaN;
    const i = tick & (SENT_RING - 1);
    return this.sentTicks[i] === tick ? this.sentMs[i]! : NaN;
  }

  /** Queues a reliable event for this client. */
  push(event: ReliableEvent): void {
    if (this.events.push(event) < 0) this.reliableOverflows++;
  }

  /** New connection or Resync: next snapshot is full, rate back to 60 Hz, reliable queue restarts at seq 0. */
  reset(currentTick = -1): void {
    this.baselines.reset();
    this.events.reset();
    this.sentTicks.fill(-1);
    this.echoTimeMs = -1;
    this.echoTick = -1;
    this.divisorIndex = 0;
    this.lastDegradeMs = -Infinity;
    this.lastEventTick = currentTick;
  }

  recordSent(tick: number, nowMs: number): void {
    const i = tick & (SENT_RING - 1);
    this.sentTicks[i] = tick;
    this.sentMs[i] = nowMs;
  }

  shotStore(index: number): Mutable<ShotEvent> {
    while (this.shotPool.length <= index) this.shotPool.push(createShotEvent());
    return this.shotPool[index]!;
  }
}

export interface SnapshotBuildStats {
  bytesOut: number;
  sent: number;
  skipped: number;
  droppedShots: number;
  droppedHits: number;
  droppedEntities: number;
}

export interface SnapshotEventSource {
  readonly shots: ShotLog;
  readonly hits: HitLog;
}

const MAX_SHOTS = 63;
const MAX_HITS = 31;

export class SnapshotBuilder {
  /** Quantized remote state per slot for the current tick, filled once and shared by every recipient. */
  private readonly remote: Mutable<EntityState>[] = [];
  private readonly remoteValid: Uint8Array;
  readonly stats: SnapshotBuildStats = { bytesOut: 0, sent: 0, skipped: 0, droppedShots: 0, droppedHits: 0, droppedEntities: 0 };

  constructor(maxSlots: number) {
    this.remoteValid = new Uint8Array(maxSlots);
    for (let i = 0; i < maxSlots; i++) this.remote.push(createEntityState());
  }

  /** `players` is dense and sorted by slot. `nowMs` is the send time (hold time, RTT, rate recovery). */
  build(tick: number, nowMs: number, players: readonly ReplicatedPlayer[], events: SnapshotEventSource | null = null): void {
    const remote = this.remote;
    this.remoteValid.fill(0);
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      writeRemoteEntity(p.slot, p.feet, p.state.move, p.yawQ, p.pitchQ, p.buttons, remote[p.slot]!, p.state.weapon, p.life, p.armor);
      this.remoteValid[p.slot] = 1;
    }
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.session !== null) this.buildFor(p, tick, nowMs, players, events);
    }
  }

  private buildFor(p: ReplicatedPlayer, tick: number, nowMs: number, players: readonly ReplicatedPlayer[], events: SnapshotEventSource | null): void {
    const net = p.net;
    const session = p.session!;
    if (tick % net.divisor !== 0) return;
    const queued = session.queuedBytes();
    const limit = session.kind === "websocket" ? QUEUED_SNAPSHOTS_LIMIT * Math.max(net.lastSnapshotBytes, 64) : WT_QUEUED_BYTES_LIMIT;
    if (queued > limit) {
      this.skip(net, nowMs);
      return;
    }

    const snap = net.snapshot;
    const h = snap.header;
    h.serverTick = tick;
    const baseline = net.baselines.baselineFor(tick);
    h.baselineTick = baseline === null ? null : baseline.header.serverTick;
    h.lastProcessedInputTick = p.inputs.lastProcessedInputTick;
    h.clientTimeEcho = net.echoTimeMs < 0 ? 0 : net.echoTimeMs;
    const hold = net.echoTimeMs < 0 ? 0 : nowMs - net.echoRecvMs;
    h.serverHoldMs = hold < 0 ? 0 : hold > 255 ? 255 : hold;
    h.inputBufferDepthQ = p.inputs.depthQ;
    writeOwnerMove(p.feet, p.state.move, snap.owner);
    writeOwnerWeapon(p.state.weapon, snap.weapon);
    writeOwnerVitals(p.vitals, p.armor, snap.vitals);
    const entities = snap.entities;
    entities.length = 0;
    for (let i = 0; i < players.length; i++) {
      const other = players[i]!;
      if (other.slot !== p.slot && this.remoteValid[other.slot] === 1) entities.push(this.remote[other.slot]!);
    }
    this.collectEvents(p, tick, events);
    h.sections = 0;

    const cap = session.maxDatagramSize > 0 ? Math.min(SNAPSHOT_MAX_BYTES, session.maxDatagramSize) : SNAPSHOT_MAX_BYTES;
    snap.reliable = net.events.select((cap - NON_RELIABLE_RESERVE_BYTES) * 8);
    const w = net.writer;
    const result = net.cap;
    try {
      encodeSnapshotCapped(w, snap, baseline, cap, result);
    } catch {
      net.encodeErrors++;
      this.skip(net, nowMs);
      return;
    }
    if (!result.fits || !session.sendDatagram(w.bytes())) {
      this.skip(net, nowMs);
      return;
    }
    net.events.markSent(tick);
    net.baselines.record(snap);
    net.recordSent(tick, nowMs);
    net.lastEventTick = tick;
    const bytes = w.byteLength;
    net.lastSnapshotBytes = bytes;
    net.bytesOut += bytes;
    net.snapshotsSent++;
    net.droppedShots += result.droppedShots;
    net.droppedHits += result.droppedHits;
    net.droppedEntities += result.droppedAudible + result.droppedFull;
    const st = this.stats;
    st.bytesOut += bytes;
    st.sent++;
    st.droppedShots += result.droppedShots;
    st.droppedHits += result.droppedHits;
    st.droppedEntities += result.droppedAudible + result.droppedFull;
    if (net.divisorIndex > 0 && nowMs - net.lastDegradeMs >= RECOVER_AFTER_MS) {
      net.divisorIndex--;
      net.lastDegradeMs = nowMs;
    }
  }

  /** Tier-U events since the recipient's last sent snapshot: shots by others, hits on others (oldest first). */
  private collectEvents(p: ReplicatedPlayer, tick: number, events: SnapshotEventSource | null): void {
    const net = p.net;
    const snap = net.snapshot;
    snap.shots.length = 0;
    snap.hits.length = 0;
    if (events === null) return;
    const oldest = Math.max(net.lastEventTick + 1, tick - MAX_EVENT_AGE);
    const shots = events.shots;
    for (let k = 0; k < shots.count && snap.shots.length < MAX_SHOTS; k++) {
      const s = shots.at(k);
      if (s.tick < oldest || s.tick > tick || s.shooter === p.slot || this.remoteValid[s.shooter] !== 1) continue;
      const out = net.shotStore(snap.shots.length);
      writeShotEvent(s.shooter, tick - s.tick, s.weaponId, s.shotId, s.spreadDegrees, s.yawQ, s.pitchQ, s.origin, this.remote[s.shooter]!, out);
      snap.shots.push(out);
    }
    const hits = events.hits;
    for (let k = 0; k < hits.count && snap.hits.length < MAX_HITS; k++) {
      const e = hits.at(k);
      if (e.tick < oldest || e.tick > tick || e.event.victim === p.slot) continue;
      snap.hits.push(e.event);
    }
  }

  private skip(net: ClientReplication, nowMs: number): void {
    net.snapshotsSkipped++;
    this.stats.skipped++;
    if (nowMs - net.lastDegradeMs >= DEGRADE_HOLD_MS) {
      if (net.divisorIndex < SNAPSHOT_DIVISORS.length - 1) net.divisorIndex++;
      net.lastDegradeMs = nowMs;
    }
  }
}
