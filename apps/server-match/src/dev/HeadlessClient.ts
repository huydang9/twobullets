import { ClientSnapshotStore, createSeededRng, type Clock, type Rng, type Session } from "@twobullets/netcode";
import {
  CONTENT_HASH,
  createBitReader,
  createBitWriter,
  createMutablePlayerInput,
  decodeDisconnect,
  decodeWelcome,
  encodeHello,
  encodeInputPacket,
  MAX_INPUTS_PER_PACKET,
  MsgId,
  PROTOCOL_VERSION,
  type Disconnect,
  type MutablePlayerInput,
  type Snapshot,
  type Welcome,
} from "@twobullets/protocol";
import type { PlayerInput } from "@twobullets/shared/input";

// Minimal protocol client for server tests and the local load driver (not the T3.6 bot: no prediction, clock sync or
// sim). Hello → Welcome, then one Input packet per client tick with seeded random movement and ≤ 6 unacked inputs,
// snapshots decoded against baselines through ClientSnapshotStore.

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
}

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
  private readonly options: HeadlessClientOptions;
  private readonly session: Session;
  private readonly clock: Clock;
  private readonly rng: Rng;
  private readonly writer = createBitWriter(512);
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
    e.viewOffset8 = 0;
    e.action = null;
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
      interpDelayMs: 100,
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
    } else if (bytes[0] === MsgId.Disconnect) {
      this.disconnect = decodeDisconnect(r);
      this.closedByServer = true;
    }
  }

  private onDatagram(bytes: Uint8Array): void {
    this.bytesIn += bytes.length;
    if (bytes[0] !== MsgId.Snapshot) return;
    const r = this.reader;
    r.reset(bytes);
    const reference = this.store.newestTick >= 0 ? this.store.newestTick : (this.welcome?.serverTick ?? 0);
    const snapshot = this.store.decode(r, reference);
    if (snapshot === null) {
      this.snapshotsDropped++;
      return;
    }
    this.snapshotsReceived++;
    if (snapshot.header.lastProcessedInputTick > this.lastProcessedInputTick) this.lastProcessedInputTick = snapshot.header.lastProcessedInputTick;
    this.onSnapshot?.(snapshot, this);
  }
}
