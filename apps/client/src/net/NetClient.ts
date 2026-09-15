import { ClientSnapshotStore } from "@twobullets/netcode/baselines";
import { InterpolationDelay } from "@twobullets/netcode/interpolation";
import { ReliableEventReceiver } from "@twobullets/netcode/reliableEvents";
import type { Clock } from "@twobullets/netcode/testing/clock";
import { TimeSync } from "@twobullets/netcode/timeSync";
import type { Session } from "@twobullets/netcode/transport/Session";
import { createBitReader, createBitWriter } from "@twobullets/protocol/bits";
import { LifeCode } from "@twobullets/protocol/codes";
import {
  decodeDisconnect,
  decodeKillFeed,
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
import { decodeMatchEnd, decodePhaseChange, decodeZonePhase, type MatchEnd, type PhaseChange, type ZonePhaseMessage } from "@twobullets/protocol/messages/match";
import { encodeInputPacket, MAX_INPUTS_PER_PACKET, type InputPacket } from "@twobullets/protocol/messages/input";
import { decodePing, encodePing, pingRttMs } from "@twobullets/protocol/messages/ping";
import { decodeRoster, type Roster } from "@twobullets/protocol/messages/roster";
import type { ReliableEvent } from "@twobullets/protocol/messages/events";
import type { Mutable, Snapshot } from "@twobullets/protocol/messages/snapshot";
import { Btn, type PlayerInput } from "@twobullets/shared/input";
import { t } from "../i18n";
import { CLOSE_CODE_CLIENT_LEAVE, describeCloseCode, describeDisconnectReason, helloFor, WELCOME_TIMEOUT_MS } from "./handshake";
import type { LocalPlayerNet } from "./LocalPlayerNet";
import type { NetEventSink } from "./NetCombat";
import { RESYNC_RESETS_RELIABLE_EVENTS, viewOffset8 } from "./netCombatRules";
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
/**
 * A snapshot handled this long after the previous frame (and 4 frame intervals) waited out a main-thread stall: its
 * receive time says nothing about the network, so it skips the offset, jitter and RTT estimates.
 */
const STALL_MIN_MS = 100;
/**
 * After start, a resync or a stall, the server's smoothed depth still describes the old alignment until inputs sent
 * since have reached it and this many ticks have passed (its depth EWMA is 0.1 per tick).
 */
const DEPTH_SETTLE_TICKS = 20;

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
  /** Weapon-state mispredictions (ammo, phase, shot counter, timers beyond tolerance). */
  weaponCorrectionsPerMin: number;
  weaponCorrections: number;
  /** `WeaponDiff` bits of the last weapon correction. */
  lastWeaponDiff: number;
  /** Owner life code from the newest vitals (`LifeCode`). */
  ownerLife: number;
  /** Reliable events delivered in order, and duplicates dropped. */
  eventsDelivered: number;
  eventDuplicates: number;
  /** Remote `Shot` events and `PlayerHit`s received. */
  shotsReceived: number;
  hitsReceived: number;
  resyncs: number;
  decodeFailures: number;
  /** Frame dt (plus hitch time given back) as % of wall time over the last second: 100 when frames are honest. */
  frameTimePct: number;
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
  /** M4 combat: snapshot events, reliable events in order, owner vitals and the kill feed. */
  readonly events?: NetEventSink | null;
  /** Receives the owner's life before each reconcile, so replays step with that tick's life gates. */
  readonly movement?: { life: number } | null;
  /** Battle royale lifecycle (protocol v4): PhaseChange, ZonePhase, MatchEnd, after the client state is updated. */
  readonly onMatchMessage?: (client: NetClient) => void;
  /** Roster (protocol v5): after Welcome and on every join, leave or bot fill; `client.matchRoster` is already updated. */
  readonly onRoster?: (roster: Roster, client: NetClient) => void;
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
  /** Tier R events: exactly once, in order; `ackSeq` rides every input. */
  readonly receiver = new ReliableEventReceiver();
  /** Newest PhaseChange (null until the first; Welcome also carries the phase). */
  matchPhase: PhaseChange | null = null;
  /** Announced zone phases by index order; run the shared `zoneAt(tick)` over them. */
  readonly zonePhases: ZonePhaseMessage[] = [];
  matchEnd: MatchEnd | null = null;
  /** Newest Roster (who holds each slot; bots carry `botIndex` for a localized name), null until the first. */
  matchRoster: Roster | null = null;
  private readonly session: Session;
  private readonly clock: Clock;
  private readonly netClock: NetClock;
  private readonly local: LocalPlayerNet;
  private readonly inputs: { get(tick: number): PlayerInput | null };
  private readonly roster: RemoteRoster;
  private readonly joinToken: string;
  private readonly onStateChange: ((state: NetConnectionState, client: NetClient) => void) | null;
  private readonly events: NetEventSink | null;
  private readonly movement: { life: number } | null;
  private readonly onMatchMessage: ((client: NetClient) => void) | null;
  private readonly onRoster: ((roster: Roster, client: NetClient) => void) | null;
  private deliverTick = 0;
  private readonly deliver = (event: ReliableEvent): void => this.events?.onReliableEvent(event, this.deliverTick);
  private ownerLife: number = LifeCode.alive;
  private newestVitalsTick = -1;
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
  private lastUpdateMs = -1;
  /** Smoothed wall time between frames, ms (≤ 100). */
  private frameIntervalMs = 1000 / 60;
  private burstTicks = 0;
  private frameTimeMs = 0;
  /** Depth reports count from snapshots of this server tick on (see DEPTH_SETTLE_TICKS). */
  private depthFromServerTick = 0;

  constructor(session: Session, options: NetClientOptions) {
    this.session = session;
    this.clock = options.clock;
    this.netClock = options.netClock;
    this.local = options.local;
    this.inputs = options.inputs;
    this.roster = options.roster;
    this.joinToken = options.joinToken;
    this.onStateChange = options.onStateChange ?? null;
    this.events = options.events ?? null;
    this.movement = options.movement ?? null;
    this.onMatchMessage = options.onMatchMessage ?? null;
    this.onRoster = options.onRoster ?? null;
    this.interpDelay = new InterpolationDelay({ floorMs: options.interpFloorMs ?? (session.kind === "websocket" ? 50 : 25) });
    this.packet = { newestTick: 0, ackSnapshotTick: -1, clientTimeMs: 0, interpDelayMs: 0, ackEventSeq: -1, inputs: this.packetInputs };
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
      weaponCorrectionsPerMin: 0,
      weaponCorrections: 0,
      lastWeaponDiff: 0,
      ownerLife: LifeCode.alive,
      eventsDelivered: 0,
      eventDuplicates: 0,
      shotsReceived: 0,
      hitsReceived: 0,
      resyncs: 0,
      decodeFailures: 0,
      frameTimePct: 100,
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

  /**
   * The `NetClock.currentTick` (next tick to simulate) that puts the buffer at its target: `clientTargetTickAt` is the
   * newest simulated tick whose input arrives `targetTicks` early, one below the next tick.
   */
  targetTickAt(nowMs: number): number {
    return this.sync.clientTargetTickAt(nowMs, this.netClock.dilation.targetTicks) + 1;
  }

  /** Sends Hello; Welcome must follow within WELCOME_TIMEOUT_MS. */
  start(): void {
    this.writer.reset();
    encodeHello(this.writer, helloFor(this.joinToken, this.session.kind === "websocket" ? "ws" : "wt", this.session.maxDatagramSize));
    this.sendStream();
    this.stateStartedMs = this.clock.now();
    this.rateWindowStartMs = this.stateStartedMs;
  }

  /**
   * After each predicted tick (not replays): record the prediction and send inputs with redundancy. An input with fire
   * set carries the view offset D = input tick − the render tick remote players were drawn at this frame (the input is
   * the input ring's own entry, so resends carry it too).
   */
  onPredictedTick(input: PlayerInput): void {
    if (this.stats.state !== "playing") return;
    if ((input.buttons & Btn.fire) !== 0) (input as Mutable<PlayerInput>).viewOffset8 = viewOffset8(input.tick, this.renderTickValue);
    this.local.recordTick(input);
    this.sendInputs(input.tick);
  }

  /** Once per render frame, before the player's update. */
  update(dtSec: number): void {
    const now = this.clock.now();
    const state = this.stats.state;
    const wallMs = this.lastUpdateMs >= 0 ? now - this.lastUpdateMs : dtSec * 1000;
    const stalled = wallMs > this.stallMs;
    this.lastUpdateMs = now;
    this.frameIntervalMs += 0.1 * (Math.min(wallMs, STALL_MIN_MS) - this.frameIntervalMs);
    let frameMs = dtSec * 1000;
    if (state === "handshaking") {
      if (now - this.stateStartedMs > WELCOME_TIMEOUT_MS) this.fail(t("net.reason.handshakeTimeout"));
    } else if (state === "syncing") {
      this.maybePing(now, SYNC_PING_INTERVAL_MS);
      this.maybeStart(now, dtSec);
    } else if (state === "playing") {
      this.maybePing(now, PLAY_PING_INTERVAL_MS);
      // The frame dt is capped (Game.ts: 0.1 s). Give a short hitch's dropped time back so the clock doesn't fall
      // behind and spend seconds dilating back; a longer one (> RESYNC_TICKS) is left to the hard resync below.
      const lostMs = wallMs - frameMs;
      if (lostMs > 0.5 && lostMs <= RESYNC_TICKS * this.sync.tickMs) {
        this.netClock.catchUp(lostMs / 1000);
        frameMs = wallMs;
      }
      // No inputs went out during a stall, so the server's (smoothed) depth dips below the real alignment for a while.
      if (stalled) this.holdDepth(now);
      const dilation = this.netClock.dilation;
      dilation.setJitter(this.sync.jitterMs, this.frameBurstTicks);
      const target = this.targetTickAt(now);
      if (Math.abs(this.netClock.currentTick - target) > RESYNC_TICKS) this.hardResync(now, target, dtSec);
      this.stats.interrupted = now - this.lastSnapshotMs > INTERRUPTED_MS;
    }
    if (state === "playing" || state === "syncing") {
      const delay = this.interpDelay.update(now, this.sync.tickMs, this.sync.lossRatio(), this.sync.arrivalSpreadMs);
      this.renderTickValue = this.sync.renderTickAt(now, delay);
      this.stats.remoteCount = this.roster.sample(this.renderTickValue);
    }
    this.local.update(dtSec);
    this.frameTimeMs += frameMs;
    this.updateStats(now);
  }

  /** Leaves the match: Disconnect{clientLeave}, then close. */
  disconnect(): void {
    if (this.stats.state === "disconnected") return;
    this.writer.reset();
    encodeDisconnect(this.writer, { reason: DisconnectReason.clientLeave, detail: 0 });
    this.sendStream();
    this.setState("disconnected", t("net.reason.clientLeave"));
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
        this.events?.onWelcome(welcome.playerSlot, welcome.teamId, welcome.teamSize);
        if (welcome.interpFloorMs > 0) this.interpDelay.setFloor(Math.max(welcome.interpFloorMs, this.session.kind === "websocket" ? 50 : 25));
        this.setState("syncing", "");
        break;
      }
      case MsgId.Disconnect: {
        const message = decodeDisconnect(reader);
        this.setState("disconnected", message ? describeDisconnectReason(message.reason) : t("net.reason.byServer"));
        break;
      }
      case MsgId.Resync:
        // Response: the server reset our baselines (the next snapshot is full) and its reliable event queue.
        if (decodeResyncResponse(reader) !== null && RESYNC_RESETS_RELIABLE_EVENTS) this.receiver.reset();
        break;
      case MsgId.KillFeed: {
        const feed = decodeKillFeed(reader);
        if (feed !== null) this.events?.onKillFeed(feed);
        break;
      }
      case MsgId.PhaseChange: {
        const phase = decodePhaseChange(reader);
        if (phase === null) return;
        this.matchPhase = phase;
        this.onMatchMessage?.(this);
        break;
      }
      case MsgId.ZonePhase: {
        const zone = decodeZonePhase(reader);
        if (zone === null) return;
        // Sent again on reconnect: keep one entry per index.
        const i = this.zonePhases.findIndex((z) => z.index >= zone.index);
        if (i < 0) this.zonePhases.push(zone);
        else if (this.zonePhases[i]!.index === zone.index) this.zonePhases[i] = zone;
        else this.zonePhases.splice(i, 0, zone);
        this.onMatchMessage?.(this);
        break;
      }
      case MsgId.Roster: {
        const roster = decodeRoster(reader);
        if (roster === null) return;
        this.matchRoster = roster;
        this.onRoster?.(roster, this);
        break;
      }
      case MsgId.MatchEnd: {
        const end = decodeMatchEnd(reader);
        if (end === null) return;
        this.matchEnd = end;
        this.onMatchMessage?.(this);
        break;
      }
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
      // The baseline is gone, but events precede the state: don't lose shots, hits and reliable events with it.
      const eventsOnly = this.store.eventsOnly;
      if (eventsOnly !== null) this.deliverEvents(eventsOnly, false);
      if (++this.decodeFailStreak >= DECODE_FAILURES_FOR_RESYNC) this.requestResync(recvMs);
      return;
    }
    this.decodeFailStreak = 0;
    this.lastSnapshotMs = recvMs;
    const h = snap.header;
    const stalled = this.lastUpdateMs >= 0 && recvMs - this.lastUpdateMs > this.stallMs;
    sync.onSnapshot(h.serverTick, recvMs, h.lastProcessedInputTick >= 0 ? h.clientTimeEcho : -1, h.serverHoldMs, !stalled);
    if (h.lastProcessedInputTick > this.lastProcessedInput) this.lastProcessedInput = h.lastProcessedInputTick;
    const playing = this.stats.state === "playing";
    // inputBufferDepthQ: quarter ticks the server holds beyond the tick it simulates (> target → the client slows). Not
    // gated on lastProcessedInputTick: a client whose inputs all arrive late must still hear that it is behind.
    if (playing && !stalled && h.serverTick >= this.depthFromServerTick) this.netClock.dilation.onBufferDepth(h.inputBufferDepthQ / 4, recvMs);
    const events = this.events;
    this.deliverEvents(snap, true);
    this.roster.onSnapshot(h.serverTick, snap.entities);
    if (snap.owner === null) return;
    if (h.serverTick > this.newestOwnerTick) this.newestOwnerTick = h.serverTick;
    const vitals = snap.vitals ?? null;
    let life = this.ownerLife;
    if (vitals !== null) {
      life = vitals.life;
      if (h.serverTick > this.newestVitalsTick) {
        this.newestVitalsTick = h.serverTick;
        this.ownerLife = life;
        events?.onOwnerVitals(h.serverTick, vitals);
      }
    }
    if (!playing) return;
    if (this.movement !== null) this.movement.life = life;
    this.local.onOwnerState(h.serverTick, snap.owner, recvMs, snap.weapon ?? null, life);
    // Live ticks step with the newest life, whatever order snapshots arrived in.
    if (this.movement !== null) this.movement.life = this.ownerLife;
  }

  /**
   * Inputs go out once per frame: at frame intervals of about two ticks or more, the server sees them in bursts and
   * needs that much more buffer to not run dry between frames.
   */
  private get frameBurstTicks(): number {
    const x = this.frameIntervalMs / this.sync.tickMs - 1;
    // Hysteresis around the x.5 boundaries (a 40 fps loop would flip it).
    if (Math.abs(x - this.burstTicks) > 0.65) this.burstTicks = Math.max(0, Math.round(x));
    return this.burstTicks;
  }

  /** A frame gap (or a message handled this long after the last frame) beyond this is a main-thread stall. */
  private get stallMs(): number {
    return Math.max(STALL_MIN_MS, 4 * this.frameIntervalMs);
  }

  /** Ignores depth reports until inputs sent from now on have reached the server and its smoothing caught up. */
  private holdDepth(now: number): void {
    const sync = this.sync;
    this.depthFromServerTick = Math.ceil(sync.serverTickAt(now) + sync.rttMinMs / 2 / sync.tickMs) + DEPTH_SETTLE_TICKS;
  }

  private deliverEvents(snap: Snapshot, entitiesValid: boolean): void {
    const reliable = snap.reliable;
    if (reliable !== undefined && reliable.length > 0) {
      this.deliverTick = snap.header.serverTick;
      this.receiver.receive(reliable, this.deliver);
    }
    const events = this.events;
    if (events !== null) {
      this.stats.shotsReceived += snap.shots?.length ?? 0;
      this.stats.hitsReceived += snap.hits?.length ?? 0;
      events.onSnapshotEvents(snap, entitiesValid);
    }
  }

  private maybeStart(now: number, dtSec: number): void {
    const sync = this.sync;
    if (sync.sampleCount < SYNC_SNAPSHOTS || this.newestOwnerTick < 0) return;
    if (this.pingReplies < SYNC_PINGS && now - this.stateStartedMs < SYNC_MAX_MS) return;
    const stored = this.store.get(this.newestOwnerTick);
    const owner = stored?.owner;
    if (!stored || !owner) return;
    const life = stored.vitals?.life ?? this.ownerLife;
    if (this.movement !== null) this.movement.life = life;
    this.local.startFrom(owner, stored.weapon ?? null, life);
    const dilation = this.netClock.dilation;
    dilation.setJitter(sync.jitterMs, this.frameBurstTicks);
    const tick = Math.ceil(this.targetTickAt(now));
    this.netClock.start(tick, dtSec);
    this.holdDepth(now);
    this.lastSnapshotMs = now;
    this.setState("playing", "");
  }

  /**
   * Re-aligns the tick number and drops prediction history. Local only: baselines and the reliable event queue are
   * unaffected by the client's tick alignment, and a ResyncRequest would make the server drop unacked events.
   */
  private hardResync(now: number, target: number, dtSec: number): void {
    const tick = Math.round(target);
    this.netClock.resync(tick, dtSec);
    this.holdDepth(now);
    this.local.clearHistory();
    this.stats.resyncs++;
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
    packet.ackEventSeq = this.receiver.ackSeq;
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
    s.weaponCorrections = ls.weaponCorrections;
    s.weaponCorrectionsPerMin = this.local.weaponCorrectionsPerMinute(now);
    s.lastWeaponDiff = ls.lastWeaponDiff;
    s.ownerLife = this.ownerLife;
    s.eventsDelivered = this.receiver.stats.delivered;
    s.eventDuplicates = this.receiver.stats.duplicates;
    s.extrapolatedPct = this.roster.sampledFrames > 0 ? (this.roster.extrapolatedFrames / this.roster.sampledFrames) * 100 : 0;
    const elapsed = now - this.rateWindowStartMs;
    if (elapsed >= 1000) {
      s.frameTimePct = (this.frameTimeMs * 100) / elapsed;
      this.frameTimeMs = 0;
      s.bytesInPerSec = (this.bytesIn * 1000) / elapsed;
      s.bytesOutPerSec = (this.bytesOut * 1000) / elapsed;
      this.bytesIn = 0;
      this.bytesOut = 0;
      this.rateWindowStartMs = now;
    }
  }
}
