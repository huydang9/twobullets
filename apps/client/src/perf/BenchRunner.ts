import type { TargetCamera } from "@babylonjs/core";
import type { BenchViewpoint } from "./benchViewpoints";
import type { FrameSample } from "./PerfMonitor";
import { summarize, type RollingStats } from "./stats";

/** One A/B change: applied for a shortened pass, then undone. */
export interface BenchVariant {
  readonly id: string;
  readonly label: string;
  /** Applies the change and returns its undo. */
  apply(): () => void;
}

export interface BenchTiming {
  /** Full baseline pass, per viewpoint. */
  readonly fullWarmupMs: number;
  readonly fullMeasureMs: number;
  /** Shortened A/B passes, per viewpoint. */
  readonly shortWarmupMs: number;
  readonly shortMeasureMs: number;
  /** Extra warmup after the first frame or a variant switch (shader compiles, buffer rebuilds). */
  readonly settleMs: number;
  /** Slow camera yaw sweep while on a viewpoint, so the numbers cover a little more than one frustum. */
  readonly sweepDegrees: number;
  readonly sweepPeriodMs: number;
}

export const DEFAULT_BENCH_TIMING: BenchTiming = {
  fullWarmupMs: 5000,
  fullMeasureMs: 10000,
  shortWarmupMs: 1500,
  shortMeasureMs: 2500,
  settleMs: 3000,
  sweepDegrees: 12,
  sweepPeriodMs: 8000,
};

/** Live facts the runner can't get from a FrameSample. */
export interface BenchProbe {
  /** Shadow casters drawn per cascade on the last frame. */
  shadowCasters(): readonly number[];
  renderSize(): readonly [width: number, height: number];
  isVisible(): boolean;
}

export type BenchPass = "full" | "ab";

export interface SegmentResult {
  readonly pass: BenchPass;
  readonly variant: string;
  readonly viewpoint: string;
  readonly seconds: number;
  readonly fps: number;
  /** Frame interval statistics, ms. */
  readonly frame: RollingStats;
  readonly cpu: RollingStats;
  /** Averages, ms. */
  readonly updateMs: number;
  readonly renderMs: number;
  readonly animationsMs: number;
  readonly physicsMs: number;
  readonly shadowMs: number;
  readonly evaluateMs: number;
  readonly drawMs: number;
  /** Null when the timer query (or GPU sync mode) is unavailable. */
  readonly gpuMs: number | null;
  readonly gpuSyncMs: number | null;
  /** Averages per frame. */
  readonly drawCalls: number;
  readonly activeMeshes: number;
  readonly triangles: number;
  readonly activeBones: number;
  readonly shadowCasters: readonly number[];
  readonly renderSize: readonly [number, number];
}

export interface BenchStatus {
  readonly segment: number;
  readonly segments: number;
  readonly pass: BenchPass;
  readonly variant: string;
  readonly viewpoint: string;
  readonly measuring: boolean;
  /** Seconds left in this segment and in the whole run. */
  readonly segmentLeftS: number;
  readonly totalLeftS: number;
}

export interface BenchRun {
  readonly startedAt: string;
  readonly durationS: number;
  readonly timing: BenchTiming;
  /** Segments restarted because the tab was hidden or a frame stalled. */
  readonly interruptions: number;
  readonly viewpoints: readonly Pick<BenchViewpoint, "id" | "label" | "position" | "yaw" | "pitch">[];
  readonly variants: readonly { readonly id: string; readonly label: string }[];
  readonly segments: readonly SegmentResult[];
}

export interface BenchEvents {
  /** The camera moved to a new viewpoint (after it is posed). */
  onViewpoint?(viewpoint: BenchViewpoint): void;
  onComplete?(run: BenchRun): void;
}

interface Segment {
  readonly pass: BenchPass;
  readonly variantId: string;
  /** Null for the baseline. */
  readonly variant: BenchVariant | null;
  readonly viewpoint: BenchViewpoint;
  readonly warmupMs: number;
  readonly measureMs: number;
}

/** A gap this long between frames means the tab was hidden or the page stalled: the segment starts over. */
const STALL_MS = 500;
/** Stalls restart a segment at most this many times, so a very slow machine still finishes. */
const MAX_STALL_RESTARTS = 2;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Automated camera path over fixed viewpoints: a full baseline pass, then a shortened pass per A/B variant bracketed by
 * two baseline passes (the second one exposes thermal drift). The game loop calls `update(now)` before rendering (it
 * poses the camera) and `record(sample)` after each frame.
 */
export class BenchRunner {
  private readonly segments: Segment[] = [];
  private readonly results: SegmentResult[] = [];
  private index = -1;
  private segmentStart = 0;
  private segmentWarmupMs = 0;
  private lastUpdate = 0;
  private startedAt = 0;
  private startedIso = "";
  private interruptions = 0;
  private interrupted = false;
  private stallRestarts = 0;
  private measuring = false;
  private activeVariant: BenchVariant | null = null;
  private undo: (() => void) | null = null;
  private accumulator = new Accumulator();
  private state: "idle" | "running" | "done" = "idle";

  constructor(
    private readonly camera: TargetCamera,
    private readonly viewpoints: readonly BenchViewpoint[],
    private readonly variants: readonly BenchVariant[],
    private readonly probe: BenchProbe,
    private readonly timing: BenchTiming = DEFAULT_BENCH_TIMING,
    private readonly events: BenchEvents = {},
  ) {
    if (viewpoints.length === 0) throw new Error("Benchmark needs at least one viewpoint");
    const pass = (pass: BenchPass, variantId: string, variant: BenchVariant | null, warmupMs: number, measureMs: number) => {
      for (const viewpoint of viewpoints) this.segments.push({ pass, variantId, variant, viewpoint, warmupMs, measureMs });
    };
    pass("full", "baseline", null, timing.fullWarmupMs, timing.fullMeasureMs);
    if (variants.length > 0) {
      const short = (id: string, variant: BenchVariant | null) => pass("ab", id, variant, timing.shortWarmupMs, timing.shortMeasureMs);
      short("baseline", null);
      for (const variant of variants) short(variant.id, variant);
      short("baseline_end", null);
    }
  }

  get running(): boolean {
    return this.state === "running";
  }

  get done(): boolean {
    return this.state === "done";
  }

  /** Planned duration of the whole run, s (settling included, interruptions not). */
  get plannedSeconds(): number {
    return this.secondsFrom(0);
  }

  start(now: number): void {
    if (this.state !== "idle") return;
    this.state = "running";
    this.startedAt = now;
    this.startedIso = new Date().toISOString();
    this.lastUpdate = now;
    this.enter(0, now);
  }

  /** Before rendering: advances segments and poses the camera. */
  update(now: number): void {
    if (this.state !== "running") return;
    const hidden = !this.probe.isVisible();
    const stalled = now - this.lastUpdate > STALL_MS && this.stallRestarts < MAX_STALL_RESTARTS;
    this.lastUpdate = now;
    if (hidden || stalled) {
      if (!this.interrupted) this.interruptions++;
      if (stalled) this.stallRestarts++;
      this.interrupted = true;
      this.restartSegment(now);
    } else {
      this.interrupted = false;
    }

    let segment = this.segments[this.index]!;
    if (now - this.segmentStart >= this.segmentWarmupMs + segment.measureMs) {
      this.results.push(this.accumulator.result(segment, this.probe.renderSize()));
      if (this.index + 1 >= this.segments.length) {
        this.finish(now);
        return;
      }
      this.enter(this.index + 1, now);
      segment = this.segments[this.index]!;
    }

    const elapsed = now - this.segmentStart;
    this.measuring = elapsed >= this.segmentWarmupMs;
    const { position, yaw, pitch } = segment.viewpoint;
    const sweep = Math.sin((2 * Math.PI * elapsed) / this.timing.sweepPeriodMs) * this.timing.sweepDegrees * DEG_TO_RAD;
    this.camera.position.set(position[0], position[1], position[2]);
    this.camera.rotation.set(pitch, yaw + sweep, 0);
  }

  /** After a frame: adds it to the segment when measuring. */
  record(sample: FrameSample): void {
    if (this.state === "running" && this.measuring) this.accumulator.add(sample, this.probe.shadowCasters());
  }

  status(now: number): BenchStatus | null {
    const segment = this.segments[this.index];
    if (this.state !== "running" || !segment) return null;
    const segmentLeftS = Math.max(0, (this.segmentStart + this.segmentWarmupMs + segment.measureMs - now) / 1000);
    return {
      segment: this.index + 1,
      segments: this.segments.length,
      pass: segment.pass,
      variant: segment.variant?.label ?? segment.variantId,
      viewpoint: segment.viewpoint.label,
      measuring: this.measuring,
      segmentLeftS,
      totalLeftS: segmentLeftS + this.secondsFrom(this.index + 1),
    };
  }

  /** Stops early, undoing any active variant. */
  abort(): void {
    if (this.state !== "running") return;
    this.undo?.();
    this.undo = null;
    this.state = "done";
  }

  private enter(index: number, now: number): void {
    this.index = index;
    const segment = this.segments[index]!;
    const switched = index === 0 || segment.variant !== this.activeVariant;
    if (switched && index > 0) {
      this.undo?.();
      this.undo = segment.variant?.apply() ?? null;
      this.activeVariant = segment.variant;
    }
    this.segmentWarmupMs = segment.warmupMs + (switched ? this.timing.settleMs : 0);
    this.stallRestarts = 0;
    this.restartSegment(now);
    const { position, yaw, pitch } = segment.viewpoint;
    this.camera.position.set(position[0], position[1], position[2]);
    this.camera.rotation.set(pitch, yaw, 0);
    this.events.onViewpoint?.(segment.viewpoint);
  }

  private restartSegment(now: number): void {
    this.segmentStart = now;
    this.measuring = false;
    this.accumulator = new Accumulator();
  }

  private finish(now: number): void {
    this.undo?.();
    this.undo = null;
    this.activeVariant = null;
    this.state = "done";
    this.events.onComplete?.({
      startedAt: this.startedIso,
      durationS: (now - this.startedAt) / 1000,
      timing: this.timing,
      interruptions: this.interruptions,
      viewpoints: this.viewpoints.map(({ id, label, position, yaw, pitch }) => ({ id, label, position, yaw, pitch })),
      variants: this.variants.map(({ id, label }) => ({ id, label })),
      segments: this.results,
    });
  }

  private secondsFrom(index: number): number {
    let ms = 0;
    let previous = this.segments[index - 1]?.variant;
    for (let i = index; i < this.segments.length; i++) {
      const segment = this.segments[i]!;
      const switched = i === 0 || segment.variant !== previous;
      ms += segment.warmupMs + segment.measureMs + (switched ? this.timing.settleMs : 0);
      previous = segment.variant;
    }
    return ms / 1000;
  }
}

const AVERAGED = ["updateMs", "renderMs", "animationsMs", "physicsMs", "shadowMs", "evaluateMs", "drawMs", "drawCalls", "activeMeshes", "triangles", "activeBones"] as const;
type Averaged = (typeof AVERAGED)[number];

class Accumulator {
  private readonly intervals: number[] = [];
  private readonly cpu: number[] = [];
  private readonly sums: Record<Averaged, number> = Object.fromEntries(AVERAGED.map((k) => [k, 0])) as Record<Averaged, number>;
  private gpu = 0;
  private gpuFrames = 0;
  private sync = 0;
  private syncFrames = 0;
  private readonly casters: number[] = [];

  add(sample: FrameSample, casters: readonly number[]): void {
    this.intervals.push(sample.intervalMs);
    this.cpu.push(sample.cpuMs);
    for (const key of AVERAGED) this.sums[key] += sample[key];
    if (Number.isFinite(sample.gpuMs)) {
      this.gpu += sample.gpuMs;
      this.gpuFrames++;
    }
    if (Number.isFinite(sample.gpuSyncMs)) {
      this.sync += sample.gpuSyncMs;
      this.syncFrames++;
    }
    for (let i = 0; i < casters.length; i++) this.casters[i] = (this.casters[i] ?? 0) + casters[i]!;
  }

  result(segment: Segment, renderSize: readonly [number, number]): SegmentResult {
    const frames = this.intervals.length;
    const seconds = this.intervals.reduce((a, b) => a + b, 0) / 1000;
    const avg = (key: Averaged) => (frames > 0 ? this.sums[key] / frames : Number.NaN);
    return {
      pass: segment.pass,
      variant: segment.variantId,
      viewpoint: segment.viewpoint.id,
      seconds,
      fps: seconds > 0 ? frames / seconds : 0,
      frame: summarize(this.intervals),
      cpu: summarize(this.cpu),
      updateMs: avg("updateMs"),
      renderMs: avg("renderMs"),
      animationsMs: avg("animationsMs"),
      physicsMs: avg("physicsMs"),
      shadowMs: avg("shadowMs"),
      evaluateMs: avg("evaluateMs"),
      drawMs: avg("drawMs"),
      gpuMs: this.gpuFrames > 0 ? this.gpu / this.gpuFrames : null,
      gpuSyncMs: this.syncFrames > 0 ? this.sync / this.syncFrames : null,
      drawCalls: avg("drawCalls"),
      activeMeshes: avg("activeMeshes"),
      triangles: avg("triangles"),
      activeBones: avg("activeBones"),
      shadowCasters: this.casters.map((sum) => (frames > 0 ? sum / frames : 0)),
      renderSize: [renderSize[0], renderSize[1]],
    };
  }
}
