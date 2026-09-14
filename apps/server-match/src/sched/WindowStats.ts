// Fixed-capacity sample window (tick work, lateness) with percentiles on flush. No allocation per sample; one
// typed-array view per flush.

export interface WindowSummary {
  count: number;
  p50: number;
  p99: number;
  max: number;
  mean: number;
}

export function createWindowSummary(): WindowSummary {
  return { count: 0, p50: 0, p99: 0, max: 0, mean: 0 };
}

export class WindowStats {
  private readonly samples: Float64Array;
  private count = 0;
  private sum = 0;
  private max = 0;
  /** Samples seen since the last flush, including ones past capacity (only max/mean see those). */
  private seen = 0;

  constructor(capacity = 4096) {
    this.samples = new Float64Array(capacity);
  }

  add(value: number): void {
    if (this.count < this.samples.length) this.samples[this.count++] = value;
    this.seen++;
    this.sum += value;
    if (value > this.max) this.max = value;
  }

  get size(): number {
    return this.seen;
  }

  /** Writes percentiles of the window into `out` and starts a new window. */
  flush(out: WindowSummary): WindowSummary {
    const n = this.count;
    out.count = this.seen;
    out.max = this.max;
    out.mean = this.seen > 0 ? this.sum / this.seen : 0;
    if (n === 0) {
      out.p50 = 0;
      out.p99 = 0;
    } else {
      const view = this.samples.subarray(0, n);
      view.sort();
      out.p50 = view[Math.min(n - 1, Math.floor(n * 0.5))]!;
      out.p99 = view[Math.min(n - 1, Math.floor(n * 0.99))]!;
    }
    this.count = 0;
    this.seen = 0;
    this.sum = 0;
    this.max = 0;
    return out;
  }
}
