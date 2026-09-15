import { SIMULATION } from "../constants";
import { hash32 } from "../equipment/math";
import type { ZoneCircle, ZonePhase, ZoneSpec, ZoneStage, ZoneState } from "./types";

// Shrinking zone (docs/bots/design.md §8.2): a pure schedule of phases and `zoneAt(tick)`. The rules, HUD, bots and the
// future networked client compute the same circle from the announced phases. No engine imports, no Math.random.

/** Playable half extent the zone centers are clamped to, m (Map v1: 1 km square). */
export const ZONE_PLAYABLE_HALF_EXTENT = 500;

/** Map v1 zone tuning (design.md §8.2 table, sped up 2026-09-15). The circle closes at 6:55 of combat. */
export const DEFAULT_ZONE_SPEC: ZoneSpec = {
  initial: { cx: 0, cz: 0, r: 710 },
  phases: [
    { waitSeconds: 70, shrinkSeconds: 40, radius: 400, dps: 1 },
    { waitSeconds: 35, shrinkSeconds: 30, radius: 250, dps: 2 },
    { waitSeconds: 30, shrinkSeconds: 25, radius: 150, dps: 3 },
    { waitSeconds: 25, shrinkSeconds: 20, radius: 90, dps: 5 },
    { waitSeconds: 20, shrinkSeconds: 20, radius: 45, dps: 8 },
    { waitSeconds: 20, shrinkSeconds: 15, radius: 20, dps: 12 },
    { waitSeconds: 20, shrinkSeconds: 15, radius: 0, dps: 20 },
  ],
  firstAnnounceSeconds: 30,
  damageIntervalTicks: 6,
  edgeMargin: 40,
};

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
  const bound = Math.max(0, ZONE_PLAYABLE_HALF_EXTENT - spec.edgeMargin - 0.5 * toR);
  // The previous center already satisfies the (looser) bound of a smaller circle, so it is always a valid fallback.
  let cx = clampAbs(from.cx, bound);
  let cz = clampAbs(from.cz, bound);
  const minX = Math.max(-bound, from.cx - reach);
  const maxX = Math.min(bound, from.cx + reach);
  const minZ = Math.max(-bound, from.cz - reach);
  const maxZ = Math.min(bound, from.cz + reach);
  if (reach > 0 && minX <= maxX && minZ <= maxZ) {
    for (let attempt = 0; attempt < CENTER_TRIES; attempt++) {
      const h = hash32(seed, index, attempt);
      const u = (h & 0xffff) / 0x10000;
      const v = (h >>> 16) / 0x10000;
      const x = minX + (maxX - minX) * u;
      const z = minZ + (maxZ - minZ) * v;
      const dx = x - from.cx;
      const dz = z - from.cz;
      if (dx * dx + dz * dz > reach * reach) continue;
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
