import { ClientSnapshotStore } from "@twobullets/netcode/baselines";
import { InterpolationDelay } from "@twobullets/netcode/interpolation";
import type { Clock } from "@twobullets/netcode/testing/clock";
import { TimeSync } from "@twobullets/netcode/timeSync";
import type { Session } from "@twobullets/netcode/transport/Session";
import { createBitReader, createBitWriter } from "@twobullets/protocol/bits";
import {
  decodeDisconnect,
  decodeResyncResponse,
  decodeWelcome,
  DisconnectReason,
  encodeDisconnect,
  encodeHello,
  encodeResyncRequest,
  ResyncScope,
  type Welcome,
} from "@twobullets/protocol/messages/control";
import { MsgId } from "@twobullets/protocol/messages/ids";
import { encodeInputPacket, MAX_INPUTS_PER_PACKET, type InputPacket } from "@twobullets/protocol/messages/input";
import { decodePing, encodePing, pingRttMs } from "@twobullets/protocol/messages/ping";
import type { Mutable } from "@twobullets/protocol/messages/snapshot";
import type { PlayerInput } from "@twobullets/shared/input";
import { CLOSE_CODE_CLIENT_LEAVE, describeCloseCode, describeDisconnectReason, helloFor, WELCOME_TIMEOUT_MS } from "./handshake";
import type { LocalPlayerNet } from "./LocalPlayerNet";
import type { NetClock } from "./NetClock";
import type { RemoteRoster } from "./RemoteRoster";

export type NetConnectionState = "handshaking" | "syncing" | "playing" | "disconnected";

/** Hard resync when the client tick is further than this from the target (netcode.md §11.1). */
export const RESYNC_TICKS = 10;
/** Startup: snapshots and ping echoes to collect before ticking (§11.1: 10 echoes over ~500 ms). */
const SYNC_SNAPSHOTS = 10;
const SYNC_PINGS = 5;
const SYNC_MAX_MS = 2000;
const SYNC_PING_INTERVAL_MS = 50;
const PLAY_PING_INTERVAL_MS = 1000;
/** No snapshot for this long shows "connection interrupted" (§4.2). */
const INTERRUPTED_MS = 1000;
/** Consecutive undecodable snapshots (baseline gone) before asking for a full one. */
const DECODE_FAILURES_FOR_RESYNC = 30;
const RESYNC_REQUEST_INTERVAL_MS = 500;

export interface NetStats {
  state: NetConnectionState;
  transport: Session["kind"];
  fallbackReason: string;
  slot: number;
  team: number;
  rttMs: number;
  rttMinMs: number;
  jitterMs: number;
  lossPct: number;
  /** Server-reported input buffer depth, ticks (smoothed) and its target. */
  bufferDepthTicks: number;
  bufferTargetTicks: number;
  tickScale: number;
  interpDelayMs: number;
  clientTick: number;
  /** Client tick − estimated server tick. */
  leadTicks: number;
  correctionsPerMin: number;
  corrections: number;
  lastCorrectionCm: number;
  meanCorrectionCm: number;
  replayedTicks: number;
  resyncs: number;
  decodeFailures: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  remoteCount: number;
  extrapolatedPct: number;
  interrupted: boolean;
  disconnectReason: string;
}

export interface NetClientOptions {
  readonly clock: Clock;
  readonly netClock: NetClock;
  readonly local: LocalPlayerNet;
  /** Sampled inputs by tick (PlayerController.inputHistory). */
  readonly inputs: { get(tick: number): PlayerInput | null };
  readonly roster: RemoteRoster;
  readonly joinToken: string;
  /** WS fallback raises the interpolation floor to 50 ms. */
  readonly interpFloorMs?: number;
  readonly fallbackReason?: string;
  readonly onStateChange?: (state: NetConnectionState, client: NetClient) => void;
}

/**
 * One match connection (netcode.md §3, §4, §11): Hello/Welcome, clock sync and startup, inputs every predicted tick
 * with redundancy, snapshot decode → time sync, time dilation, remote interpolation buffers and local reconciliation,
 * pings, hard resync and disconnect state. Transport-agnostic (`Session`) and clock-injected so tests drive it on a
 * virtual clock through `LinkConditioner`.
 *
 * Frame order: `update(dt)` before `PlayerController.update` (it may resync the clock and sets the smoothing offset),
 * then `RemotePlayers.update`. Predicted ticks call `onPredictedTick`.
 */
export class NetClient {
  readonly stats: NetStats;
  readonly sync = new TimeSync();
  readonly interpDelay: InterpolationDelay;
  readonly store = new ClientSnapshotStore();
  private readonly session: Session;
  private readonly clock: Clock;
  private readonly netClock: NetClock;
  private readonly local: LocalPlayerNet;
  private readonly inputs: { get(tick: number): PlayerInput | null };
  private readonly roster: RemoteRoster;
  private readonly joinToken: string;
  private readonly onStateChange: ((state: NetConnectionState, client: NetClient) => void) | null;
  private readonly writer = createBitWriter(1500);
  private readonly reader = createBitReader(new Uint8Array(0));
  private readonly packetInputs: PlayerInput[] = [];
  private readonly packet: Mutable<InputPacket>;
  private welcome: Welcome | null = null;
  private stateStartedMs = 0;
  private lastPingMs = -Infinity;
  private pingSeq = 0;
  private pingReplies = 0;
  private lastProcessedInput = -1;
  private newestOwnerTick = -1;
  private lastSnapshotMs = 0;
  private decodeFailStreak = 0;
  private lastResyncRequestMs = -Infinity;
  private bytesIn = 0;
  private bytesOut = 0;
  private rateWindowStartMs = 0;
  private renderTickValue = 0;

  constructor(session: Session, options: NetClientOptions) {
    this.session = session;
    this.clock = options.clock;
    this.netClock = options.netClock;
    this.local = options.local;
    this.inputs = options.inputs;
    this.roster = options.roster;
    this.joinToken = options.joinToken;
    this.onStateChange = options.onStateChange ?? null;
    this.interpDelay = new InterpolationDelay({ floorMs: options.interpFloorMs ?? (session.kind === "websocket" ? 50 : 25) });
    this.packet = { newestTick: 0, ackSnapshotTick: -1, clientTimeMs: 0, interpDelayMs: 0, inputs: this.packetInputs };
    this.stats = {
      state: "handshaking",
      transport: session.kind,
      fallbackReason: options.fallbackReason ?? "",
      slot: -1,
      team: -1,
      rttMs: 0,
      rttMinMs: 0,
      jitterMs: 0,
      lossPct: 0,
      bufferDepthTicks: 0,
      bufferTargetTicks: 0,
      tickScale: 1,
      interpDelayMs: 0,
      clientTick: 0,
      leadTicks: 0,
      correctionsPerMin: 0,
      corrections: 0,
      lastCorrectionCm: 0,
      meanCorrectionCm: 0,
      replayedTicks: 0,
      resyncs: 0,
      decodeFailures: 0,
      bytesInPerSec: 0,
      bytesOutPerSec: 0,
      remoteCount: 0,
      extrapolatedPct: 0,
      interrupted: false,
      disconnectReason: "",
    };
    const onMessage = (bytes: Uint8Array, recvMs: number) => this.handleMessage(bytes, recvMs);
    session.onDatagram(onMessage);
    session.onStream((bytes) => onMessage(bytes, this.clock.now()));
  }

  get state(): NetConnectionState {
    return this.stats.state;
  }

  get playerSlot(): number {
    return this.welcome?.playerSlot ?? -1;
  }

  /** Fractional server tick remote players render at this frame. */
  get renderTick(): number {
    return this.renderTickValue;
  }

  /** Sends Hello; Welcome must follow within WELCOME_TIMEOUT_MS. */
  start(): void {
    this.writer.reset();
    encodeHello(this.writer, helloFor(this.joinToken, this.session.kind === "websocket" ? "ws" : "wt", this.session.maxDatagramSize));
    this.sendStream();
    this.stateStartedMs = this.clock.now();
    this.rateWindowStartMs = this.stateStartedMs;
  }

  /** After each predicted tick (not replays): record the prediction and send inputs with redundancy. */
  onPredictedTick(input: PlayerInput): void {
    if (this.stats.state !== "playing") return;
    this.local.recordTick(input);
    this.sendInputs(input.tick);
  }

  /** Once per render frame, before the player's update. */
  update(dtSec: number): void {
    const now = this.clock.now();
    const state = this.stats.state;
    if (state === "handshaking") {
      if (now - this.stateStartedMs > WELCOME_TIMEOUT_MS) this.fail("no Welcome from the server (handshake timeout)");
    } else if (state === "syncing") {
      this.maybePing(now, SYNC_PING_INTERVAL_MS);
      this.maybeStart(now);
    } else if (state === "playing") {
      this.maybePing(now, PLAY_PING_INTERVAL_MS);
      const dilation = this.netClock.dilation;
      dilation.setJitter(this.sync.jitterMs);
      const target = this.sync.clientTargetTickAt(now, dilation.targetTicks);
      if (Math.abs(this.netClock.currentTick - target) > RESYNC_TICKS) this.hardResync(now, target);
      this.stats.interrupted = now - this.lastSnapshotMs > INTERRUPTED_MS;
    }
    if (state === "playing" || state === "syncing") {
      const delay = this.interpDelay.update(now, this.sync.tickMs, this.sync.lossRatio(), this.sync.arrivalSpreadMs);
      this.renderTickValue = this.sync.renderTickAt(now, delay);
      this.stats.remoteCount = this.roster.sample(this.renderTickValue);
    }
    this.local.update(dtSec);
    this.updateStats(now);
  }

  /** Leaves the match: Disconnect{clientLeave}, then close. */
  disconnect(): void {
    if (this.stats.state === "disconnected") return;
    this.writer.reset();
    encodeDisconnect(this.writer, { reason: DisconnectReason.clientLeave, detail: 0 });
    this.sendStream();
    this.setState("disconnected", "left the match");
    this.session.close(CLOSE_CODE_CLIENT_LEAVE);
  }

  /** The transport closed underneath (wire from `OpenedTransport.onClose`). */
  handleTransportClosed(code: number): void {
    if (this.stats.state !== "disconnected") this.setState("disconnected", describeCloseCode(code));
  }

  private handleMessage(bytes: Uint8Array, recvMs: number): void {
    if (this.stats.state === "disconnected" || bytes.length === 0) return;
    this.bytesIn += bytes.length;
    const reader = this.reader;
    reader.reset(bytes);
    switch (bytes[0]) {
      case MsgId.Snapshot:
        this.handleSnapshot(recvMs);
        break;
      case MsgId.Ping: {
        const ping = decodePing(reader);
        if (ping === null) return;
        if (ping.reply) {
          this.sync.addRttSample(pingRttMs(ping, recvMs), recvMs);
          this.pingReplies++;
        } else {
          this.writer.reset();
          encodePing(this.writer, { seq: ping.seq, originTimeMs: ping.originTimeMs, holdMs: this.clock.now() - recvMs, reply: true });
          this.sendDatagram();
        }
        break;
      }
      case MsgId.Welcome: {
        const welcome = decodeWelcome(reader);
        if (welcome === null || this.stats.state !== "handshaking") return;
        this.welcome = welcome;
        this.stats.slot = welcome.playerSlot;
        this.stats.team = welcome.teamId;
        this.roster.setOwnSlot(welcome.playerSlot);
        if (welcome.interpFloorMs > 0) this.interpDelay.setFloor(Math.max(welcome.interpFloorMs, this.session.kind === "websocket" ? 50 : 25));
        this.setState("syncing", "");
        break;
      }
      case MsgId.Disconnect: {
        const message = decodeDisconnect(reader);
        this.setState("disconnected", message ? describeDisconnectReason(message.reason) : "disconnected by the server");
        break;
      }
      case MsgId.Resync:
        // Response: the server reset our baselines; the next snapshot is full. Nothing else to do on the client.
        decodeResyncResponse(reader);
        break;
      default:
        break;
    }
  }

  private handleSnapshot(recvMs: number): void {
    if (this.welcome === null) return;
    const sync = this.sync;
    const reference = sync.newestSnapshotTick >= 0 ? sync.newestSnapshotTick : this.welcome.serverTick;
    const snap = this.store.decode(this.reader, reference);
    if (snap === null) {
      this.stats.decodeFailures++;
      if (++this.decodeFailStreak >= DECODE_FAILURES_FOR_RESYNC) this.requestResync(recvMs);
      return;
    }
    this.decodeFailStreak = 0;
    this.lastSnapshotMs = recvMs;
    const h = snap.header;
    sync.onSnapshot(h.serverTick, recvMs, h.lastProcessedInputTick >= 0 ? h.clientTimeEcho : -1, h.serverHoldMs);
    if (h.lastProcessedInputTick > this.lastProcessedInput) this.lastProcessedInput = h.lastProcessedInputTick;
    const playing = this.stats.state === "playing";
    if (playing && h.lastProcessedInputTick >= 0) this.netClock.dilation.onBufferDepth(h.inputBufferDepthQ / 4, recvMs);
    this.roster.onSnapshot(h.serverTick, snap.entities);
    if (snap.owner === null) return;
    if (h.serverTick > this.newestOwnerTick) this.newestOwnerTick = h.serverTick;
    if (playing) this.local.onOwnerState(h.serverTick, snap.owner, recvMs);
  }

  private maybeStart(now: number): void {
    const sync = this.sync;
    if (sync.sampleCount < SYNC_SNAPSHOTS || this.newestOwnerTick < 0) return;
    if (this.pingReplies < SYNC_PINGS && now - this.stateStartedMs < SYNC_MAX_MS) return;
    const owner = this.store.get(this.newestOwnerTick)?.owner;
    if (!owner) return;
    this.local.startFrom(owner);
    const dilation = this.netClock.dilation;
    dilation.setJitter(sync.jitterMs);
    this.netClock.start(Math.ceil(sync.clientTargetTickAt(now, dilation.targetTicks)));
    this.lastSnapshotMs = now;
    this.setState("playing", "");
  }

  private hardResync(now: number, target: number): void {
    this.netClock.resync(Math.round(target));
    this.local.clearHistory();
    this.stats.resyncs++;
    this.requestResync(now);
  }

  private requestResync(now: number): void {
    if (now - this.lastResyncRequestMs < RESYNC_REQUEST_INTERVAL_MS) return;
    this.lastResyncRequestMs = now;
    this.decodeFailStreak = 0;
    this.writer.reset();
    encodeResyncRequest(this.writer, { scope: ResyncScope.state });
    this.sendStream();
  }

  private maybePing(now: number, interval: number): void {
    if (now - this.lastPingMs < interval) return;
    this.lastPingMs = now;
    this.writer.reset();
    encodePing(this.writer, { seq: this.pingSeq++ & 0xff, originTimeMs: Math.floor(now) & 0xffff, holdMs: 0, reply: false });
    this.sendDatagram();
  }

  private sendInputs(newest: number): void {
    const list = this.packetInputs;
    list.length = 0;
    for (let t = newest; t > newest - MAX_INPUTS_PER_PACKET && (t > this.lastProcessedInput || t === newest); t--) {
      const input = this.inputs.get(t);
      if (input === null) break;
      list.push(input);
    }
    if (list.length === 0) return;
    const packet = this.packet;
    packet.newestTick = newest;
    packet.ackSnapshotTick = this.store.newestTick;
    packet.clientTimeMs = Math.floor(this.clock.now()) & 0xffff;
    packet.interpDelayMs = this.interpDelay.delayMs;
    this.writer.reset();
    encodeInputPacket(this.writer, packet);
    this.sendDatagram();
  }

  private sendDatagram(): void {
    const bytes = this.writer.bytes();
    if (this.session.sendDatagram(bytes)) this.bytesOut += bytes.length;
  }

  private sendStream(): void {
    const bytes = this.writer.bytes();
    this.session.sendStream(bytes);
    this.bytesOut += bytes.length;
  }

  private fail(reason: string): void {
    this.setState("disconnected", reason);
    this.session.close(CLOSE_CODE_CLIENT_LEAVE);
  }

  private setState(state: NetConnectionState, reason: string): void {
    if (this.stats.state === state) return;
    this.stats.state = state;
    this.stateStartedMs = this.clock.now();
    if (state === "disconnected") {
      this.stats.disconnectReason = reason;
      this.netClock.stop();
    }
    this.onStateChange?.(state, this);
  }

  private updateStats(now: number): void {
    const s = this.stats;
    const sync = this.sync;
    const dilation = this.netClock.dilation;
    s.rttMs = sync.rttMs;
    s.rttMinMs = sync.rttMinMs;
    s.jitterMs = sync.jitterMs;
    s.lossPct = sync.lossRatio() * 100;
    s.bufferDepthTicks = dilation.depthTicks;
    s.bufferTargetTicks = dilation.targetTicks;
    s.tickScale = dilation.tickScale;
    s.interpDelayMs = this.interpDelay.delayMs;
    s.clientTick = this.netClock.currentTick;
    s.leadTicks = sync.sampleCount > 0 ? this.netClock.currentTick - sync.serverTickAt(now) : 0;
    const ls = this.local.stats;
    s.corrections = ls.corrections;
    s.correctionsPerMin = this.local.correctionsPerMinute(now);
    s.lastCorrectionCm = ls.lastCorrectionM * 100;
    s.meanCorrectionCm = ls.corrections > 0 ? (ls.sumCorrectionM / ls.corrections) * 100 : 0;
    s.replayedTicks = ls.replayedTicks;
    s.extrapolatedPct = this.roster.sampledFrames > 0 ? (this.roster.extrapolatedFrames / this.roster.sampledFrames) * 100 : 0;
    const elapsed = now - this.rateWindowStartMs;
    if (elapsed >= 1000) {
      s.bytesInPerSec = (this.bytesIn * 1000) / elapsed;
      s.bytesOutPerSec = (this.bytesOut * 1000) / elapsed;
      this.bytesIn = 0;
      this.bytesOut = 0;
      this.rateWindowStartMs = now;
    }
  }
}
