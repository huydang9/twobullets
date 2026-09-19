# Audio

Realistic, PUBG-style game audio built from free CC0 recordings (plus three owner-supplied voice clips): spatial gunshots with speed-of-sound delay and distance layers, near-miss cracks, surface footsteps, impacts, weapon mechanics synced to the viewmodel clips, grenades (frag, smoke, flashbang, molotov) with loops and ear ringing, healing and loot foley, an outdoor ambience bed, and — for the maze maps, where you cannot see — reverb measured from the corridor you are standing in, a leaf rustle when a round goes through a hedge, and a close-range click when a glazed pane switches mode.

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
| `assets-src/audio/` | Raw downloads and extracted sources (gitignored); `owner/` holds the owner-supplied clips, copied by hand |
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

All downloaded audio is **CC0**. Attribution isn't required, but every file is credited with its exact origin (file and cut time) in `credits.json`.

**Owner-supplied (2026-09-15, internal release, the owner's choice).** Three voice clips the owner found on the internet (original author and license unknown, credited as "Unknown (from the internet)"; replace before any public release); `license: "Owner-supplied"` in `sources.ts` and `credits.json`, no URL, never fetched (`fetch.ts` only checks they were copied into `assets-src/audio/owner/`):

| Source file | Sound | Plays |
|---|---|---|
| `trinh-la-gi.mp3` (stereo, 17.1 s) | `music.matchEnd` (stereo, 96 kbit/s, lazy) | Once per match on the placement screen (see "Event → sound") |
| `chay-di-cac-chau-oi.mp3` (dual mono, 4.5 s) | `voice.fragOut` (mono, 64 kbit/s, eager) | When a frag grenade is thrown |
| `do-anh-bat-duoc-em.mp3` (stereo, 3.9 s) | `voice.glassBlocked` (mono, 64 kbit/s, eager) | When a bullet stops dead in a bulletproof glass pane |

The source of `voice.glassBlocked` holds two spoken lines over a quiet bed; only the second, louder one is cut
(2.71 → 3.90 s, 1.19 s), because an impact sound that runs for seconds stacks horribly. For the first line instead,
change its cut in `clips.ts` to `at: [0.9]` with `maxSeconds: 1.25` and rebuild with
`--only=voice.glassBlocked`.

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
| [Swishes Sound Pack](https://opengameart.org/content/swishes-sound-pack) | artisticdude | Cloth (equip, jump), grenade throw whoosh, molotov ignition whoosh (pitched down) |
| [25 CC0 bang / firework SFX](https://opengameart.org/content/25-cc0-bang-firework-sfx) | rubberduck | Frag explosion close layer (bangs and cannon shots slowed to 80 % with a low shelf), flashbang bang, far-explosion variant |
| [Muffled Distant Explosion](https://opengameart.org/content/muffled-distant-explosion) | NenadSimic | Down-range explosion layer |
| [Fire Crackling](https://opengameart.org/content/fire-crackling) | AntumDeluge | Molotov fire crackle loop |
| [Glass Break](https://opengameart.org/content/glass-break) | Till Behrend | Molotov bottle shatter |
| [75 CC0 breaking / falling / hit sfx](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | Explosion debris rain, grenade canister bounces, spoon ping, glass shatter variants, pill rattle, armor breaking |
| [100 CC0 SFX](https://opengameart.org/content/100-cc0-sfx) | rubberduck | Grenade pin pull, spoon, bandage paper, drink slosh, smoke gas burst |

Not used:
- **OGA "Footsteps on different surfaces" (CC-BY 3.0).** The CC0 packs above cover the same surfaces.
- **Freesound.** It needs a login.
- **OGA "2 High Quality Explosions", "Big Explosion", "Rumble/explosion" and "Breaking Bottle".** They are CC-BY 3.0; the CC0 packs above cover the same needs.
- **Sonniss #GameAudioGDC bundles.** They are multi-GB, and the license forbids redistributing the sounds as loose files. They are the best future upgrade for gun tails, bullet cracks and explosions, but only if the files are baked into non-extractable sprites and the license is re-checked.

The Free Firearm library ships only gunshots. Its "near" takes are recorded beside the shooter, and the "mid" takes down range with the natural outdoor tail. It has no reload foley, which is why the mechanics come from the smaller packs.

Equipment sounds that no CC0 recording covers are synthesized at runtime: the smoke gas hiss loop (procedural band-limited noise with a periodic sputter), fire pops on top of the crackle loop, the explosion pressure sub, the tinnitus tones, the zipper (medkit, backpack), gulps, the antiseptic spray, the heartbeat and the knocked/eliminated stings. The bandage tape reuses the tape-measure pulls from LFA's equipment clicks III.

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
  | Total | 2.95 MB | 4.38 MB |
  | Eager (decoded before the first click) | 1.62 MB | |
  | Lazy (ambience, fetched on first use, so never while ambience is off; the results clip, fetched in the background after the eager set) | the rest | |

  58 sounds, 213 variations. This is well under the 8–15 MB budget, which leaves room for more variations.
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
    | Explosion and flashbang bangs | −19 / −21 LUFS, lookahead limiter ≤ 3–6 dB |
    | Throwable and consumable foley, armor | −20 to −26 LUFS; peaky hits may shave ≤ 3–5 dB |
    | Ambience | −24/−26 LUFS |
    | Owner-supplied voice clips (results clip, frag-out shout) | −18 LUFS, kept whole (`untrimmed` cut) |
    | Owner-supplied bulletproof-glass line | −18 LUFS, one line cut out of the source |

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
                                                                  ├→ room send ─→ bus room tap ┬→ convolver (0.9 s) ─→ room return ──┐
                                                                  │                            └→ corridor flutter (2 delays) ───────┤
                                                                  └→ echo send ─→ bus echo tap ─→ slapback + valley echo ─→ outdoor return ─┤
bus input ─ [weapons: glue compressor] ─→ duck gain ─→ fader (settings) ─→ master ─→ muffle low-pass ─→ limiter (−1 dB, 20:1) ─→ out ◄──┘
overlay voices (ear ringing) ─→ overlay gain (master volume) ──────────────────────────────────────────→ limiter
clear voices (results clip) ─→ bus "clear" gain (bus volume) ─→ overlay gain (master volume) ──────────→ limiter
```

The **muffle** is a master low-pass (open at 22 kHz) that `AudioEngine.muffle()` closes for flashbang ringing, close frag overpressure, knocks and eliminations. **Overlay** voices skip the buses and the muffle, so the tinnitus stays clear while everything else is dulled. **Clear** voices (the results clip on the UI bus) keep the bus volume and master volume but skip ducking, the muffle, reverb and echo.

| File | Role |
|---|---|
| `AudioEngine.ts` | Context unlock on first gesture; buses (weapons, impacts, footsteps, foley, ambience, ui); limiter; room reverb, corridor flutter and outdoor echo returns (`setRoom`); ducking; listener (Babylon's left-handed Z mirrored); voice pool |
| `SoundBank.ts` | Format pick, fetch + `OfflineAudioContext` decode (ready before the user gesture), eager loading at startup, lazy sounds on first use, no-repeat variation picking |
| `GameAudio.ts` | **Network-ready API.** Distance, delay, air absorption, occlusion, sends and layering per event |
| `AudioWorldProbe.ts` | Havok raycasts, max 10 per frame: occlusion (cached 150 ms), surface under feet / at impacts, enclosure probe, space probe (`space`, `roomSend`); holds the map's `MapPropAudio` |
| `MapPropAudio.ts` | Sounds the placed props make on their own: hedge rustles (analytic bullet-vs-hedge, no rays) and glazed-pane clicks, both read off `MapLayout.props` |
| `foliage.ts` | Hedge rustle: mix, cooldown, and the catalog rule that turns a colliderless prop into a volume |
| `glassPhaseClick.ts` | Glazed-pane mode-change click: range, level, the two synthesized partials |
| `FootstepSystem.ts` | Stride timing from distance travelled; stance; jump/land edges; local player + `FootstepEmitterSource`s |
| `NearMissDetector.ts` | Segment-vs-head closest approach per bullet per frame, ≤ 3 m → crack (> 343 m/s) or whiz |
| `AmbienceSystem.ts` | Wind loop (louder with height), birdsong loop (thinner with height), spatial bird calls, indoor damping |
| `WeaponAudio.ts` | First-person mechanics scheduled from viewmodel `ClipPlan` cues (tags cancel reloads and cycles) |
| `AudioDirector.ts` | Composition root created by `WeaponPresentation`. Per-frame listener/probe/footsteps/near-miss/ambience; `attachEquipment(view)` (called from `Game.ts`) |
| `equipment/EquipmentAudio.ts` | `EquipmentView` events and state → `GameAudio` calls: throw handling, bounces, detonations, smoke/fire loops (levels from cloud age / burning share), flash ringing, item-use foley, pickups, armor, heartbeat, knocked/revive/eliminated |
| `equipment/foley.ts` | Item-use cue layers and the synthesized equipment sounds (gas hiss loop buffer, fire pops, zipper, gulps, spray) |
| `equipmentMix.ts` | Dependency-free blast recipe by distance (`blastLayers`), echo and duck curves, loop levels, tinnitus model, item-use cue timelines (rendered by `verify.ts`) |
| `audioCredits.ts` | Loads `credits.json` into lines the HUD's credits list appends |
| `matchEndCue.ts` | UI → audio bridge for the results clip: `AudioDirector` registers `GameAudio` as the sink; `MatchScreens` drives one `MatchEndCue` per match (play once, owner screen, stop on hide, death → result handover) |
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

**Explosions sit above the sniper.** `verify.ts` renders `blastLayers()` at 4 m (inside the reference distance, so at full voice level) for every variation and requires a frag ≥ 3 LU over the first-person sniper with a bigger momentary max, a flashbang ≥ 0.5 LU over it, and peaks ≤ −1 dBTP:

| At 4 m | LUFS | Momentary max | Peak |
|---|---|---|---|
| Sniper K-98 (first person) | −24.0 | −16.4 | −1.2 dBTP |
| Frag (4 variations) | −19.0 … −19.7 | −13.4 … −14.9 | ≤ −1.7 dBTP |
| Flashbang (3 variations) | −19.2 … −22.9 | −14.0 … −17.3 | ≤ −2.3 dBTP |

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
- **Priorities:** results clip 5 > local 4 > important 3 (remote gunshots, enemy footsteps) > normal 2 > detail 1 > ambient 0.
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
- **How big is the space you are in** (`acoustics.roomFromSpace`, `AudioEngine.setRoom`). In a maze you cannot see, so the reverb has to say what is ahead of you before your eyes do: a 4 m squeeze rings, a 12 m boulevard slaps, the plaza opens out.
  - **Measured, never authored.** The probe casts one horizontal ray per frame from the head, round-robin over 8 directions (4 world axes, 4 diagonals) at `SPACE.reach` = 28 m, so the whole fan refreshes in ~130 ms and is smoothed over 0.3 s. That is one more ray per frame out of the same budget of 10; the budget is unchanged. No map constant is involved, so a maze whose corridors change width changes the reverb with it.
    - `width` = the narrowest **span** through the listener (a pair of opposite rays added together). On an axis-aligned lattice the axis pair across a corridor reads its width exactly.
    - `meanFreePath` = the mean of all 8 distances: how much room there is in total.
    - Space rays use their own mask: blockers **in** (a pane in its shoot-through mode and a chainlink fence are still walls to sound), players **out** (a teammate must not shrink the corridor).
  - **What it drives.** `closeness` (1 at 4 m, 0 at 18 m) raises the room convolver return and the per-voice room send, opens the room low-pass (5000 → 6800 Hz), and feeds a **corridor flutter**: a stereo pair of short feedback delays whose time is the round trip across the space (4 m → 23 ms, a metallic ring; 12 m → 70 ms, a distinct slap), glided so walking out of a squeeze sweeps it. `openness` (mean free path 8 → 24 m) fades the open-field slapback/valley echo back in.
  - **Voices couple by space, not by roof.** `probe.roomSend` is `max(enclosure, closeness)`; every `room:` send uses it. The old `probe.enclosure` is 0 in an open-topped corridor, which is exactly the space that rings most.
  - **Open maps are untouched.** With nothing within reach the probe measures `2 × reach` across and `reach` of free path, which lands on room = enclosure, echo = the old `1 − indoor × 0.85`, flutter silent, tone 5000 Hz — the model Map v1 and the real-world maps already had. `verify.ts` asserts that equality.
  - DEV: `__audio.space(4)` forces a squeeze, `__audio.space(null)` restores the rays, `__audio.space()` reads them.
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
| Impact on bulletproof glass (`wall_glass_solid`) | The pane's own `impact.metal`, plus the owner-supplied `voice.glassBlocked` spatial at the impact point. Recognized from the prop collider the surface ray hit (`propCollider_wall_glass_solid_*`), not from the material, so the shoot-through `wall_glass` stays silent. One line every 2.5 s across all panes, so emptying a magazine into one doesn't stack it. Everything about it (clip, prop, cooldown, mix, and an `enabled` switch) is in `audio/glassBlocked.ts` |
| Bullet through a hedge (`wall_grass`, and any walk-through bush) | A leaf rustle at the point it went in: `step.grass` at 1.35–1.6× (the CC0 grass take is a real rustle; fast and bright it reads as a bush, not a boot) + a slow `foley.cloth` for the branch + a high noise tick. Reference 2 m, range 30 m, priority `detail`, one per hedge per 0.14 s, at most 2 per frame. **No impact sound and no dust** — nothing stopped the round. Everything is in `audio/foliage.ts`; `enabled: false` silences it |
| Glazed pane changing mode within 8 m (`wall_glass`, `map/glassPhase.ts`) | A synthesized dry tick in the glazing: two decaying partials (3.1 / 4.7 kHz) + a 8 ms noise tick, ×1.28 in pitch and shorter when the pane **opens** rather than goes armoured. Reference 1.5 m, range 8 m, rolloff 1.4 (the steepest here), gain 0.3, priority `detail`, at most 2 panes per flip. Never on the first frame of a match (joining mid-cycle must not click every pane at once). Everything is in `audio/glassPhaseClick.ts` |
| Impact on target | `impact.flesh`, spatial |
| Hit confirm (shooter) | `impact.flesh` thud + tick; headshot adds a metallic tink; kill adds a low thump |
| Footstep | `step.concrete/dirt/grass/gravel/wood/metal`, gain/rate by stance |
| Jump / land | step + `foley.cloth` / `foley.land` + double step, scaled by fall speed |
| Near miss | Synthesized crack or whiz |
| Frag explosion (`onDetonate` frag) | `explosion.near` + slowed/darkened copy (body) crossfading (10 → 140 m) into `explosion.far` (pitched down past 120 m), 70 → 28 Hz sub, low rumble, `explosion.debris` + dirt raining over 1.5 s within 45 m; 343 m/s delay, air absorption, occlusion, echo send 0.5 → 1.2 with distance; direct route under 80 m; ducks the other buses by up to 16 dB (scaled by distance); under 14 m the master muffles briefly, under 5 m the ears ring |
| Flashbang bang | `flash.bang` + short bright snap, lighter sub; same distance model (range 300 m) |
| Flashbang exposure (`onFlash`) | Tinnitus (3.65/3.71/7.3 kHz, overlay route) at the bang's arrival, fading over `deafSeconds`; all other buses ducked 6–26 dB and the master low-passed to 5.3 kHz → 350 Hz by exposure strength, both recovering over the ringing |
| Pin pull / cook / throw (`onThrow`) | `throw.pin` + latch (molotov: flint strike and flame catch); cook = `throw.spoon`; throw = `throw.swish` (underhand softer) + cloth, spoon flying off for smoke/flash; pin return = latch; draw/holster = cloth |
| Grenade bounce (`onThrowableBounce`) | `throw.bounce` canister clunk pitched per kind and surface (wood duller, metal brighter) + the surface's footstep sample; soft ground uses a dirt thud; level by impact speed; 35 m |
| Smoke | Detonation: 150 → 60 Hz pop + `smoke.burst`; then a procedural hiss loop per cloud, loud while venting (0–9 s), gone by 16 s; nearest 3 clouds play |
| Molotov | `molotov.shatter` + slowed swish and noise whoosh of the fuel catching; `fire.loop` per patch (two detuned offset copies) with random crackle pops, level by burning share, nearest 4 patches play |
| Item use (`onUse`) | One tagged voice scheduling the item's cue timeline over its use time: bandage paper/tape/cloth; first aid zip/paper/tape; medkit zip/pill rattle/spray/tape/zip; energy drink can open (click + pssht), gulps, slosh; painkiller rattle, cap clicks, water, gulps. Cancel stops it (25 ms fade) |
| Pickup / drop (`onItem`) | Cloth + by kind: ammo casings rattle, weapon latch, armor strap/buckle clank, backpack zip, consumable paper, throwable clink; drop adds a soft thud |
| Armor absorbs (`onArmor`) | `armor.hit` plate clank by absorbed damage; destroyed adds `armor.break` |
| Frag thrown (`onThrow` `throwReleased`, overhand/underhand, kind frag) | Owner-supplied `voice.fragOut`, first person on the foley bus at release (not on pin pull or cook). Frags only. At most one instance per thrower (a thrower whose shout is still playing gets none) |
| Bot frag thrown (offline `MatchFxEvent` `throwRelease`, via `AudioDirector.remoteThrow`) | Same shout, spatial from the bot's head: reference 4 m, range 45 m, delay, air absorption, occlusion; one per bot |
| Placement screen (`MatchScreens`: `ResultScreen.show`, or `DeathScreen.show` once the team is out and a placement exists) | Owner-supplied `music.matchEnd`, non-spatial on the UI bus "clear" route; once per match (the result screen that follows a placement death screen takes it over without restarting); stops (0.4 s fade) when that screen hides (close, spectate, leave, exit to menu), when a new match's screens are created, or when the director is disposed. If the lazy file isn't in yet it starts on arrival, unless over 4 s late |
| Knocked / revive / eliminated (`onVitals`) | Knock: low sting, thud, brief muffle; heartbeat while knocked or under 25 HP (faster as it drains); revive: cloth rustles every ~0.7 s; eliminated: low sting and a 4 s muffle |
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
audio.playGlassBlocked({ position, age? })                                       // bulletproof pane; playImpact calls it
audio.playFoliageHit(position)                                                   // bullet through a hedge (MapPropAudio)
audio.playGlassPhaseClick(position, blocking)                                    // a pane near you switched mode
audio.playExplosion({ position, kind?: "frag"|"flash", power?, age? })            // Detonate
audio.playThrowableBounce({ kind, position, normal?, impactSpeed, surface? })     // derived from local stepThrowables
audio.playThrowAction({ action: "draw"|"pinPull"|"spoon"|"throw"|"pinReturn"|"holster", kind, style?, position /* null = first person */ })
audio.playSmokePop({ position, age? })  audio.playMolotovShatter({ position, age? })   // Detonate / AreaEffectStart
audio.playSmokeHiss(areaId, position, level?)  audio.playFire(areaId, position, level?)  audio.stopArea(areaId)   // AreaEffectStart/End
audio.updateAreas(dt)                                                              // per frame (AudioDirector does it)
audio.playFlashRing({ strength, seconds?, delay? })                                // local flash exposure
audio.playItemUse({ itemId, seconds, elapsed?, position, tag })  audio.stopItemUse(tag)   // actionKind + phaseStart
audio.playPickup(kind | "drop", position?)  audio.playArmorHit({ absorbed, destroyed, position })   // PlayerHit armor flag
audio.playMechanical({ kind, weaponId, position /* null = first person */, delay?, span?, tag? })  // remote reload = spatial, 12 m
audio.playHitConfirm({ zone, killed })                                            // HitConfirm
audio.playFragCallout({ thrower /* slot | "local" */, position /* head; null = first person */, age? })   // frag release
audio.playMatchEndMusic()  audio.stopMatchEndMusic(fade?)                         // placement screen (via matchEndCue.ts)
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
__audio.glassBlocked(); __audio.glassBlocked(20, 90)   // bulletproof-glass line; rate-limited to one per 2.5 s
__audio.explosion(40, 0)             // frag; __audio.explosion(15, 90, "flash") for the bang
__audio.explosion(4); __audio.explosion(250, -30)   // close overpressure + ringing vs distant rolling boom
__audio.flashRing(1)                   // full tinnitus: mix ducked and dulled, recovering over 6 s
__audio.smoke(12, 30); __audio.fire(8, -40)
__audio.bounce("wood", 5, 45, 7, "smoke"); __audio.throw("pinPull"); __audio.throw("throw")
__audio.fragOut(); __audio.fragOut(20, 45)   // own frag-out shout; a thrower 20 m away, 45° right
__audio.matchEnd(); __audio.matchEnd(false)  // results clip on/off
__audio.useItem("medkit"); __audio.cancelUse(); __audio.pickup("armor"); __audio.armor(true)
__audio.mech("pump", "shotgun"); __audio.hit("head", true)
__audio.ambience(true)   // ambience is off by default; this turns wind/birds on for the session
__audio.rustle(); __audio.rustle(12, -90)    // a bullet going through a hedge, 12 m away on your left
__audio.paneClick(); __audio.paneClick(false, 2, 180)   // a pane going armoured; one opening 2 m behind you
__audio.space(4)     // force a 4 m squeeze: everything rings. 12 = boulevard, 40 = plaza, null = live rays
__audio.space()      // read the measured width / mean free path and the reverb it produces
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
9. **Explosions.** `__audio.explosion(d)` for d = 4, 20, 60, 150, 400: a frag must be clearly bigger than `__audio.ab("sniper", "rifle")`, the near → far handover shouldn't jump, and the debris shouldn't sound like crockery (swap `explosion.debris` cuts in `clips.ts`). The near layer is a firework/cannon bang slowed to 80 %; if it reads as a firework, try `rate: 0.7`.
10. **Flashbang.** `__audio.explosion(8, 0, "flash")` then `__audio.flashRing(1)`: the ring must stay audible while the rest is dull, and recover smoothly.
11. **Loops.** `__audio.smoke()` hiss should not sound like tape noise; `__audio.fire()` crackle loop is 2.3 s, so listen for repetition.
12. **Bulletproof glass.** `__audio.glassBlocked()`, and in game empty a magazine into a `wall_glass_solid` pane. The cut was picked by envelope analysis, not by ear: check that it starts on the first syllable and isn't the wrong half of the source (the file holds two lines), and that one line per 2.5 s feels right rather than naggy.
13. **Corridor reverb** (`?map=mazebr`). Stand in a 4 m squeeze and fire: the shot should ring, tight and bright, with the open-field slap gone. Walk out into the plaza still firing — the ring should stretch into a slap and then open out, smoothly, with no click from the delay line. `__audio.space(4)` / `(12)` / `(40)` A/Bs it from anywhere; `__audio.space(null)` gives the rays back. Then check `?map=v1`: it must sound exactly as it did (`__audio.space()` should read ~56 m wide out in the open). If the flutter reads as a comb filter rather than a room, lower `FLUTTER_FEEDBACK` in `acoustics.ts`.
14. **Hedge rustle.** Fire a burst into a `wall_grass` hedge at 5 m, then at 25 m. It should be leaves, close to silent at the far end, and it must not read as a footstep — if it does, raise the rate in `GameAudio.playFoliageHit` or drop the `foley.cloth` layer. Then stand **inside** a hedge while a bot fires into it. `__audio.rustle()` auditions it without hunting for a bush.
15. **Pane click.** Stand beside a `wall_glass` pane and wait (a group flips every ten seconds). The tick should be quiet enough to miss while a fight is on and clear when you are listening, and armoured-vs-open should be tellable. Walk 10 m away: nothing. `__audio.paneClick(true)` then `__audio.paneClick(false)` A/Bs the two modes. If it gives the pane away too cheaply, set `openRate` to 1 (both modes identical) or drop `gain`.
16. **Pin, spoon, tape.** The pin pull uses key-in-lock recordings and the bandage tape uses tape-measure pulls; both were chosen by spectrum. Replace the cuts if they don't read as intended.

## Known limitations

- Occlusion is binary (one ray, no transmission through thin materials) and uses the listener's current position for the whole delayed sound.
- Enclosure is a heuristic. Near tall walls it reads partly indoor.
- The space probe measures from the listener's head only, so the reverb is the space you are standing in, not the one you are looking into. You hear a plaza as you reach it, not from three corridors away.
- Space rays are horizontal, so on sloping ground a hillside ahead counts as a wall. That is arguably right (it does reflect), but it means a valley on a real-world map reads narrower than it looks.
- Hedges are absent from the space measurement: they have no collider for the rays to find, which is also the honest answer acoustically — a hedge absorbs rather than reflects. A corridor walled with hedges therefore reads as open.
- The hedge rustle is derived from the bullet's per-frame segment against the prop's own box, so it approximates the visible hedge (a 4 × 0.9 × 3 m slab), not the ragged silhouette the stand-in mesh draws. A round clipping the very top blades is silent.
- The pane click runs off the client's `MapRuntime` phase clock. Once the match server owns combat that must be the match tick's own time, like `PropColliders.setPhaseTime`.
- Surface resolution on building floors falls back to the terrain provider unless building meshes set `metadata.surface`.
- The ambience height factor uses absolute Y. On the map terrain it should use height above ground.
- Near-miss cracks are synthesized. The explosion close layer is a firework/cannon recording, not a real grenade.
- Smoke and fire loops sit on the ambience bus (volume slider "ambience"), which is otherwise idle while ambience is switched off.
- Grenade bounces on players aren't simulated (grenades collide with the static world only), so there is no body-hit bounce sound.
