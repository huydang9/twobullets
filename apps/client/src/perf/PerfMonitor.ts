import { EngineInstrumentation, SceneInstrumentation, type AbstractEngine, type Scene } from "@babylonjs/core";
import { summarize, type RollingStats } from "./stats";

/** One rendered frame. Times in ms. */
export interface FrameSample {
  /** Since the previous frame began: what the display sees (vsync-capped). */
  readonly intervalMs: number;
  /** Whole render-loop callback: game update, scene.render, HUD. */
  readonly cpuMs: number;
  /** Game systems before scene.render (player, combat, FX, world LOD and grass). */
  readonly updateMs: number;
  /** scene.render, from animations to the last draw submitted. */
  readonly renderMs: number;
  readonly animationsMs: number;
  readonly physicsMs: number;
  /** Render targets: the cascaded shadow map (all cascades). */
  readonly shadowMs: number;
  /** Frustum culling and active mesh selection for the main camera. */
  readonly evaluateMs: number;
  /** Main camera draw phase. */
  readonly drawMs: number;
  /** GPU time from EXT_disjoint_timer_query_webgl2 (arrives a few frames late); NaN when unavailable. */
  readonly gpuMs: number;
  /** Time blocked on a 1-pixel readback after rendering (`gpusync` mode only); NaN otherwise. */
  readonly gpuSyncMs: number;
  /** Draw calls in all passes (shadow cascades included). */
  readonly drawCalls: number;
  readonly activeMeshes: number;
  /** Triangles submitted in all passes. */
  readonly triangles: number;
  readonly activeBones: number;
}

export interface PerfMonitorOptions {
  /** Force a GPU sync each frame with a 1-pixel readback, to time GPU work when no timer query exists. Distorts. */
  readonly gpuSync?: boolean;
  /** Frames kept for the rolling statistics. */
  readonly window?: number;
}

/**
 * Frame instrumentation built on Babylon's SceneInstrumentation and EngineInstrumentation. The game loop calls
 * `beginFrame`, `beforeRender`, `afterRender` and `endFrame`; the monitor turns them into a FrameSample per frame and
 * notifies `onFrame` listeners (the overlay and the benchmark).
 */
export class PerfMonitor {
  readonly gpuTimerAvailable: boolean;
  readonly gpuSync: boolean;
  private readonly scene: SceneInstrumentation;
  private readonly engineInstrumentation: EngineInstrumentation;
  private readonly listeners: ((sample: FrameSample) => void)[] = [];
  private readonly intervals: Float64Array;
  private intervalCount = 0;
  private intervalNext = 0;
  private readonly pixel = new Uint8Array(4);
  private readonly gl: WebGL2RenderingContext | WebGLRenderingContext | null;

  private frameStart = -1;
  private previousStart = -1;
  private updateEnd = 0;
  private syncMs = Number.NaN;
  private sample: FrameSample | null = null;

  constructor(
    engine: AbstractEngine,
    private readonly target: Scene,
    options: PerfMonitorOptions = {},
  ) {
    this.scene = new SceneInstrumentation(target);
    this.scene.captureFrameTime = true;
    this.scene.captureRenderTime = true;
    this.scene.captureRenderTargetsRenderTime = true;
    this.scene.captureActiveMeshesEvaluationTime = true;
    this.scene.captureAnimationsTime = true;
    this.scene.capturePhysicsTime = true;
    this.engineInstrumentation = new EngineInstrumentation(engine);
    this.gpuTimerAvailable = Boolean(engine.getCaps().timerQuery);
    if (this.gpuTimerAvailable) this.engineInstrumentation.captureGPUFrameTime = true;
    this.gpuSync = options.gpuSync ?? false;
    const canvas = engine.getRenderingCanvas();
    this.gl = canvas ? (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) : null;
    this.intervals = new Float64Array(options.window ?? 600);
  }

  /** Latest completed frame. */
  get last(): FrameSample | null {
    return this.sample;
  }

  onFrame(listener: (sample: FrameSample) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  beginFrame(): void {
    this.previousStart = this.frameStart;
    this.frameStart = performance.now();
  }

  beforeRender(): void {
    this.updateEnd = performance.now();
  }

  afterRender(): void {
    this.syncMs = Number.NaN;
    if (this.gpuSync && this.gl) {
      const started = performance.now();
      this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.pixel);
      this.syncMs = performance.now() - started;
    }
  }

  endFrame(): void {
    const end = performance.now();
    if (this.previousStart < 0) return;
    const s = this.scene;
    const gpu = this.engineInstrumentation.gpuFrameTimeCounter;
    const intervalMs = this.frameStart - this.previousStart;
    this.sample = {
      intervalMs,
      cpuMs: end - this.frameStart,
      updateMs: this.updateEnd - this.frameStart,
      renderMs: s.frameTimeCounter.current,
      animationsMs: s.animationsTimeCounter.current,
      physicsMs: s.physicsTimeCounter.current,
      shadowMs: s.renderTargetsRenderTimeCounter.current,
      evaluateMs: s.activeMeshesEvaluationTimeCounter.current,
      drawMs: s.renderTimeCounter.current,
      // Babylon reports timer queries in nanoseconds.
      gpuMs: this.gpuTimerAvailable && gpu.count > 0 ? gpu.current * 1e-6 : Number.NaN,
      gpuSyncMs: this.syncMs,
      drawCalls: s.drawCallsCounter.current,
      activeMeshes: this.target.getActiveMeshes().length,
      triangles: this.target.getActiveIndices() / 3,
      activeBones: this.target.getActiveBones(),
    };
    this.intervals[this.intervalNext] = intervalMs;
    this.intervalNext = (this.intervalNext + 1) % this.intervals.length;
    this.intervalCount = Math.min(this.intervalCount + 1, this.intervals.length);
    for (const listener of this.listeners) listener(this.sample);
  }

  /** Frame interval statistics over the rolling window. */
  intervalStats(): RollingStats {
    return summarize(this.intervals.subarray(0, this.intervalCount));
  }

  /** Resets the rolling window (after a teleport or toggle, so spikes don't linger). */
  resetWindow(): void {
    this.intervalCount = 0;
    this.intervalNext = 0;
  }

  dispose(): void {
    this.listeners.length = 0;
    this.scene.dispose();
    this.engineInstrumentation.dispose();
  }
}
