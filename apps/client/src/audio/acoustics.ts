/**
 * Pure acoustic model: distance attenuation, air absorption, gunshot layer weights, speed of sound and bullet
 * fly-by geometry. No WebAudio or Babylon here, so it can be unit-tested headlessly (tools/audio/verify.ts).
 */

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const SPEED_OF_SOUND = 343;

/** Below this linear gain a sound is culled instead of playing (-54 dB). */
export const CULL_GAIN = 0.002;

/**
 * Noise radii (m) used by the mixer. These mirror the server audibility table planned in
 * docs/backend/netcode.md §10.2 and should move to packages/shared/src/audio/audibility.ts with it.
 */
export const AUDIBLE_RANGE = {
  footstepCrouch: 8,
  footstepWalk: 20,
  footstepRun: 30,
  footstepSprint: 40,
  landing: 25,
  reload: 12,
  suppressedShot: 150,
  impact: 80,
  explosion: 300,
  pinPull: 10,
  heal: 12,
  throwableBounce: 35,
  smokePop: 90,
  molotov: 110,
} as const;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(1e-6, gain));
}

/**
 * Inverse-power falloff beyond `reference` (exponent 1 = physical inverse distance), faded to silence over the last
 * 25 % of `range` so nothing pops out at the culling edge. Exponents below 1 keep loud events (gunshots) audible
 * at long range, compensating for the limited dynamic range of a game mix.
 */
export function distanceGain(d: number, reference: number, range: number, exponent = 1): number {
  if (d >= range) return 0;
  const falloff = (reference / Math.max(d, reference)) ** exponent;
  const edge = 1 - smoothstep(range * 0.75, range, d);
  return falloff * edge;
}

/** Low-pass cutoff (Hz) approximating air absorption: ~5 kHz at 100 m, ~1.6 kHz at 400 m, ~900 Hz at 800 m. */
export function airAbsorptionCutoff(d: number): number {
  return clamp(20_000 / (1 + d / 28), 700, 20_000);
}

export interface GunshotLayers {
  /** Close recording (crack, body, mechanism). */
  readonly near: number;
  /** Down-range recording (boom and natural tail). */
  readonly far: number;
  /** Extra send into the outdoor echo, 0..1: distant shots are mostly reflections. */
  readonly echo: number;
  /** Playback rate for the far layer; very distant reports sound lower and duller. */
  readonly farRate: number;
}

/** Crossfade between the near and far recordings by distance. */
export function gunshotLayers(d: number): GunshotLayers {
  const near = 1 - smoothstep(6, 70, d);
  const far = smoothstep(3, 45, d);
  return {
    near,
    far: Math.max(far, 0.2),
    echo: clamp(0.2 + d / 350, 0.2, 0.9),
    farRate: 1 - 0.12 * smoothstep(150, 700, d),
  };
}

/** Seconds until sound emitted `age` seconds ago at distance `d` reaches the listener. */
export function arrivalDelay(d: number, age = 0): number {
  return Math.max(0, d / SPEED_OF_SOUND - age);
}

export interface ClosestApproach {
  /** Distance from the listener to the segment's closest point, m. */
  readonly distance: number;
  /** 0..1 along the segment. */
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Closest point of segment a→b to point p. */
export function closestApproach(ax: number, ay: number, az: number, bx: number, by: number, bz: number, p: Vec3Like): ClosestApproach {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  const t = lengthSq > 0 ? clamp(((p.x - ax) * dx + (p.y - ay) * dy + (p.z - az) * dz) / lengthSq, 0, 1) : 0;
  const x = ax + dx * t;
  const y = ay + dy * t;
  const z = az + dz * t;
  return { distance: Math.hypot(p.x - x, p.y - y, p.z - z), t, x, y, z };
}

/** A bullet cracks (sonic boom) above the speed of sound and whizzes below it. */
export function isSupersonic(speed: number): boolean {
  return speed > SPEED_OF_SOUND;
}

/** Footstep spacing (m per footfall) by horizontal speed: ~2.4 steps/s crouching, ~3 running, ~3.3 sprinting. */
export function strideLength(speed: number): number {
  return clamp(0.55 + 0.25 * speed, 0.7, 3);
}

// --- Enclosed space: how big is the room you are standing in ---------------------------------------------------------

/**
 * Sizes at which a space stops being a corridor, m. Everything below reads these off rays the probe casts around the
 * listener (AudioWorldProbe.space), so a map that changes its corridor widths changes the reverb with no constants to
 * follow. A map with nothing within reach (Map v1, the real-world maps) measures `reach` in every direction, which
 * lands on `closeness` 0 / `openness` 1 — the open-field mix this file described before any of this existed.
 */
export const SPACE = {
  /** How far the space rays look, m. Beyond this a direction counts as open sky. */
  reach: 28,
  /** Span across the narrowest axis at which a space stops ringing like a corridor: 4 m squeeze … 18 m room. */
  tight: 4,
  loose: 18,
  /**
   * Mean free path over which the open-field slapback fades back in. `open` sits under `reach` on purpose: open ground
   * can only ever measure `reach` in every direction, and it has to land on fully open, not on nearly.
   */
  enclosed: 8,
  open: 24,
} as const;

/** What the listener's surroundings measure, m: both are spans through the listener, not distances to one wall. */
export interface SpaceMeasure {
  /** Narrowest span through the listener across any sampled axis — a corridor's width. */
  readonly width: number;
  /** Mean distance to whatever is around, all directions: how much room there is in total. */
  readonly meanFreePath: number;
}

/** Reverb the engine builds from a measured space (AudioEngine.setRoom). */
export interface RoomAcoustics {
  /** Room convolver return, 0..1. */
  readonly room: number;
  /** Open-field slapback / valley echo return, 0..1. */
  readonly echo: number;
  /** Level of the corridor flutter tap, 0..1: the ring of two close parallel walls. */
  readonly flutter: number;
  /** Flutter round trip, s: sound crossing the corridor and coming back. */
  readonly flutterSeconds: number;
  readonly flutterFeedback: number;
  /** Room low-pass, Hz. Hard close walls keep their highs; a big space eats them. */
  readonly tone: number;
  /** How much a sound couples into the room at all, 0..1 (the per-voice `room` send scale). */
  readonly send: number;
}

/** Strongest flutter feedback, at `SPACE.tight`. Above ~0.6 the tap rings on past the sound that fed it. */
const FLUTTER_FEEDBACK = 0.5;

/**
 * Reverb from geometry: a tight corridor rings, a plaza opens out, and a roof over your head still puts you indoors.
 *
 * `indoor` is the enclosure probe's roof estimate and only ever adds — an open-topped 4 m corridor (the maze) reads
 * `indoor` 0 and must still ring, and a room with a ceiling must still sound like a room in the middle of a hall. The
 * numbers are spans, so nothing here knows what a maze is: on a map with no walls within reach every term collapses to
 * the open-field mix (room = indoor, echo = the old `1 - indoor * 0.85`, flutter silent, tone 5000 Hz).
 */
export function roomFromSpace(space: SpaceMeasure, indoor: number): RoomAcoustics {
  const closeness = 1 - smoothstep(SPACE.tight, SPACE.loose, space.width);
  const openness = smoothstep(SPACE.enclosed, SPACE.open, space.meanFreePath);
  return {
    room: clamp(Math.max(indoor, closeness * 0.8), 0, 1),
    echo: (1 - indoor * 0.85) * (0.3 + 0.7 * openness),
    flutter: 0.9 * closeness,
    // One bounce across the corridor and back: 4 m → 23 ms (a metallic ring), 12 m → 70 ms (a distinct slap).
    flutterSeconds: clamp((2 * space.width) / SPEED_OF_SOUND, 0.008, 0.09),
    flutterFeedback: FLUTTER_FEEDBACK * closeness,
    tone: 5000 + 1800 * closeness,
    send: clamp(Math.max(indoor, closeness), 0, 1),
  };
}
