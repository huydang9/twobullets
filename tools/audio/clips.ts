// What ships: every sound id, its variations and where each one is cut from.
// Cut points came from `node tools/audio/analyze.ts <file>` (event onsets/peaks); `at` is refined to the actual
// attack at build time, so ±50 ms is fine. Recordings were chosen by metadata and spectrum, not by ear:
// audition in game (docs/audio.md, "Listening checklist") and adjust here.
import type { SourceId } from "./sources.ts";

export type Channels = 1 | 2;
/** eager: decoded at startup (weapons, footsteps, impacts). lazy: fetched on first use or after startup (ambience). */
export type LoadPolicy = "eager" | "lazy";

export interface CutSpec {
  readonly source: SourceId;
  /** Path relative to the source's download (single file) or extraction directory. */
  readonly file: string;
  /**
   * Times (s) near each wanted event; each yields one variation starting at that event's attack.
   * "whole" takes the file from its first attack.
   */
  readonly at: readonly number[] | "whole";
  /** Playback rate baked into the file (pitching a donor recording). */
  readonly rate?: number;
  /** Seconds after the attack where the variation starts (tails without the direct sound). */
  readonly skip?: number;
}

export interface LoopSpec {
  readonly source: SourceId;
  readonly file: string;
  readonly start: number;
  readonly length: number;
  /** Seconds of the tail crossfaded into the head so the loop is seamless. */
  readonly crossfade: number;
}

export interface ClipSpec {
  readonly id: string;
  readonly channels: Channels;
  readonly load: LoadPolicy;
  /** Longest variation, s; shorter source events end where the next `at` begins. */
  readonly maxSeconds: number;
  /** Fraction of the clip length used for the fade-out. */
  readonly fadeOut: number;
  /**
   * Integrated loudness target (LUFS). Without `limitDb` it is applied as a linear gain capped by the true-peak
   * ceiling, so very peaky recordings land below target.
   */
  readonly lufs: number;
  /** Allows a lookahead limiter to shave up to this many dB off the first transient so the clip reaches `lufs`. */
  readonly limitDb?: number;
  /** Opus bitrate, kbit/s (AAC fallback uses ~1.25×). */
  readonly kbps: number;
  readonly highpass?: number;
  /** Extra ffmpeg filters (EQ, stereo width) applied before normalization. */
  readonly filters?: readonly string[];
  readonly cuts?: readonly CutSpec[];
  readonly loop?: LoopSpec;
}

const FFSL = "Prepared SFX Library/";
const KENNEY = "Audio/";
const kenney = (name: string, indices: readonly number[]): CutSpec[] =>
  indices.map((i) => ({ source: "kenneyImpact", file: `${KENNEY}${name}_${String(i).padStart(3, "0")}.ogg`, at: "whole" }));
const fantozzi = (kind: "Stone" | "Sand"): CutSpec[] =>
  ["L1", "L2", "L3", "R1", "R2", "R3"].map((side) => ({ source: "fantozziSteps", file: `Fantozzi-footsteps/flac/Fantozzi-${kind}${side}.flac`, at: "whole" }));

const GUN_NEAR = { channels: 2, load: "eager", fadeOut: 0.5, kbps: 128, highpass: 30, limitDb: 2 } as const;
const GUN_FAR = { channels: 1, load: "eager", fadeOut: 0.4, kbps: 64, highpass: 30, limitDb: 2 } as const;

/**
 * Gunshot file loudness, LUFS. The library's takes are mastered hot: every one is already peak-limited, and within
 * the blast the waveform sits near full scale, so no gain or limiting can raise a file's loudness without audibly
 * crushing it (a 10 dB limiter pass made the rifle quieter). Files therefore target what their quietest variants can
 * reach, which keeps variations within ~2 LU of each other. The weapon loudness hierarchy (sniper loudest) lives in
 * the runtime mix, where there is headroom: see WEAPON_SOUNDS in apps/client/src/audio/soundDesign.ts and
 * `node tools/audio/fp-mix.ts`.
 */
export const GUN_LUFS = {
  near: { pistol: -26.5, rifle: -28.5, shotgun: -26.5, sniper: -28 },
  far: { pistol: -29, rifle: -29, shotgun: -28.5, sniper: -29 },
} as const;
/** Sniper voicing: infrasound out, low-shelf weight, 2–4 kHz crack presence. */
const SNIPER_EQ = ["highpass=f=35", "bass=g=3:f=100:w=0.8", "equalizer=f=3000:t=q:w=0.9:g=2.5"];
const MECH = { channels: 1, load: "eager", fadeOut: 0.3, lufs: -18, kbps: 64, highpass: 80 } as const;
const ONE_SHOT = { channels: 1, load: "eager", fadeOut: 0.3, lufs: -18, kbps: 56, highpass: 40 } as const;

export const CLIPS: readonly ClipSpec[] = [
  // --- Gunshots. "near" = recorded beside the shooter (first person, close third person);
  // "far" = recorded down range, longer natural tail (mid/far layers and the first-person tail layer).
  {
    id: "shot.rifle.near",
    ...GUN_NEAR,
    lufs: GUN_LUFS.near.rifle,
    maxSeconds: 1.1,
    cuts: [
      { source: "ffsl", file: `${FFSL}AR-15/D_32P.wav`, at: [0.705, 5.65] },
      { source: "ffsl", file: `${FFSL}AK-47/C_28P.wav`, at: [0.615, 3.26, 6.02] },
    ],
  },
  {
    id: "shot.rifle.far",
    ...GUN_FAR,
    lufs: GUN_LUFS.far.rifle,
    maxSeconds: 2.6,
    cuts: [
      { source: "ffsl", file: `${FFSL}AR-15/D_24P.wav`, at: [0.58, 3.935] },
      { source: "ffsl", file: `${FFSL}AK-47/C_31P.wav`, at: [0.355, 4.42] },
    ],
  },
  {
    id: "shot.shotgun.near",
    ...GUN_NEAR,
    lufs: GUN_LUFS.near.shotgun,
    maxSeconds: 1.3,
    cuts: [
      { source: "ffsl", file: `${FFSL}Nova/O_21P.wav`, at: [0.435, 3.465] },
      { source: "ffsl", file: `${FFSL}CD/H_21P.wav`, at: [0.465, 3.075] },
      { source: "ffsl", file: `${FFSL}Model 12/K_22P.wav`, at: [0.845, 7.445] },
    ],
  },
  {
    id: "shot.shotgun.far",
    ...GUN_FAR,
    lufs: GUN_LUFS.far.shotgun,
    maxSeconds: 2.6,
    cuts: [
      { source: "ffsl", file: `${FFSL}Nova/O_17P.wav`, at: [0.695, 3.705] },
      { source: "ffsl", file: `${FFSL}CD/H_16P.wav`, at: [0.605, 4.115] },
      { source: "ffsl", file: `${FFSL}Model 12/K_17P.wav`, at: [0.905, 7.055] },
    ],
  },
  {
    id: "shot.pistol.near",
    ...GUN_NEAR,
    lufs: GUN_LUFS.near.pistol,
    maxSeconds: 0.9,
    cuts: [
      { source: "ffsl", file: `${FFSL}Walther PPQ/X_39P.wav`, at: [1.405, 6.445, 10.66] },
      { source: "ffsl", file: `${FFSL}1911/A_42P.wav`, at: [0.945, 5.005] },
    ],
  },
  {
    id: "shot.pistol.far",
    ...GUN_FAR,
    lufs: GUN_LUFS.far.pistol,
    maxSeconds: 2.2,
    cuts: [
      { source: "ffsl", file: `${FFSL}Walther PPQ/X_31P.wav`, at: [1.085, 5.24] },
      { source: "ffsl", file: `${FFSL}1911/A_34P.wav`, at: [1.54, 6.655] },
    ],
  },
  {
    id: "shot.sniper.near",
    ...GUN_NEAR,
    lufs: GUN_LUFS.near.sniper,
    maxSeconds: 1.8,
    // Tikka T3, Springfield 1917 and Arisaka (.30-06 class) carry the most 45–150 Hz body and the longest natural
    // tails in the library; the Mosin takes are denser but thinner, so they were dropped.
    filters: [...SNIPER_EQ, "extrastereo=m=1.3:c=false"],
    cuts: [
      { source: "ffsl", file: `${FFSL}Tikka/W_29P.wav`, at: [0.585, 5.67] },
      { source: "ffsl", file: `${FFSL}1917/B_24P.wav`, at: [1.315, 6.735] },
      { source: "ffsl", file: `${FFSL}Arisaka/E_25P.wav`, at: [0.525, 4.03] },
    ],
  },
  {
    id: "shot.sniper.far",
    ...GUN_FAR,
    lufs: GUN_LUFS.far.sniper,
    maxSeconds: 3.2,
    filters: SNIPER_EQ,
    cuts: [
      { source: "ffsl", file: `${FFSL}Tikka/W_24P.wav`, at: [0.775, 5.4] },
      { source: "ffsl", file: `${FFSL}Mosin Nagant/M_26P.wav`, at: [1.15, 6.12, 10.755] },
      { source: "ffsl", file: `${FFSL}1917/B_16P.wav`, at: [0.63] },
    ],
  },
  {
    // First-person outdoor tail: the down-range takes without their direct sound, 2.5 s of rolling report.
    id: "shot.sniper.tail",
    channels: 2,
    load: "eager",
    maxSeconds: 2.5,
    fadeOut: 0.6,
    lufs: -27,
    limitDb: 2,
    kbps: 96,
    highpass: 40,
    filters: ["lowpass=f=7000", "bass=g=2:f=90:w=0.8"],
    cuts: [
      { source: "ffsl", file: `${FFSL}1917/B_16P.wav`, at: [0.63, 6.0], skip: 0.12 },
      { source: "ffsl", file: `${FFSL}Tikka/W_24P.wav`, at: [0.775, 5.4], skip: 0.12 },
      { source: "ffsl", file: `${FFSL}Arisaka/E_18P.wav`, at: [0.38, 4.51], skip: 0.12 },
    ],
  },

  // --- Weapon mechanics (first person, synced to viewmodel clip cues).
  { id: "mech.rifle.magOut", ...MECH, maxSeconds: 0.45, cuts: [{ source: "rifleReload", file: "assaultriflereload1.wav", at: [0.28] }] },
  { id: "mech.rifle.magIn", ...MECH, maxSeconds: 0.5, cuts: [{ source: "rifleReload", file: "assaultriflereload1.wav", at: [1.1] }] },
  { id: "mech.pistol.magOut", ...MECH, maxSeconds: 0.35, cuts: [{ source: "handgunReload", file: "handgun-reload.wav", at: [0.11] }] },
  { id: "mech.pistol.magIn", ...MECH, maxSeconds: 0.4, cuts: [{ source: "handgunReload", file: "handgun-reload.wav", at: [0.6] }] },
  { id: "mech.pistol.slide", ...MECH, maxSeconds: 0.45, cuts: [{ source: "handgunReload", file: "handgun-reload.wav", at: [1.05] }] },
  // Real bolt-action rifle cycles (equipment clicks III); alternate events are the opening and closing halves.
  {
    id: "mech.bolt.open",
    ...MECH,
    maxSeconds: 0.35,
    cuts: [{ source: "lfaClicks3", file: "equipment_clicks3.wav", at: [0.215, 1.525, 2.86, 3.735] }],
  },
  {
    id: "mech.bolt.close",
    ...MECH,
    maxSeconds: 0.35,
    cuts: [{ source: "lfaClicks3", file: "equipment_clicks3.wav", at: [0.885, 2.185, 3.33, 4.35] }],
  },
  {
    id: "mech.charge",
    ...MECH,
    maxSeconds: 0.3,
    cuts: [{ source: "lfaClicks3", file: "equipment_clicks3.wav", at: [9.655, 11.44, 19.74, 20.885] }],
  },
  { id: "mech.shotgun.pump", ...MECH, maxSeconds: 0.5, cuts: [{ source: "shotgunReload", file: "ShotgunSounds/Rack.mp3", at: [0.66] }] },
  {
    id: "mech.shotgun.shell",
    ...MECH,
    maxSeconds: 0.65,
    cuts: [
      { source: "shotgunReload", file: "ShotgunSounds/Subsequent Shells.mp3", at: [0.7] },
      { source: "shotgunReload", file: "ShotgunSounds/4 Shell Reload.mp3", at: [1.2, 2.25, 3.3] },
    ],
  },
  {
    id: "mech.dryFire",
    ...MECH,
    maxSeconds: 0.2,
    cuts: [{ source: "lfaClicks2", file: "equipmentclicks.wav", at: [0.15, 5.485] }],
  },
  {
    id: "mech.latch",
    ...MECH,
    maxSeconds: 0.3,
    cuts: [{ source: "lfaClicks2", file: "equipmentclicks.wav", at: [2.065, 2.39, 3.93] }],
  },

  // --- Foley.
  {
    id: "foley.cloth",
    ...ONE_SHOT,
    lufs: -22,
    maxSeconds: 0.6,
    cuts: [1, 2, 3, 4].map((i): CutSpec => ({ source: "swishes", file: `swishes/swish-${i}.wav`, at: "whole" })),
  },
  { id: "foley.casing", ...ONE_SHOT, maxSeconds: 0.35, cuts: kenney("impactMetal_light", [0, 1, 2, 3, 4]) },
  { id: "foley.land", ...ONE_SHOT, maxSeconds: 0.5, cuts: kenney("impactSoft_heavy", [0, 1, 2, 3, 4]) },

  // --- Footsteps by surface.
  { id: "step.concrete", ...ONE_SHOT, lufs: -20, maxSeconds: 0.4, cuts: fantozzi("Stone") },
  { id: "step.dirt", ...ONE_SHOT, lufs: -20, maxSeconds: 0.4, cuts: fantozzi("Sand") },
  { id: "step.grass", ...ONE_SHOT, lufs: -20, maxSeconds: 0.4, cuts: kenney("footstep_grass", [0, 1, 2, 3, 4]) },
  { id: "step.wood", ...ONE_SHOT, lufs: -20, maxSeconds: 0.4, cuts: kenney("footstep_wood", [0, 1, 2, 3, 4]) },
  { id: "step.metal", ...ONE_SHOT, lufs: -20, maxSeconds: 0.4, cuts: kenney("impactPlate_light", [0, 1, 2, 3, 4]) },
  {
    id: "step.gravel",
    ...ONE_SHOT,
    lufs: -20,
    maxSeconds: 0.5,
    cuts: [1, 2, 3, 4, 5, 6].map(
      (i): CutSpec => ({ source: "snowGravelSteps", file: `Corsica_S-Walking_in_Snow/Corsica_S-Walking_on_snow_covered_gravel_0${i}.flac`, at: "whole" }),
    ),
  },

  // --- Bullet impacts by surface.
  { id: "impact.concrete", ...ONE_SHOT, maxSeconds: 0.45, cuts: kenney("impactMining", [0, 1, 2, 3, 4]) },
  { id: "impact.metal", ...ONE_SHOT, maxSeconds: 0.6, cuts: kenney("impactMetal_medium", [0, 1, 2, 3, 4]) },
  { id: "impact.wood", ...ONE_SHOT, maxSeconds: 0.45, cuts: kenney("impactPlank_medium", [0, 1, 2, 3, 4]) },
  { id: "impact.dirt", ...ONE_SHOT, maxSeconds: 0.4, cuts: kenney("impactSoft_medium", [0, 1, 2, 3, 4]) },
  { id: "impact.flesh", ...ONE_SHOT, maxSeconds: 0.35, cuts: kenney("impactPunch_medium", [0, 1, 2, 3, 4]) },

  // --- Ambience (lazy).
  {
    id: "amb.wind",
    channels: 2,
    load: "lazy",
    maxSeconds: 45,
    fadeOut: 0,
    lufs: -24,
    kbps: 96,
    // The field recording carries mic buffeting below ~100 Hz.
    highpass: 100,
    loop: { source: "parkWind", file: "park_ambience_wind.wav", start: 12, length: 45, crossfade: 3 },
  },
  {
    id: "amb.birds",
    channels: 2,
    load: "lazy",
    maxSeconds: 45,
    fadeOut: 0,
    lufs: -26,
    kbps: 96,
    // Only the birdsong is wanted; the wind bed supplies the low end.
    highpass: 400,
    loop: { source: "parkBirds", file: "park_ambience_birds.wav", start: 30, length: 45, crossfade: 3 },
  },
  {
    id: "amb.birdCall",
    ...ONE_SHOT,
    load: "lazy",
    lufs: -22,
    highpass: 300,
    maxSeconds: 3,
    fadeOut: 0.25,
    cuts: [{ source: "isaiahBirds", file: "birds-isaiah658.ogg", at: [1.6, 5.8, 7.9, 11.1, 14.95, 19.15, 24.85] }],
  },
];
