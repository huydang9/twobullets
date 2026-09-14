import type { Session } from "@twobullets/netcode";
import { ServerSnapshotBaselines, type ServerInputBuffer } from "@twobullets/netcode";
import {
  createBitWriter,
  encodeSnapshot,
  NO_TICK,
  SNAPSHOT_MAX_BYTES,
  type BitWriter,
  type EntityState,
  type Mutable,
  type OwnerMoveBlock,
  type Snapshot,
  type SnapshotHeader,
} from "@twobullets/protocol";
import type { PlayerState } from "@twobullets/shared/input";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { createEntityState, createOwnerBlock, writeOwnerMove, writeRemoteEntity } from "./replication";

// Per-client snapshots (netcode.md §2.3, §6.5–6.7; architecture.md §6.4). M3: every player is sent to every client
// (no relevance), the owner block carries the recipient's move state, deltas go against the newest acked baseline.
// Backpressure (C18): skip when the send queue backs up, then drop to 30 Hz, then 20 Hz; step back up after 5 s clean.

export const SNAPSHOT_DIVISORS = [1, 2, 3] as const;
const DEGRADE_HOLD_MS = 1000;
const RECOVER_AFTER_MS = 5000;
/** A WS client is backlogged when more than this many snapshots sit in `bufferedAmount` (netcode.md §2.3). */
const QUEUED_SNAPSHOTS_LIMIT = 4;
/** WebTransport datagrams don't queue; a large `queuedBytes` there means the session itself is congested. */
const WT_QUEUED_BYTES_LIMIT = 16 * 1024;

/** What the builder needs from a player; the match owns the rest. */
export interface ReplicatedPlayer {
  readonly slot: number;
  readonly feet: Readonly<Vec3>;
  readonly state: PlayerState;
  readonly yawQ: number;
  readonly pitchQ: number;
  readonly buttons: number;
  readonly inputs: ServerInputBuffer;
  /** null while disconnected (the character stays in the world). */
  readonly session: Session | null;
  readonly net: ClientReplication;
}

interface MutableSnapshotView extends Snapshot {
  readonly header: Mutable<SnapshotHeader>;
  readonly owner: Mutable<OwnerMoveBlock>;
  readonly entities: EntityState[];
}

export class ClientReplication {
  readonly baselines = new ServerSnapshotBaselines();
  readonly writer: BitWriter = createBitWriter(SNAPSHOT_MAX_BYTES);
  readonly snapshot: MutableSnapshotView = {
    header: { serverTick: 0, baselineTick: null, lastProcessedInputTick: NO_TICK, clientTimeEcho: 0, serverHoldMs: 0, inputBufferDepthQ: 0, sections: 0 },
    owner: createOwnerBlock(),
    entities: [],
  };
  /** `clientTimeMs` of the newest input packet (by newest tick) and when it arrived; −1 before any. */
  echoTimeMs = -1;
  echoTick = -1;
  echoRecvMs = 0;
  divisorIndex = 0;
  lastDegradeMs = -Infinity;
  lastSnapshotBytes = 0;
  bytesOut = 0;
  snapshotsSent = 0;
  snapshotsSkipped = 0;
  encodeErrors = 0;

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

  /** New connection or Resync: next snapshot is full, rate back to 60 Hz. */
  reset(): void {
    this.baselines.reset();
    this.echoTimeMs = -1;
    this.echoTick = -1;
    this.divisorIndex = 0;
    this.lastDegradeMs = -Infinity;
  }
}

export interface SnapshotBuildStats {
  bytesOut: number;
  sent: number;
  skipped: number;
}

export class SnapshotBuilder {
  /** Quantized remote state per slot for the current tick, filled once and shared by every recipient. */
  private readonly remote: Mutable<EntityState>[] = [];
  private readonly remoteValid: Uint8Array;
  readonly stats: SnapshotBuildStats = { bytesOut: 0, sent: 0, skipped: 0 };

  constructor(maxSlots: number) {
    this.remoteValid = new Uint8Array(maxSlots);
    for (let i = 0; i < maxSlots; i++) this.remote.push(createEntityState());
  }

  /** `players` is dense and sorted by slot. `nowMs` is the send time (hold time, rate recovery). */
  build(tick: number, nowMs: number, players: readonly ReplicatedPlayer[]): void {
    const remote = this.remote;
    this.remoteValid.fill(0);
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      writeRemoteEntity(p.slot, p.feet, p.state.move, p.yawQ, p.pitchQ, p.buttons, remote[p.slot]!);
      this.remoteValid[p.slot] = 1;
    }
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.session !== null) this.buildFor(p, tick, nowMs, players);
    }
  }

  private buildFor(p: ReplicatedPlayer, tick: number, nowMs: number, players: readonly ReplicatedPlayer[]): void {
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
    const entities = snap.entities;
    entities.length = 0;
    for (let i = 0; i < players.length; i++) {
      const other = players[i]!;
      if (other.slot !== p.slot && this.remoteValid[other.slot] === 1) entities.push(this.remote[other.slot]!);
    }
    h.sections = 0;

    const w = net.writer;
    w.reset();
    try {
      encodeSnapshot(w, snap, baseline);
    } catch {
      net.encodeErrors++;
      this.skip(net, nowMs);
      return;
    }
    const bytes = w.bytes();
    const cap = session.maxDatagramSize > 0 ? Math.min(SNAPSHOT_MAX_BYTES, session.maxDatagramSize) : SNAPSHOT_MAX_BYTES;
    if (bytes.length > cap || !session.sendDatagram(bytes)) {
      this.skip(net, nowMs);
      return;
    }
    net.baselines.record(snap);
    net.lastSnapshotBytes = bytes.length;
    net.bytesOut += bytes.length;
    net.snapshotsSent++;
    this.stats.bytesOut += bytes.length;
    this.stats.sent++;
    if (net.divisorIndex > 0 && nowMs - net.lastDegradeMs >= RECOVER_AFTER_MS) {
      net.divisorIndex--;
      net.lastDegradeMs = nowMs;
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
