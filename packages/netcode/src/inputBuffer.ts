import type { PlayerInput } from "@twobullets/shared/input";
import { copyPlayerInput, createMutablePlayerInput, type MutablePlayerInput } from "@twobullets/protocol/messages/input";

// Per-client server input ring (netcode.md §3.1, §11.2, §1.5). Inputs are keyed by tick: the server simulates tick T
// with the client's input for T. Late inputs (tick already simulated) and duplicates are dropped and counted; inputs
// too far ahead are dropped; a token bucket caps accepted new inputs at tickRate + 6/s. A missing input repeats the
// previous one with edge-triggered buttons and actions cleared, and the tick is marked synthetic.

export interface InputBufferOptions {
  /** Ring slots, power of two, > maxLeadTicks. */
  readonly capacity?: number;
  /** Inputs more than this many ticks ahead of the server tick are dropped. */
  readonly maxLeadTicks?: number;
  readonly tickRate?: number;
  /** Extra accepted inputs per second above tickRate (catch-up allowance). */
  readonly catchUpPerSecond?: number;
  /** Token bucket size: one packet of redundant inputs after a stall must fit. */
  readonly tokenBurst?: number;
  /** Buttons cleared on synthetic repeats (jump press, reload, interact). */
  readonly edgeButtons?: number;
  /** Smoothing of the reported depth per consumed tick. */
  readonly depthAlpha?: number;
}

export const InsertResult = { accepted: 0, duplicate: 1, late: 2, tooEarly: 3, rateLimited: 4 } as const;
export type InsertResult = (typeof InsertResult)[keyof typeof InsertResult];

export interface InputBufferStats {
  accepted: number;
  duplicate: number;
  late: number;
  tooEarly: number;
  rateLimited: number;
  synthetic: number;
  consumed: number;
}

const JUMP = 1;
const RELOAD = 32;
const INTERACT = 64;

type ActionStore = { type: NonNullable<PlayerInput["action"]>["type"]; arg: number };

export class ServerInputBuffer {
  readonly stats: InputBufferStats = { accepted: 0, duplicate: 0, late: 0, tooEarly: 0, rateLimited: 0, synthetic: 0, consumed: 0 };
  private readonly mask: number;
  private readonly slotTicks: Float64Array;
  /** 1 once the slot's input was simulated; kept so redundant copies count as duplicates, not late. */
  private readonly slotConsumed: Uint8Array;
  private readonly slots: MutablePlayerInput[] = [];
  private readonly slotActions: ActionStore[] = [];
  private readonly maxLead: number;
  private readonly tokensPerTick: number;
  private readonly burst: number;
  private readonly edgeButtons: number;
  private readonly depthAlpha: number;
  private readonly current = createMutablePlayerInput();
  private readonly currentAction: ActionStore = { type: 1, arg: 0 };
  private tokens: number;
  private hasInput = false;
  private lastTaken = -1;
  private lastReal = -1;
  private lastArrived = -1;
  private depth = 0;
  private syntheticRun = 0;
  private synthetic = false;

  constructor(options: InputBufferOptions = {}) {
    const capacity = options.capacity ?? 64;
    if ((capacity & (capacity - 1)) !== 0) throw new RangeError("capacity must be a power of two");
    this.mask = capacity - 1;
    this.maxLead = Math.min(options.maxLeadTicks ?? 32, capacity - 1);
    const tickRate = options.tickRate ?? 60;
    this.tokensPerTick = (tickRate + (options.catchUpPerSecond ?? 6)) / tickRate;
    this.burst = options.tokenBurst ?? 12;
    this.tokens = this.burst;
    this.edgeButtons = options.edgeButtons ?? JUMP | RELOAD | INTERACT;
    this.depthAlpha = options.depthAlpha ?? 0.1;
    this.slotTicks = new Float64Array(capacity).fill(-1);
    this.slotConsumed = new Uint8Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.slots.push(createMutablePlayerInput());
      this.slotActions.push({ type: 1, arg: 0 });
    }
  }

  /** Newest tick consumed from a real (non-synthetic) input: the snapshot's `lastProcessedInputTick`. −1 before any. */
  get lastProcessedInputTick(): number {
    return this.lastReal;
  }
  /** Whether the last `take` synthesized its input. */
  get lastWasSynthetic(): boolean {
    return this.synthetic;
  }
  /** Consecutive synthetic ticks (a long run means the client stalled or fell behind). */
  get syntheticStreak(): number {
    return this.syntheticRun;
  }
  /** Smoothed (newest buffered tick − simulated tick); while inputs arrive late, (newest arrived − simulated tick) ≤ 0. */
  get depthTicks(): number {
    return this.depth;
  }
  /** `depthTicks` in signed quarter ticks for the snapshot header. */
  get depthQ(): number {
    const q = Math.round(this.depth * 4);
    return q < -128 ? -128 : q > 127 ? 127 : q;
  }

  /** `serverTick` is the next tick the server will simulate. */
  insert(input: PlayerInput, serverTick: number): InsertResult {
    const tick = input.tick;
    const index = tick & this.mask;
    if (this.slotTicks[index] === tick) {
      this.stats.duplicate++;
      return InsertResult.duplicate;
    }
    if (tick <= this.lastTaken || tick < serverTick) {
      // Still an arrival for the depth: a client running behind reads as its real lateness, not as time since the last
      // accepted input (which saturates the client's controller and winds it up).
      if (tick > this.lastArrived) this.lastArrived = tick;
      this.stats.late++;
      return InsertResult.late;
    }
    if (tick > serverTick + this.maxLead) {
      this.stats.tooEarly++;
      return InsertResult.tooEarly;
    }
    if (this.tokens < 1) {
      this.stats.rateLimited++;
      return InsertResult.rateLimited;
    }
    this.tokens -= 1;
    this.slotTicks[index] = tick;
    this.slotConsumed[index] = 0;
    copyPlayerInput(input, this.slots[index]!, this.slotActions[index]);
    this.lastArrived = tick;
    this.stats.accepted++;
    return InsertResult.accepted;
  }

  /** Inserts a decoded packet's inputs oldest first (the soonest-needed inputs win the tokens). Returns accepted. */
  insertPacket(inputs: readonly PlayerInput[], count: number, serverTick: number): number {
    let accepted = 0;
    for (let i = Math.min(count, inputs.length) - 1; i >= 0; i--) {
      if (this.insert(inputs[i]!, serverTick) === InsertResult.accepted) accepted++;
    }
    return accepted;
  }

  /** The input to simulate `tick` with (call once per tick, in order). The returned object is reused. */
  take(tick: number): PlayerInput {
    this.tokens = Math.min(this.burst, this.tokens + this.tokensPerTick);
    const index = tick & this.mask;
    const cur = this.current;
    if (this.slotTicks[index] === tick && this.slotConsumed[index] === 0) {
      copyPlayerInput(this.slots[index]!, cur, this.currentAction);
      this.slotConsumed[index] = 1;
      this.lastReal = tick;
      this.synthetic = false;
      this.syntheticRun = 0;
      this.hasInput = true;
      this.stats.consumed++;
    } else {
      if (!this.hasInput) {
        cur.forward = 0;
        cur.right = 0;
        cur.buttons = 0;
        cur.yawQ = 0;
        cur.pitchQ = 0;
        cur.viewOffset8 = 0;
      }
      cur.buttons &= ~this.edgeButtons;
      cur.select = 0;
      cur.action = null;
      this.synthetic = true;
      this.syntheticRun++;
      this.stats.synthetic++;
    }
    cur.tick = tick;
    this.lastTaken = tick;
    this.depth += this.depthAlpha * (this.measureDepth(tick) - this.depth);
    return cur;
  }

  /** Newest buffered tick beyond `tick`, or how far the latest arrival lags behind when nothing is buffered. */
  private measureDepth(tick: number): number {
    let newest = -1;
    for (let k = 1; k <= this.maxLead; k++) {
      const t = tick + k;
      const index = t & this.mask;
      if (this.slotTicks[index] === t && this.slotConsumed[index] === 0) newest = t;
    }
    if (newest >= 0) return newest - tick;
    return this.lastArrived < 0 ? 0 : Math.min(0, this.lastArrived - tick);
  }

  reset(): void {
    this.slotTicks.fill(-1);
    this.slotConsumed.fill(0);
    this.tokens = this.burst;
    this.hasInput = false;
    this.lastTaken = -1;
    this.lastReal = -1;
    this.lastArrived = -1;
    this.depth = 0;
    this.syntheticRun = 0;
    this.synthetic = false;
  }
}
