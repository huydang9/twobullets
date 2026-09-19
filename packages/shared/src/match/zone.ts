import { SIMULATION } from "../constants";
import { hash32 } from "../equipment/math";
import type { PointOfInterest } from "../map/types";
import type { ZoneCenterBias, ZoneCircle, ZonePhase, ZonePhaseSpec, ZoneSpec, ZoneStage, ZoneState } from "./types";

// Shrinking zone (docs/bots/design.md §8.2): a pure schedule of phases and `zoneAt(tick)`. The rules, HUD, bots and the
// future networked client compute the same circle from the announced phases. No engine imports, no Math.random.

/** Playable half extent `DEFAULT_ZONE_SPEC` is tuned for, m (Map v1 and the real maps are a 500 m square). */
export const ZONE_PLAYABLE_HALF_EXTENT = 250;

/**
 * Zone tuning (design.md §8.2 table, sped up 2026-09-15). The circle closes at 6:55 of combat.
 *
 * Every radius halved with the map on 2026-09-16: the initial circle still covers the playable square
 * (250·√2 ≈ 354) and the pacing in time is unchanged. A smaller map takes `zoneSpecForHalfExtent`, which
 * scales the radii the same way.
 */
export const DEFAULT_ZONE_SPEC: ZoneSpec = {
  initial: { cx: 0, cz: 0, r: 355 },
  phases: [
    { waitSeconds: 70, shrinkSeconds: 40, radius: 200, dps: 1 },
    { waitSeconds: 35, shrinkSeconds: 30, radius: 125, dps: 2 },
    { waitSeconds: 30, shrinkSeconds: 25, radius: 75, dps: 3 },
    { waitSeconds: 25, shrinkSeconds: 20, radius: 45, dps: 5 },
    { waitSeconds: 20, shrinkSeconds: 20, radius: 25, dps: 8 },
    { waitSeconds: 20, shrinkSeconds: 15, radius: 12, dps: 12 },
    { waitSeconds: 20, shrinkSeconds: 15, radius: 0, dps: 20 },
  ],
  firstAnnounceSeconds: 30,
  damageIntervalTicks: 6,
  edgeMargin: 20,
};

/** The playable half extent `spec` is tuned for, m (`ZONE_PLAYABLE_HALF_EXTENT` when the spec doesn't say). */
export function zonePlayableHalfExtent(spec: ZoneSpec): number {
  return spec.playableHalfExtent ?? ZONE_PLAYABLE_HALF_EXTENT;
}

/**
 * Defaults for `ZoneCenterBias`: the pull ramps over the trailing 5 of the 7 phases up to 0.8 of the way to the
 * target. The ramp makes the first two of those a nudge (0.16, 0.32) and the endgame a real pull, measured on the maze
 * at ±96 m with its nav check, the last circle with a real radius overlaps the plaza 75 % of the time instead of 34 %,
 * and its center still varies by ±24 m (a quarter of the half extent) across seeds, so matches don't all end in the
 * same corner. The thresholds are ratios, not metres, so a resized map keeps them.
 */
export const ZONE_CENTER_BIAS = { phases: 5, strength: 0.8 } as const;

/** Options `zoneSpecForHalfExtent` shapes a scaled-down spec with. All of them are inert at the base spec's own size. */
export interface ZoneScaleOptions {
  /**
   * Smallest radius a circle may shrink to, m (the terminal 0-radius circle is exempt). Default: the smallest non-zero
   * radius `base` itself uses — i.e. a small map never plays an endgame circle tighter than the one Map v1 ships.
   */
  readonly minRadius?: number;
  /**
   * Smallest radius drop between consecutive circles once the floor bites, m (default `minRadius / 2`). Containment
   * caps a center's move at `from.r − to.r`, so without this the floored phases would freeze the circle in place.
   */
  readonly minShrink?: number;
  /** Late-phase center pull (`zoneCenterBiasForPois`); omitted keeps `base`'s, null clears it. */
  readonly centerBias?: ZoneCenterBias | null;
}

/** Smallest non-zero phase radius of a spec, m (0 when every phase closes to a point). */
function smallestPhaseRadius(spec: ZoneSpec): number {
  let min = 0;
  for (const phase of spec.phases) if (phase.radius > 0 && (min === 0 || phase.radius < min)) min = phase.radius;
  return min;
}

/**
 * `base` scaled to a map whose playable square is ±`halfExtent` m: every radius (the initial circle included) and the
 * edge margin scale with the map; timings, dps and the phase count don't (that is the 2026-09-16 halving, generalized).
 * The initial circle keeps its 1.42 × half extent, so it still covers the square (√2 ≈ 1.4142).
 *
 * On a small map pure proportional scaling shrinks the endgame below one room (the maze at ±96 m: 9.6 m and 4.61 m,
 * a fraction of one corridor lane), so the scaled radii are then floored at `minRadius` and spread apart by
 * `minShrink`, and `centerBias` pulls the last circles toward the map's hottest POI. All three are part of the
 * scaling: a spec asked for its own half extent is returned as-is.
 *
 * Returns `base` itself at its own half extent, so Map v1, the real-world maps and every hand-written spec (arena) come
 * out untouched — options or not.
 */
export function zoneSpecForHalfExtent(halfExtent: number, base: ZoneSpec = DEFAULT_ZONE_SPEC, options: ZoneScaleOptions = {}): ZoneSpec {
  if (!(halfExtent > 0)) throw new Error(`zone half extent must be positive (got ${halfExtent})`);
  const scale = halfExtent / zonePlayableHalfExtent(base);
  if (scale === 1) return base;
  const initialR = round2(base.initial.r * scale);
  const minRadius = Math.max(0, options.minRadius ?? smallestPhaseRadius(base));
  const minShrink = Math.max(0, options.minShrink ?? minRadius / 2);
  const phases: ZonePhaseSpec[] = base.phases.map((phase) => ({ ...phase, radius: round2(phase.radius * scale) }));
  // Back to front: lift anything under the floor, then keep every step at least `minShrink` wide so centers can move.
  for (let i = phases.length - 1; i >= 0; i--) {
    const phase = phases[i]!;
    if (phase.radius <= 0) continue; // the terminal close stays a point, as it is on the tuned map
    const next = phases[i + 1];
    const floor = Math.max(minRadius, next && next.radius > 0 ? next.radius + minShrink : minRadius);
    if (phase.radius < floor) phases[i] = { ...phase, radius: round2(floor) };
  }
  // A map small enough for the floors to outgrow the map itself still gets a monotone schedule inside the first circle.
  let ceiling = initialR;
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]!;
    if (phase.radius > ceiling) phases[i] = { ...phase, radius: ceiling };
    else ceiling = phase.radius;
  }
  const bias = options.centerBias === undefined ? base.lateCenterBias : (options.centerBias ?? undefined);
  const { lateCenterBias: _dropped, ...rest } = base; // re-added below, so `centerBias: null` really clears it
  return {
    ...rest,
    initial: { cx: round2(base.initial.cx * scale), cz: round2(base.initial.cz * scale), r: initialR },
    phases,
    edgeMargin: round2(base.edgeMargin * scale),
    playableHalfExtent: halfExtent,
    ...(bias ? { lateCenterBias: bias } : {}),
  };
}

/**
 * The center pull for a map's POIs: its highest-tier POI (ties: the bigger one, then the lower id — no `Math.random`,
 * no map-file coupling). On Map v1 that is a hot drop; on the maze it is the tower plaza. Training ranges are skipped.
 * Returns null when the map has no POI to aim at.
 */
export function zoneCenterBiasForPois(pois: readonly PointOfInterest[], options: Omit<ZoneCenterBias, "x" | "z"> = {}): ZoneCenterBias | null {
  let best: PointOfInterest | null = null;
  for (const poi of pois) {
    if (poi.kind === "training") continue;
    if (best === null || poi.lootTier > best.lootTier || (poi.lootTier === best.lootTier && (poi.radius > best.radius || (poi.radius === best.radius && poi.id < best.id)))) best = poi;
  }
  if (best === null) return null;
  return { x: best.center[0], z: best.center[1], ...options };
}

/** Seconds before a shrink at which `zoneWarning` events fire. */
export const ZONE_WARNING_SECONDS: readonly number[] = [30, 10];

/** Tries before a phase keeps the previous center (design.md §8.2). */
const CENTER_TRIES = 16;

/** Injected center check (nav: walkable and in the main component). */
export type ZoneCenterCheck = (x: number, z: number) => boolean;

/** Seconds (scaled) → whole ticks. */
export function secondsToTicks(seconds: number, timeScale = 1): number {
  return Math.round(seconds * timeScale * SIMULATION.tickRate);
}

/** Combat seconds (unscaled) at which the last circle finishes closing: announce delay plus every wait and shrink. */
export function zoneCloseSeconds(spec: ZoneSpec): number {
  let total = spec.firstAnnounceSeconds;
  for (const phase of spec.phases) total += phase.waitSeconds + phase.shrinkSeconds;
  return total;
}

/**
 * Phase `index` (1-based), announced when the previous phase's shrink ends (phase 1: `firstAnnounceSeconds` into
 * combat). The center is seeded by `hash32(seed, index, try)`: inside `from.r − to.r` of the previous center (so the
 * next circle is contained in the current one) and inside ±(half − edgeMargin − to.r / 2) of the origin. A center the
 * check rejects is re-rolled up to 16 times, then the previous center is kept.
 *
 * With `spec.lateCenterBias`, the last phases lerp that seeded sample toward the bias point (clamped into the same
 * reach disc and square, both convex, so a biased center is contained exactly like an unbiased one). The pull ramps up
 * over the trailing phases and is 0 before them, so early circles stay as varied as they ever were.
 */
export function computeZonePhase(
  spec: ZoneSpec,
  seed: number,
  index: number,
  previous: ZonePhase | null,
  combatStartTick: number,
  timeScale = 1,
  isValidCenter: ZoneCenterCheck | null = null,
): ZonePhase {
  const row = spec.phases[index - 1];
  if (!row) throw new Error(`zone phase ${index} is not in the spec (${spec.phases.length} phases)`);
  const from: ZoneCircle = previous ? previous.to : spec.initial;
  const waitStartTick = previous ? previous.shrinkEndTick : combatStartTick + secondsToTicks(spec.firstAnnounceSeconds, timeScale);
  const shrinkStartTick = waitStartTick + secondsToTicks(row.waitSeconds, timeScale);
  const shrinkEndTick = shrinkStartTick + secondsToTicks(row.shrinkSeconds, timeScale);

  const toR = row.radius;
  const reach = Math.max(0, from.r - toR);
  const bound = Math.max(0, zonePlayableHalfExtent(spec) - spec.edgeMargin - 0.5 * toR);
  // The previous center already satisfies the (looser) bound of a smaller circle, so it is always a valid fallback.
  let cx = clampAbs(from.cx, bound);
  let cz = clampAbs(from.cz, bound);
  const minX = Math.max(-bound, from.cx - reach);
  const maxX = Math.min(bound, from.cx + reach);
  const minZ = Math.max(-bound, from.cz - reach);
  const maxZ = Math.min(bound, from.cz + reach);
  const pull = centerBiasWeight(spec, index);
  // The bias point as far as this circle can actually reach it: clamped into the square, then onto the reach disc.
  let ax = 0;
  let az = 0;
  if (pull > 0) {
    const bias = spec.lateCenterBias!;
    ax = clampAbs(bias.x, bound);
    az = clampAbs(bias.z, bound);
    const bdx = ax - from.cx;
    const bdz = az - from.cz;
    const d2 = bdx * bdx + bdz * bdz;
    if (d2 > reach * reach) {
      const k = reach / Math.sqrt(d2);
      ax = from.cx + bdx * k;
      az = from.cz + bdz * k;
    }
  }
  if (reach > 0 && minX <= maxX && minZ <= maxZ) {
    for (let attempt = 0; attempt < CENTER_TRIES; attempt++) {
      const h = hash32(seed, index, attempt);
      const u = (h & 0xffff) / 0x10000;
      const v = (h >>> 16) / 0x10000;
      let x = minX + (maxX - minX) * u;
      let z = minZ + (maxZ - minZ) * v;
      const dx = x - from.cx;
      const dz = z - from.cz;
      if (dx * dx + dz * dz > reach * reach) continue;
      if (pull > 0) {
        x += (ax - x) * pull;
        z += (az - z) * pull;
      }
      if (isValidCenter && !isValidCenter(x, z)) continue;
      cx = round2(x);
      cz = round2(z);
      // Rounding must not push the circle outside the previous one.
      const rdx = cx - from.cx;
      const rdz = cz - from.cz;
      if (rdx * rdx + rdz * rdz > reach * reach) {
        cx = x;
        cz = z;
      }
      break;
    }
  }
  return { index, waitStartTick, shrinkStartTick, shrinkEndTick, from, to: { cx, cz, r: toR }, dps: row.dps };
}

/**
 * How hard phase `index` is pulled toward `spec.lateCenterBias`, 0..1. 0 outside the trailing `phases` window, then a
 * linear ramp to `strength` on the last phase, so only the endgame is shaped.
 */
function centerBiasWeight(spec: ZoneSpec, index: number): number {
  const bias = spec.lateCenterBias;
  if (!bias) return 0;
  const window = Math.max(1, Math.round(bias.phases ?? ZONE_CENTER_BIAS.phases));
  const first = spec.phases.length - window + 1;
  if (index < first) return 0;
  const strength = Math.min(1, Math.max(0, bias.strength ?? ZONE_CENTER_BIAS.strength));
  return (strength * (index - first + 1)) / window;
}

/** Every phase of the spec at once (tests, tooling and replays; a live match announces them one by one). */
export function scheduleZonePhases(spec: ZoneSpec, seed: number, combatStartTick: number, timeScale = 1, isValidCenter: ZoneCenterCheck | null = null): ZonePhase[] {
  const phases: ZonePhase[] = [];
  let previous: ZonePhase | null = null;
  for (let index = 1; index <= spec.phases.length; index++) {
    previous = computeZonePhase(spec, seed, index, previous, combatStartTick, timeScale, isValidCenter);
    phases.push(previous);
  }
  return phases;
}

/** Writable ZoneState for callers that update one object in place every tick. */
export type MutableZoneState = { -readonly [K in keyof ZoneState]: ZoneState[K] };
type MutableCircle = { -readonly [K in keyof ZoneCircle]: ZoneCircle[K] };

export function createZoneState(spec: ZoneSpec): MutableZoneState {
  return { phaseIndex: 0, stage: "idle", current: { cx: spec.initial.cx, cz: spec.initial.cz, r: spec.initial.r }, next: null, dps: 0, ticksToChange: 0, phase: null };
}

/**
 * The zone at `tick` from the announced phases (in index order). `out.current` is written in place (keep it a private
 * object); `out.next` and `out.phase` reference the phase data. Allocation-free.
 * - before phase 1: stage `idle`, the initial circle, no damage
 * - announced → shrink: `waiting` on the previous circle with the phase's dps, `next` = the phase's circle
 * - shrinking: lerp from → to
 * - after the last announced shrink: `closed` when it was the spec's last phase, else `waiting` for the next announcement
 */
export function zoneAtInto(spec: ZoneSpec, phases: readonly ZonePhase[], tick: number, out: MutableZoneState): MutableZoneState {
  const current = out.current as MutableCircle;
  let active: ZonePhase | null = null;
  for (let i = phases.length - 1; i >= 0; i--) {
    const phase = phases[i]!;
    if (tick >= phase.waitStartTick) {
      active = phase;
      break;
    }
  }
  if (!active) {
    setCircle(current, spec.initial);
    const first = phases[0];
    out.phaseIndex = 0;
    out.stage = "idle";
    out.next = null;
    out.dps = 0;
    out.ticksToChange = first ? Math.max(0, first.waitStartTick - tick) : 0;
    out.phase = null;
    return out;
  }

  out.phaseIndex = active.index;
  out.phase = active;
  out.dps = active.dps;
  let stage: ZoneStage;
  if (tick < active.shrinkStartTick) {
    stage = "waiting";
    setCircle(current, active.from);
    out.next = active.to;
    out.ticksToChange = active.shrinkStartTick - tick;
  } else if (tick < active.shrinkEndTick) {
    stage = "shrinking";
    const t = (tick - active.shrinkStartTick) / (active.shrinkEndTick - active.shrinkStartTick);
    current.cx = active.from.cx + (active.to.cx - active.from.cx) * t;
    current.cz = active.from.cz + (active.to.cz - active.from.cz) * t;
    current.r = active.from.r + (active.to.r - active.from.r) * t;
    out.next = active.to;
    out.ticksToChange = active.shrinkEndTick - tick;
  } else {
    setCircle(current, active.to);
    out.next = null;
    stage = active.index >= spec.phases.length ? "closed" : "waiting";
    out.ticksToChange = 0;
  }
  out.stage = stage;
  return out;
}

/** Allocating convenience wrapper of `zoneAtInto`. */
export function zoneAt(spec: ZoneSpec, phases: readonly ZonePhase[], tick: number): ZoneState {
  return zoneAtInto(spec, phases, tick, createZoneState(spec));
}

/** Horizontal distance outside the circle, m (≤ 0 inside). */
export function distanceOutsideZone(circle: ZoneCircle, x: number, z: number): number {
  const dx = x - circle.cx;
  const dz = z - circle.cz;
  return Math.sqrt(dx * dx + dz * dz) - circle.r;
}

export function isOutsideZone(circle: ZoneCircle, x: number, z: number): boolean {
  const dx = x - circle.cx;
  const dz = z - circle.cz;
  return dx * dx + dz * dz > circle.r * circle.r;
}

/** Damage per zone tick for a phase's dps (applied every `damageIntervalTicks`). */
export function zoneTickDamage(spec: ZoneSpec, dps: number): number {
  return Math.round(dps * (spec.damageIntervalTicks / SIMULATION.tickRate) * 1000) / 1000;
}

function setCircle(out: MutableCircle, circle: ZoneCircle): void {
  out.cx = circle.cx;
  out.cz = circle.cz;
  out.r = circle.r;
}

function clampAbs(value: number, bound: number): number {
  return value < -bound ? -bound : value > bound ? bound : value;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
