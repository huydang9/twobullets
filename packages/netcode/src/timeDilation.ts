// Client input-rate controller (netcode.md §11.1): the server reports how far ahead the client's inputs arrive
// (`inputBufferDepthQ`, quarter ticks). The client stretches or shrinks its tick by up to ±5% so that depth settles at
// the target: Δ_client = Δ × (1 + gain × clamp(u, ±maxError)), u from a PI controller with a leaky 1 s integral.

export interface TimeDilationOptions {
  /** Buffer target, ticks (raised with upstream jitter). */
  readonly targetTicks?: number;
  /** Fractional speed change per tick of control error (0.02 → ±5% at 2.5 ticks). */
  readonly gain?: number;
  readonly maxError?: number;
  readonly kp?: number;
  readonly ki?: number;
  /** Integral leak time constant, ms. */
  readonly integralWindowMs?: number;
  /** Depth smoothing per sample. */
  readonly depthAlpha?: number;
  /** |error| beyond this (ticks) asks for a hard resync. */
  readonly resyncTicks?: number;
}

const JITTER_HYSTERESIS_MS = 1.5;

export class TimeDilation {
  private readonly baseTarget: number;
  private readonly gain: number;
  private readonly maxError: number;
  private readonly kp: number;
  private readonly ki: number;
  private readonly tau: number;
  private readonly depthAlpha: number;
  private readonly resyncTicks: number;
  private target: number;
  private jitterStep = 0;
  private depth = 0;
  private integral = 0;
  private lastMs = -1;
  private samples = 0;
  private u = 0;

  constructor(options: TimeDilationOptions = {}) {
    this.baseTarget = options.targetTicks ?? 1;
    this.target = this.baseTarget;
    this.gain = options.gain ?? 0.02;
    this.maxError = options.maxError ?? 2.5;
    this.kp = options.kp ?? 1;
    this.ki = options.ki ?? 0.5;
    this.tau = options.integralWindowMs ?? 1000;
    this.depthAlpha = options.depthAlpha ?? 0.25;
    this.resyncTicks = options.resyncTicks ?? 10;
  }

  get targetTicks(): number {
    return this.target;
  }
  /** Smoothed reported depth, ticks. */
  get depthTicks(): number {
    return this.depth;
  }
  /** Multiplier on the tick duration: > 1 slows the client down. */
  get tickScale(): number {
    return 1 + this.gain * this.u;
  }
  /** True when the client is so far off that re-aligning the tick number beats dilating. */
  get needsResync(): boolean {
    return this.samples > 0 && Math.abs(this.depth - this.target) > this.resyncTicks;
  }

  /**
   * Target 1 tick, 2 above 8 ms upstream jitter σ, 3 above 16 ms (the client can only measure downstream σ), plus
   * `extraTicks` (e.g. for inputs sent in bursts by a slow or irregular frame loop).
   */
  setJitter(jitterMs: number, extraTicks = 0): void {
    let step = jitterMs > 16 ? 2 : jitterMs > 8 ? 1 : 0;
    // Hysteresis: σ hovering around a threshold (≈ 8–9 ms on a "typical" link) mustn't flip the target every second.
    if (step < this.jitterStep && jitterMs > 8 * this.jitterStep - JITTER_HYSTERESIS_MS) step = this.jitterStep;
    this.jitterStep = step;
    this.target = this.baseTarget + step + extraTicks;
  }

  /** Feed `inputBufferDepthQ / 4` from each snapshot, with its arrival time. */
  onBufferDepth(depthTicks: number, nowMs: number): void {
    this.depth = this.samples === 0 ? depthTicks : this.depth + this.depthAlpha * (depthTicks - this.depth);
    this.samples++;
    const e = this.depth - this.target;
    if (this.lastMs >= 0) {
      const dt = Math.max(0, nowMs - this.lastMs);
      const leak = Math.exp(-dt / this.tau);
      // Anti-windup: the output saturates at ±maxError, so a larger error mustn't keep charging the integral.
      const ei = e < -this.maxError ? -this.maxError : e > this.maxError ? this.maxError : e;
      this.integral = this.integral * leak + ei * (1 - leak);
    }
    this.lastMs = nowMs;
    const u = this.kp * e + this.ki * this.integral;
    this.u = u < -this.maxError ? -this.maxError : u > this.maxError ? this.maxError : u;
  }

  /** After a hard resync: forget history so the old error doesn't steer the new alignment. */
  reset(): void {
    this.depth = 0;
    this.integral = 0;
    this.lastMs = -1;
    this.samples = 0;
    this.u = 0;
  }
}

/** Fixed-step accumulator whose step is stretched by `TimeDilation.tickScale` (the networked `TickClock` core). */
export class DilatedTickClock {
  readonly tickMs: number;
  /** Next tick to simulate. */
  tick = 0;
  private acc = 0;

  constructor(tickRate = 60) {
    this.tickMs = 1000 / tickRate;
  }

  start(tick: number): void {
    this.tick = tick;
    this.acc = 0;
  }

  /** Adds frame time; returns how many ticks are due. The caller simulates them and increments `tick` per tick. */
  advance(dtMs: number, tickScale: number): number {
    this.acc += dtMs;
    const step = this.tickMs * tickScale;
    const n = Math.floor(this.acc / step);
    this.acc -= n * step;
    return n;
  }

  /** Fraction of the next tick already elapsed, for render interpolation. */
  alpha(tickScale: number): number {
    return this.acc / (this.tickMs * tickScale);
  }
}
