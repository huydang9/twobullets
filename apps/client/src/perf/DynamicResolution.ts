import type { AbstractEngine } from "@babylonjs/core";

export interface DynamicResolutionOptions {
  /** Frame budget as a rate; match the display refresh (a 60 Hz display never reaches 120). Default 120. */
  readonly targetFps?: number;
  /** Largest hardware scaling multiplier over the starting level: 1.5 renders at 67% linear resolution. */
  readonly maxScale?: number;
  /** Multiplier change per step. */
  readonly step?: number;
}

/** Frames over budget this long trigger a step down in resolution, ms. */
const OVER_BUDGET_MS = 300;
/** Minimum time between changes, ms. */
const SETTLE_MS = 500;
/** First wait before probing a higher resolution; doubles each time a probe fails, up to MAX_PROBE_DELAY_MS. */
const PROBE_DELAY_MS = 2000;
const MAX_PROBE_DELAY_MS = 16000;

/**
 * Adaptive hardware scaling (dynamic resolution). The frame interval is display-paced, so headroom can't be read from
 * it: after running within budget for a while the controller probes one step sharper, and backs off (waiting twice as
 * long before the next probe) if that drops frames again.
 */
export class DynamicResolution {
  private readonly base: number;
  private readonly budgetMs: number;
  private readonly maxScale: number;
  private readonly step: number;
  private scale = 1;
  private average = 0;
  private overSince = -1;
  private withinSince = -1;
  private lastChange = -Infinity;
  private lastProbe = -Infinity;
  private probeDelay = PROBE_DELAY_MS;

  constructor(
    private readonly engine: AbstractEngine,
    options: DynamicResolutionOptions = {},
  ) {
    this.base = engine.getHardwareScalingLevel();
    this.budgetMs = 1000 / (options.targetFps ?? 120);
    this.maxScale = options.maxScale ?? 1.5;
    this.step = options.step ?? 0.1;
    this.average = this.budgetMs;
  }

  /** Current multiplier over the starting hardware scaling level (1 = full resolution). */
  get currentScale(): number {
    return this.scale;
  }

  update(now: number, frameMs: number): void {
    this.average += (Math.min(frameMs, 100) - this.average) * 0.1;
    const over = this.average > this.budgetMs * 1.1;
    const within = this.average < this.budgetMs * 1.03;
    this.overSince = over ? (this.overSince < 0 ? now : this.overSince) : -1;
    this.withinSince = within ? (this.withinSince < 0 ? now : this.withinSince) : -1;
    if (now - this.lastChange < SETTLE_MS) return;

    if (over && now - this.overSince >= OVER_BUDGET_MS && this.scale < this.maxScale) {
      // Dropping frames right after a probe: the sharper step doesn't fit, so wait longer before the next one.
      if (now - this.lastProbe < this.probeDelay) this.probeDelay = Math.min(this.probeDelay * 2, MAX_PROBE_DELAY_MS);
      this.apply(Math.min(this.maxScale, this.scale + this.step), now);
    } else if (within && now - this.withinSince >= this.probeDelay && this.scale > 1) {
      this.lastProbe = now;
      this.apply(Math.max(1, this.scale - this.step), now);
    }
  }

  /** Back to full resolution. */
  reset(): void {
    this.apply(1, performance.now());
    this.probeDelay = PROBE_DELAY_MS;
  }

  private apply(scale: number, now: number): void {
    this.lastChange = now;
    this.overSince = -1;
    this.withinSince = -1;
    if (scale === this.scale) return;
    this.scale = scale;
    this.engine.setHardwareScalingLevel(this.base * scale);
  }
}
