// Builds web audio from the raw sources: cut → mono/stereo → fades → loudness-normalize (EBU R128, measured
// with ffmpeg loudnorm, applied as linear gain) → encode Ogg Opus + AAC/M4A fallback. Writes the typed
// manifest and credits.json. One ffmpeg process at a time.
// Usage: node tools/audio/pipeline.ts [--only=<id prefix>[,<id prefix>…]]   (run fetch.ts first)
// A partial build re-encodes only the matching clips and reuses the other clips' existing outputs for the manifest
// and credits.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CLIPS, type ClipSpec, type CutSpec } from "./clips.ts";
import { decodeMono } from "./lib/signal.ts";
import { DOWNLOAD_DIR, EXTRACT_DIR, MANIFEST_TS, OUT_DIR, SRC_DIR, SOURCES, sourceById, type SourceId } from "./sources.ts";

setTimeout(() => {
  console.error("pipeline: timed out after 15 minutes");
  process.exit(2);
}, 15 * 60_000).unref();

const RATE = 48_000;
const TRUE_PEAK_CEILING = -1;
/** Limited clips aim a little lower: the lossy encoders add a few tenths of a dB of overshoot. */
const LIMITED_CEILING = -1.5;
const WORK_DIR = path.join(SRC_DIR, "work");
const only = process.argv
  .find((arg) => arg.startsWith("--only="))
  ?.slice(7)
  .split(",")
  .filter((prefix) => prefix.length > 0);
const AAC_ENCODER = hasEncoder("aac_at") ? "aac_at" : "aac";

interface BuiltVariant {
  readonly file: string;
  readonly duration: number;
  readonly source: SourceId;
  readonly origin: string;
  /** Absent for variants reused from a previous build. */
  readonly loudness?: Loudness;
}

interface Loudness {
  readonly lufs: number;
  readonly truePeak: number;
  /** Peak reduction applied by the limiter, dB. */
  readonly limitedDb: number;
}

interface BuiltClip {
  readonly spec: ClipSpec;
  readonly variants: BuiltVariant[];
}

function ffmpeg(args: readonly string[]): string {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${result.stderr}`);
  return result.stderr;
}

function hasEncoder(name: string): boolean {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
  return result.stdout.split("\n").some((line) => line.trim().split(/\s+/)[1] === name);
}

function probeDuration(file: string): number {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  const seconds = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(seconds)) throw new Error(`ffprobe failed for ${file}: ${result.stderr}`);
  return seconds;
}

function sourcePath(source: SourceId, file: string): string {
  const spec = sourceById(source);
  return spec.archive ? path.join(EXTRACT_DIR, source, file) : path.join(DOWNLOAD_DIR, file);
}

/** First moment the signal reaches 10% of the local peak within ±150 ms of `near` (or from the file start). */
function findAttack(file: string, near: number | null): number {
  const windowStart = near === null ? 0 : Math.max(0, near - 0.15);
  const signal = decodeMono(file, 16_000, { start: windowStart, duration: near === null ? 5 : 0.3 });
  const { samples, rate } = signal;
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  if (peak === 0) return near ?? 0;
  const threshold = peak * 0.1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] as number) >= threshold) return windowStart + i / rate;
  }
  return near ?? 0;
}

/** Integrated loudness and true peak of a clip. Short clips are padded with silence (gated out by R128). */
function measureLoudness(file: string): { lufs: number; truePeak: number } {
  const stderr = ffmpeg(["-i", file, "-af", "apad=whole_dur=3,loudnorm=I=-16:TP=-1:print_format=json", "-f", "null", "-"]);
  const json = stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1);
  const stats = JSON.parse(json) as { input_i: string; input_tp: string };
  return { lufs: Number(stats.input_i), truePeak: Number(stats.input_tp) };
}

/**
 * Brings a clip to its loudness target and encodes it. Plain clips get one linear gain capped by the true-peak ceiling.
 * Clips with `limitDb` may shave their first spike with a fast lookahead limiter (latency-compensated, 0.5 ms attack)
 * so quieter variations reach the target; the reduction is capped and the level lowered if more would be needed.
 */
function normalizeAndEncode(spec: ClipSpec, wav: string, outBase: string): Loudness {
  const measured = measureLoudness(wav);
  let input = wav;
  let gain = Number.isFinite(measured.lufs) ? spec.lufs - measured.lufs : 0;
  let limitedDb = 0;
  if (spec.limitDb !== undefined && Number.isFinite(measured.lufs)) {
    const overshoot = measured.truePeak + gain - LIMITED_CEILING;
    if (overshoot > spec.limitDb) gain -= overshoot - spec.limitDb;
    limitedDb = Math.max(0, Math.min(overshoot, spec.limitDb));
    if (limitedDb > 0) {
      // Oversampled so the sample-peak limiter also catches inter-sample peaks.
      const ceiling = 10 ** (LIMITED_CEILING / 20);
      input = wav.replace(/\.wav$/, ".limited.wav");
      ffmpeg([
        "-i", wav,
        "-af", `volume=${gain.toFixed(2)}dB,aresample=192000,alimiter=limit=${ceiling.toFixed(4)}:attack=0.5:release=15:level=false:latency=true,aresample=${RATE}`,
        input,
      ]);
      gain = 0;
    }
  }
  if (limitedDb === 0) gain = Math.min(gain, (spec.limitDb !== undefined ? LIMITED_CEILING : TRUE_PEAK_CEILING) - measured.truePeak);
  // A limiter can still leave inter-sample overshoot: trim the residue.
  const after = limitedDb > 0 ? measureLoudness(input) : { lufs: measured.lufs + gain, truePeak: measured.truePeak + gain };
  const trim = Math.min(0, LIMITED_CEILING - after.truePeak);
  const volume = `volume=${(gain + trim).toFixed(2)}dB`;
  const opusRate = spec.kbps;
  const aacRate = Math.round((spec.kbps * 1.25) / 8) * 8;
  ffmpeg(["-i", input, "-af", volume, "-c:a", "libopus", "-b:a", `${opusRate}k`, "-vbr", "on", "-application", "audio", `${outBase}.ogg`]);
  ffmpeg(["-i", input, "-af", volume, "-c:a", AAC_ENCODER, "-b:a", `${aacRate}k`, "-movflags", "+faststart", `${outBase}.m4a`]);
  return { lufs: after.lufs + trim, truePeak: after.truePeak + trim, limitedDb };
}

function baseFilters(spec: ClipSpec): string[] {
  const filters = [`aformat=sample_fmts=flt:sample_rates=${RATE}:channel_layouts=${spec.channels === 1 ? "mono" : "stereo"}`];
  if (spec.highpass) filters.push(`highpass=f=${spec.highpass}`);
  filters.push(...(spec.filters ?? []));
  return filters;
}

async function buildCut(spec: ClipSpec, cut: CutSpec, index: number, near: number | null, next: number | null): Promise<BuiltVariant> {
  const input = sourcePath(cut.source, cut.file);
  if (!existsSync(input)) throw new Error(`${spec.id}: missing source ${input} (run node tools/audio/fetch.ts)`);
  const attack = findAttack(input, near);
  const start = cut.skip ? attack + cut.skip : Math.max(0, attack - 0.004);
  const available = (next !== null ? next - 0.05 : probeDuration(input)) - start;
  const length = Math.min(spec.maxSeconds, available);
  if (length < 0.05) throw new Error(`${spec.id}: cut at ${near} in ${cut.file} is too short`);

  const filters = baseFilters(spec);
  const rate = cut.rate ?? 1;
  if (rate !== 1) filters.push(`asetrate=${Math.round(RATE * rate)}`, `aresample=${RATE}`);
  // Fades run after the rate change, so they are timed on the stretched output.
  const outLength = length / rate;
  const fadeOut = Math.max(0.01, outLength * spec.fadeOut);
  filters.push(`afade=t=in:d=${cut.skip ? 0.04 : 0.003}`, `afade=t=out:st=${(outLength - fadeOut).toFixed(4)}:d=${fadeOut.toFixed(4)}`);

  const name = `${spec.id}.${index}`;
  const wav = path.join(WORK_DIR, `${name}.wav`);
  ffmpeg(["-ss", start.toFixed(4), "-t", length.toFixed(4), "-i", input, "-af", filters.join(","), wav]);
  const loudness = normalizeAndEncode(spec, wav, path.join(OUT_DIR, name));
  return { file: name, duration: probeDuration(wav), source: cut.source, origin: `${cut.file}@${start.toFixed(3)}s`, loudness };
}

async function buildLoop(spec: ClipSpec): Promise<BuiltVariant> {
  const loop = spec.loop;
  if (!loop) throw new Error(`${spec.id}: no loop spec`);
  const input = sourcePath(loop.source, loop.file);
  const { length: L, crossfade: X } = loop;
  const name = `${spec.id}.0`;
  const wav = path.join(WORK_DIR, `${name}.wav`);
  // head + tail crossfade: the loop's first X seconds blend the material that follows its last sample.
  const graph = [
    `[0:a]${baseFilters(spec).join(",")},asplit=3[a][b][c]`,
    `[a]atrim=start=${L}:end=${L + X},asetpts=PTS-STARTPTS,afade=t=out:d=${X}:curve=qsin[tail]`,
    `[b]atrim=start=0:end=${X},asetpts=PTS-STARTPTS,afade=t=in:d=${X}:curve=qsin[head]`,
    `[c]atrim=start=${X}:end=${L},asetpts=PTS-STARTPTS[body]`,
    `[tail][head]amix=inputs=2:normalize=0:duration=shortest[seam]`,
    `[seam][body]concat=n=2:v=0:a=1[out]`,
  ].join(";");
  ffmpeg(["-ss", String(loop.start), "-t", String(L + X), "-i", input, "-filter_complex", graph, "-map", "[out]", wav]);
  const loudness = normalizeAndEncode(spec, wav, path.join(OUT_DIR, name));
  return { file: name, duration: probeDuration(wav), source: loop.source, origin: `${loop.file}@${loop.start}s+${L}s loop`, loudness };
}

async function buildClip(spec: ClipSpec): Promise<BuiltClip> {
  const variants: BuiltVariant[] = [];
  if (spec.loop) variants.push(await buildLoop(spec));
  for (const cut of spec.cuts ?? []) {
    if (cut.at === "whole") {
      variants.push(await buildCut(spec, cut, variants.length, null, null));
      continue;
    }
    const times = [...cut.at].sort((a, b) => a - b);
    for (let i = 0; i < times.length; i++) {
      variants.push(await buildCut(spec, cut, variants.length, times[i] as number, times[i + 1] ?? null));
    }
  }
  const lufs = variants.map((v) => v.loudness?.lufs ?? NaN);
  const peak = Math.max(...variants.map((v) => v.loudness?.truePeak ?? NaN));
  const limited = Math.max(...variants.map((v) => v.loudness?.limitedDb ?? 0));
  console.log(
    `  ${spec.id}: ${variants.length} variation(s), ${Math.min(...lufs).toFixed(1)}…${Math.max(...lufs).toFixed(1)} LUFS (target ${spec.lufs}), peak ${peak.toFixed(1)} dBTP${limited > 0 ? `, limited ≤${limited.toFixed(1)} dB` : ""}`,
  );
  return { spec, variants };
}

function manifestSource(clips: readonly BuiltClip[]): string {
  const ids = clips.map((c) => JSON.stringify(c.spec.id));
  const entries = clips.map(({ spec, variants }) => {
    const list = variants.map((v) => `{ file: ${JSON.stringify(v.file)}, duration: ${v.duration.toFixed(4)} }`).join(", ");
    return `  ${JSON.stringify(spec.id)}: { channels: ${spec.channels}, load: ${JSON.stringify(spec.load)}, variants: [${list}] },`;
  });
  return `// Generated by tools/audio/pipeline.ts. Do not edit by hand.

export type SoundId =
${ids.map((id) => `  | ${id}`).join("\n")};

export interface SoundVariant {
  /** File name without extension, relative to AUDIO_ROOT. */
  readonly file: string;
  /** Seconds. */
  readonly duration: number;
}

export interface SoundAsset {
  /** 1 = mono (spatialized in the world), 2 = stereo (first person, ambience). */
  readonly channels: 1 | 2;
  /** eager: decoded at startup; lazy: decoded on first use or in the background. */
  readonly load: "eager" | "lazy";
  readonly variants: readonly SoundVariant[];
}

/** Encodings in order of preference; the first one the browser can decode wins. */
export const AUDIO_FORMATS = [
  { ext: "ogg", mime: 'audio/ogg; codecs="opus"' },
  { ext: "m4a", mime: 'audio/mp4; codecs="mp4a.40.2"' },
] as const;

export const AUDIO_ROOT = "assets/audio/";

export const AUDIO_MANIFEST: Readonly<Record<SoundId, SoundAsset>> = {
${entries.join("\n")}
};
`;
}

async function writeCredits(clips: readonly BuiltClip[]): Promise<void> {
  const used = new Map<SourceId, { sounds: Set<string>; files: string[] }>();
  for (const { spec, variants } of clips) {
    for (const v of variants) {
      const entry = used.get(v.source) ?? { sounds: new Set<string>(), files: [] };
      entry.sounds.add(spec.id);
      entry.files.push(`${v.file} ← ${v.origin}`);
      used.set(v.source, entry);
    }
  }
  const body = {
    note: "All shipped audio is CC0 (public domain). Attribution is not required but given here.",
    licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
    generated: new Date().toISOString().slice(0, 10),
    formats: ["ogg (Opus)", "m4a (AAC-LC)"],
    sources: SOURCES.filter((s) => used.has(s.id)).map((s) => ({
      id: s.id,
      title: s.title,
      authors: s.authors,
      license: s.license,
      url: s.page,
      download: s.url,
      sounds: [...(used.get(s.id)?.sounds ?? [])],
      files: used.get(s.id)?.files ?? [],
    })),
  };
  await writeFile(path.join(OUT_DIR, "credits.json"), `${JSON.stringify(body, null, 2)}\n`);
}

async function main(): Promise<void> {
  const matches = (id: string) => !only || only.some((prefix) => id.startsWith(prefix));
  const selected = CLIPS.filter((c) => matches(c.id));
  if (selected.length === 0) throw new Error(`No clips match ${only?.join(",")}`);
  await mkdir(WORK_DIR, { recursive: true });
  await mkdir(OUT_DIR, { recursive: true });
  // Drop stale outputs of everything being rebuilt so removed variations don't linger.
  for (const file of await readdir(OUT_DIR)) {
    if (/\.(ogg|m4a)$/.test(file) && selected.some((c) => file.startsWith(`${c.id}.`))) await rm(path.join(OUT_DIR, file));
  }
  const previousOrigins = only ? await readPreviousOrigins() : new Map<string, string>();
  console.log(`Building ${selected.length} sounds (AAC encoder: ${AAC_ENCODER})`);
  const built: BuiltClip[] = [];
  for (const spec of CLIPS) built.push(matches(spec.id) ? await buildClip(spec) : await reuseClip(spec, previousOrigins));

  await writeFile(MANIFEST_TS, manifestSource(built));
  await writeCredits(built);
  await report(built);
}

/** Existing outputs of a clip that isn't being rebuilt. */
async function reuseClip(spec: ClipSpec, origins: ReadonlyMap<string, string>): Promise<BuiltClip> {
  const cuts = spec.loop ? [spec.loop.source] : (spec.cuts ?? []).flatMap((cut) => (cut.at === "whole" ? [cut.source] : cut.at.map(() => cut.source)));
  const variants: BuiltVariant[] = cuts.map((source, i) => {
    const file = `${spec.id}.${i}`;
    const ogg = path.join(OUT_DIR, `${file}.ogg`);
    if (!existsSync(ogg)) throw new Error(`${spec.id}: ${file}.ogg missing; rebuild it (--only=${spec.id})`);
    return { file, duration: probeDuration(ogg), source, origin: origins.get(file) ?? "(previous build)" };
  });
  return { spec, variants };
}

async function readPreviousOrigins(): Promise<Map<string, string>> {
  const origins = new Map<string, string>();
  try {
    const credits = JSON.parse(await readFile(path.join(OUT_DIR, "credits.json"), "utf8")) as { sources: { files: string[] }[] };
    for (const line of credits.sources.flatMap((s) => s.files)) {
      const [file, origin] = line.split(" ← ");
      if (file && origin) origins.set(file, origin);
    }
  } catch {
    // No previous credits: origins read "(previous build)".
  }
  return origins;
}

async function report(clips: readonly BuiltClip[]): Promise<void> {
  const totals = { ogg: 0, m4a: 0, eagerOgg: 0 };
  for (const { spec, variants } of clips) {
    for (const v of variants) {
      const ogg = (await stat(path.join(OUT_DIR, `${v.file}.ogg`))).size;
      totals.ogg += ogg;
      totals.m4a += (await stat(path.join(OUT_DIR, `${v.file}.m4a`))).size;
      if (spec.load === "eager") totals.eagerOgg += ogg;
    }
  }
  const files = clips.reduce((n, c) => n + c.variants.length, 0);
  const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;
  console.log(`\n${clips.length} sounds, ${files} variations`);
  console.log(`Opus: ${mb(totals.ogg)} (eager ${mb(totals.eagerOgg)}), AAC: ${mb(totals.m4a)}`);
  console.log(`Wrote ${path.relative(process.cwd(), MANIFEST_TS)} and credits.json`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
