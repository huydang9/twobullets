import { SIMULATION } from "./constants";

// Where simulation ticks come from (refactor R4). Offline: a render-frame accumulator. Networked: NetClock
// (packages/netcode), which may run ahead of or hard-resync to the server's tick.

export const TICK_SECONDS = 1 / SIMULATION.tickRate;

export interface TickClock {
  /** Advances by one render frame; returns how many ticks to simulate now (0..SIMULATION.maxTicksPerFrame). */
  advance(frameSeconds: number): number;
  /** Number of the next tick to simulate (u32, `PlayerInput.tick`); moves past it. Call once per simulated tick. */
  nextTick(): number;
  /** Fraction of a tick since the last simulated tick, 0..1, for render interpolation. */
  readonly alpha: number;
}

export interface AccumulatorClockOptions {
  readonly maxTicksPerFrame?: number;
  /** Backlog carried to later frames, in ticks; anything beyond it is dropped (offline resync). */
  readonly maxBacklogTicks?: number;
  readonly firstTick?: number;
}

/** Offline clock: ≤ maxTicksPerFrame per frame, the rest of the backlog carries into following frames. */
export class AccumulatorClock implements TickClock {
  private accumulator = 0;
  private tick: number;
  private readonly maxTicksPerFrame: number;
  private readonly maxBacklog: number;

  constructor(options: AccumulatorClockOptions = {}) {
    this.maxTicksPerFrame = options.maxTicksPerFrame ?? SIMULATION.maxTicksPerFrame;
    this.maxBacklog = options.maxBacklogTicks ?? SIMULATION.maxBacklogTicks;
    this.tick = options.firstTick ?? 0;
  }

  advance(frameSeconds: number): number {
    this.accumulator += frameSeconds;
    let ticks = 0;
    while (this.accumulator >= TICK_SECONDS && ticks < this.maxTicksPerFrame) {
      this.accumulator -= TICK_SECONDS;
      ticks++;
    }
    if (this.accumulator >= TICK_SECONDS * (this.maxBacklog + 1)) {
      this.accumulator = (this.accumulator % TICK_SECONDS) + TICK_SECONDS * this.maxBacklog;
    }
    return ticks;
  }

  nextTick(): number {
    const tick = this.tick;
    this.tick = (tick + 1) >>> 0;
    return tick;
  }

  get alpha(): number {
    return Math.min(1, this.accumulator / TICK_SECONDS);
  }
}
