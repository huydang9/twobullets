import type { SoundId } from "./audioManifest";

/**
 * Gunshot mix per weapon and the first-person shot recipe. Dependency-free (no Babylon, no shared package) so
 * `node tools/audio/fp-mix.ts` renders exactly what the game layers and measures its loudness offline.
 */

/** Same union as WeaponId in @twobullets/shared (checked in soundDesign.ts). */
export type GunId = "rifle" | "shotgun" | "pistol" | "sniper";

export interface DuckSpec {
  /** Depth, dB. */
  readonly db: number;
  /** Seconds at full depth before the release starts. */
  readonly hold: number;
  /** Seconds to recover. */
  readonly release: number;
}

export interface WeaponSound {
  readonly near: SoundId;
  readonly far: SoundId;
  /**
   * Overall level of this weapon (linear, first person and remote). The files are all mastered to about the same
   * loudness, so this is where the hierarchy lives: sniper 0 dB, shotgun −4 dB, rifle −5 dB, pistol −7 dB.
   */
  readonly level: number;
  /** Audible range when unsuppressed, m (netcode.md §10.2: rifle 800 m, sniper farther). */
  readonly range: number;
  /** Distance where falloff begins, m. */
  readonly reference: number;
  /** Falloff exponent (< 1 carries further). */
  readonly rolloff: number;
  /** Remote shots: multiplier on the down-range "boom" layer. */
  readonly farBoost: number;
  /** Remote shots: low boom tone under the far layer, relative gain (0 = none). */
  readonly farSub: number;
  readonly fp: {
    /** Dedicated first-person tail, or null to reuse the down-range take from 120 ms in. */
    readonly tail: SoundId | null;
    readonly tailGain: number;
    /** Mechanism click, relative to `level`. */
    readonly mech: number;
    /** Synthesized 50–110 Hz thump. */
    readonly sub: number;
    /** Delayed, darkened reflections of the report (outdoor slapback). */
    readonly slap: number;
    /** Send into the engine's outdoor echo. */
    readonly echo: number;
  };
  /** Remote shots: outdoor echo send scale. */
  readonly echo: number;
  /** Ducking when the local player fires. */
  readonly duck: { readonly ambience: DuckSpec; readonly weapons: DuckSpec; readonly footsteps: DuckSpec };
  /** Remote voices skip the weapons bus glue compressor (keeps the transient of the biggest guns). */
  readonly bypassGlue: boolean;
  /** Spent case: rate applied to the brass tink (shotgun hulls are duller). */
  readonly casingRate: number;
  readonly casingLowpass: number;
}

const duck = (db: number, hold: number, release: number): DuckSpec => ({ db, hold, release });

export const WEAPON_SOUNDS: Readonly<Record<GunId, WeaponSound>> = {
  rifle: {
    near: "shot.rifle.near",
    far: "shot.rifle.far",
    level: 0.56,
    range: 800,
    reference: 6,
    rolloff: 0.72,
    farBoost: 1,
    farSub: 0,
    fp: { tail: null, tailGain: 0.4, mech: 0.35, sub: 0, slap: 0, echo: 0.45 },
    echo: 0.8,
    duck: { ambience: duck(8, 0.25, 0.9), weapons: duck(2, 0.08, 0.3), footsteps: duck(4, 0.15, 0.5) },
    bypassGlue: false,
    casingRate: 1.7,
    casingLowpass: 12_000,
  },
  shotgun: {
    near: "shot.shotgun.near",
    far: "shot.shotgun.far",
    level: 0.93,
    range: 500,
    reference: 6,
    rolloff: 0.8,
    farBoost: 1,
    farSub: 0,
    fp: { tail: null, tailGain: 0.75, mech: 0.15, sub: 0, slap: 0, echo: 0.5 },
    echo: 0.9,
    duck: { ambience: duck(10, 0.3, 1.1), weapons: duck(3, 0.12, 0.45), footsteps: duck(5, 0.2, 0.6) },
    bypassGlue: false,
    casingRate: 0.75,
    casingLowpass: 2500,
  },
  pistol: {
    near: "shot.pistol.near",
    far: "shot.pistol.far",
    level: 0.36,
    range: 400,
    reference: 5,
    rolloff: 0.8,
    farBoost: 1,
    farSub: 0,
    fp: { tail: null, tailGain: 0.3, mech: 0.5, sub: 0, slap: 0, echo: 0.35 },
    echo: 0.6,
    duck: { ambience: duck(6, 0.2, 0.7), weapons: duck(1.5, 0.06, 0.25), footsteps: duck(3, 0.12, 0.4) },
    bypassGlue: false,
    casingRate: 1.9,
    casingLowpass: 12_000,
  },
  sniper: {
    near: "shot.sniper.near",
    far: "shot.sniper.far",
    level: 0.78,
    range: 1250,
    reference: 12,
    rolloff: 0.55,
    farBoost: 1.5,
    farSub: 0.5,
    fp: { tail: "shot.sniper.tail", tailGain: 1.15, mech: 0.1, sub: 0.35, slap: 0.4, echo: 0.8 },
    echo: 1.2,
    duck: { ambience: duck(14, 0.6, 2.2), weapons: duck(5, 0.35, 1.2), footsteps: duck(7, 0.35, 1) },
    bypassGlue: true,
    casingRate: 1.4,
    casingLowpass: 10_000,
  },
};

export type FirstPersonLayer =
  | {
      readonly kind: "sample";
      readonly sound: SoundId;
      /** Seconds after the trigger. */
      readonly delay: number;
      readonly gain: number;
      /** Seconds skipped into the buffer. */
      readonly offset: number;
      /** Hz, or null for a full-band layer. */
      readonly lowpass: number | null;
      /** Multiplies the shot's random rate; mechanism clicks carry their own pitch. */
      readonly rate: number;
    }
  | {
      /** Sine sweeping exponentially from `from` to `to` Hz over `sweep` s, 2 ms attack, exponential decay. */
      readonly kind: "sub";
      readonly delay: number;
      readonly gain: number;
      readonly from: number;
      readonly to: number;
      readonly sweep: number;
      readonly decay: number;
    };

/** The layers of one first-person shot, before the per-shot random pitch and level. */
export function firstPersonShot(design: WeaponSound): FirstPersonLayer[] {
  const { fp, level } = design;
  const layers: FirstPersonLayer[] = [
    // Transient-preserved close report.
    { kind: "sample", sound: design.near, delay: 0, gain: level, offset: 0, lowpass: null, rate: 1 },
    fp.tail
      ? { kind: "sample", sound: fp.tail, delay: 0.05, gain: level * fp.tailGain, offset: 0, lowpass: null, rate: 1 }
      : { kind: "sample", sound: design.far, delay: 0.03, gain: level * fp.tailGain, offset: 0.12, lowpass: 6000, rate: 1 },
    { kind: "sample", sound: "mech.dryFire", delay: 0, gain: level * fp.mech, offset: 0, lowpass: null, rate: 1.3 },
  ];
  if (fp.sub > 0) {
    layers.push({ kind: "sub", delay: 0.006, gain: level * fp.sub, from: 110, to: 48, sweep: 0.12, decay: 0.075 });
  }
  if (fp.slap > 0) {
    // A near tree line / building face, then a farther one.
    layers.push({ kind: "sample", sound: design.far, delay: 0.16, gain: level * fp.slap, offset: 0, lowpass: 2800, rate: 0.98 });
    layers.push({ kind: "sample", sound: design.far, delay: 0.41, gain: level * fp.slap * 0.55, offset: 0, lowpass: 1400, rate: 0.96 });
  }
  return layers;
}
