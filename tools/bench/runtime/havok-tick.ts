/**
 * Full authoritative-tick benchmark for one match: 500 × 500 m heightfield, ~300 buildings, 10 players with character
 * controllers + step-up/ground-snap casts, 10×20 kinematic bone hitboxes, ~50 projectiles with segment raycasts,
 * weapons, and a world step, measured tick by tick (back-to-back, not wall-clock paced).
 *
 *   node tools/bench/runtime/havok-tick.ts --mode=direct|babylon|babylon-render [--ticks=3600] [--warmup=600]
 *        [--players=10] [--projectiles=50] [--hitboxes=20] [--buildings=300] [--samples=513] [--out=file.json]
 *
 * Run one mode per process so memory and JIT state are not shared. Add --trace-gc to Node for a raw GC log.
 */
import "./lib/resolve.ts";
import { writeFileSync } from "node:fs";

const { installWatchdog, GcTracker, memoryMb, machineInfo, parseArgs, summarize, round } = await import("./lib/stats.ts");
installWatchdog(180_000);
const processStart = performance.now();

const args = parseArgs({ mode: "direct", ticks: 3600, warmup: 600, players: 10, projectiles: 50, hitboxes: 20, buildings: 300, samples: 513, seed: 1234, out: "" });
const { DEFAULT_SCENARIO } = await import("./lib/scenario.ts");
const { createMatch } = await import("./lib/match.ts");
const { havokHeapBytes } = await import("./lib/havok.ts");

const scenario = {
  ...DEFAULT_SCENARIO,
  seed: Number(args.seed),
  players: Number(args.players),
  projectiles: Number(args.projectiles),
  hitboxesPerPlayer: Number(args.hitboxes),
  buildings: Number(args.buildings),
  heightfieldSamples: Number(args.samples),
};

const memBaseline = memoryMb();
const match = await createMatch(String(args.mode), scenario);
const setupStart = performance.now();
await match.setup();
const setupTotalMs = performance.now() - setupStart;
const memAfterSetup = memoryMb();
const heapAfterSetup = havokHeapBytes((match as unknown as { hk: unknown }).hk);

const phases = match.phases;
const out = new Float64Array(phases.length);
const warmup = Number(args.warmup);
const ticks = Number(args.ticks);
for (let i = 0; i < warmup; i++) match.tick(out);
const memAfterWarmup = memoryMb();

const total = new Float64Array(ticks);
const perPhase = phases.map(() => new Float64Array(ticks));
const gc = new GcTracker();
const memorySeries: Record<string, number>[] = [];
const cpuStart = process.cpuUsage();
gc.start();
const runStart = performance.now();
for (let i = 0; i < ticks; i++) {
  const t0 = performance.now();
  match.tick(out);
  total[i] = performance.now() - t0;
  for (let k = 0; k < phases.length; k++) perPhase[k]![i] = out[k]!;
  // Yield to the event loop every second of game time so GC observer callbacks run (outside the timed region).
  if (i % 60 === 59) await new Promise((r) => setImmediate(r));
  if (i % 3600 === 3599) memorySeries.push({ tick: i + 1, ...memoryMb(), havokHeap: round(havokHeapBytes((match as unknown as { hk: unknown }).hk) / 1e6, 1) });
}
const runMs = performance.now() - runStart;
const cpu = process.cpuUsage(cpuStart);
const gcReport = await gc.stop();
const memAfterRun = memoryMb();

const report = {
  benchmark: "havok-tick",
  date: new Date().toISOString(),
  machine: machineInfo(),
  args,
  scenario,
  setup: {
    processToReadyMs: round(performance.now() - processStart - runMs, 1),
    setupTotalMs: round(setupTotalMs, 1),
    phasesMs: match.setupMs,
  },
  tickMs: summarize(total),
  phaseMs: Object.fromEntries(phases.map((name, k) => [name, summarize(perPhase[k]!)])),
  ticksOver: {
    "2ms": total.filter((v) => v > 2).length,
    "4ms": total.filter((v) => v > 4).length,
    "8ms": total.filter((v) => v > 8).length,
    "16.67ms": total.filter((v) => v > 1000 / 60).length,
  },
  throughput: {
    runWallMs: round(runMs, 1),
    cpuUserMs: round(cpu.user / 1000, 1),
    cpuSystemMs: round(cpu.system / 1000, 1),
    /** Match-seconds simulated per CPU-second, i.e. how many real-time matches one core could carry at 100% (ignores I/O). */
    realtimeFactor: round(ticks / 60 / ((cpu.user + cpu.system) / 1e6), 2),
  },
  memoryMb: { baseline: memBaseline, afterSetup: memAfterSetup, afterWarmup: memAfterWarmup, afterRun: memAfterRun, series: memorySeries },
  havokHeapMb: { afterSetup: round(heapAfterSetup / 1e6, 1), afterRun: round(havokHeapBytes((match as unknown as { hk: unknown }).hk) / 1e6, 1) },
  gc: gcReport,
  sanity: match.sanity(),
};

const json = JSON.stringify(report, null, 2);
if (args.out) writeFileSync(String(args.out), json);
console.log(json);
match.dispose();
process.exit(0);
