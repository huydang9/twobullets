// In-memory token buckets keyed by client IP or account (platform.md §6.5). One API process, so no shared store.

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly perMinute: number;
  private readonly burst: number;
  private readonly now: () => number;

  constructor(perMinute: number, options: { burst?: number; now?: () => number } = {}) {
    this.perMinute = perMinute;
    this.burst = options.burst ?? perMinute;
    this.now = options.now ?? Date.now;
  }

  /** 0 when allowed; otherwise seconds until one token is available. */
  take(key: string): number {
    const now = this.now();
    const refillPerMs = this.perMinute / 60_000;
    let b = this.buckets.get(key);
    if (b === undefined) {
      b = { tokens: this.burst, updatedAt: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + (now - b.updatedAt) * refillPerMs);
      b.updatedAt = now;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000));
  }

  /** Forget full buckets (call every minute or so). */
  sweep(): void {
    const now = this.now();
    for (const [k, b] of this.buckets) if (now - b.updatedAt > 10 * 60_000) this.buckets.delete(k);
  }
}
