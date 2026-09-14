import type { Engine, Scene, TargetCamera } from "@babylonjs/core";
import type { TargetRange } from "../targets/TargetRange";
import type { Hud } from "../ui/Hud";
import type { Environment } from "../world/environment";
import type { MapRuntime } from "../world/mapRuntime";
import { formatBenchMarkdown, formatBenchReport, formatBenchJson, type BenchReport } from "./benchReport";
import { BenchRunner, type BenchRun } from "./BenchRunner";
import { createBenchVariants } from "./benchVariants";
import { resolveBenchViewpoints } from "./benchViewpoints";
import { describeOptimizations } from "./flags";
import { PerfMonitor, type FrameSample } from "./PerfMonitor";
import { PerfOverlay } from "./PerfOverlay";

export interface PerfToolsOptions {
  /** Show the stats panel from the start (`?perf=1`). */
  readonly panel: boolean;
  /** Benchmark to run (`?bench=v1`), or null. */
  readonly bench: string | null;
  /** A/B variant ids to run (`?variants=grassOff,shadowsOff`); empty runs none; null runs all. */
  readonly variants: readonly string[] | null;
  /** 1-pixel readback per frame to time the GPU when no timer query exists (`?gpusync=1`). */
  readonly gpuSync: boolean;
}

export interface PerfToolsContext {
  readonly engine: Engine;
  readonly scene: Scene;
  readonly camera: TargetCamera;
  readonly environment: Environment;
  readonly world: MapRuntime | null;
  readonly targets: TargetRange;
  readonly hud: Hud;
}

const PANEL_KEY = "F4";
const REFRESH_MS = 250;

export function readPerfOptions(search: string): PerfToolsOptions {
  const params = new URLSearchParams(search);
  const variants = params.get("variants");
  return {
    panel: params.get("perf") === "1",
    bench: params.get("bench"),
    variants: variants === null ? null : variants === "0" || variants === "none" ? [] : variants.split(",").map((v) => v.trim()),
    gpuSync: params.get("gpusync") === "1",
  };
}

/**
 * DEV performance tools: the F4 / `?perf=1` stats panel and the `?bench=v1` benchmark. The game loop calls the four
 * frame hooks; while the benchmark runs it owns the camera (`drivesCamera`) and the game skips player movement.
 */
export class PerfTools {
  private monitor: PerfMonitor | null = null;
  private readonly overlay = new PerfOverlay();
  private readonly bench: BenchRunner | null = null;
  private readonly recent = new FrameWindow();
  private lastRefresh = 0;

  constructor(
    private readonly context: PerfToolsContext,
    private readonly options: PerfToolsOptions,
  ) {
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.code !== PANEL_KEY) return;
        event.preventDefault();
        if (!event.repeat) this.togglePanel();
      },
      { capture: true },
    );
    if (options.panel) this.togglePanel();
    this.bench = this.createBench();
  }

  /** True while the benchmark poses the camera: skip player input and movement. */
  get drivesCamera(): boolean {
    return this.bench?.running ?? false;
  }

  beginFrame(): void {
    const now = performance.now();
    if (this.bench && !this.bench.running && !this.bench.done) this.startBench(now);
    this.monitor?.beginFrame();
    this.bench?.update(now);
  }

  beforeRender(): void {
    this.monitor?.beforeRender();
  }

  afterRender(): void {
    this.monitor?.afterRender();
  }

  endFrame(): void {
    this.monitor?.endFrame();
  }

  private togglePanel(): void {
    this.ensureMonitor();
    this.overlay.panelVisible = !this.overlay.panelVisible;
  }

  private ensureMonitor(): PerfMonitor {
    if (this.monitor) return this.monitor;
    const monitor = new PerfMonitor(this.context.engine, this.context.scene, { gpuSync: this.options.gpuSync });
    monitor.onFrame((sample) => this.onFrame(sample));
    this.monitor = monitor;
    return monitor;
  }

  private onFrame(sample: FrameSample): void {
    this.bench?.record(sample);
    this.recent.add(sample);
    const now = performance.now();
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;
    if (this.overlay.panelVisible) this.overlay.setStats(this.statsText());
    this.recent.reset();
    const status = this.bench?.status(now);
    this.overlay.setStatus(
      status
        ? `BENCH ${status.segment}/${status.segments} · ${status.pass === "full" ? "full pass" : `A/B: ${status.variant}`} · ${status.viewpoint} · ` +
            `${status.measuring ? "measuring" : "warming up"} ${status.segmentLeftS.toFixed(1)} s · ${minutes(status.totalLeftS)} left · keep this tab visible`
        : null,
    );
  }

  private createBench(): BenchRunner | null {
    const { bench } = this.options;
    if (!bench) return null;
    const { world, camera } = this.context;
    if (bench !== "v1" || !world) {
      console.warn(`[bench] unknown benchmark "${bench}" or no map loaded; use ?bench=v1 (it loads Map v1)`);
      return null;
    }
    const viewpoints = resolveBenchViewpoints(world.map, world.terrain, world.layout);
    const variants = createBenchVariants({ ...this.context, world }, this.options.variants ?? undefined);
    const shadowCulling = this.context.environment.shadowCulling;
    const runner = new BenchRunner(
      camera,
      viewpoints,
      variants,
      {
        shadowCasters: () => shadowCulling?.counts ?? [],
        renderSize: () => [this.context.engine.getRenderWidth(), this.context.engine.getRenderHeight()],
        isVisible: () => document.visibilityState === "visible",
      },
      undefined,
      {
        onViewpoint: () => this.monitor?.resetWindow(),
        onComplete: (run) => this.completeBench(run),
      },
    );
    console.info(`[bench] v1: ${viewpoints.length} viewpoints, ${variants.length} A/B variants, about ${minutes(runner.plannedSeconds)}. Keep the tab visible.`);
    return runner;
  }

  private startBench(now: number): void {
    this.ensureMonitor();
    this.overlay.setShield(true);
    this.context.hud.debugForceVisible(true);
    this.bench?.start(now);
  }

  private completeBench(run: BenchRun): void {
    this.overlay.setShield(false);
    this.overlay.setStatus(null);
    this.context.hud.debugForceVisible(false);
    const report: BenchReport = { ...run, meta: this.meta() };
    console.info(formatBenchMarkdown(report));
    console.info(formatBenchJson(report));
    Object.assign(window, { __twobulletsBench: report });
    this.overlay.showResults(formatBenchReport(report));
  }

  private meta(): BenchReport["meta"] {
    const { engine, scene } = this.context;
    const canvas = engine.getRenderingCanvas();
    return {
      userAgent: navigator.userAgent,
      gpu: engine.getGlInfo().renderer,
      webgl: engine.webGLVersion,
      cores: navigator.hardwareConcurrency,
      canvas: canvas ? `${canvas.clientWidth}×${canvas.clientHeight} CSS px` : "?",
      render: `${engine.getRenderWidth()}×${engine.getRenderHeight()}`,
      hardwareScaling: engine.getHardwareScalingLevel(),
      devicePixelRatio: window.devicePixelRatio,
      antialias: engine.getCreationOptions().antialias ?? false,
      gpuTimer: this.monitor?.gpuTimerAvailable ? "EXT_disjoint_timer_query_webgl2" : "unavailable",
      gpuSync: this.options.gpuSync,
      optimizations: describeOptimizations(),
      meshes: scene.meshes.length,
      materials: scene.materials.length,
      textures: scene.textures.length,
    };
  }

  private statsText(): string {
    const { engine, scene, world, environment } = this.context;
    const monitor = this.ensureMonitor();
    const f = monitor.intervalStats();
    const w = this.recent;
    const lines = [
      `PERF (${PANEL_KEY})  render ${engine.getRenderWidth()}×${engine.getRenderHeight()} · scaling ${engine.getHardwareScalingLevel().toFixed(2)} · DPR ${window.devicePixelRatio}`,
      `frame  ${ms(f.avg)} avg · p95 ${ms(f.p95)} · p99 ${ms(f.p99)} · max ${ms(f.max)} · ${(1000 / f.avg).toFixed(0)} fps`,
      `cpu    ${ms(w.avg("cpuMs"))} loop · update ${ms(w.avg("updateMs"))} · scene.render ${ms(w.avg("renderMs"))}`,
      `       anim ${ms(w.avg("animationsMs"))} · physics ${ms(w.avg("physicsMs"))} · shadow RTT ${ms(w.avg("shadowMs"))} · eval ${ms(w.avg("evaluateMs"))} · draw ${ms(w.avg("drawMs"))}`,
      monitor.gpuTimerAvailable
        ? `gpu    ${ms(w.avg("gpuMs"))}`
        : monitor.gpuSync
          ? `gpu    sync wait ${ms(w.avg("gpuSyncMs"))} (gpusync mode)`
          : "gpu    n/a: EXT_disjoint_timer_query_webgl2 unavailable (try ?gpusync=1)",
      `draws  ${w.avg("drawCalls").toFixed(0)} · meshes ${w.avg("activeMeshes").toFixed(0)}/${scene.meshes.length} · tris ${(w.avg("triangles") / 1e6).toFixed(2)}M · bones ${w.avg("activeBones").toFixed(0)} · textures ${scene.textures.length}`,
    ];
    const culling = environment.shadowCulling;
    if (culling) lines.push(`casters/cascade ${culling.counts.join(" · ")} (of ${culling.candidates})`);
    if (world) {
      const terrain = world.renderer.getStats();
      lines.push(`grass ${world.grass.instances} · terrain chunks ${terrain.visible}/${terrain.chunks} · LOD ${terrain.lodHistogram.join("/")}`);
    }
    lines.push(`opt    ${describeOptimizations()}`);
    return lines.join("\n");
  }
}

type NumericKey = { [K in keyof FrameSample]: FrameSample[K] extends number ? K : never }[keyof FrameSample];

/** Sums of the samples since the last panel refresh. */
class FrameWindow {
  private readonly sums = new Map<NumericKey, number>();
  private readonly counts = new Map<NumericKey, number>();

  add(sample: FrameSample): void {
    for (const key of Object.keys(sample) as NumericKey[]) {
      const value = sample[key];
      if (!Number.isFinite(value)) continue;
      this.sums.set(key, (this.sums.get(key) ?? 0) + value);
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }
  }

  avg(key: NumericKey): number {
    const count = this.counts.get(key) ?? 0;
    return count > 0 ? this.sums.get(key)! / count : Number.NaN;
  }

  reset(): void {
    this.sums.clear();
    this.counts.clear();
  }
}

function ms(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "–";
}

function minutes(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
