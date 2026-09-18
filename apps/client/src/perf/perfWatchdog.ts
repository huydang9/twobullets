/**
 * Fires once when the game has been durably slow, so the client can offer performance advice (see `gpuClass.ts`:
 * the warning is driven by this watchdog and/or `GpuInfo.hybridHint`, never by `gpuClass === "integrated"` alone -
 * Apple Silicon is integrated and fast).
 *
 * Pure time-in/state-out: the caller passes the clock, so tests need no timers and nothing is allocated per frame.
 */

export interface PerfWatchdogOptions {
  /** Smoothed FPS at or below this counts as slow. Default 30. */
  readonly slowFps?: number;
  /** Ignore this long after construction - loading, shader compile, asset upload. Default 6000 ms. */
  readonly graceMs?: number;
  /** FPS must stay slow this long before it fires. Default 4000 ms. */
  readonly sustainMs?: number;
}

/** Exponential moving average factor: ~40 frames to cover most of a step, so a few stutters can't fire the warning. */
const SMOOTHING = 0.08;
/** FPS must climb this far above the threshold to clear the slow timer, so it can't flap at the boundary. */
const RECOVERY_RATIO = 1.15;

export class PerfWatchdog {
  private readonly slowFps: number;
  private readonly recoverFps: number;
  private readonly graceMs: number;
  private readonly sustainMs: number;
  private startMs = 0;
  private started = false;
  private average = 0;
  private seeded = false;
  private slowSinceMs = -1;
  private fired = false;

  constructor(options: PerfWatchdogOptions = {}) {
    this.slowFps = options.slowFps ?? 30;
    this.recoverFps = this.slowFps * RECOVERY_RATIO;
    this.graceMs = options.graceMs ?? 6000;
    this.sustainMs = options.sustainMs ?? 4000;
  }

  /** Exponentially smoothed FPS. 0 until the first sample past the grace period. */
  get averageFps(): number {
    return this.average;
  }

  get triggered(): boolean {
    return this.fired;
  }

  /** Feed one frame. Returns true ONLY on the frame where slowness is first confirmed. */
  update(nowMs: number, fps: number): boolean {
    if (!Number.isFinite(nowMs)) return false;
    // The constructor doesn't know the clock: the first call starts the grace period.
    if (!this.started) {
      this.started = true;
      this.startMs = nowMs;
    }
    if (!Number.isFinite(fps) || fps <= 0) return false;
    if (nowMs - this.startMs < this.graceMs) return false;

    if (this.seeded) this.average += (fps - this.average) * SMOOTHING;
    else {
      this.average = fps;
      this.seeded = true;
    }
    if (this.fired) return false;

    if (this.average <= this.slowFps) {
      if (this.slowSinceMs < 0) this.slowSinceMs = nowMs;
      if (nowMs - this.slowSinceMs >= this.sustainMs) {
        this.fired = true;
        return true;
      }
    } else if (this.average > this.recoverFps) {
      this.slowSinceMs = -1;
    }
    return false;
  }

  /** Arms it again (player dismissed the warning and wants it re-checked). The grace period restarts from the next update. */
  reset(): void {
    this.started = false;
    this.startMs = 0;
    this.average = 0;
    this.seeded = false;
    this.slowSinceMs = -1;
    this.fired = false;
  }
}
