/**
 * Worker-thread match host used by capacity.ts. Runs `matches` DirectMatch instances on one thread with a
 * drift-free 60 Hz scheduler (setTimeout until ~2 ms before the deadline, then setImmediate polling), receives a
 * timestamped input message per tick from the parent and sends one snapshot-sized message back per tick.
 */
import { parentPort, workerData } from "node:worker_threads";
import { getHeapStatistics } from "node:v8";
import { DirectMatch } from "./directMatch.ts";
import { DEFAULT_SCENARIO } from "./scenario.ts";
import { loadHavok, havokHeapBytes, type HavokApi } from "./havok.ts";
import { summarize } from "./stats.ts";

interface WorkerConfig {
  index: number;
  matches: number;
  seconds: number;
  rate: number;
  sharedHavok: boolean;
  module: WebAssembly.Module;
  spinMs: number;
  shareStaticShapes: boolean;
}

const cfg = workerData as WorkerConfig;
const port = parentPort!;
const epochNow = (): number => performance.timeOrigin + performance.now();

const setupStart = performance.now();
let shared: HavokApi | undefined;
if (cfg.sharedHavok && cfg.matches > 0) shared = await loadHavok(cfg.module);
const matches: DirectMatch[] = [];
for (let m = 0; m < cfg.matches; m++) {
  const match = new DirectMatch({ ...DEFAULT_SCENARIO, seed: 1000 + cfg.index * 100 + m, levelSeed: DEFAULT_SCENARIO.seed, shareStaticShapes: cfg.shareStaticShapes });
  await match.setup(cfg.module, shared);
  matches.push(match);
}
const setupMs = performance.now() - setupStart;
const heapAfterSetup = getHeapStatistics().used_heap_size;
const wasmBytes = matches.length === 0 ? 0 : shared ? havokHeapBytes(shared) : matches.reduce((sum, m) => sum + havokHeapBytes(m.hk), 0);

// The parent replies to "ready" with {type: "start", at}: an absolute epoch time shared by every worker.
const startMessage = new Promise<number>((resolve) => port.once("message", (msg: { at: number }) => resolve(msg.at)));
port.postMessage({ type: "ready", setupMs, heapUsedMb: heapAfterSetup / 1e6, wasmMb: wasmBytes / 1e6 });
const startAtEpoch = await startMessage;
let inputLatencies: number[] = [];
port.on("message", (msg: { sentAt?: number }) => {
  if (msg.sentAt !== undefined) inputLatencies.push(epochNow() - msg.sentAt);
});
while (epochNow() < startAtEpoch) await new Promise((r) => setTimeout(r, Math.max(0, startAtEpoch - epochNow() - 1)));

const period = 1000 / cfg.rate;
const totalTicks = Math.round(cfg.seconds * cfg.rate);
const lateness = new Float64Array(totalTicks);
const work = new Float64Array(totalTicks);
const phaseOut = new Float64Array(5);
const snapshot = new Uint8Array(200);
const start = startAtEpoch;
const cpuStart = process.threadCpuUsage();
let overruns = 0;
let skipped = 0;
let measured = 0;

for (let tick = 0; tick < totalTicks; tick++) {
  const due = start + tick * period;
  // Hybrid wait: coarse timer sleep, then poll with setImmediate for the last spinMs (lets messages in).
  for (;;) {
    const remaining = due - epochNow();
    if (remaining <= 0) break;
    if (remaining > cfg.spinMs) await new Promise((r) => setTimeout(r, remaining - cfg.spinMs));
    else await new Promise((r) => setImmediate(r));
  }
  const began = epochNow();
  lateness[measured] = began - due;
  for (const match of matches) match.tick(phaseOut);
  const ended = epochNow();
  work[measured++] = ended - began;
  if (ended > due + period) overruns++;
  snapshot[0] = tick & 0xff;
  port.postMessage({ type: "snapshot", sentAt: ended, bytes: snapshot });
  // If we fell more than one tick behind, drop the backlog instead of spiralling (counts as skipped ticks).
  const behind = Math.floor((epochNow() - start) / period) - tick - 1;
  if (behind > 1) {
    skipped += behind - 1;
    tick += behind - 1;
  }
}
const cpu = process.threadCpuUsage(cpuStart);
const wallMs = epochNow() - start;
const lat = inputLatencies;
inputLatencies = [];
port.postMessage({
  type: "done",
  ticks: measured,
  lateness: summarize(lateness, measured),
  workMs: summarize(work, measured),
  overruns,
  skipped,
  threadCpuPercent: Math.round(((cpu.user + cpu.system) / 1000 / wallMs) * 1000) / 10,
  inputLatencyMs: lat.length ? summarize(lat) : null,
});
