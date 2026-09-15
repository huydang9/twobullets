import { ClientSnapshotStore, createSeededRng, ReliableEventReceiver, type Clock, type Rng, type Session } from "@twobullets/netcode";
import {
  CONTENT_HASH,
  createBitReader,
  createLootUpdateBuffer,
  decodeLootUpdateInto,
  lootCellOfQ,
  LootOpCode,
  createBitWriter,
  createMutablePlayerInput,
  decodeDisconnect,
  decodeKillFeed,
  decodeMatchEnd,
  decodePhaseChange,
  decodeZonePhase,
  LifeCode,
  decodeWelcome,
  encodeHello,
  encodeInputPacket,
  MAX_INPUTS_PER_PACKET,
  MAX_JOIN_TOKEN_BYTES,
  MsgId,
  PROTOCOL_VERSION,
  type Disconnect,
  type KillFeed,
  type LootOp,
  type MatchEnd,
  type PhaseChange,
  type ZonePhaseMessage,
  type ReliableEvent,
  type MutablePlayerInput,
  type Snapshot,
  type Welcome,
} from "@twobullets/protocol";
import { remoteLifeCode } from "@twobullets/netcode/replication";
import { quantizePitch, quantizeYaw } from "@twobullets/shared/aim";
import { Btn, type PlayerInput } from "@twobullets/shared/input";

// Minimal protocol client for server tests and the local load driver (not the T3.6 bot: no prediction, clock sync or
// sim). Hello → Welcome, then one Input packet per client tick with seeded random movement (or a test script, or
// `combat: "spray"` for load) and ≤ 6 unacked inputs, snapshots decoded against baselines through ClientSnapshotStore,
// reliable events delivered once through ReliableEventReceiver and acked with `ackEventSeq`. Inputs with fire set carry
// an honest view offset D = tick − (newest snapshot tick + its age − interpolation delay).

export interface HeadlessClientOptions {
  readonly session: Session;
  readonly clock: Clock;
  readonly token: string;
  readonly seed: number;
  /** Ticks the client runs ahead of Welcome.serverTick (covers RTT + buffer). */
  readonly leadTicks?: number;
  readonly protocolVersion?: number;
  readonly contentHash?: number;
  readonly tickRate?: number;
  readonly onSnapshot?: (snapshot: Snapshot, client: HeadlessClient) => void;
  /** Interpolation delay reported in Input and used for the honest view offset. Default 100 ms. */
  readonly interpDelayMs?: number;
  /** "spray": hold fire and aim at the nearest remote entity (load driver). Default: random movement only. */
  readonly combat?: "none" | "spray";
}

/** Writes a tick's input after the default script; set `viewOffset8` ≥ 0 to override the honest view offset. */
export type InputScript = (tick: number, input: MutablePlayerInput, client: HeadlessClient) => void;

const HISTORY = 64;

export class HeadlessClient {
  readonly store = new ClientSnapshotStore();
  welcome: Welcome | null = null;
  disconnect: Disconnect | null = null;
  closedByServer = false;
  snapshotsReceived = 0;
  snapshotsDropped = 0;
  bytesIn = 0;
  bytesOut = 0;
  inputsSent = 0;
  lastProcessedInputTick = -1;
  /** Stops sending inputs while true (idle-timeout tests). */
  paused = false;
  onSnapshot: ((snapshot: Snapshot, client: HeadlessClient) => void) | null;
  readonly events = new ReliableEventReceiver();
  onReliable: ((event: ReliableEvent, client: HeadlessClient) => void) | null = null;
  onKillFeed: ((feed: KillFeed, client: HeadlessClient) => void) | null = null;
  script: InputScript | null = null;
  /** Newest PhaseChange, every ZonePhase in arrival order, MatchEnd (BR lifecycle). */
  phase: PhaseChange | null = null;
  readonly phases: PhaseChange[] = [];
  readonly zonePhases: ZonePhaseMessage[] = [];
  matchEnd: MatchEnd | null = null;
  reliableDelivered = 0;
  killFeeds = 0;
  shotsSeen = 0;
  hitsSeen = 0;
  /** Ground loot as the server streamed it (protocol v7 LootUpdate), by loot id; copies of the decoded spawn ops. */
  readonly loot = new Map<number, LootOp>();
  lootMessages = 0;
  lootBytes = 0;
  lootMalformed = 0;
  private readonly lootBuffer = createLootUpdateBuffer();
  /** View offsets (1/8 tick) sent with fire, newest last (tests; capped). */
  readonly viewOffsets: number[] = [];
  private newestRecvMs = 0;
  private readonly deliver = (event: ReliableEvent): void => {
    this.reliableDelivered++;
    this.onReliable?.(event, this);
  };
  private readonly options: HeadlessClientOptions;
  private readonly session: Session;
  private readonly clock: Clock;
  private readonly rng: Rng;
  /** Sized for Hello with the longest accepted join token. */
  private readonly writer = createBitWriter(MAX_JOIN_TOKEN_BYTES + 16);
  private readonly reader = createBitReader(new Uint8Array(0));
  private readonly history: MutablePlayerInput[] = [];
  private readonly packetInputs: PlayerInput[] = [];
  private readonly tickMs: number;
  private welcomeAtMs = 0;
  private nextTick = -1;
  // Random input script state.
  private forward: -1 | 0 | 1 = 1;
  private right: -1 | 0 | 1 = 0;
  private buttons = 0;
  private yawQ = 0;
  private yawRate = 0;
  private changeAt = 0;

  constructor(options: HeadlessClientOptions) {
    this.options = options;
    this.session = options.session;
    this.clock = options.clock;
    this.rng = createSeededRng(options.seed);
    this.tickMs = 1000 / (options.tickRate ?? 60);
    this.onSnapshot = options.onSnapshot ?? null;
    for (let i = 0; i < HISTORY; i++) this.history.push(createMutablePlayerInput());
    this.session.onStream((bytes) => this.onStream(bytes));
    this.session.onDatagram((bytes) => this.onDatagram(bytes));
  }

  get playerSlot(): number {
    return this.welcome?.playerSlot ?? -1;
  }

  hello(): void {
    const w = this.writer;
    w.reset();
    encodeHello(w, {
      protocolVersion: this.options.protocolVersion ?? PROTOCOL_VERSION,
      contentHash: this.options.contentHash ?? CONTENT_HASH,
      joinToken: this.options.token,
      maxDatagramSize: this.session.maxDatagramSize,
      transport: this.session.kind === "websocket" ? "ws" : "wt",
    });
    this.session.sendStream(w.bytes());
    this.bytesOut += w.byteLength;
  }

  /** Sends inputs for every client tick due by now. */
  update(): void {
    if (this.welcome === null || this.disconnect !== null || this.paused) return;
    const now = this.clock.now();
    const due = this.welcome.serverTick + (this.options.leadTicks ?? 3) + Math.floor((now - this.welcomeAtMs) / this.tickMs);
    if (this.nextTick < 0) this.nextTick = due;
    // After a long stall, skip ahead rather than flooding the server with stale ticks.
    if (due - this.nextTick > MAX_INPUTS_PER_PACKET) this.nextTick = due - MAX_INPUTS_PER_PACKET;
    let newest = -1;
    while (this.nextTick <= due) {
      this.sample(this.nextTick);
      newest = this.nextTick++;
    }
    if (newest >= 0) this.send(newest);
  }

  inputAt(tick: number): PlayerInput | null {
    const e = this.history[tick % HISTORY]!;
    return e.tick === tick ? e : null;
  }

  private sample(tick: number): void {
    const random = this.rng;
    if (tick >= this.changeAt) {
      this.forward = ([-1, 0, 1, 1, 1] as const)[Math.floor(random.next() * 5)]!;
      this.right = ([-1, 0, 0, 1] as const)[Math.floor(random.next() * 4)]!;
      let b = 0;
      if (random.next() < 0.5) b |= 2; // sprint
      if (random.next() < 0.15) b |= 1; // jump
      if (random.next() < 0.15) b |= 4; // crouch
      if (random.next() < 0.2) b |= 16; // aim
      this.buttons = b;
      this.yawRate = Math.floor((random.next() * 2 - 1) * 8000);
      this.changeAt = tick + 20 + Math.floor(random.next() * 60);
    }
    this.yawQ = (((this.yawQ + this.yawRate) % (1 << 20)) + (1 << 20)) % (1 << 20);
    const e = this.history[tick % HISTORY]!;
    e.tick = tick;
    e.forward = this.forward;
    e.right = this.right;
    e.buttons = this.buttons;
    e.select = 0;
    e.yawQ = this.yawQ;
    e.pitchQ = (1 << 17) - 1;
    e.viewOffset8 = -1;
    e.action = null;
    if (this.options.combat === "spray") this.spray(tick, e);
    this.script?.(tick, e, this);
    if ((e.buttons & Btn.fire) === 0) e.viewOffset8 = 0;
    else {
      if (e.viewOffset8 < 0) e.viewOffset8 = this.honestViewOffset8(tick);
      if (this.viewOffsets.length < 4096) this.viewOffsets.push(e.viewOffset8);
    }
  }

  /** 8 × (tick − render tick): the render tick is the newest snapshot tick advanced by its age, minus interpolation. */
  honestViewOffset8(tick: number): number {
    const newest = this.store.newestTick;
    if (newest < 0) return 0;
    const render = newest + (this.clock.now() - this.newestRecvMs) / this.tickMs - (this.options.interpDelayMs ?? 100) / this.tickMs;
    const q = Math.round((tick - render) * 8);
    return q < 0 ? 0 : q > 255 ? 255 : q;
  }

  private sprayAim = { x: 0, y: 0, z: 0 };

  /** Load script: hold fire at the nearest remote entity; pistol taps once the rifle is dry. */
  private spray(tick: number, e: MutablePlayerInput): void {
    const snap = this.store.newestTick >= 0 ? this.store.get(this.store.newestTick) : null;
    if (snap === null || snap.owner === null) return;
    const o = snap.owner;
    let best = Infinity;
    for (const other of snap.entities) {
      const dx = other.xMm - o.xMm;
      const dz = other.zMm - o.zMm;
      const d = dx * dx + dz * dz;
      if (d < best && remoteLifeCode(other.flags) !== LifeCode.dead) {
        best = d;
        this.sprayAim.x = (other.xMm - o.xMm) / 1000;
        this.sprayAim.y = (other.yMm - o.yMm) / 1000 - 0.4;
        this.sprayAim.z = (other.zMm - o.zMm) / 1000;
      }
    }
    if (best === Infinity) return;
    const a = this.sprayAim;
    const jitter = (this.rng.next() - 0.5) * 0.04;
    e.yawQ = quantizeYaw(Math.atan2(a.x, a.z) + jitter);
    e.pitchQ = quantizePitch(Math.atan2(-a.y, Math.sqrt(a.x * a.x + a.z * a.z)));
    e.buttons |= Btn.fire | Btn.aim;
    e.buttons &= ~Btn.sprint;
    const weapon = snap.weapon;
    if (weapon && weapon.slotCount > 0) {
      const rifleDry = weapon.slotMagazine[0]! + weapon.slotReserve[0]! === 0;
      if (rifleDry && weapon.activeIndex !== 2) e.select = 3;
      if (weapon.activeIndex === 2 && tick % 2 === 1) e.buttons &= ~Btn.fire;
    }
  }

  private send(newest: number): void {
    const list = this.packetInputs;
    list.length = 0;
    for (let t = newest; t > newest - MAX_INPUTS_PER_PACKET && t > this.lastProcessedInputTick; t--) {
      const input = this.inputAt(t);
      if (input === null) break;
      list.push(input);
    }
    if (list.length === 0) return;
    const w = this.writer;
    w.reset();
    encodeInputPacket(w, {
      newestTick: newest,
      ackSnapshotTick: this.store.newestTick,
      clientTimeMs: Math.floor(this.clock.now()) & 0xffff,
      interpDelayMs: this.options.interpDelayMs ?? 100,
      ackEventSeq: this.events.ackSeq,
      inputs: list,
    });
    if (this.session.sendDatagram(w.bytes())) {
      this.inputsSent++;
      this.bytesOut += w.byteLength;
    }
  }

  private onStream(bytes: Uint8Array): void {
    this.bytesIn += bytes.length;
    const r = this.reader;
    r.reset(bytes);
    if (bytes[0] === MsgId.Welcome) {
      this.welcome = decodeWelcome(r);
      this.welcomeAtMs = this.clock.now();
    } else if (bytes[0] === MsgId.KillFeed) {
      const feed = decodeKillFeed(r);
      if (feed !== null) {
        this.killFeeds++;
        this.onKillFeed?.(feed, this);
      }
    } else if (bytes[0] === MsgId.PhaseChange) {
      const phase = decodePhaseChange(r);
      if (phase !== null) {
        this.phase = phase;
        if (this.phases.length < 256) this.phases.push(phase);
      }
    } else if (bytes[0] === MsgId.ZonePhase) {
      const zone = decodeZonePhase(r);
      if (zone !== null && !this.zonePhases.some((z) => z.index === zone.index)) this.zonePhases.push(zone);
    } else if (bytes[0] === MsgId.MatchEnd) {
      this.matchEnd = decodeMatchEnd(r);
    } else if (bytes[0] === MsgId.Disconnect) {
      this.disconnect = decodeDisconnect(r);
      this.closedByServer = true;
    } else if (bytes[0] === MsgId.LootUpdate) {
      this.applyLoot(bytes);
    }
  }

  private applyLoot(bytes: Uint8Array): void {
    this.lootMessages++;
    this.lootBytes += bytes.length;
    const buf = this.lootBuffer;
    if (!decodeLootUpdateInto(this.reader, buf)) {
      this.lootMalformed++;
      return;
    }
    const loot = this.loot;
    for (let i = 0; i < buf.count; i++) {
      const op = buf.ops[i]!;
      if (op.op === LootOpCode.spawn) loot.set(op.lootId, { ...op });
      else if (op.op === LootOpCode.remove) loot.delete(op.lootId);
      else if (op.op === LootOpCode.quantity) {
        const item = loot.get(op.lootId);
        if (item) item.quantity = op.quantity;
      } else if (op.op === LootOpCode.clear) loot.clear();
      else if (op.op === LootOpCode.forgetCell) {
        for (const [id, item] of loot) if (lootCellOfQ(item.xCm, item.zCm) === op.cell) loot.delete(id);
      }
    }
  }

  private onDatagram(bytes: Uint8Array): void {
    this.bytesIn += bytes.length;
    if (bytes[0] !== MsgId.Snapshot) return;
    const r = this.reader;
    r.reset(bytes);
    const reference = this.store.newestTick >= 0 ? this.store.newestTick : (this.welcome?.serverTick ?? 0);
    const previousNewest = this.store.newestTick;
    const snapshot = this.store.decode(r, reference);
    if (snapshot === null) {
      this.snapshotsDropped++;
      return;
    }
    this.snapshotsReceived++;
    if (this.store.newestTick > previousNewest) this.newestRecvMs = this.clock.now();
    this.shotsSeen += snapshot.shots?.length ?? 0;
    this.hitsSeen += snapshot.hits?.length ?? 0;
    if (snapshot.reliable !== undefined && snapshot.reliable.length > 0) this.events.receive(snapshot.reliable, this.deliver);
    if (snapshot.header.lastProcessedInputTick > this.lastProcessedInputTick) this.lastProcessedInputTick = snapshot.header.lastProcessedInputTick;
    this.onSnapshot?.(snapshot, this);
  }
}
