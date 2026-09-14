// Offline render of a first-person shot recipe (apps/client/src/audio/weaponMix.ts) with ffmpeg, mirroring the
// WebAudio graph: per-layer rate, offset, 2-pole low-pass, gain and delay, mono layers up-mixed at equal level.
import { spawnSync } from "node:child_process";
import type { FirstPersonLayer } from "../../../apps/client/src/audio/weaponMix.ts";

const RATE = 48_000;

export interface MixLoudness {
  /** Integrated loudness of the shot in a 3 s window, LUFS. */
  readonly lufs: number;
  /** Loudest 400 ms (momentary max), LUFS: closest to how "big" the blast itself feels. */
  readonly momentary: number;
  readonly truePeak: number;
}

export interface MixInput {
  readonly file: string;
  readonly channels: 1 | 2;
}

/** `resolve` maps a sample layer to the variant file to use; `post` is an optional ffmpeg chain on the sum (bus DSP). */
export function measureMix(layers: readonly FirstPersonLayer[], resolve: (sound: string) => MixInput, post?: string): MixLoudness {
  const args: string[] = ["-hide_banner", "-nostdin"];
  const chains: string[] = [];
  const labels: string[] = [];
  let input = 0;
  layers.forEach((layer, i) => {
    const label = `l${i}`;
    if (layer.kind === "sample") {
      const source = resolve(layer.sound);
      args.push("-i", source.file);
      const steps = [
        source.channels === 1 ? "pan=stereo|c0=c0|c1=c0" : "aformat=channel_layouts=stereo",
        "aformat=sample_fmts=flt",
        `atrim=start=${layer.offset}`,
        "asetpts=PTS-STARTPTS",
      ];
      if (layer.rate !== 1) steps.push(`asetrate=${Math.round(RATE * layer.rate)}`, `aresample=${RATE}`);
      if (layer.lowpass !== null) steps.push(`lowpass=f=${layer.lowpass}:t=q:w=0.5`);
      steps.push(`volume=${layer.gain.toFixed(5)}`, `adelay=${Math.round(layer.delay * 1000)}:all=1`);
      chains.push(`[${input++}:a]${steps.join(",")}[${label}]`);
    } else {
      const r = layer.to / layer.from;
      const t = `(t-${layer.delay})`;
      const phase = `if(lt(${t},${layer.sweep}),${layer.from * layer.sweep}*(pow(${r},${t}/${layer.sweep})-1)/log(${r}),${(layer.from * layer.sweep * (r - 1)) / Math.log(r)}+${layer.to}*(${t}-${layer.sweep}))`;
      const envelope = `if(lt(${t},0),0,if(lt(${t},0.002),${layer.gain}*${t}/0.002,${layer.gain}*exp(-(${t}-0.002)/${layer.decay})))`;
      const expr = `${envelope}*sin(2*PI*${phase})`;
      chains.push(`aevalsrc=exprs='${expr}|${expr}':s=${RATE}:d=${(layer.delay + layer.decay * 10).toFixed(3)},aformat=sample_fmts=flt[${label}]`);
    }
    labels.push(`[${label}]`);
  });
  const graph = `${chains.join(";")};${labels.join("")}amix=inputs=${labels.length}:normalize=0:duration=longest,${post ? `${post},` : ""}apad=whole_dur=3,ebur128=peak=true:framelog=info[out]`;
  args.push("-filter_complex", graph, "-map", "[out]", "-f", "null", "-");
  const result = spawnSync("ffmpeg", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg mixdown failed:\n${result.stderr.slice(-2000)}`);
  const summary = result.stderr.slice(result.stderr.lastIndexOf("Summary:"));
  const integrated = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  const peak = Number(/Peak:\s+(-?[\d.inf]+) dBFS/.exec(summary)?.[1]);
  let momentary = -Infinity;
  for (const match of result.stderr.matchAll(/ M:\s*(-?[\d.]+)/g)) momentary = Math.max(momentary, Number(match[1]));
  return { lufs: integrated, momentary, truePeak: peak };
}
