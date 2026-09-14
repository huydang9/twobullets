import type { JoinClaims, MatchConfig, MatchPhase } from "@twobullets/contracts";
import { ServerInputBuffer, type Clock, type Session } from "@twobullets/netcode";
import {
  CONTENT_HASH,
  createBitReader,
  createBitWriter,
  createInputPacketBuffer,
  decodeInputPacketInto,
  decodePing,
  decodeResyncRequest,
  DisconnectReason,
  encodePing,
  encodeResyncResponse,
  encodeWelcome,
  MsgId,
  PhaseCode,
  RESUME_TOKEN_BYTES,
  type Mutable,
  type OwnerMoveBlock,
} from "@twobullets/protocol";
import { quantizeYaw } from "@twobullets/shared/aim";
import type { PlayerInput, PlayerState } from "@twobullets/shared/input";
import { createMoveState } from "@twobullets/shared/movement/movement";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import { DEFAULT_LOADOUT } from "@twobullets/shared/weapons/weapons";
import { createWeaponState } from "@twobullets/shared/weapons/weaponStep";
import { createSimWorld, stepPlayer, type HavokModule, type PlayerBody, type ServerLevel, type SimWorld, type StepOptions } from "@twobullets/sim";
import { createHmac } from "node:crypto";
import type { AttachResult, Match } from "../host/MatchHost";
import { disconnectSession } from "../session/control";
import { ClientReplication, SnapshotBuilder, type ReplicatedPlayer } from "../snapshot/SnapshotBuilder";
import { writeOwnerMove } from "../snapshot/replication";
import { chooseSlot, SpawnPlanner } from "./slots";

// One match: slots/teams, per-client input rings, one Havok world, server-authoritative movement and snapshots.
// Lifecycle (contracts MatchPhase): Booting (sim world loading) → Allocated (ready, accepting joins) → Warmup (ticking;
// M5 continues to LandingSelect/Glide/Combat) → Ended.

export interface ServerMatchOptions {
  readonly config: MatchConfig;
  readonly havok: HavokModule;
  readonly level: ServerLevel;
  readonly clock: Clock;
  /** Tick number the host will run next; inputs are unwrapped against it until the first tick. */
  readonly startTick: number;
  /** Key for Welcome.resumeToken (HMAC-SHA256/128, netcode.md §7.4). */
  readonly resumeSecret: Uint8Array;
  readonly tickRate?: number;
  /** No datagram or stream message for this long → Disconnect{timeout}. */
  readonly idleTimeoutMs?: number;
  /** A disconnected character stays in the world this long (join-token reconnect window, ADR 0106). */
  readonly reconnectGraceMs?: number;
  /** Datagrams per second above which extra datagrams are dropped (D18: 72/s), and the kick threshold (180/s). */
  readonly datagramRateLimit?: number;
  readonly datagramKickRate?: number;
  readonly onPlayer?: (accountId: string, event: "joined" | "left") => void;
  /** Debug/test hook, runs at the end of every tick. */
  readonly onTickEnd?: (tick: number, match: ServerMatch) => void;
}

export interface MatchStats {
  inputsMalformed: number;
  datagramsRateLimited: number;
  kicks: number;
}

/** Body blocking is a product rule, but T3.1's CharacterBody still excludes CollisionLayer.player from movement. */
const BODY_BLOCKING_SUPPORTED = false;
const STEP: StepOptions = { replay: false };
const INTERP_FLOOR_WS_MS = 50;
const INTERP_FLOOR_WT_MS = 25;
const MAX_REWIND_MS = 200;

class Player implements ReplicatedPlayer {
  readonly slot: number;
  readonly teamId: number;
  readonly accountId: string;
  readonly body: PlayerBody;
  readonly spawn: { readonly feet: Vec3; readonly yaw: number };
  readonly inputs = new ServerInputBuffer();
  readonly net = new ClientReplication();
  state: PlayerState;
  epoch = 0;
  yawQ = 0;
  pitchQ = 0;
  buttons = 0;
  session: Session | null = null;
  lastRecvMs = 0;
  disconnectedAtMs = -1;
  rateWindowStartMs = 0;
  rateWindowCount = 0;
  abusiveWindows = 0;

  constructor(slot: number, teamId: number, accountId: string, body: PlayerBody, spawn: { feet: Vec3; yaw: number }) {
    this.slot = slot;
    this.teamId = teamId;
    this.accountId = accountId;
    this.body = body;
    this.spawn = spawn;
    this.state = freshState();
    this.yawQ = quantizeYaw(spawn.yaw);
    this.pitchQ = quantizePitchLevel();
  }

  get feet(): Readonly<Vec3> {
    return this.body.feet;
  }
}

function freshState(): PlayerState {
  return { move: createMoveState(), weapon: createWeaponState(DEFAULT_LOADOUT) };
}

/** 18-bit pitch of a level gaze (shared aim.ts: q = 2^17 − 1 is exactly 0). */
function quantizePitchLevel(): number {
  return (1 << 17) - 1;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

export class ServerMatch implements Match {
  readonly id: string;
  readonly config: MatchConfig;
  readonly ready: Promise<void>;
  readonly stats: MatchStats = { inputsMalformed: 0, datagramsRateLimited: 0, kicks: 0 };
  readonly snapshots: SnapshotBuilder;
  private phaseValue: MatchPhase = "Booting";
  private world: SimWorld | null = null;
  private readonly options: ServerMatchOptions;
  private readonly clock: Clock;
  private readonly slots: (Player | null)[];
  /** Dense, sorted by slot; rebuilt only on join/leave. */
  private active: Player[] = [];
  private readonly byAccount = new Map<string, Player>();
  private readonly bySession = new Map<Session, Player>();
  private readonly spawns: SpawnPlanner;
  private readonly reader = createBitReader(new Uint8Array(0));
  private readonly packet = createInputPacketBuffer();
  private readonly datagramWriter = createBitWriter(64);
  private readonly controlWriter = createBitWriter(128);
  private readonly idleTimeoutMs: number;
  private readonly graceMs: number;
  private readonly rateLimit: number;
  private readonly kickRate: number;
  private next: number;
  private lastSweepMs = 0;

  constructor(options: ServerMatchOptions) {
    this.options = options;
    this.config = options.config;
    this.id = options.config.matchId;
    this.clock = options.clock;
    this.next = options.startTick;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10_000;
    this.graceMs = options.reconnectGraceMs ?? 60_000;
    this.rateLimit = options.datagramRateLimit ?? 72;
    this.kickRate = options.datagramKickRate ?? 180;
    const maxSlots = Math.min(16, options.config.maxPlayers);
    this.slots = new Array<Player | null>(maxSlots).fill(null);
    this.snapshots = new SnapshotBuilder(16);
    this.spawns = new SpawnPlanner(options.level.spawnPoints, options.config.matchSeed, options.config.maxTeamSize);
    this.ready = createSimWorld(options.havok, options.level).then((world) => {
      this.world = world;
      if (this.phaseValue === "Booting") this.phaseValue = "Allocated";
    });
  }

  get phase(): MatchPhase {
    return this.phaseValue;
  }

  /** Next tick to simulate (inputs for earlier ticks are late). */
  get nextTick(): number {
    return this.next;
  }

  get playerCount(): number {
    return this.active.length;
  }

  get connectedCount(): number {
    let n = 0;
    for (const p of this.active) if (p.session !== null) n++;
    return n;
  }

  get freeSlots(): number {
    return this.slots.length - this.active.length;
  }

  get players(): readonly ReplicatedPlayer[] {
    return this.active;
  }

  attach(session: Session, claims: JoinClaims): AttachResult {
    if (this.world === null || this.phaseValue === "Ended") return { ok: false, reason: DisconnectReason.internalError };
    const existing = this.byAccount.get(claims.sub);
    if (existing !== undefined) {
      if (existing.session !== null) {
        if (claims.epoch < existing.epoch) return { ok: false, reason: DisconnectReason.replaced };
        const old = existing.session;
        this.unbind(existing);
        disconnectSession(old, DisconnectReason.replaced);
      }
      this.bind(existing, session, claims);
      return { ok: true, slot: existing.slot, teamId: existing.teamId, resumed: true };
    }

    const choice = chooseSlot(this.config, claims, (slot) => this.slots[slot] !== null);
    if (!choice.ok) return { ok: false, reason: choice.reason === "matchFull" ? DisconnectReason.matchFull : DisconnectReason.notAssigned };
    const spawn = this.spawns.spawnFor(choice.slot);
    const player = new Player(choice.slot, choice.teamId, claims.sub, this.world.createBody(spawn.feet), spawn);
    this.slots[choice.slot] = player;
    this.byAccount.set(claims.sub, player);
    this.rebuildActive();
    this.bind(player, session, claims);
    return { ok: true, slot: player.slot, teamId: player.teamId, resumed: false };
  }

  /** The transport closed (or the client left): the character stays in the world for the reconnect grace. */
  detach(session: Session): void {
    const player = this.bySession.get(session);
    if (player !== undefined) this.unbind(player);
  }

  tick(tick: number): void {
    const world = this.world;
    if (world === null || this.phaseValue === "Ended") return;
    if (this.phaseValue === "Allocated") this.phaseValue = "Warmup";
    const players = this.active;
    if (BODY_BLOCKING_SUPPORTED && this.config.rules.bodyBlocking) this.syncBodiesForBlocking();
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      const input = p.inputs.take(tick);
      p.yawQ = input.yawQ;
      p.pitchQ = input.pitchQ;
      p.buttons = input.buttons;
      p.state = this.step(p, input);
      if (p.body.feet.y < this.options.level.killY) this.respawn(p);
    }
    this.next = tick + 1;
    const now = this.clock.now();
    this.snapshots.build(tick, now, players);
    if (now - this.lastSweepMs >= 1000) {
      this.lastSweepMs = now;
      this.sweep(now);
    }
    this.options.onTickEnd?.(tick, this);
  }

  /** Quantized owner block of a slot's current state (tests, debug tooling). */
  ownerBlockOf(slot: number, out: Mutable<OwnerMoveBlock>): boolean {
    const p = this.slots[slot];
    if (p === null || p === undefined) return false;
    writeOwnerMove(p.body.feet, p.state.move, out);
    return true;
  }

  /** Sends Disconnect{reason} to everyone, disposes the world. */
  end(reason: DisconnectReason = DisconnectReason.matchEnded): void {
    if (this.phaseValue === "Ended") return;
    this.phaseValue = "Ended";
    for (const p of this.active) {
      const s = p.session;
      if (s !== null) {
        this.unbind(p);
        disconnectSession(s, reason);
      }
    }
    for (const p of this.active) p.body.dispose();
    this.active = [];
    this.slots.fill(null);
    this.byAccount.clear();
    this.world?.dispose();
    this.world = null;
  }

  private step(p: Player, input: PlayerInput): PlayerState {
    return stepPlayer(p.body, p.state, input, TICK_SECONDS, STEP).state;
  }

  /**
   * Hook for player body blocking (product rule ON). CharacterBody's MOVEMENT_COLLIDE_MASK excludes
   * CollisionLayer.player until SimWorld syncs other bodies before each step (T3.1 TODO). When that lands: move every
   * other player's Havok body to its current feet here (or between each player's step) and flip
   * BODY_BLOCKING_SUPPORTED. Replay on clients must then restore remote bodies too (netcode.md §1.3).
   */
  private syncBodiesForBlocking(): void {}

  private respawn(p: Player): void {
    p.body.restore(p.spawn.feet, ZERO, "stand");
    p.state = freshState();
  }

  private bind(player: Player, session: Session, claims: JoinClaims): void {
    player.session = session;
    player.epoch = claims.epoch;
    player.disconnectedAtMs = -1;
    player.lastRecvMs = this.clock.now();
    player.rateWindowStartMs = player.lastRecvMs;
    player.rateWindowCount = 0;
    player.abusiveWindows = 0;
    player.inputs.reset();
    player.net.reset();
    this.bySession.set(session, player);
    session.onDatagram((bytes, recvMs) => this.onDatagram(player, session, bytes, recvMs));
    session.onStream((bytes) => this.onStream(player, session, bytes));
    this.sendWelcome(player, session);
    this.options.onPlayer?.(player.accountId, "joined");
  }

  private unbind(player: Player): void {
    const session = player.session;
    if (session === null) return;
    this.bySession.delete(session);
    player.session = null;
    player.disconnectedAtMs = this.clock.now();
    this.options.onPlayer?.(player.accountId, "left");
  }

  private sendWelcome(player: Player, session: Session): void {
    const nowMs = this.clock.now();
    const mac = createHmac("sha256", this.options.resumeSecret)
      .update(`${this.id}|${player.slot}|${player.epoch}|${Math.floor(nowMs)}`)
      .digest()
      .subarray(0, RESUME_TOKEN_BYTES);
    const w = this.controlWriter;
    w.reset();
    encodeWelcome(w, {
      playerSlot: player.slot,
      teamId: player.teamId,
      serverTick: this.next,
      tickRate: this.options.tickRate ?? 60,
      snapshotRate: this.options.tickRate ?? 60,
      matchSeed: this.config.matchSeed >>> 0,
      phase: PhaseCode.Warmup,
      phaseEndTick: 0,
      maxRewindMs: MAX_REWIND_MS,
      interpFloorMs: session.kind === "websocket" ? INTERP_FLOOR_WS_MS : INTERP_FLOOR_WT_MS,
      resumeToken: mac,
      contentHash: CONTENT_HASH,
      flags: 0,
    });
    session.sendStream(w.bytes());
  }

  private onDatagram(player: Player, session: Session, bytes: Uint8Array, recvMs: number): void {
    if (player.session !== session || bytes.length === 0) return;
    player.lastRecvMs = recvMs;
    if (recvMs - player.rateWindowStartMs >= 1000) {
      if (player.rateWindowCount > this.kickRate) player.abusiveWindows++;
      else player.abusiveWindows = 0;
      player.rateWindowStartMs = recvMs;
      player.rateWindowCount = 0;
      if (player.abusiveWindows >= 3) {
        this.kick(player, DisconnectReason.rateLimited);
        return;
      }
    }
    if (++player.rateWindowCount > this.rateLimit) {
      this.stats.datagramsRateLimited++;
      return;
    }
    const id = bytes[0]!;
    if (id === MsgId.Input) {
      const r = this.reader;
      r.reset(bytes);
      const packet = this.packet;
      if (!decodeInputPacketInto(r, this.next, packet)) {
        this.stats.inputsMalformed++;
        return;
      }
      player.inputs.insertPacket(packet.inputs, packet.count, this.next);
      player.net.baselines.ack(packet.ackSnapshotTick);
      player.net.onInputPacket(packet.newestTick, packet.clientTimeMs, recvMs);
    } else if (id === MsgId.Ping) {
      const r = this.reader;
      r.reset(bytes);
      const ping = decodePing(r);
      if (ping === null || ping.reply) return;
      const w = this.datagramWriter;
      w.reset();
      encodePing(w, { seq: ping.seq, originTimeMs: ping.originTimeMs, holdMs: this.clock.now() - recvMs, reply: true });
      session.sendDatagram(w.bytes());
    }
  }

  private onStream(player: Player, session: Session, bytes: Uint8Array): void {
    if (player.session !== session || bytes.length === 0) return;
    player.lastRecvMs = this.clock.now();
    const id = bytes[0]!;
    if (id === MsgId.Resync) {
      const r = this.reader;
      r.reset(bytes);
      const request = decodeResyncRequest(r);
      if (request === null) return;
      player.net.reset();
      const w = this.controlWriter;
      w.reset();
      encodeResyncResponse(w, { scope: request.scope, serverTick: this.next });
      session.sendStream(w.bytes());
    } else if (id === MsgId.Disconnect) {
      this.unbind(player);
      session.close(DisconnectReason.clientLeave);
    }
    // Hello is handled by the SessionManager before attach; other control messages arrive in later milestones.
  }

  private kick(player: Player, reason: DisconnectReason): void {
    const session = player.session;
    if (session === null) return;
    this.stats.kicks++;
    this.unbind(player);
    disconnectSession(session, reason);
  }

  private sweep(now: number): void {
    let removed = false;
    for (const p of this.active) {
      if (p.session !== null) {
        if (now - p.lastRecvMs > this.idleTimeoutMs) this.kick(p, DisconnectReason.timeout);
      } else if (p.disconnectedAtMs >= 0 && now - p.disconnectedAtMs > this.graceMs) {
        this.slots[p.slot] = null;
        this.byAccount.delete(p.accountId);
        p.body.dispose();
        removed = true;
      }
    }
    if (removed) this.rebuildActive();
  }

  private rebuildActive(): void {
    const list: Player[] = [];
    for (const p of this.slots) if (p !== null) list.push(p);
    this.active = list;
  }
}
