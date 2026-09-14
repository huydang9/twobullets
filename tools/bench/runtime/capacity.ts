/**
 * Real-time capacity test: W worker threads × M matches per worker, each ticking at 60 Hz with the drift-free hybrid
 * scheduler, exchanging one input message (parent → worker) and one 200-byte snapshot message (worker → parent)
 * per match-thread per tick. Measures process RSS per worker/match, WASM heap, tick start lateness, work time,
 * overruns (tick finished after its deadline), per-thread CPU and message latency.
 *
 *   node tools/bench/runtime/capacity.ts --workers=1 --perWorker=10 [--seconds=20] [--sharedHavok=true] [--spinMs=2]
 *
 * Workers load a stripped-JS build of the direct match (see lib/buildJs.ts), not TypeScript.
 */
import "./lib/resolve.ts";
import { writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

const { installWatchdog, machineInfo, memoryMb, parseArgs, round, summarize } = await import("./lib/stats.ts");
installWatchdog(180_000);
const args = parseArgs({ workers: 1, perWorker: 1, seconds: 20, rate: 60, sharedHavok: true, shareStaticShapes: false, spinMs: 2, out: "" });
const { buildJs } = await import("./lib/buildJs.ts");
const { compileHavok } = await import("./lib/havok.ts");

const workerEntry = buildJs(new URL("./lib/matchWorker.ts", import.meta.url).pathname);
const t0 = performance.now();
const module = compileHavok();
const compileMs = performance.now() - t0;

// Settle, then take the baseline.
await new Promise((r) => setTimeout(r, 300));
const baseline = memoryMb();
const epochNow = (): number => performance.timeOrigin + performance.now();

const W = Number(args.workers);
const M = Number(args.perWorker);
const workers: Worker[] = [];
const ready: Promise<{ setupMs: number; heapUsedMb: number; wasmMb: number }>[] = [];
const done: Promise<Record<string, unknown>>[] = [];
const snapshotLatency: number[] = [];
const spawnStart = performance.now();
for (let w = 0; w < W; w++) {
  const worker = new Worker(workerEntry, {
    workerData: { index: w, matches: M, seconds: Number(args.seconds), rate: Number(args.rate), sharedHavok: Boolean(args.sharedHavok), module, spinMs: Number(args.spinMs), shareStaticShapes: Boolean(args.shareStaticShapes) && Boolean(args.sharedHavok) },
  });
  workers.push(worker);
  ready.push(new Promise((resolve) => worker.on("message", (msg) => msg.type === "ready" && resolve(msg))));
  done.push(
    new Promise((resolve, reject) => {
      worker.on("message", (msg) => {
        if (msg.type === "snapshot") snapshotLatency.push(epochNow() - msg.sentAt);
        else if (msg.type === "done") resolve(msg);
      });
      worker.on("error", reject);
    }),
  );
}
const readyInfo = await Promise.all(ready);
const spawnMs = performance.now() - spawnStart;
await new Promise((r) => setTimeout(r, 200));
const afterSetup = memoryMb();
const startAt = epochNow() + 300;
for (const worker of workers) worker.postMessage({ type: "start", at: startAt });
await new Promise((r) => setTimeout(r, 300));

// Parent → worker inputs at the tick rate, one message per match per tick (batched per worker would be cheaper).
const inputTimer = setInterval(() => {
  for (const worker of workers) for (let m = 0; m < Math.max(1, M); m++) worker.postMessage({ sentAt: epochNow() });
}, 1000 / Number(args.rate));
const results = await Promise.all(done);
clearInterval(inputTimer);
const afterRun = memoryMb();
for (const worker of workers) await worker.terminate();

const perWorkerRssMb = round((afterSetup.rss! - baseline.rss!) / W, 1);
const report = {
  benchmark: "capacity",
  date: new Date().toISOString(),
  machine: machineInfo(),
  args,
  havokCompileMs: round(compileMs, 1),
  spawnAndSetupMs: round(spawnMs, 1),
  memoryMb: {
    baseline,
    afterSetup,
    afterRun,
    rssPerWorker: perWorkerRssMb,
    rssPerMatch: M > 0 ? round((afterSetup.rss! - baseline.rss!) / (W * M), 1) : null,
  },
  workers: readyInfo.map((r, i) => ({ ...r, ...results[i] })),
  parentSnapshotReceiveLatencyMs: snapshotLatency.length ? summarize(snapshotLatency) : null,
  totals: {
    matches: W * M,
    players: W * M * 10,
    overruns: results.reduce((s, r) => s + (r.overruns as number), 0),
    skipped: results.reduce((s, r) => s + (r.skipped as number), 0),
  },
};
const json = JSON.stringify(report, null, 2);
if (args.out) writeFileSync(String(args.out), json);
console.log(json);
process.exit(0);
