// Minimal signal analysis on top of ffmpeg: decode to mono float PCM and find sound events by envelope.
import { spawnSync } from "node:child_process";

export interface MonoSignal {
  readonly samples: Float32Array;
  readonly rate: number;
}

export interface SoundEvent {
  /** Seconds. */
  readonly start: number;
  readonly end: number;
  readonly peakAt: number;
  readonly peakDb: number;
  /** Zero-crossing rate around the peak, Hz: a cheap brightness proxy (clicks high, thumps low). */
  readonly brightness: number;
}

/** Decodes any ffmpeg-readable file (optionally a section of it) to mono float samples at `rate`. */
export function decodeMono(file: string, rate: number, section?: { start: number; duration: number }): MonoSignal {
  const args = ["-v", "error"];
  if (section) args.push("-ss", String(section.start), "-t", String(section.duration));
  args.push("-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", "-");
  const result = spawnSync("ffmpeg", args, { maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg decode failed for ${file}: ${result.stderr.toString()}`);
  const bytes = result.stdout;
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 4)).slice();
  return { samples, rate };
}

export function toDb(amplitude: number): number {
  return 20 * Math.log10(Math.max(1e-9, amplitude));
}

/**
 * Splits a recording into events: 5 ms RMS windows above `thresholdDb` relative to the file peak, merged when the
 * gap between them is shorter than `minGapSeconds`.
 */
export function detectEvents(signal: MonoSignal, options: { thresholdDb: number; minGapSeconds: number }): SoundEvent[] {
  const { samples, rate } = signal;
  const window = Math.max(1, Math.round(rate * 0.005));
  const frames = Math.floor(samples.length / window);
  const rms = new Float32Array(frames);
  let filePeak = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * window; i < (f + 1) * window; i++) sum += (samples[i] as number) ** 2;
    rms[f] = Math.sqrt(sum / window);
    filePeak = Math.max(filePeak, rms[f] as number);
  }
  const threshold = filePeak * 10 ** (options.thresholdDb / 20);
  const gapFrames = Math.round(options.minGapSeconds / 0.005);

  const events: SoundEvent[] = [];
  let start = -1;
  let lastLoud = -1;
  const close = () => {
    if (start < 0) return;
    let peakFrame = start;
    for (let f = start; f <= lastLoud; f++) if ((rms[f] as number) > (rms[peakFrame] as number)) peakFrame = f;
    let peakSample = 0;
    for (let i = start * window; i < (lastLoud + 1) * window; i++) peakSample = Math.max(peakSample, Math.abs(samples[i] as number));
    events.push({
      start: (start * window) / rate,
      end: ((lastLoud + 1) * window) / rate,
      peakAt: (peakFrame * window) / rate,
      peakDb: toDb(peakSample),
      brightness: zeroCrossingRate(samples, peakFrame * window, Math.round(rate * 0.03), rate),
    });
    start = -1;
  };
  for (let f = 0; f < frames; f++) {
    if ((rms[f] as number) < threshold) {
      if (start >= 0 && f - lastLoud > gapFrames) close();
      continue;
    }
    if (start < 0) start = f;
    lastLoud = f;
  }
  close();
  return events;
}

function zeroCrossingRate(samples: Float32Array, from: number, length: number, rate: number): number {
  const end = Math.min(samples.length, from + length);
  let crossings = 0;
  for (let i = from + 1; i < end; i++) if ((samples[i - 1] as number) < 0 !== (samples[i] as number) < 0) crossings++;
  return end > from ? (crossings / 2) * (rate / (end - from)) : 0;
}
