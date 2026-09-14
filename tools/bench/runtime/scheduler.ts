/**
 * Tick scheduling precision of Node timers on this machine, with a synthetic 1 ms of work per tick:
 *   setInterval          setInterval(fn, 1000/rate)
 *   setTimeoutRelative   setTimeout(fn, 1000/rate) re-armed after each tick (accumulates drift)
 *   driftFree            setTimeout to the next absolute deadline (start + n·period)
 *   hybrid-Nms           driftFree sleep until N ms before the deadline, then setImmediate polling
 *   spin                 setImmediate polling only (busy wait)
 * Reports tick start lateness (p50/p99/max), cumulative drift and thread CPU%.
 *
 *   node tools/bench/runtime/scheduler.ts [--seconds=8] [--rate=60] [--workMs=1]
 */
import "./lib/resolve.ts";
import { writeFileSync } from "node:fs";

const { installWatchdog, machineInfo, parseArgs, round, summarize } = await import("./lib/stats.ts");
installWatchdog(180_000);
const args = parseArgs({ seconds: 8, rate: 60, workMs: 1, out: "" });
const period = 1000 / Number(args.rate);
const ticks = Math.round(Number(args.seconds) * Number(args.rate));
const now = (): number => performance.now();

function work(): void {
  const end = now() + Number(args.workMs);
  let x = 0;
  while (now() < end) x += Math.sqrt(x + 1);
}

type Strategy = (onTick: (due: number) => boolean) => Promise<void>;

const strategies: Record<string, Strategy> = {
  setInterval: (onTick) =>
    new Promise((resolve) => {
      const start = now();
      let n = 0;
      const id = setInterval(() => {
        if (!onTick(start + ++n * period)) {
          clearInterval(id);
          resolve();
        }
      }, period);
    }),
  setTimeoutRelative: (onTick) =>
    new Promise((resolve) => {
      const start = now();
      let n = 0;
      const loop = (): void => {
        if (!onTick(start + ++n * period)) return resolve();
        setTimeout(loop, period);
      };
      setTimeout(loop, period);
    }),
  driftFree: async (onTick) => {
    const start = now();
    for (let n = 1; ; n++) {
      const due = start + n * period;
      const wait = due - now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (!onTick(due)) return;
    }
  },
  ...Object.fromEntries(
    [1, 2, 4].map((spin) => [
      `hybrid-${spin}ms`,
      async (onTick: (due: number) => boolean) => {
        const start = now();
        for (let n = 1; ; n++) {
          const due = start + n * period;
          for (;;) {
            const remaining = due - now();
            if (remaining <= 0) break;
            if (remaining > spin) await new Promise((r) => setTimeout(r, remaining - spin));
            else await new Promise((r) => setImmediate(r));
          }
          if (!onTick(due)) return;
        }
      },
    ]),
  ),
  spin: async (onTick) => {
    const start = now();
    for (let n = 1; ; n++) {
      const due = start + n * period;
      while (now() < due) await new Promise((r) => setImmediate(r));
      if (!onTick(due)) return;
    }
  },
};

const results: Record<string, unknown> = {};
for (const [name, strategy] of Object.entries(strategies)) {
  const lateness = new Float64Array(ticks);
  let count = 0;
  const cpu0 = process.threadCpuUsage();
  const t0 = now();
  let firstDue = 0;
  let lastStart = 0;
  await strategy((due) => {
    const started = now();
    if (count === 0) firstDue = due;
    lastStart = started;
    lateness[count++] = started - due;
    work();
    return count < ticks;
  });
  const wall = now() - t0;
  const cpu = process.threadCpuUsage(cpu0);
  // Drift for relative timers: how far the last tick started from where an ideal clock would have put it.
  const idealLast = firstDue + (count - 1) * period;
  results[name] = {
    latenessMs: summarize(lateness, count),
    driftMsAfterRun: round(lastStart - idealLast, 2),
    threadCpuPercent: round(((cpu.user + cpu.system) / 1000 / wall) * 100, 1),
  };
  console.error(name, JSON.stringify(results[name]));
}

const report = { benchmark: "scheduler", date: new Date().toISOString(), machine: machineInfo(), args, results };
if (args.out) writeFileSync(String(args.out), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
