// Client clock estimation (netcode.md §11.1): RTT from input time echoes (EWMA + 2 s min filter), server time offset
// from snapshot arrivals (2 s min filter, NTP-style), arrival jitter σ and downstream loss. Times are ms on one local
// monotonic clock (performance.now()); ticks are fractional server ticks.

export interface TimeSyncOptions {
  readonly tickRate?: number;
  /** Min-filter / jitter window. */
  readonly windowMs?: number;
  /** RTT EWMA factor. */
  readonly rttAlpha?: number;
  /**
   * The timeline offset follows the min filter at most this fast (ms per second), so the render and server clocks
   * never jump when the window's minimum sample expires. Larger differences than `offsetSnapMs` snap.
   */
  readonly offsetSlewMsPerSec?: number;
  readonly offsetSnapMs?: number;
}

const CAPACITY = 512;

/** Time-stamped samples in a ring; window queries scan the live span (≤ ~120 entries at 60 Hz over 2 s). */
class SampleWindow {
  readonly times = new Float64Array(CAPACITY);
  readonly values = new Float64Array(CAPACITY);
  head = 0;
  size = 0;

  push(t: number, v: number): void {
    this.times[this.head] = t;
    this.values[this.head] = v;
    this.head = (this.head + 1) % CAPACITY;
    if (this.size < CAPACITY) this.size++;
  }

  /** Drops samples older than `t0`. */
  trim(t0: number): void {
    while (this.size > 0) {
      const tail = (this.head - this.size + CAPACITY) % CAPACITY;
      if (this.times[tail]! >= t0) break;
      this.size--;
    }
  }

  min(): number {
    let m = Infinity;
    for (let i = 0; i < this.size; i++) {
      const v = this.values[(this.head - 1 - i + CAPACITY) % CAPACITY]!;
      if (v < m) m = v;
    }
    return m;
  }

  /** Root-mean-square distance above `floor`. */
  rmsAbove(floor: number): number {
    if (this.size === 0) return 0;
    let sq = 0;
    for (let i = 0; i < this.size; i++) {
      const d = this.values[(this.head - 1 - i + CAPACITY) % CAPACITY]! - floor;
      sq += d * d;
    }
    return Math.sqrt(sq / this.size);
  }

  std(): number {
    if (this.size < 2) return 0;
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < this.size; i++) {
      const v = this.values[(this.head - 1 - i + CAPACITY) % CAPACITY]!;
      sum += v;
      sq += v * v;
    }
    const mean = sum / this.size;
    return Math.sqrt(Math.max(0, sq / this.size - mean * mean));
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }
}

export class TimeSync {
  readonly tickMs: number;
  private readonly windowMs: number;
  private readonly alpha: number;
  private readonly offsets = new SampleWindow();
  private readonly rtts = new SampleWindow();
  /** Distinct snapshot ticks received, for the loss estimate (values = tick). */
  private readonly ticks = new SampleWindow();
  private rttEwma = -1;
  private offsetMin = 0;
  private offsetSmooth = 0;
  private offsetUpdatedMs = 0;
  private readonly slew: number;
  private readonly snap: number;
  private spread = 0;
  private rttMin = 0;
  private jitter = 0;
  private newestTick = -1;
  private samples = 0;

  constructor(options: TimeSyncOptions = {}) {
    this.tickMs = 1000 / (options.tickRate ?? 60);
    this.windowMs = options.windowMs ?? 2000;
    this.alpha = options.rttAlpha ?? 0.1;
    this.slew = options.offsetSlewMsPerSec ?? 10;
    this.snap = options.offsetSnapMs ?? 100;
  }

  /** Snapshots received so far (offset samples). */
  get sampleCount(): number {
    return this.samples;
  }
  get hasRtt(): boolean {
    return this.rttEwma >= 0;
  }
  get rttMs(): number {
    return Math.max(0, this.rttEwma);
  }
  get rttMinMs(): number {
    return this.rttMin;
  }
  /** σ of snapshot arrival residuals over the window. */
  get jitterMs(): number {
    return this.jitter;
  }
  /**
   * RMS of arrival residuals above the min-filter line (arrival − tick·Δ − o_min): how late snapshots typically land
   * relative to the render timeline. Use it for the interpolation delay; `jitterMs` (σ) for the input buffer target.
   */
  get arrivalSpreadMs(): number {
    return this.spread;
  }
  /** min(arrival − tick·Δ) over the window: clock offset plus the least downstream delay. */
  get offsetMinMs(): number {
    return this.offsetMin;
  }
  /** The slewed offset the tick estimates use. */
  get offsetMs(): number {
    return this.offsetSmooth;
  }
  get newestSnapshotTick(): number {
    return this.newestTick;
  }

  /**
   * One decoded snapshot. `clientTimeEcho`/`serverHoldMs` from its header give an RTT sample (pass a negative echo
   * when the server has no input yet). Duplicates are ignored for loss accounting.
   */
  onSnapshot(serverTick: number, arrivalMs: number, clientTimeEcho = -1, serverHoldMs = 0): void {
    const t0 = arrivalMs - this.windowMs;
    this.offsets.push(arrivalMs, arrivalMs - serverTick * this.tickMs);
    this.offsets.trim(t0);
    this.offsetMin = this.offsets.min();
    this.jitter = this.offsets.std();
    this.spread = this.offsets.rmsAbove(this.offsetMin);
    const diff = this.offsetMin - this.offsetSmooth;
    if (this.samples === 0 || Math.abs(diff) > this.snap) this.offsetSmooth = this.offsetMin;
    else {
      const step = (Math.max(0, arrivalMs - this.offsetUpdatedMs) / 1000) * this.slew;
      this.offsetSmooth += diff > step ? step : diff < -step ? -step : diff;
    }
    this.offsetUpdatedMs = arrivalMs;
    this.samples++;
    if (serverTick > this.newestTick) {
      this.newestTick = serverTick;
      this.ticks.push(arrivalMs, serverTick);
    } else if (!this.hasTick(serverTick)) {
      this.ticks.push(arrivalMs, serverTick);
    }
    this.ticks.trim(t0);
    if (clientTimeEcho >= 0 && serverHoldMs < 255) {
      const rtt = ((Math.floor(arrivalMs) - clientTimeEcho) & 0xffff) - serverHoldMs;
      if (rtt >= 0 && rtt < 10_000) this.addRttSample(rtt, arrivalMs);
    }
  }

  addRttSample(rttMs: number, nowMs: number): void {
    this.rttEwma = this.rttEwma < 0 ? rttMs : this.rttEwma + this.alpha * (rttMs - this.rttEwma);
    this.rtts.push(nowMs, rttMs);
    this.rtts.trim(nowMs - this.windowMs);
    this.rttMin = this.rtts.min();
  }

  /**
   * Downstream snapshot loss over the window, given the snapshot interval in ticks (1 at 60 Hz, 2 at 30 Hz).
   * Reordering and duplicates don't count as loss.
   */
  lossRatio(snapshotIntervalTicks = 1): number {
    const n = this.ticks.size;
    if (n < 2) return 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = this.ticks.values[(this.ticks.head - 1 - i + CAPACITY) % CAPACITY]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const expected = Math.floor((hi - lo) / snapshotIntervalTicks) + 1;
    return expected <= n ? 0 : (expected - n) / expected;
  }

  /** Estimated server tick now (fractional): (t − o_min)/Δ + (RTT_min/2)/Δ, with o_min slewed. */
  serverTickAt(nowMs: number): number {
    return (nowMs - this.offsetSmooth + this.rttMin / 2) / this.tickMs;
  }

  /** Remote render timeline: (t − o_min)/Δ − interpDelay/Δ, with o_min slewed. */
  renderTickAt(nowMs: number, interpDelayMs: number): number {
    return (nowMs - this.offsetSmooth - interpDelayMs) / this.tickMs;
  }

  /** Tick the client should be simulating so its input arrives `bufferTicks` before the server needs it. */
  clientTargetTickAt(nowMs: number, bufferTicks: number): number {
    return this.serverTickAt(nowMs) + this.rttMin / 2 / this.tickMs + bufferTicks;
  }

  reset(): void {
    this.offsets.clear();
    this.rtts.clear();
    this.ticks.clear();
    this.rttEwma = -1;
    this.offsetMin = 0;
    this.offsetSmooth = 0;
    this.offsetUpdatedMs = 0;
    this.spread = 0;
    this.rttMin = 0;
    this.jitter = 0;
    this.newestTick = -1;
    this.samples = 0;
  }

  private hasTick(tick: number): boolean {
    for (let i = 0; i < this.ticks.size; i++) {
      if (this.ticks.values[(this.ticks.head - 1 - i + CAPACITY) % CAPACITY] === tick) return true;
    }
    return false;
  }
}
