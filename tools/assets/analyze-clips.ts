/**
 * Recovers clip boundaries from a single baked first-person animation: `pnpm assets:analyze [weaponId]`.
 *
 * Every channel is sampled at each source frame and compared with frame 0 (all DJMaesen clips start at the
 * rest pose). Boundaries are:
 *  - rest holds: a run of rest frames followed by motion — the next clip starts on the last rest frame;
 *  - freezes: a duplicated non-rest frame (e.g. the pistol's fireLast ends slide-locked, then reloadEmpty);
 *  - peaks: hide → ready share the frame where the gun body is furthest from its rest transform;
 *  - jumps: a single-frame pose discontinuity.
 * Segments are labeled by hand in config.ts using the per-part motion summary printed here; the script then
 * checks that every configured clip edge lands on a detected boundary. Validated against the author's
 * published pistol and sniper tables.
 *
 * `throw_arms` (equipment/config.ts) runs through the same analysis with the right wrist as the "body": its 21-frame
 * clip has no rest holds, so its edges are the wind-up peak, the release jump and the follow-through freeze.
 */
import { join } from "node:path";
import type { AnimationChannel } from "@gltf-transform/core";
import { SRC_DIR, WEAPONS } from "./config.ts";
import { THROW_ARMS } from "./equipment/config.ts";
import { createIO } from "./lib/gltf.ts";
import { lastKeyTime, sampleAt } from "./lib/pose.ts";

setTimeout(() => {
  console.error("aborted after 120s");
  process.exit(2);
}, 120_000).unref();

const REST_EPSILON = 1;
/** Pose distance weight: 1 cm of translation counts like 3° of rotation. */
const CM_WEIGHT = 3;

interface Track {
  node: string;
  path: string;
  frames: number[][];
}

const angle = (a: number[], b: number[]) => {
  const dot = Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
};
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]!));
const trackDelta = (t: Track, f: number, g: number) =>
  t.path === "rotation" ? angle(t.frames[f]!, t.frames[g]!) : distance(t.frames[f]!, t.frames[g]!) * CM_WEIGHT;
const poseDelta = (tracks: Track[], f: number, g: number) => tracks.reduce((sum, t) => sum + trackDelta(t, f, g), 0);

const io = await createIO();
const filter = process.argv[2];
let failures = 0;

interface ClipSpec {
  readonly id: string;
  readonly source: string;
  readonly fps: number;
  readonly clips: Readonly<Partial<Record<string, readonly [number, number]>>>;
  readonly nodes: { readonly body: string };
  /** IK helper nodes left out of the pose distance. */
  readonly helpers: RegExp;
}
const SPECS: readonly ClipSpec[] = [...WEAPONS.map((w) => ({ ...w, helpers: /_Pole$/ })), { ...THROW_ARMS, helpers: /_(Pole|Goal)$/ }];

for (const spec of SPECS.filter((w) => !filter || w.id === filter)) {
  const doc = await io.read(join(SRC_DIR, spec.source));
  const animation = doc.getRoot().listAnimations()[0]!;
  const last = Math.round(lastKeyTime(animation) * spec.fps);
  const tracks: Track[] = animation
    .listChannels()
    .filter((c: AnimationChannel) => !spec.helpers.test(c.getTargetNode()!.getName()) && c.getTargetPath() !== "scale")
    .map((c) => ({
      node: c.getTargetNode()!.getName(),
      path: c.getTargetPath()!,
      frames: Array.from({ length: last + 1 }, (_, f) => sampleAt(c.getSampler()!, f / spec.fps)),
    }));

  const rest = Array.from({ length: last + 1 }, (_, f) => poseDelta(tracks, f, 0));
  const bodyTracks = tracks.filter((t) => t.node === spec.nodes.body);
  const bodyOffset = Array.from({ length: last + 1 }, (_, f) => poseDelta(bodyTracks, f, 0));
  const velocity = Array.from({ length: last + 1 }, (_, f) => (f === 0 ? 0 : poseDelta(tracks, f, f - 1)));
  const atRest = (f: number) => rest[f]! < REST_EPSILON;

  // Clip starts from rest holds: last rest frame before motion resumes.
  const starts = new Set<number>([0]);
  for (let f = 1; f < last; f++) if (atRest(f) && atRest(f - 1) && !atRest(f + 1)) starts.add(f);
  const freezes = new Set<number>();
  for (let f = 1; f < last; f++) if (!atRest(f) && velocity[f]! < REST_EPSILON && velocity[f + 1]! >= REST_EPSILON) freezes.add(f);
  const jumps = new Set<number>();
  for (let f = 2; f < last - 1; f++) {
    const around = [velocity[f - 2]!, velocity[f - 1]!, velocity[f + 1]!, velocity[f + 2]!].sort((a, b) => a - b);
    if (velocity[f]! > 150 && velocity[f]! > 3 * around[1]!) jumps.add(f);
  }

  console.log(`\n== ${spec.id} (${last + 1} frames @ ${spec.fps} fps, ${tracks.length} channels)`);
  const sortedStarts = [...starts].sort((a, b) => a - b);
  const peaks = new Set<number>();
  sortedStarts.forEach((start, i) => {
    const end = (sortedStarts[i + 1] ?? last + 1) - 1;
    let peak = start;
    for (let f = start; f <= end; f++) if (bodyOffset[f]! > bodyOffset[peak]!) peak = f;
    peaks.add(peak);
    const moving = new Map<string, number>();
    for (const t of tracks.filter((t) => t.path === "translation" && !/_\d+$/.test(t.node))) {
      let max = 0;
      for (let f = start; f <= end; f++) max = Math.max(max, distance(t.frames[f]!, t.frames[start]!));
      if (max > 0.5) moving.set(t.node, max);
    }
    const parts = [...moving].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, d]) => `${n} ${d.toFixed(1)}cm`);
    const inside = (set: Set<number>) => [...set].filter((f) => f > start && f <= end);
    console.log(
      `  [${start}, ${end}]`.padEnd(14) +
        `len ${String(end - start + 1).padStart(3)}  pose ${String(Math.round(Math.max(...rest.slice(start, end + 1)))).padStart(4)}` +
        `  body peak ${String(Math.round(bodyOffset[peak]!)).padStart(3)} @${peak}` +
        (inside(freezes).length ? `  freeze@${inside(freezes)}` : "") +
        (inside(jumps).length ? `  jump@${inside(jumps)}` : "") +
        `  moves: ${parts.join(", ") || "-"}`,
    );
  });

  const near = (set: Set<number>, f: number) => set.has(f) || set.has(f - 1) || set.has(f + 1);
  for (const [name, [start, end]] of Object.entries(spec.clips) as [string, readonly [number, number]][]) {
    const startOk = near(starts, start) || near(freezes, start) || near(peaks, start) || near(jumps, start);
    const endOk = end === last || near(starts, end + 1) || near(freezes, end + 1) || near(peaks, end) || near(jumps, end + 1);
    if (!startOk || !endOk) failures++;
    console.log(`  ${startOk && endOk ? "ok " : "BAD"} ${name.padEnd(12)} [${start}, ${end}]`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} configured clip(s) do not align with detected boundaries`);
  process.exitCode = 1;
}
