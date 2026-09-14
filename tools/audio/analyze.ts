// Prints the sound events inside a recording (onset, end, peak level, brightness), used to pick clip
// boundaries for pipeline.ts without an audio editor.
// Usage: node tools/audio/analyze.ts <file> [--threshold=-30] [--gap=0.08]
import { decodeMono, detectEvents } from "./lib/signal.ts";

setTimeout(() => process.exit(2), 120_000).unref();

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/audio/analyze.ts <file> [--threshold=-30] [--gap=0.08]");
  process.exit(1);
}
const option = (name: string, fallback: number): number => {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return raw ? Number(raw.split("=")[1]) : fallback;
};

const signal = decodeMono(file, 16_000);
const events = detectEvents(signal, { thresholdDb: option("threshold", -30), minGapSeconds: option("gap", 0.08) });
console.log(`${file}: ${(signal.samples.length / signal.rate).toFixed(2)} s, ${events.length} events`);
for (const e of events) {
  console.log(
    `  ${e.start.toFixed(3)}–${e.end.toFixed(3)} s  (${(e.end - e.start).toFixed(3)} s)  peak ${e.peakDb.toFixed(1)} dBFS @ ${e.peakAt.toFixed(3)}  zcr ${e.brightness.toFixed(0)} Hz`,
  );
}
