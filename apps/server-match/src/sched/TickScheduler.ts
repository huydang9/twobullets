import type { Clock } from "@twobullets/netcode";
import { WindowStats } from "./WindowStats";

// Drift-free hybrid tick scheduler (ADR 0304): absolute deadlines t0 + n·period, sleep with setTimeout until `spinMs`
// before the deadline, then yield with setImmediate until it. Late ticks catch up back-to-back and tick numbers are
// never skipped; more than `hitchMs` behind raises a hitch. `onTick` must never await.

export interface TimerApi {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setImmediate(cb: () => void): unknown;
  clearImmediate(handle: unknown): void;
}

export const NODE_TIMERS: TimerApi = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setImmediate: (cb) => setImmediate(cb),
  clearImmediate: (h) => clearImmediate(h as ReturnType<typeof setImmediate>),
};

export interface TickSchedulerOptions {
  readonly clock: Clock;
  readonly timers?: TimerApi;
  readonly tickRate?: number;
  /** 1 ms single-match, 2 ms packed (ADR 0304 §1). */
  readonly spinMs?: number;
  readonly hitchMs?: number;
  /** Ticks run back-to-back per event-loop turn before yielding to I/O (inputs) during a catch-up. */
  readonly maxTicksPerTurn?: number;
  readonly onTick: (tick: number) => void;
  /** Runs on every loop turn before due ticks (e.g. pumping fake-net link conditioners). */
  readonly beforeTicks?: () => void;
  readonly onHitch?: (behindMs: number, tick: number) => void;
}

export class TickScheduler {
  readonly periodMs: number;
  private readonly tickRate: number;
  readonly lateness = new WindowStats();
  readonly work = new WindowStats();
  overruns = 0;
  hitches = 0;
  ticksRun = 0;
  private readonly clock: Clock;
  private readonly timers: TimerApi;
  private readonly spinMs: number;
  private readonly hitchMs: number;
  private readonly maxTicksPerTurn: number;
  private readonly onTick: (tick: number) => void;
  private readonly beforeTicks: (() => void) | null;
  private readonly onHitch: ((behindMs: number, tick: number) => void) | null;
  private startMs = 0;
  private startTick = 0;
  private next = 0;
  private running = false;
  private inHitch = false;
  private timeoutHandle: unknown = null;
  private immediateHandle: unknown = null;

  constructor(options: TickSchedulerOptions) {
    this.clock = options.clock;
    this.timers = options.timers ?? NODE_TIMERS;
    this.tickRate = options.tickRate ?? 60;
    this.periodMs = 1000 / this.tickRate;
    this.spinMs = options.spinMs ?? 1;
    this.hitchMs = options.hitchMs ?? 250;
    this.maxTicksPerTurn = options.maxTicksPerTurn ?? 8;
    this.onTick = options.onTick;
    this.beforeTicks = options.beforeTicks ?? null;
    this.onHitch = options.onHitch ?? null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The next tick number to run. */
  get nextTick(): number {
    return this.next;
  }

  deadlineOf(tick: number): number {
    // Multiply before dividing so whole seconds land exactly on integer milliseconds.
    return this.startMs + ((tick - this.startTick) * 1000) / this.tickRate;
  }

  /** Starts ticking with `startTick` due now. With `autoLoop` false nothing is armed: call `pump()` (virtual clocks). */
  start(startTick = 0, autoLoop = true): void {
    if (this.running) return;
    this.running = true;
    this.startMs = this.clock.now();
    this.startTick = startTick;
    this.next = startTick;
    if (autoLoop) this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timeoutHandle !== null) this.timers.clearTimeout(this.timeoutHandle);
    if (this.immediateHandle !== null) this.timers.clearImmediate(this.immediateHandle);
    this.timeoutHandle = null;
    this.immediateHandle = null;
  }

  /** Runs every due tick (at most `limit`); returns how many ran. */
  pump(limit = this.maxTicksPerTurn): number {
    if (!this.running) return 0;
    if (this.beforeTicks !== null) this.beforeTicks();
    let ran = 0;
    let now = this.clock.now();
    while (this.running && ran < limit) {
      const tick = this.next;
      const deadline = this.deadlineOf(tick);
      if (now < deadline) break;
      const behind = now - deadline;
      if (behind > this.hitchMs) {
        if (!this.inHitch) {
          this.inHitch = true;
          this.hitches++;
          if (this.onHitch !== null) this.onHitch(behind, tick);
        }
      } else if (behind < this.periodMs) {
        this.inHitch = false;
      }
      this.lateness.add(behind);
      this.onTick(tick);
      this.next = tick + 1;
      this.ticksRun++;
      ran++;
      const end = this.clock.now();
      this.work.add(end - now);
      if (end > deadline + this.periodMs) this.overruns++;
      now = end;
    }
    return ran;
  }

  private readonly loop = (): void => {
    this.timeoutHandle = null;
    this.immediateHandle = null;
    if (!this.running) return;
    this.pump();
    if (!this.running) return;
    const wait = this.deadlineOf(this.next) - this.clock.now();
    if (wait > this.spinMs) this.timeoutHandle = this.timers.setTimeout(this.loop, wait - this.spinMs);
    else this.immediateHandle = this.timers.setImmediate(this.loop);
  };
}
