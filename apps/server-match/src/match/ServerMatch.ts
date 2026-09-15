import type { JoinClaims, MatchConfig, MatchPhase } from "@twobullets/contracts";
import type { Clock, Session } from "@twobullets/netcode";
import { writeOwnerMove } from "@twobullets/netcode/replication";
import {
  CONTENT_HASH,
  copyPlayerInput,
  createBitReader,
  createBitWriter,
  createInputPacketBuffer,
  createMutablePlayerInput,
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
import { MOVEMENT } from "@twobullets/shared/constants";
import { createVitals, VITALS } from "@twobullets/shared/equipment/vitals";
import { Btn, PlayerActionType, type MoveGates, type PlayerInput } from "@twobullets/shared/input";
import { createMoveState, fallDamage } from "@twobullets/shared/movement/movement";
import type { Stance, Vec3 } from "@twobullets/shared/movement/types";
import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import { createSimWorld, stepPlayer, type HavokModule, type ServerLevel, type SimWorld, type StepOptions } from "@twobullets/sim";
import { createHmac } from "node:crypto";
import type { AttachResult, Match } from "../host/MatchHost";
import { disconnectSession } from "../session/control";
import { SnapshotBuilder } from "../snapshot/SnapshotBuilder";
import { freshPlayerState, Player } from "./Player";
import { ServerCombat, type CombatHost, type ServerCombatOptions } from "./ServerCombat";
import { chooseSlot, matchSlotCount, matchTeamCount, matchTeamSize, SpawnPlanner } from "./slots";

// One match: slots/teams, per-client input rings, one Havok world, server-authoritative movement, weapons, hit
// registration and vitals (ServerCombat), and snapshots. Lifecycle (contracts MatchPhase): Booting (sim world loading) →
// Allocated (ready, accepting joins) → Warmup (ticking; M5 continues to LandingSelect/Glide/Combat) → Ended.

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
  /** Combat overrides (tests): damage toggle, spawn armor. */
  readonly combat?: Partial<Pick<ServerCombatOptions, "damageEnabled" | "spawnArmor">>;
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
/** Alive: open gates, weapons on. */
const STEP_ALIVE: StepOptions = { replay: false, weapons: true };
/** Knocked: prone crawl, no sprint or jump; combat buttons are cleared before the step (client mirrors both). */
export const DOWNED_GATES: MoveGates = { speedScale: VITALS.crawlSpeed / MOVEMENT.walkSpeed, allowSprint: false, allowJump: false, crawl: true };
const STEP_DOWNED: StepOptions = { replay: false, weapons: true, gates: DOWNED_GATES };
const COMBAT_BUTTONS = Btn.fire | Btn.aim | Btn.reload;
const INTERP_FLOOR_WS_MS = 50;
const INTERP_FLOOR_WT_MS = 25;
const MAX_REWIND_MS = 200;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

export class ServerMatch implements Match, CombatHost {
  readonly id: string;
  readonly config: MatchConfig;
  readonly ready: Promise<void>;
  readonly stats: MatchStats = { inputsMalformed: 0, datagramsRateLimited: 0, kicks: 0 };
  readonly snapshots: SnapshotBuilder;
  /** Null until the sim world is ready. */
  combat: ServerCombat | null = null;
  private phaseValue: MatchPhase = "Booting";
  private world: SimWorld | null = null;
  private readonly options: ServerMatchOptions;
  private readonly clock: Clock;
  readonly slots: (Player | null)[];
  /** Dense, sorted by slot; rebuilt only on join/leave. */
  private active: Player[] = [];
  private readonly byAccount = new Map<string, Player>();
  private readonly bySession = new Map<Session, Player>();
  private readonly spawns: SpawnPlanner;
  private readonly reader = createBitReader(new Uint8Array(0));
  private readonly packet = createInputPacketBuffer();
  private readonly gatedInput = createMutablePlayerInput();
  private readonly gatedAction: { type: PlayerActionType; arg: number } = { type: PlayerActionType.pickup, arg: 0 };
  private readonly datagramWriter = createBitWriter(64);
  private readonly controlWriter = createBitWriter(128);
  private readonly idleTimeoutMs: number;
  private readonly graceMs: number;
  private readonly rateLimit: number;
  private readonly kickRate: number;
  private readonly tickMs: number;
  private next: number;
  private lastTickStartMs = NaN;
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
    this.tickMs = 1000 / (options.tickRate ?? 60);
    const maxSlots = matchSlotCount(options.config);
    const teamSize = matchTeamSize(options.config);
    this.slots = new Array<Player | null>(maxSlots).fill(null);
    this.snapshots = new SnapshotBuilder(maxSlots);
    this.spawns = new SpawnPlanner(options.level.spawnPoints, options.config.matchSeed, teamSize);
    this.ready = createSimWorld(options.havok, options.level).then((world) => {
      this.world = world;
      const combat = new ServerCombat({ ...options.combat, rules: options.config.rules, maxSlots, raycastWorld: world.raycastWorld, tickRate: options.tickRate });
      combat.attach(this, matchTeamCount(options.config), teamSize);
      this.combat = combat;
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

  get players(): readonly Player[] {
    return this.active;
  }

  /** The player in `slot` (tests, debug tooling). */
  player(slot: number): Player | null {
    return this.slots[slot] ?? null;
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
    player.armor = this.combat!.armorForSpawn();
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
    const combat = this.combat;
    if (world === null || combat === null || this.phaseValue === "Ended") return;
    if (this.phaseValue === "Allocated") this.phaseValue = "Warmup";
    this.lastTickStartMs = this.clock.now();
    const players = this.active;
    combat.beginTick(tick);
    if (BODY_BLOCKING_SUPPORTED && this.config.rules.bodyBlocking) this.syncBodiesForBlocking();
    const killY = this.options.level.killY;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      const input = p.inputs.take(tick);
      // The dead are frozen (spectating): inputs still drain the buffer and ack, but nothing moves or aims.
      if (p.life === "dead") continue;
      p.yawQ = input.yawQ;
      p.pitchQ = input.pitchQ;
      p.buttons = input.buttons;
      this.step(p, input, combat);
      if (p.body.feet.y < killY) combat.outOfBounds(p);
    }
    combat.endTick(tick);
    this.next = tick + 1;
    const now = this.clock.now();
    this.snapshots.build(tick, now, players, combat);
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

  /** Teleports a player (tests, debug tooling); the lag-comp history snaps across it. */
  debugPlace(slot: number, feet: Vec3, stance: Stance = "stand"): void {
    const p = this.slots[slot];
    if (!p) return;
    p.body.restore(feet, ZERO, stance);
    p.state = { move: { ...createMoveState(), stance, grounded: true }, weapon: p.state.weapon };
    p.poseDiscontinuous = true;
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
    this.combat?.projectiles.clear();
    this.world?.dispose();
    this.world = null;
  }

  /** Server spawn, fresh loadout and vitals (M4 warmup respawn; CombatHost). */
  respawn(p: Player): void {
    p.body.restore(p.spawn.feet, ZERO, "stand");
    p.state = freshPlayerState();
    p.vitals = createVitals();
    p.armor = this.combat!.armorForSpawn();
    p.deathTick = -1;
    p.reviveTarget = -1;
    p.buttons = 0;
    p.poseDiscontinuous = true;
    this.combat!.history.clear(p.slot);
  }

  private step(p: Player, input: PlayerInput, combat: ServerCombat): void {
    let options = STEP_ALIVE;
    let effective = input;
    if (p.life === "downed") {
      options = STEP_DOWNED;
      const gated = this.gatedInput;
      copyPlayerInput(input, gated, this.gatedAction);
      gated.buttons &= ~COMBAT_BUTTONS;
      gated.select = 0;
      effective = gated;
      p.buttons = gated.buttons;
    }
    const result = stepPlayer(p.body, p.state, effective, TICK_SECONDS, options);
    p.state = result.state;
    const shots = result.shots;
    for (let k = 0; k < shots.length; k++) combat.fire(p, shots[k]!, input.viewOffset8);
    const events = result.events;
    for (let k = 0; k < events.length; k++) {
      const e = events[k]!;
      if (e.type === "landed") combat.landed(p, fallDamage(e.fallSpeed));
    }
  }

  /**
   * Hook for player body blocking (product rule ON). CharacterBody's MOVEMENT_COLLIDE_MASK excludes
   * CollisionLayer.player until SimWorld syncs other bodies before each step (T3.1 TODO). When that lands: move every
   * other player's Havok body to its current feet here (or between each player's step) and flip
   * BODY_BLOCKING_SUPPORTED. Replay on clients must then restore remote bodies too (netcode.md §1.3).
   */
  private syncBodiesForBlocking(): void {}

  private bind(player: Player, session: Session, claims: JoinClaims): void {
    player.session = session;
    player.epoch = claims.epoch;
    player.disconnectedAtMs = -1;
    player.lastRecvMs = this.clock.now();
    player.rateWindowStartMs = player.lastRecvMs;
    player.rateWindowCount = 0;
    player.abusiveWindows = 0;
    player.inputs.reset();
    player.net.reset(this.next - 1);
    player.viewDelay.reset();
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
      teamSize: matchTeamSize(this.config),
      maxPlayers: this.slots.length,
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
      const net = player.net;
      net.baselines.ack(packet.ackSnapshotTick);
      net.events.onAck(packet.ackSnapshotTick, packet.ackEventSeq);
      net.onInputPacket(packet.newestTick, packet.clientTimeMs, recvMs);
      player.viewDelay.onInputPacket(packet.newestTick, this.arrivalTick(recvMs), packet.interpDelayMs, packet.ackSnapshotTick, net.sentTimeOf(packet.ackSnapshotTick), recvMs);
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

  /** Fractional server tick at `recvMs`: the last tick started plus the time since, capped at one tick. */
  private arrivalTick(recvMs: number): number {
    const start = this.lastTickStartMs;
    if (start !== start) return this.next;
    const frac = (recvMs - start) / this.tickMs;
    return this.next - 1 + (frac < 0 ? 0 : frac > 1 ? 1 : frac);
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
      player.net.reset(this.next - 1);
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
        this.combat?.removed(p.slot);
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

