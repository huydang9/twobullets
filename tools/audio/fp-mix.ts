// Renders each weapon's first-person shot as the game layers it (weaponMix.ts recipe, every near variation) and
// prints loudness relative to the rifle, so the weapon hierarchy can be tuned by numbers.
// Usage: node tools/audio/fp-mix.ts
import path from "node:path";
import { AUDIO_MANIFEST, type SoundId } from "../../apps/client/src/audio/audioManifest.ts";
import { WEAPON_SOUNDS, firstPersonShot, type GunId } from "../../apps/client/src/audio/weaponMix.ts";
import { measureMix, type MixLoudness } from "./lib/mixdown.ts";
import { OUT_DIR } from "./sources.ts";

setTimeout(() => {
  console.error("fp-mix: timed out");
  process.exit(2);
}, 5 * 60_000).unref();

const GUNS: readonly GunId[] = ["pistol", "rifle", "shotgun", "sniper"];

function energyMean(values: readonly number[]): number {
  return 10 * Math.log10(values.reduce((sum, v) => sum + 10 ** (v / 10), 0) / values.length);
}

const results = new Map<GunId, { lufs: number; momentary: number; peak: number }>();
for (const gun of GUNS) {
  const design = WEAPON_SOUNDS[gun];
  const layers = firstPersonShot(design);
  const count = AUDIO_MANIFEST[design.near].variants.length;
  const takes: MixLoudness[] = [];
  // Sequential ffmpeg runs, one variation at a time.
  for (let variant = 0; variant < count; variant++) {
    takes.push(
      measureMix(layers, (sound) => {
        const asset = AUDIO_MANIFEST[sound as SoundId];
        const file = asset.variants[variant % asset.variants.length]?.file;
        return { file: path.join(OUT_DIR, `${file}.ogg`), channels: asset.channels };
      }),
    );
  }
  results.set(gun, {
    lufs: energyMean(takes.map((t) => t.lufs)),
    momentary: energyMean(takes.map((t) => t.momentary)),
    peak: Math.max(...takes.map((t) => t.truePeak)),
  });
}

const reference = results.get("rifle");
console.log("First-person shot, bus level before master volume (mean of variations; peak = loudest variation)");
for (const [gun, r] of results) {
  const relative = reference ? r.lufs - reference.lufs : 0;
  console.log(
    `  ${gun.padEnd(8)} ${r.lufs.toFixed(1)} LUFS (${relative >= 0 ? "+" : ""}${relative.toFixed(1)} LU vs rifle)  momentary max ${r.momentary.toFixed(1)} LUFS  peak ${r.peak.toFixed(1)} dBTP`,
  );
}
