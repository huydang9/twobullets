// Headless checks for the shipped audio: manifest ↔ files, decodability and format of every variant, credits
// coverage, size budget, plus unit checks of the pure acoustic model the client mixes with.
// Usage: node tools/audio/verify.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  airAbsorptionCutoff,
  arrivalDelay,
  closestApproach,
  distanceGain,
  gunshotLayers,
  isSupersonic,
  roomFromSpace,
  SPACE,
  strideLength,
} from "../../apps/client/src/audio/acoustics.ts";
import { AUDIO_FORMATS, AUDIO_MANIFEST, type SoundId } from "../../apps/client/src/audio/audioManifest.ts";
import {
  BLAST_SOUNDS,
  USE_CUES,
  blastDuckDb,
  blastEcho,
  blastLayers,
  fireLevel,
  flashRing,
  smokeHissLevel,
} from "../../apps/client/src/audio/equipmentMix.ts";
import { WEAPON_SOUNDS, firstPersonShot, type GunId } from "../../apps/client/src/audio/weaponMix.ts";
import { CLIPS } from "./clips.ts";
import { measureMix } from "./lib/mixdown.ts";
import { OUT_DIR, OWNER_LICENSE, SOURCES } from "./sources.ts";

setTimeout(() => {
  console.error("verify: timed out");
  process.exit(2);
}, 5 * 60_000).unref();

/** Per-format download budget for the whole library (task brief: 8–15 MB). */
const BUDGET_BYTES = 15_000_000;
const CODEC: Readonly<Record<string, string>> = { ogg: "opus", m4a: "aac" };

let failures = 0;
function check(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    failures++;
    console.error(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function probe(file: string): { codec: string; channels: number; duration: number } {
  const result = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,channels:format=duration", "-of", "json", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  const json = JSON.parse(result.stdout) as { streams: { codec_name: string; channels: number }[]; format: { duration: string } };
  const stream = json.streams[0];
  if (!stream) throw new Error("no audio stream");
  return { codec: stream.codec_name, channels: stream.channels, duration: Number(json.format.duration) };
}

function decodes(file: string): boolean {
  return spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-f", "null", "-"], { encoding: "utf8" }).stderr.trim() === "";
}

// --- Manifest and files ------------------------------------------------------------------------------------------------

const ids = Object.keys(AUDIO_MANIFEST) as SoundId[];
const totals: Record<string, number> = { ogg: 0, m4a: 0 };
let variants = 0;
check("manifest matches clip specs", () => {
  assert.deepEqual([...ids].sort(), CLIPS.map((c) => c.id).sort());
});
for (const id of ids) {
  const asset = AUDIO_MANIFEST[id];
  check(`${id} has 1+ variants`, () => assert.ok(asset.variants.length > 0));
  for (const variant of asset.variants) {
    variants++;
    for (const { ext } of AUDIO_FORMATS) {
      const file = path.join(OUT_DIR, `${variant.file}.${ext}`);
      check(`${variant.file}.${ext}`, () => {
        assert.ok(existsSync(file), "missing");
        totals[ext] = (totals[ext] ?? 0) + statSync(file).size;
        const info = probe(file);
        assert.equal(info.codec, CODEC[ext]);
        assert.equal(info.channels, asset.channels, "channel count");
        assert.ok(Math.abs(info.duration - variant.duration) < 0.06, `duration ${info.duration} vs manifest ${variant.duration}`);
        assert.ok(decodes(file), "ffmpeg decode errors");
      });
    }
  }
}

// --- Credits -------------------------------------------------------------------------------------------------------------

check("credits.json covers every used source", () => {
  const credits = JSON.parse(readFileSync(path.join(OUT_DIR, "credits.json"), "utf8")) as { sources: { id: string; license: string; url: string }[] };
  const used = new Set(CLIPS.flatMap((c) => [...(c.cuts ?? []).map((cut) => cut.source), ...(c.loop ? [c.loop.source] : [])]));
  for (const id of used) {
    const entry = credits.sources.find((s) => s.id === id);
    assert.ok(entry, `no credit for ${id}`);
    const source = SOURCES.find((s) => s.id === id);
    assert.equal(entry.license, source?.license);
    // Owner-supplied clips have no public page.
    if (!source?.ownerSupplied) assert.ok(entry.url.startsWith("https://"));
  }
  for (const source of SOURCES) assert.equal(source.license, source.ownerSupplied ? OWNER_LICENSE : "CC0", `${source.id} license`);
});

check("size budget", () => {
  for (const [ext, bytes] of Object.entries(totals)) assert.ok(bytes <= BUDGET_BYTES, `${ext} ${bytes} B > ${BUDGET_BYTES}`);
});

// --- Acoustic model ------------------------------------------------------------------------------------------------------

check("distanceGain", () => {
  assert.equal(distanceGain(2, 5, 100), 1, "full level inside the reference distance");
  assert.ok(distanceGain(50, 5, 800, 0.7) > distanceGain(400, 5, 800, 0.7), "monotonic");
  assert.equal(distanceGain(800, 5, 800), 0, "silent at range");
  assert.ok(Math.abs(distanceGain(10, 5, 1000) - 0.5) < 1e-9, "inverse distance with exponent 1");
});
check("arrivalDelay", () => {
  assert.ok(Math.abs(arrivalDelay(343) - 1) < 1e-9);
  assert.equal(arrivalDelay(34.3, 0.5), 0, "network age never makes the delay negative");
});
check("air absorption", () => {
  assert.ok(airAbsorptionCutoff(5) > 15_000);
  assert.ok(airAbsorptionCutoff(400) < 2_000);
});
check("gunshot layers", () => {
  const close = gunshotLayers(3);
  const far = gunshotLayers(300);
  assert.ok(close.near > 0.95 && far.near < 0.01);
  assert.ok(far.far > 0.99 && far.echo > close.echo);
});
check("closestApproach", () => {
  const pass = closestApproach(-10, 0, 1.5, 10, 0, 1.5, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(pass.distance - 1.5) < 1e-9 && Math.abs(pass.t - 0.5) < 1e-9);
  const before = closestApproach(-10, 0, 0, -5, 0, 0, { x: 0, y: 0, z: 0 });
  assert.equal(before.t, 1, "not yet passed");
});
check("crack vs whiz", () => {
  // Muzzle velocities from packages/shared/src/weapons/weapons.ts: shotgun 350 m/s decays below Mach 1 → whiz.
  assert.ok(isSupersonic(620) && isSupersonic(400) && isSupersonic(380));
  assert.ok(!isSupersonic(330));
});
check("room from corridor width", () => {
  // An open map measures the probe's full reach in every direction: the model must land exactly on the open-field mix
  // it replaced, or Map v1 and the real-world maps change the day this ships.
  const open = roomFromSpace({ width: 2 * SPACE.reach, meanFreePath: SPACE.reach }, 0);
  assert.equal(open.room, 0, "open ground: no room reverb");
  assert.equal(open.flutter, 0, "open ground: no corridor flutter");
  assert.ok(Math.abs(open.echo - 1) < 1e-9, "open ground: the full open-field echo");
  assert.equal(open.tone, 5000, "open ground: the tone the convolver always had");
  const roofed = roomFromSpace({ width: 2 * SPACE.reach, meanFreePath: SPACE.reach }, 1);
  assert.equal(roofed.room, 1, "a roof alone still puts you indoors");
  assert.ok(Math.abs(roofed.echo - 0.15) < 1e-9, "indoors: the old 1 - indoor * 0.85");

  // Corridors, with no roof over them at all: the width has to carry the whole cue.
  const squeeze = roomFromSpace({ width: 4, meanFreePath: 9 }, 0);
  const boulevard = roomFromSpace({ width: 12, meanFreePath: 18 }, 0);
  const plaza = roomFromSpace({ width: 40, meanFreePath: 26 }, 0);
  assert.ok(squeeze.room > 0.7 && squeeze.flutter > 0.8, "a 4 m squeeze rings under open sky");
  assert.ok(squeeze.room > boulevard.room && boulevard.room > plaza.room, "wider is drier");
  assert.ok(squeeze.echo < boulevard.echo && boulevard.echo < plaza.echo, "wider gets the open-field slapback back");
  assert.ok(squeeze.tone > plaza.tone, "hard close walls keep their highs");
  assert.equal(plaza.flutter, 0, "a plaza does not flutter");
  // Flutter time is the round trip across the space, which is what makes width audible rather than just loud.
  assert.ok(Math.abs(squeeze.flutterSeconds - 8 / 343) < 1e-6, "4 m corridor: ~23 ms");
  assert.ok(boulevard.flutterSeconds > squeeze.flutterSeconds * 2.5, "12 m corridor: a distinct slap");
  assert.ok(squeeze.flutterFeedback > boulevard.flutterFeedback, "the tighter space rings longer");
  assert.ok(squeeze.send > 0.9 && plaza.send === 0, "voices only couple into the room where there is one");
});
check("stride cadence", () => {
  const cadence = (speed: number) => speed / strideLength(speed);
  assert.ok(cadence(3.2) > 2 && cadence(3.2) < 2.8, "crouch");
  assert.ok(cadence(9.5) > 3 && cadence(9.5) < 3.6, "sprint");
});

// --- Weapon loudness hierarchy (first-person mixdown of variation 0) ------------------------------------------------

check("first-person loudness hierarchy", () => {
  const loudness = (gun: GunId) => {
    const design = WEAPON_SOUNDS[gun];
    return measureMix(firstPersonShot(design), (sound) => {
      const asset = AUDIO_MANIFEST[sound as SoundId];
      return { file: path.join(OUT_DIR, `${asset.variants[0]?.file}.ogg`), channels: asset.channels };
    });
  };
  const mix = Object.fromEntries((["rifle", "shotgun", "pistol", "sniper"] as const).map((gun) => [gun, loudness(gun)])) as Record<GunId, ReturnType<typeof loudness>>;
  assert.ok(mix.sniper.lufs - mix.rifle.lufs >= 3.5, `sniper only ${(mix.sniper.lufs - mix.rifle.lufs).toFixed(1)} LU above rifle`);
  assert.ok(mix.sniper.momentary > mix.rifle.momentary, "sniper blast not louder than rifle");
  assert.ok(mix.pistol.lufs < mix.rifle.lufs, "pistol louder than rifle");
  for (const [gun, m] of Object.entries(mix)) assert.ok(m.truePeak <= -0.9, `${gun} first-person peak ${m.truePeak.toFixed(1)} dBTP above -1 dBTP`);
  const sniperDesign = WEAPON_SOUNDS.sniper;
  assert.ok(sniperDesign.range >= WEAPON_SOUNDS.rifle.range * 1.5 && sniperDesign.rolloff < WEAPON_SOUNDS.rifle.rolloff, "sniper must carry farther");
});

// --- Equipment mix -------------------------------------------------------------------------------------------------------

check("blast layers by distance", () => {
  const frag = BLAST_SOUNDS.frag;
  const gain = (d: number, sound: SoundId) => blastLayers(frag, d).reduce((sum, l) => sum + (l.kind === "sample" && l.sound === sound ? l.gain : 0), 0);
  assert.ok(gain(3, frag.near) > gain(3, frag.far), "close: the near bang dominates");
  assert.ok(gain(200, frag.near) === 0 && gain(200, frag.far) > 0, "far: only the down-range take");
  assert.ok(blastEcho(frag, 300) > blastEcho(frag, 5), "echo grows with distance");
  assert.ok(blastDuckDb(frag, frag.reference) >= frag.duckDb - 1e-9 && blastDuckDb(frag, frag.range) === 0, "duck scales down with distance");
  assert.ok(frag.range >= BLAST_SOUNDS.flash.range, "frag carries at least as far as a flashbang");
});
check("loops and ringing", () => {
  assert.ok(smokeHissLevel(0) === 0 && smokeHissLevel(3) > 0.5 && smokeHissLevel(20) === 0, "hiss vents, then stops");
  assert.ok(fireLevel(0) === 0 && fireLevel(1) > fireLevel(0.2), "fire follows the burning share");
  const weak = flashRing(0.2);
  const full = flashRing(1);
  assert.ok(full.tone > weak.tone && full.duckDb > weak.duckDb && full.lowpass < weak.lowpass, "ringing scales with exposure");
});
check("use cues", () => {
  for (const [item, cues] of Object.entries(USE_CUES)) {
    let last = -1;
    for (const [at] of cues) {
      assert.ok(at >= 0 && at < 1 && at >= last, `${item} cue at ${at} out of order`);
      last = at;
    }
  }
});
check("loudness hierarchy: explosions over the sniper", () => {
  const resolve = (variant: number) => (sound: string) => {
    const asset = AUDIO_MANIFEST[sound as SoundId];
    return { file: path.join(OUT_DIR, `${asset.variants[variant % asset.variants.length]?.file}.ogg`), channels: asset.channels };
  };
  const sniper = measureMix(firstPersonShot(WEAPON_SOUNDS.sniper), resolve(0));
  for (const [kind, design] of Object.entries(BLAST_SOUNDS)) {
    for (let variant = 0; variant < AUDIO_MANIFEST[design.near].variants.length; variant++) {
      // 4 m: inside the reference distance, so the voice plays the recipe at full level.
      const blast = measureMix(blastLayers(design, 4), resolve(variant));
      const margin = kind === "frag" ? 3 : 0.5;
      assert.ok(blast.lufs - sniper.lufs >= margin, `${kind} v${variant} only ${(blast.lufs - sniper.lufs).toFixed(1)} LU over the sniper`);
      if (kind === "frag") assert.ok(blast.momentary > sniper.momentary, `frag v${variant} blast not bigger than the sniper's`);
      assert.ok(blast.truePeak <= -0.9, `${kind} v${variant} peak ${blast.truePeak.toFixed(1)} dBTP above -1 dBTP`);
    }
  }
});

const mb = (bytes: number | undefined) => `${((bytes ?? 0) / 1e6).toFixed(2)} MB`;
console.log(`${ids.length} sounds, ${variants} variants; ogg/opus ${mb(totals.ogg)}, m4a/aac ${mb(totals.m4a)}`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("audio verify: all checks passed");
