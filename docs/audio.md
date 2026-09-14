# Audio

Realistic, PUBG-style game audio built from free CC0 recordings: spatial gunshots with speed-of-sound delay and distance layers, near-miss cracks, surface footsteps, impacts, weapon mechanics synced to the viewmodel clips, and an outdoor ambience bed.

> **Ambience is currently switched off** (`AMBIENCE_ENABLED = false` in `apps/client/src/audio/AudioSettings.ts`, by request).
> - The gate wins over any saved ambience volume.
> - No ambience file is fetched: lazy sounds load only on first use.
> - Nothing ducks the ambience bus.
> - Re-enable for a session with `__audio.ambience(true)`, or flip the constant.

## Layout

| Path | What |
|---|---|
| `tools/audio/sources.ts` | Upstream files: URL, expected size, license, authors |
| `tools/audio/fetch.ts` | Downloads with size checks, extracts archives (bsdtar reads 7z) |
| `tools/audio/analyze.ts` | Prints event onsets and peaks in a recording, used to pick cut points |
| `tools/audio/clips.ts` | Every shipped sound id, its variations and where each one is cut from |
| `tools/audio/pipeline.ts` | cut → mono/stereo → fades → EBU R128 normalize → Opus + AAC; writes the manifest and credits |
| `tools/audio/fp-mix.ts` | Renders each weapon's first-person shot exactly as the game layers it and prints LUFS / momentary max / true peak relative to the rifle |
| `tools/audio/verify.ts` | Headless checks: manifest ↔ files, ffprobe codec/channels/duration, decode, credits, budget, acoustic model, weapon loudness hierarchy |
| `assets-src/audio/` | Raw downloads and extracted sources (gitignored) |
| `apps/client/public/assets/audio/` | `<id>.<n>.ogg` / `.m4a` + `credits.json` |
| `apps/client/src/audio/audioManifest.ts` | Generated typed manifest (`SoundId`) |
| `apps/client/src/audio/` | Runtime (see Architecture) |

```sh
node tools/audio/fetch.ts        # ~250 MB download, once (cached by size)
node tools/audio/pipeline.ts     # ~50 s; --only=shot.,mech.bolt rebuilds matching clips and reuses the rest
node tools/audio/fp-mix.ts       # ~2 s; first-person gun loudness table
node tools/audio/verify.ts       # ~15 s
node_modules/.bin/tsc -p tools/audio/tsconfig.json
```

## Sources

All shipped audio is **CC0**. Attribution isn't required, but every file is credited with its exact origin (file and cut time) in `credits.json`.

| Source | Author | Used for |
|---|---|---|
| [The Free Firearm Sound Library](https://opengameart.org/content/the-free-firearm-sound-library) (Prepared library) | Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney | All gunshots: AR-15/AK-47 (rifle), Nova/Charles Daly/Model 12 (shotgun), Walther PPQ/1911 (pistol); sniper near from Tikka T3/Springfield 1917/Arisaka, down-range and tail from Tikka/Mosin/1917/Arisaka |
| [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds) | Kenney | Grass/wood footsteps, metal steps, bullet impacts (concrete, metal, wood, dirt, flesh), landing thuds, casings |
| [Fantozzi's Footsteps](https://opengameart.org/content/fantozzis-footsteps-grasssand-stone) | Fantozzi, qubodup | Concrete (stone) and dirt (sand) footsteps |
| [42 Snow and Gravel Footsteps](https://opengameart.org/content/42-snow-and-gravel-footsteps) | Corsica_S, Iwan Gabovitch | Gravel footsteps |
| [Park ambiences](https://opengameart.org/content/park-ambiences) | Thimras | Wind bed, birdsong bed (only the first 24 MB of each WAV is fetched) |
| [Ambient Bird Sounds](https://opengameart.org/content/ambient-bird-sounds) | isaiah658 | Spatial bird calls |
| [equipment clicks III](https://opengameart.org/content/equipment-clicks-iii) | LFA | Bolt open/close, charging handle (a real bolt-action rifle) |
| [Equipment Clicks II](https://opengameart.org/content/equipment-clicks-ii) | LFA | Dry fire, latches |
| [Handgun Reload Sound Effect](https://opengameart.org/content/handgun-reload-sound-effect) | zer0_sol | Pistol mag out/in, slide |
| [Shotgun Reload Sound effects](https://opengameart.org/content/shotgun-reload-sound-effects) | zer0_sol | Pump rack, shell inserts |
| [Gun reload sounds](https://opengameart.org/content/gun-reload-sounds) | SpringySpringo | Rifle/sniper mag out/in |
| [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) | artisticdude | Cloth (equip, jump) |

Not used:
- **OGA "Footsteps on different surfaces" (CC-BY 3.0).** The CC0 packs above cover the same surfaces.
- **Freesound.** It needs a login.
- **Sonniss #GameAudioGDC bundles.** They are multi-GB, and the license forbids redistributing the sounds as loose files. They are the best future upgrade for gun tails, bullet cracks and explosions, but only if the files are baked into non-extractable sprites and the license is re-checked.

The Free Firearm library ships only gunshots. Its "near" takes are recorded beside the shooter, and the "mid" takes down range with the natural outdoor tail. It has no reload foley, which is why the mechanics come from the smaller packs.

## Format and budget

- **Primary: Ogg Opus.** Chrome, Edge and Firefox decode it everywhere, and Safari added Opus-in-Ogg in 18.4 (macOS 15.4 / iOS 18.4, March 2025).
- **Fallback: AAC-LC in M4A.** It covers Safari 15–18.3, which reports no Opus-in-Ogg support.
- **Selection:** `SoundBank` picks the format via `canPlayType('audio/ogg; codecs="opus"')`. A file that fails to decode is retried in the other format.
  - Each client downloads one set.
  - Opus at 48 kHz has sample-exact trimming, which matters for the loops.
  - AAC gets an edit list for its priming delay.
- **Encoding:**
  - Gunshot "near" layers are stereo at 128 kbit/s.
  - Everything spatial is mono at 56–64 kbit/s.
  - The ambience beds are stereo at 96 kbit/s.
- **Size:**

  | | Opus | AAC |
  |---|---|---|
  | Total | 2.24 MB | 3.34 MB |
  | Eager (decoded before the first click) | 1.12 MB | |
  | Lazy (ambience, fetched on first use, so never while ambience is off) | the rest | |

  37 sounds, 150 variations. This is well under the 8–15 MB budget, which leaves room for more variations.
- **Loudness:**
  - Each variation is measured with ffmpeg `loudnorm` (EBU R128 integrated loudness).
  - Short clips are padded with silence, which R128 gating ignores.
  - The measurement is applied as a single linear gain, capped at −1 dBTP, so transients are untouched.
  - Targets:

    | Category | Target |
    |---|---|
    | Guns | per weapon, see below |
    | Mechanics and impacts | −18 LUFS |
    | Footsteps | −20 LUFS |
    | Ambience | −24/−26 LUFS |

  - Relative mix levels live in `soundDesign.ts` and `weaponMix.ts`.
- **Gun files:**
  - The Free Firearm takes are mastered hot: every one is already peak-limited, and inside the blast the waveform sits near full scale.
  - A limiter can't raise their loudness. In a test, +9 dB into a limiter came out 1 dB quieter.
  - So gun files only aim for consistency: `GUN_LUFS` in `clips.ts` (≈ −26.5 to −29 LUFS), with at most 2 dB shaved off the first spike by a latency-compensated lookahead limiter, and a −1.5 dBTP ceiling so encoder overshoot stays under −1.
  - Variations within a weapon now sit within about 2 LU of each other. The shotgun's used to spread 8 LU.

## Architecture

Raw WebAudio, not Babylon's AudioEngineV2. The v9.26 `StaticSound` API offers panning and volume per sound, but not what this design needs:
- per-voice filter chains (air absorption and occlusion low-pass)
- per-voice effect sends
- sample-accurate delayed starts for the speed of sound
- cheap one-shot layering

```
voice: buffer sources ─ layer gain/LP ─→ voice low-pass ─→ voice gain ─→ [HRTF panner] ─→ bus input
                                                                  ├→ room send ─→ bus room tap ─→ convolver (0.9 s) ─→ indoor return ─┐
                                                                  └→ echo send ─→ bus echo tap ─→ slapback + valley echo ─→ outdoor return ─┤
bus input ─ [weapons: glue compressor] ─→ duck gain ─→ fader (settings) ─→ master ─→ limiter (−3 dB, 20:1) ─→ out ◄──────────┘
```

| File | Role |
|---|---|
| `AudioEngine.ts` | Context unlock on first gesture; buses (weapons, impacts, footsteps, foley, ambience, ui); limiter; room reverb and outdoor echo returns; ducking; listener (Babylon's left-handed Z mirrored); voice pool |
| `SoundBank.ts` | Format pick, fetch + `OfflineAudioContext` decode (ready before the user gesture), eager loading at startup, lazy sounds on first use, no-repeat variation picking |
| `GameAudio.ts` | **Network-ready API.** Distance, delay, air absorption, occlusion, sends and layering per event |
| `AudioWorldProbe.ts` | Havok raycasts, max 10 per frame: occlusion (cached 150 ms), surface under feet / at impacts, enclosure probe |
| `FootstepSystem.ts` | Stride timing from distance travelled; stance; jump/land edges; local player + `FootstepEmitterSource`s |
| `NearMissDetector.ts` | Segment-vs-head closest approach per bullet per frame, ≤ 3 m → crack (> 343 m/s) or whiz |
| `AmbienceSystem.ts` | Wind loop (louder with height), birdsong loop (thinner with height), spatial bird calls, indoor damping |
| `WeaponAudio.ts` | First-person mechanics scheduled from viewmodel `ClipPlan` cues (tags cancel reloads and cycles) |
| `AudioDirector.ts` | Composition root created by `WeaponPresentation`. Per-frame listener/probe/footsteps/near-miss/ambience |
| `acoustics.ts` | Pure model (unit-checked by `verify.ts`) |
| `surfaces.ts` | `SurfaceProvider`, terrain/building/arena material → acoustic surface |
| `soundDesign.ts` | All mix constants per weapon, surface and stance |
| `AudioSettings.ts` | Master + per-bus volumes, persisted in `localStorage`; `AMBIENCE_ENABLED` gate |
| `AudioDebug.ts` | DEV console API and overlay |

### Weapon loudness hierarchy

The hierarchy lives in the runtime mix, where there is headroom: `WeaponSound.level` in `weaponMix.ts`, plus each weapon's first-person layer recipe `firstPersonShot()`.
- The game and `tools/audio/fp-mix.ts` use the same recipe, so the numbers below are measured, not estimated.
- `verify.ts` fails if the sniper drops below +3.5 LU over the rifle, the pistol rises above the rifle, or any first-person peak exceeds −1 dBTP.

First-person shot at bus level, mean of all variations. "Before" is the previous build as heard through the old weapons glue compressor (acompressor approximation).

| Weapon | Before LUFS | Before peak | After LUFS | After momentary max | After peak | vs rifle |
|---|---|---|---|---|---|---|
| Pistol P-9 | −28.2 | −3.4 dBTP | −30.9 | −27.9 | −7.8 dBTP | −2.0 LU |
| Rifle AR-4 | −29.1 | −2.1 dBTP | −28.9 | −24.4 | −5.2 dBTP | 0 |
| Shotgun S-12 | −30.8 | −1.4 dBTP | −28.2 | −20.4 | −1.6 dBTP | +0.7 LU (momentary +4) |
| Sniper K-98 | −29.7 | −0.9 dBTP | −23.9 | −16.6 | −1.2 dBTP | **+5.0 LU** (was −0.6) |

Before, the sniper was quieter than the rifle. All takes are equally hot, the old first-person gains were nearly equal, and the glue compressor took the most off the sniper (−3.8 dB).

**Sniper first-person layers:**
1. **Close report.** Tikka/1917/Arisaka near takes, chosen for the most 45–150 Hz body and the longest tails. They were chosen by band-energy measurement over the thinner Mosin takes.
   - Baked in: 35 Hz high-pass (removes infrasound that ate headroom), +3 dB low shelf at 100 Hz, +2.5 dB presence at 3 kHz, stereo width ×1.3.
   - Played unfiltered, on the direct path.
2. **Sub thump.** Synthesized sine sweeping 110 → 48 Hz, 2 ms attack, 75 ms decay.
3. **Outdoor tail.** `shot.sniper.tail`: 2.5 s stereo, from the down-range takes starting 120 ms after the direct sound, low-passed at 7 kHz, +2 dB at 90 Hz.
4. **Slapbacks.** The down-range take at +160 ms (low-passed at 2.8 kHz) and +410 ms (1.4 kHz, −5 dB), plus a 0.8 send into the engine's outdoor slapback/valley echo.
5. **Mechanism click.** Quiet.

The bolt cycle stays separate and unchanged.

**Routing:**
- The local player's shots and remote sniper shots use the weapons bus "direct" path. It skips the glue compressor and ducking, and has a gentle compressor (−8 dB, 2:1, 20 ms attack) that lets transients through and only tames long bursts.
- The master limiter is a safety net at −1 dB. At master volume 1 the loudest sniper variation peaks at about −1.2 dBTP before it.

**Remote shots:**
- Remote gain is `level × 1.6` (capped at 1), so relative loudness matches first person.
- Sniper: range 1250 m (rifle 800 m), rolloff 0.55 (rifle 0.72), reference 12 m.
- Its down-range layer is ×1.5, and a 64 → 36 Hz boom tone rolls in under it. The 343 m/s delay is unchanged.

**Ducking when you fire:**

| Weapon | Ambience | Other weapons | Footsteps |
|---|---|---|---|
| Sniper | −14 dB, hold 0.6 s, release 2.2 s | −5 dB, 0.35 s, 1.2 s | −7 dB |
| Rifle | −8 dB, 0.25 s, 0.9 s | −2 dB, 0.08 s, 0.3 s | −4 dB |

Pistol and shotgun sit either side of the rifle.

### Voices
- Every sound is one `Voice`, which can hold several layers.
- **Caps:** 64 voices globally. Per bus: weapons 20, impacts 12, footsteps 14, foley 12, ambience 8, ui 4.
- **Priorities:** local 4 > important 3 (remote gunshots, enemy footsteps) > normal 2 > detail 1 > ambient 0.
- **Stealing:** when a cap is hit, the lowest priority×loudness voice is faded out in 25 ms. Ties go to the oldest. A new voice that scores lower than every existing one is refused.
- **Culling:** sounds whose attenuated gain is below −54 dB, or beyond the event's range, are never created.

### Spatial model
- **Attenuation:** `distanceGain(d, reference, range, exponent)`, inverse-power beyond a reference distance and faded to zero over the last 25 % of the range.
  - Gunshots use exponents 0.55–0.8, so they carry: rifle 800 m, sniper 1250 m, shotgun 500 m, pistol 400 m, suppressed 150 m.
  - Footsteps use 1.1. Their ranges follow netcode.md §10.2: crouch 8, walk 20, run 30, sprint 40 m.
- **Speed of sound:** remote sounds start `d / 343 − age` seconds late. A 300 m shot arrives about 0.9 s after the tracer. `age` is the network latency, so it isn't counted twice.
- **Air absorption:** a low-pass at `20000 / (1 + d/28)` Hz (≈5 kHz at 100 m, 900 Hz at 800 m).
- **Gunshot layers:**
  - The near recording fades out between 6 and 70 m, and the down-range recording fades in between 3 and 45 m.
  - Beyond 150 m the far layer is pitched down by up to 12 % ("boom").
  - The echo send rises with distance, so far shots are mostly rolling reflections.
- **First-person shot:** non-spatial stereo, built from the `firstPersonShot()` recipe with ±3 % pitch and −0.6…0 dB level variation (see "Weapon loudness hierarchy").
- **Occlusion:** a ray from the listener to the source, ending 0.35 m short (feet are raised 0.6 m). If blocked, the source loses 7 dB and the low-pass is capped at 900 Hz. Occluded gunshots send 30 % more to the echo.
- **Environment:** the enclosure probe casts one of 5 rays per frame from the head: up, which counts double, and 4 diagonals at 30 m. The result is smoothed.
  - The indoor amount crossfades the outdoor slapback/valley echo into a short room reverb.
  - It also damps and dulls the ambience.
  - It is provisional until buildings expose room volumes. Set `probe.enclosureProvider` to override it.
- **Near misses:**
  - Supersonic bullets: a synthesized N-wave snap, a short zip and a slap.
  - Subsonic bullets (the shotgun at 350 m/s): a Doppler-swept band-passed whiz whose panner travels ±4 m along the trajectory.
  - A bullet first seen within 4 m of the listener counts as their own and never cracks.

## Event → sound

| Event | Sound |
|---|---|
| Local shot (`combat.onShot`) | `shot.<weapon>.near` + tail (`shot.<weapon>.far` from 120 ms, or `shot.sniper.tail`) + `mech.dryFire` click; sniper adds sub thump and slapbacks; ducks ambience, other weapons and footsteps |
| Remote gunshot | Spatial `near`/`far` crossfade by distance, delayed, air-absorbed, occluded, echo |
| Bolt cycle (sniper `bolt` clip cues) | `mech.bolt.open` ×2, `mech.bolt.close` ×2 across the cue span |
| Pump (shotgun `pump` cue) | `mech.shotgun.pump` |
| Reload cues | `magOut` / `magIn`: `mech.rifle.*` (sniper pitched −10 %) or `mech.pistol.*`; `slide`: pistol slide / rifle bolt release (`mech.charge`); `charge`: two `mech.charge` clicks; `shellInsert`: `mech.shotgun.shell` |
| Equip | `foley.cloth` + `mech.latch` |
| Dry fire | `mech.dryFire` |
| Casing bounce | `foley.casing` pitched per weapon (shotgun hull duller) |
| Impact on world | `impact.concrete/metal/wood/dirt` by the hit material; occasional ricochet whine on concrete/metal |
| Impact on target | `impact.flesh`, spatial |
| Hit confirm (shooter) | `impact.flesh` thud + tick; headshot adds a metallic tink; kill adds a low thump |
| Footstep | `step.concrete/dirt/grass/gravel/wood/metal`, gain/rate by stance |
| Jump / land | step + `foley.cloth` / `foley.land` + double step, scaled by fall speed |
| Near miss | Synthesized crack or whiz |
| Explosion (placeholder) | Shotgun/sniper reports pitched down + noise rumble + sub tone; heavy ducking |
| Ambience | `amb.wind` + `amb.birds` loops, `amb.birdCall` one-shots 25–80 m away |

Surfaces are resolved in this order:
1. `mesh.metadata.surface`. It accepts an acoustic surface, a terrain surface (`grass/dirt/rock/road`) or a `BuildingMaterialId`.
2. Arena material `mat_<look>`.
3. Registered `SurfaceProvider`s, e.g. `terrainSurfaceProvider(surfaceMask)`.
4. Mesh-name hints.

## Network-ready API (`GameAudio`)

All positions are plain `{x, y, z}`.

```ts
audio.playGunshot({ weaponId, position, shooterIsLocal, suppressed?, age? })     // Shot / AudioShot
audio.playNearMiss({ position /* closest point */, velocity, weaponId })          // derived from Shot trajectories
audio.playFootstep({ position, surface?, stance: "crouch"|"walk"|"run"|"sprint", isLocal })
audio.playLanding({ position, fallSpeed, surface?, isLocal })  audio.playJump({ position, surface?, isLocal })
audio.playImpact({ position, normal?, surface?: AcousticSurface | "flesh", weaponId?, age? })
audio.playExplosion({ position, power?, age? })                                  // Detonate (placeholder sound)
audio.playMechanical({ kind, weaponId, position /* null = first person */, delay?, span?, tag? })  // remote reload = spatial, 12 m
audio.playHitConfirm({ zone, killed })                                            // HitConfirm
```

M3–M4 integration (netcode.md §10):
- `NetEvents` calls these methods directly: `presentation.audio.audio`.
- **Remote players:** add a `FootstepEmitterSource` to `director.footsteps.sources`. It reports feet position, grounded, crouched, sprinting and alive from interpolated snapshots. Stride timing and jump/land edges are derived from those.
- **Remote shots:** feed the client-side tracer simulations into `NearMissDetector` as a non-own projectile list, the same way `director.flyBys` works today.
- The audible radii in `acoustics.ts AUDIBLE_RANGE` mirror §10.2 and should move to `packages/shared/src/audio/audibility.ts` when that file exists.

## DEV console

`__audio.help()` prints everything. Bearings are degrees clockwise from where you look.

```js
__audio.ab("sniper", "rifle")          // A/B first-person: sniper, then rifle 1.6 s later
__audio.ab("sniper", "rifle", 300)     // A/B at 300 m (spatial, delayed)
__audio.gunshot("sniper", 600, -60)    // distant boom arrives ~1.75 s later, dull, rolling echo
__audio.gunshot("rifle", 25, 90)       // close, bright, right ear
__audio.burst("rifle", 200, 45, 8, 0.09)
__audio.nearMiss("rifle", 1.2, 0)      // crack, then the report 0.7 s later
__audio.nearMiss("shotgun", 1.5, 90)   // subsonic whiz sweeping past
__audio.footsteps("gravel", "sprint", 10, 180)   // enemy running behind you
__audio.footsteps("metal", "crouch", 4, -90)
__audio.impact("metal", 12, 30)
__audio.explosion(40, 0)
__audio.mech("pump", "shotgun"); __audio.hit("head", true)
__audio.ambience(true)   // ambience is off by default; this turns wind/birds on for the session
__audio.indoor(1)   // force room reverb; __audio.indoor(null) restores the probe
__audio.volume("ambience", 0.3); __audio.stats(); __audio.voices(); __audio.overlay()
```

Add `?audioDebug` to the URL to open the voice overlay on load. It shows bus, label, priority, distance, gain, occlusion and remaining time. The old presentation helpers still work: `__twobullets.presentation.debugFire("sniper")` and `debugReload(true)`.

## Listening checklist

The cut points were chosen by transient analysis and spectrograms, **not by ear**. Please audition these:

1. **Weapon hierarchy.** `__audio.ab("sniper", "rifle")`: the K-98 should be clearly bigger and heavier, with a long roll. If the sub thump reads as synthetic, lower `fp.sub` in `weaponMix.ts`; for more width or presence, edit `SNIPER_EQ` in `clips.ts` and rebuild with `--only=shot.sniper`. Re-run `fp-mix.ts` after any level change.
2. **Own shots, all four weapons.** Near takes should be punchy with no pre-shot noise. The tail should not double the attack. If AK and AR variations clash tonally, drop the AK cuts in `clips.ts`.
3. **Bolt/pump/reload sync.** `mech.bolt.open/close` alternate events from one recording; if open and close sound swapped, swap the `at` lists. The pump rack is aligned 30 ms early; nudge it in `GameAudio.playMechanical`.
4. **Distance.** `__audio.gunshot("rifle", d)` for d = 10, 50, 150, 400, 800: near → far crossfade without a level jump, and delay/echo growth.
5. **Footsteps vs ambience** (after `__audio.ambience(true)`). Enemy footsteps at 10–20 m must stay clearly audible over wind/birds. The wind loop is from a field recording and may carry handling or traffic noise.
6. **Loop seams.** Listen at 45 s for `amb.wind` / `amb.birds`, especially in Safari, which uses the AAC fallback.
7. **HRTF front/back.** Use `__audio.footsteps("concrete", "run", 6, 0)` against bearing 180.
8. **Indoor.** Under the central platform, the room reverb should replace the slapback.

## Known limitations

- Occlusion is binary (one ray, no transmission through thin materials) and uses the listener's current position for the whole delayed sound.
- Enclosure is a heuristic. Near tall walls it reads partly indoor.
- Surface resolution on building floors falls back to the terrain provider unless building meshes set `metadata.surface`.
- The ambience height factor uses absolute Y. On the 1×1 km terrain it should use height above ground.
- Explosions and near-miss cracks are synthesized placeholders.
