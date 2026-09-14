/**
 * Incremental memory per match when several matches share one isolate (and one Havok WASM instance): builds K
 * matches one after another, ticks each for a simulated second, forces a full GC and records RSS, V8 heap and WASM
 * heap after each. The first delta includes one-time costs (Havok instance, Babylon import).
 *
 *   node --expose-gc tools/bench/runtime/memory-per-match.ts --mode=direct --matches=16 [--shareStaticShapes=true]
 *   node --expose-gc --experimental-transform-types tools/bench/runtime/memory-per-match.ts --mode=babylon --matches=4
 */
import "./lib/resolve.ts";
import { writeFileSync } from "node:fs";

const { installWatchdog, machineInfo, memoryMb, parseArgs, round } = await import("./lib/stats.ts");
installWatchdog(180_000);
const args = parseArgs({ mode: "direct", matches: 6, shareStaticShapes: false, out: "" });
const { createMatch } = await import("./lib/match.ts");
const { DEFAULT_SCENARIO } = await import("./lib/scenario.ts");
const { loadHavok, havokHeapBytes } = await import("./lib/havok.ts");

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --expose-gc");
const settle = async (): Promise<void> => {
  gc();
  await new Promise((r) => setTimeout(r, 100));
  gc();
};

await settle();
const rows: Record<string, unknown>[] = [{ matches: 0, ...memoryMb(), wasmMb: 0 }];
const hk = await loadHavok();
const keep = [];
const out = new Float64Array(5);
for (let k = 1; k <= Number(args.matches); k++) {
  const match = await createMatch(String(args.mode), { ...DEFAULT_SCENARIO, seed: 1234 + k, levelSeed: 1234, shareStaticShapes: Boolean(args.shareStaticShapes) });
  await match.setup(undefined, hk);
  for (let t = 0; t < 60; t++) match.tick(out);
  keep.push(match);
  await settle();
  rows.push({ matches: k, ...memoryMb(), wasmMb: round(havokHeapBytes(hk) / 1e6, 1) });
  console.error(JSON.stringify(rows.at(-1)));
}
const first = rows[1] as Record<string, number>;
const last = rows.at(-1) as Record<string, number>;
const K = Number(args.matches);
const report = {
  benchmark: "memory-per-match",
  date: new Date().toISOString(),
  machine: machineInfo(),
  args,
  rows,
  marginalPerMatchMb:
    K > 1
      ? {
          rss: round((last.rss! - first.rss!) / (K - 1), 1),
          heapUsed: round((last.heapUsed! - first.heapUsed!) / (K - 1), 1),
          wasm: round((last.wasmMb! - first.wasmMb!) / (K - 1), 1),
        }
      : null,
};
if (args.out) writeFileSync(String(args.out), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
