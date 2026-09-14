import type { SoundId } from "./audioManifest";
import type { FirstPersonLayer } from "./weaponMix";

/**
 * Throwable and consumable mix: explosion recipes by distance, loop levels and the tinnitus model. Dependency-free
 * (type imports only, like weaponMix.ts) so tools/audio/verify.ts renders the same explosion layers offline with plain
 * Node and checks the loudness hierarchy (explosions above the sniper).
 */

const clamp = (value: number, min: number, max: number): number => (value < min ? min : value > max ? max : value);
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** A layer of a detonation at the source, before distance attenuation (same shape as a first-person shot layer). */
export type MixLayer = FirstPersonLayer;

export type BlastKind = "frag" | "flash";

export interface BlastSound {
  readonly near: SoundId;
  readonly far: SoundId;
  /** Overall level (linear) at and inside `reference`. */
  readonly level: number;
  readonly reference: number;
  /** Audible range, m (netcode.md §10.2: explosion 300 m; a frag carries farther in this mix). */
  readonly range: number;
  readonly rolloff: number;
  /** Synthesized 70 → 28 Hz pressure thump, relative to `level`. */
  readonly sub: number;
  /** Down-range layer relative to `level`. */
  readonly farGain: number;
  /** Debris and dirt raining back down (spatial one-shots within DEBRIS_RANGE). */
  readonly debris: boolean;
  /** Outdoor echo send at 0 m and at range. */
  readonly echo: readonly [near: number, far: number];
  /** Deepest duck of the other buses, dB, for a blast at `reference` (scaled down with distance). */
  readonly duckDb: number;
}

export const BLAST_SOUNDS: Readonly<Record<BlastKind, BlastSound>> = {
  frag: {
    near: "explosion.near",
    far: "explosion.far",
    // Measured by verify.ts at 4 m: ≈ +4.5 LU over the first-person sniper, peaks under −1 dBTP.
    level: 0.5,
    reference: 8,
    range: 500,
    rolloff: 0.62,
    sub: 0.75,
    farGain: 0.9,
    debris: true,
    echo: [0.5, 1.2],
    duckDb: 16,
  },
  flash: {
    near: "flash.bang",
    far: "explosion.far",
    level: 0.72,
    reference: 6,
    range: 300,
    rolloff: 0.7,
    sub: 0.25,
    farGain: 0.45,
    debris: false,
    echo: [0.45, 1],
    duckDb: 12,
  },
};

/** Debris rain is only heard close to the blast, m. */
export const DEBRIS_RANGE = 45;

/**
 * Detonation layers by listener distance: the close bang (plus a slowed, darkened copy for body) crossfades into the
 * down-range recording, which is pitched down far away; a sub thump carries the pressure wave up close.
 */
export function blastLayers(design: BlastSound, distance: number): MixLayer[] {
  const near = 1 - smoothstep(10, 140, distance);
  const far = Math.max(smoothstep(4, 70, distance), 0.3);
  const farRate = 1 - 0.14 * smoothstep(120, 450, distance);
  const { level } = design;
  const layers: MixLayer[] = [];
  if (near > 0.02) {
    layers.push({ kind: "sample", sound: design.near, delay: 0, gain: level * near, offset: 0, lowpass: null, rate: 1 });
    layers.push({ kind: "sample", sound: design.near, delay: 0.012, gain: level * near * 0.55, offset: 0, lowpass: 700, rate: 0.72 });
  }
  layers.push({ kind: "sample", sound: design.far, delay: 0.02, gain: level * far * design.farGain, offset: 0, lowpass: null, rate: farRate });
  if (design.sub > 0) {
    layers.push({ kind: "sub", delay: 0.004, gain: level * design.sub * (0.35 + 0.65 * near), from: 70, to: 28, sweep: 0.5, decay: 0.22 });
  }
  return layers;
}

export function blastEcho(design: BlastSound, distance: number): number {
  const [nearEcho, farEcho] = design.echo;
  return nearEcho + (farEcho - nearEcho) * smoothstep(0, design.range * 0.6, distance);
}

/** Duck depth (dB) for the other buses: full at the reference distance, gone by 60 % of the range. */
export function blastDuckDb(design: BlastSound, distance: number): number {
  return design.duckDb * (1 - smoothstep(design.reference, design.range * 0.6, distance));
}

// --- Loops -----------------------------------------------------------------------------------------------------------

export const LOOP_RANGE = { smoke: 35, fire: 30 } as const;
/** Loop voices kept at once (nearest first); the rest stay silent until they are among the nearest. */
export const LOOP_VOICES = { smoke: 3, fire: 4 } as const;

/** Smoke canister hiss by cloud age: loud while the canister vents, then gone as the cloud just hangs. */
export function smokeHissLevel(age: number): number {
  return 0.55 * (smoothstep(0, 0.25, age) - smoothstep(9, 16, age));
}

/** Fire crackle by the burning share of a patch (0..1). */
export function fireLevel(burning: number): number {
  return burning <= 0 ? 0 : 0.35 + 0.45 * clamp(burning, 0, 1);
}

// --- Flashbang tinnitus ------------------------------------------------------------------------------------------------

export interface RingMix {
  /** Ringing tone level. */
  readonly tone: number;
  /** Other buses ducked by this much, dB. */
  readonly duckDb: number;
  /** Master low-pass cutoff at the start of the ringing, Hz. */
  readonly lowpass: number;
}

/** Ear ringing for a flash exposure strength (0..1). */
export function flashRing(strength: number): RingMix {
  const s = clamp(strength, 0, 1);
  return { tone: 0.03 + 0.11 * s, duckDb: 6 + 20 * s, lowpass: 5000 * (1 - s) + 350 };
}

// --- Consumables -------------------------------------------------------------------------------------------------------

export type UseCue = "paper" | "tape" | "cloth" | "zip" | "rattle" | "capClick" | "canOpen" | "gulp" | "slosh" | "spray";

/** Foley cues across an item's use time: [fraction of the use time, cue]. Scaled to the real duration at start. */
export const USE_CUES: Readonly<Record<"bandage" | "first_aid" | "medkit" | "energy_drink" | "painkiller", readonly (readonly [number, UseCue])[]>> = {
  bandage: [[0, "cloth"], [0.04, "paper"], [0.16, "paper"], [0.3, "tape"], [0.52, "tape"], [0.72, "tape"], [0.9, "cloth"]],
  first_aid: [[0, "zip"], [0.14, "paper"], [0.26, "cloth"], [0.4, "tape"], [0.56, "paper"], [0.7, "tape"], [0.88, "cloth"]],
  medkit: [[0, "zip"], [0.1, "rattle"], [0.18, "paper"], [0.3, "spray"], [0.42, "tape"], [0.55, "tape"], [0.68, "paper"], [0.8, "cloth"], [0.9, "zip"]],
  energy_drink: [[0, "cloth"], [0.12, "canOpen"], [0.35, "gulp"], [0.5, "gulp"], [0.65, "gulp"], [0.8, "slosh"], [0.92, "cloth"]],
  painkiller: [[0, "cloth"], [0.08, "rattle"], [0.16, "capClick"], [0.26, "rattle"], [0.45, "slosh"], [0.58, "gulp"], [0.7, "gulp"], [0.86, "capClick"]],
};
