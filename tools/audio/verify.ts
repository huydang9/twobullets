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
  strideLength,
} from "../../apps/client/src/audio/acoustics.ts";
import { AUDIO_FORMATS, AUDIO_MANIFEST, type SoundId } from "../../apps/client/src/audio/audioManifest.ts";
import { WEAPON_SOUNDS, firstPersonShot, type GunId } from "../../apps/client/src/audio/weaponMix.ts";
import { CLIPS } from "./clips.ts";
import { measureMix } from "./lib/mixdown.ts";
import { OUT_DIR, SOURCES } from "./sources.ts";

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
    assert.equal(entry.license, "CC0");
    assert.ok(entry.url.startsWith("https://"));
  }
  for (const source of SOURCES) assert.equal(source.license, "CC0");
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

const mb = (bytes: number | undefined) => `${((bytes ?? 0) / 1e6).toFixed(2)} MB`;
console.log(`${ids.length} sounds, ${variants} variants; ogg/opus ${mb(totals.ogg)}, m4a/aac ${mb(totals.m4a)}`);
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("audio verify: all checks passed");
