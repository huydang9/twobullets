/**
 * Headless check of the benchmark camera path (NullEngine, simulated clock, no timings):
 *
 *   node --experimental-transform-types --import ./tools/map/lib/resolve.ts apps/client/src/perf/checkBenchPath.ts
 *
 * Builds the Map v1 terrain and layout, validates the viewpoints, then runs the whole BenchRunner schedule against a
 * NullEngine camera and checks every posed frame stands on or above the terrain, every variant is applied and undone
 * once, and every segment collects frames. Throws (exit code 1) on the first failure.
 */
import { NullEngine, Scene, TargetCamera, Vector3 } from "@babylonjs/core";
import { MAP_V1, buildMapLayout, buildTerrain } from "@twobullets/shared";
import { BenchRunner, DEFAULT_BENCH_TIMING, type BenchRun, type BenchVariant } from "./BenchRunner";
import { BENCH_EYE_HEIGHT, resolveBenchViewpoints, validateBenchViewpoints } from "./benchViewpoints";
import type { FrameSample } from "./PerfMonitor";

const FRAME_MS = 1000 / 120;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`[bench check] ${message}`);
}

const terrain = buildTerrain(MAP_V1.terrain, MAP_V1.flatten);
const layout = buildMapLayout(MAP_V1, terrain);
const viewpoints = resolveBenchViewpoints(MAP_V1, terrain, layout);
const issues = validateBenchViewpoints(viewpoints, terrain, layout);
check(issues.length === 0, `viewpoint issues:\n  ${issues.join("\n  ")}`);
for (const v of viewpoints) {
  const [x, y, z] = v.position;
  const above = y - terrain.sampleHeight(x, z);
  console.info(`[bench check] ${v.id.padEnd(8)} (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) ${above.toFixed(1)} m above terrain, yaw ${((v.yaw * 180) / Math.PI).toFixed(0)}°, pitch ${((v.pitch * 180) / Math.PI).toFixed(1)}°`);
}

const engine = new NullEngine();
const scene = new Scene(engine);
const camera = new TargetCamera("benchCamera", Vector3.Zero(), scene);
scene.activeCamera = camera;

const applied = new Map<string, number>();
const undone = new Map<string, number>();
const variants: BenchVariant[] = ["first", "second"].map((id) => ({
  id,
  label: id,
  apply: () => {
    applied.set(id, (applied.get(id) ?? 0) + 1);
    return () => undone.set(id, (undone.get(id) ?? 0) + 1);
  },
}));

// Assigned from a callback, so keep the declared type wide for control-flow analysis.
let run = null as BenchRun | null;
const visited = new Set<string>();
const runner = new BenchRunner(
  camera,
  viewpoints,
  variants,
  { shadowCasters: () => [1, 2, 3, 4], renderSize: () => [1920, 1080], isVisible: () => true },
  DEFAULT_BENCH_TIMING,
  {
    onViewpoint: (viewpoint) => {
      visited.add(viewpoint.id);
      scene.render();
    },
    onComplete: (result) => (run = result),
  },
);

const sample: FrameSample = {
  intervalMs: FRAME_MS,
  cpuMs: 1,
  updateMs: 0.2,
  renderMs: 0.7,
  animationsMs: 0.1,
  physicsMs: 0.1,
  shadowMs: 0.2,
  evaluateMs: 0.1,
  drawMs: 0.2,
  gpuMs: Number.NaN,
  gpuSyncMs: Number.NaN,
  drawCalls: 100,
  activeMeshes: 50,
  triangles: 1e5,
  activeBones: 0,
};

let now = 0;
let frames = 0;
const maxFrames = Math.ceil((runner.plannedSeconds * 1000) / FRAME_MS) + 1000;
runner.start(now);
while (!run && frames < maxFrames) {
  now += FRAME_MS;
  frames++;
  runner.update(now);
  if (!runner.running) break;
  const { x, y, z } = camera.position;
  check(y >= terrain.sampleHeight(x, z) + BENCH_EYE_HEIGHT - 1e-3, `frame ${frames}: camera (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}) is below eye height over the terrain`);
  runner.record(sample);
}

const finished = run;
check(finished !== null, `runner did not finish within ${maxFrames} frames`);
check(visited.size === viewpoints.length, `visited ${visited.size} of ${viewpoints.length} viewpoints`);
const expectedSegments = viewpoints.length * (1 + variants.length + 2);
check(finished.segments.length === expectedSegments, `${finished.segments.length} segments, expected ${expectedSegments}`);
for (const s of finished.segments) check(s.frame.frames > 0, `segment ${s.pass}/${s.variant}/${s.viewpoint} measured no frames`);
for (const v of variants) check(applied.get(v.id) === 1 && undone.get(v.id) === 1, `variant ${v.id} applied ${applied.get(v.id) ?? 0}× and undone ${undone.get(v.id) ?? 0}×`);
const simulated = (frames * FRAME_MS) / 1000;
check(Math.abs(simulated - runner.plannedSeconds) < 2, `simulated ${simulated.toFixed(1)} s, planned ${runner.plannedSeconds.toFixed(1)} s`);

console.info(`[bench check] ok: ${finished.segments.length} segments over ${frames} frames (${simulated.toFixed(0)} s simulated), all camera poses above the terrain`);
scene.dispose();
engine.dispose();
