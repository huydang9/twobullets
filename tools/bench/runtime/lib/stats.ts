/** Measurement helpers shared by the runtime benchmarks: percentiles, GC observation, memory and machine info. */
import { execSync } from "node:child_process";
import { cpus, loadavg, totalmem } from "node:os";
import { PerformanceObserver, constants as perfConstants } from "node:perf_hooks";

/** Hard self-termination required by the bench rules (macOS has no `timeout`). Call at the top of every script. */
export function installWatchdog(ms = 180_000): void {
  setTimeout(() => {
    console.error(`watchdog: aborted after ${ms} ms`);
    process.exit(2);
  }, ms).unref();
}

export interface Summary {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
  min: number;
}

export function summarize(samples: ArrayLike<number>, count = samples.length): Summary {
  const sorted = Float64Array.from({ length: count }, (_, i) => samples[i]!).sort();
  const at = (q: number): number => sorted[Math.min(count - 1, Math.floor(q * count))] ?? 0;
  let sum = 0;
  for (let i = 0; i < count; i++) sum += sorted[i]!;
  return {
    n: count,
    mean: round(sum / Math.max(1, count)),
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    p999: round(at(0.999)),
    max: round(sorted[count - 1] ?? 0),
    min: round(sorted[0] ?? 0),
  };
}

export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

const GC_KIND: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};

export interface GcReport {
  count: Record<string, number>;
  totalMs: Record<string, number>;
  maxMs: Record<string, number>;
  pauses: Summary | null;
}

/** Collects `gc` performance entries (V8 pause durations) between start() and stop(). */
export class GcTracker {
  private readonly durations: number[] = [];
  private readonly count: Record<string, number> = {};
  private readonly totalMs: Record<string, number> = {};
  private readonly maxMs: Record<string, number> = {};
  private observer: PerformanceObserver | null = null;

  start(): void {
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const detail = (entry as unknown as { detail?: { kind?: number } }).detail;
        const kind = GC_KIND[detail?.kind ?? -1] ?? "other";
        this.count[kind] = (this.count[kind] ?? 0) + 1;
        this.totalMs[kind] = round((this.totalMs[kind] ?? 0) + entry.duration, 3);
        this.maxMs[kind] = round(Math.max(this.maxMs[kind] ?? 0, entry.duration), 3);
        this.durations.push(entry.duration);
      }
    });
    try {
      this.observer.observe({ entryTypes: ["gc"] });
    } catch {
      // Runtimes without GC performance entries (e.g. Bun) report no GC data.
      this.observer = null;
    }
  }

  /** GC entries are delivered asynchronously; await a macrotask before reading. */
  async stop(): Promise<GcReport> {
    await new Promise((r) => setImmediate(r));
    this.observer?.disconnect();
    return {
      count: this.count,
      totalMs: this.totalMs,
      maxMs: this.maxMs,
      pauses: this.durations.length > 0 ? summarize(this.durations) : null,
    };
  }
}

export function memoryMb(): Record<string, number> {
  const m = process.memoryUsage();
  return {
    rss: round(m.rss / 1e6, 1),
    heapTotal: round(m.heapTotal / 1e6, 1),
    heapUsed: round(m.heapUsed / 1e6, 1),
    external: round(m.external / 1e6, 1),
    arrayBuffers: round(m.arrayBuffers / 1e6, 1),
  };
}

export function machineInfo(): Record<string, unknown> {
  const sysctl = (key: string): string => {
    try {
      return execSync(`sysctl -n ${key}`, { encoding: "utf8" }).trim();
    } catch {
      return "n/a";
    }
  };
  return {
    cpu: process.platform === "darwin" ? sysctl("machdep.cpu.brand_string") : (cpus()[0]?.model ?? "n/a"),
    ncpu: process.platform === "darwin" ? Number(sysctl("hw.ncpu")) : cpus().length,
    perfCores: process.platform === "darwin" ? sysctl("hw.perflevel0.physicalcpu") : "n/a",
    effCores: process.platform === "darwin" ? sysctl("hw.perflevel1.physicalcpu") : "n/a",
    memGb: round((process.platform === "darwin" ? Number(sysctl("hw.memsize")) : totalmem()) / 2 ** 30, 1),
    node: process.version,
    v8: process.versions.v8,
    platform: `${process.platform}-${process.arch}`,
    /** 1/5/15-minute load averages when the benchmark ran (other processes on a shared dev machine skew tails). */
    loadAvg: loadavg().map((v) => round(v, 2)),
  };
}

export function parseArgs(defaults: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const out = { ...defaults };
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const [, key, raw] = match as unknown as [string, string, string | undefined];
    const def = defaults[key];
    out[key] = raw === undefined ? true : typeof def === "number" ? Number(raw) : typeof def === "boolean" ? raw !== "false" : raw;
  }
  return out;
}

/** Deterministic PRNG (mulberry32) so every mode sees the same world and inputs. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
