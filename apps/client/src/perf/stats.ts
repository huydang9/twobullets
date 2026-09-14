export interface RollingStats {
  readonly frames: number;
  readonly avg: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** Mean and upper percentiles (nearest rank) of a set of values. */
export function summarize(values: ArrayLike<number>): RollingStats {
  const frames = values.length;
  if (frames === 0) return { frames: 0, avg: Number.NaN, p95: Number.NaN, p99: Number.NaN, max: Number.NaN };
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const v of sorted) sum += v;
  const rank = (p: number) => sorted[Math.min(frames - 1, Math.ceil(p * frames) - 1)]!;
  return { frames, avg: sum / frames, p95: rank(0.95), p99: rank(0.99), max: sorted[frames - 1]! };
}
