import type { ZoneCircle, ZoneState } from "../../match/types";
import type { Vec3 } from "../../movement/types";
import type { MutVec3 } from "../brain/util";

// Zone rotation urgency (design.md §5.2 `rotate`): p = (path time to the safe point + margin) / time until the zone
// edge passes the bot; outside the current circle is always urgent.

/** Planning speed for path-time estimates (walk with some sprint), m/s. */
const ROTATE_SPEED = 6.5;
/** Straight-line → path length fudge. */
const DETOUR = 1.25;
/** Never trust a measured detour below the open-ground default (a bot that has only walked short legs). */
const MIN_DETOUR = DETOUR;
/** Safe point depth inside the target circle, fraction of its radius. */
const SAFE_DEPTH = 0.7;
/** Inside this fraction of the next radius the bot is already safe. */
const SAFE_INSIDE = 0.85;
const SAMPLES = 16;

export interface RotatePlan {
  score: number;
  outside: boolean;
  /** Where to go (xz; y is the bot's feet height). */
  readonly target: MutVec3;
  /** Circle to stay inside while pathing (zone path option), or null. */
  circle: ZoneCircle | null;
}

export function createRotatePlan(): RotatePlan {
  return { score: 0, outside: false, target: { x: 0, y: 0, z: 0 }, circle: null };
}

export function planRotate(zone: ZoneState, feet: Vec3, dt: number, marginSeconds: number, out: RotatePlan, detour = DETOUR): RotatePlan {
  out.score = 0;
  out.outside = false;
  out.circle = null;
  const current = zone.current;
  const dCurrent = horizontal(feet, current.cx, current.cz);
  const next = zone.next;
  const goal = next ?? current;
  const dGoal = horizontal(feet, goal.cx, goal.cz);
  safePoint(feet, goal, dGoal, out.target);
  out.target.y = feet.y;

  if (dCurrent > current.r) {
    out.outside = true;
    out.score = 1;
    out.circle = goal;
    return out;
  }
  if (!next || dGoal <= next.r * SAFE_INSIDE) return out;

  const pathSeconds = (Math.max(0, dGoal - next.r * SAFE_DEPTH) * (detour > MIN_DETOUR ? detour : MIN_DETOUR)) / ROTATE_SPEED;
  const edgeSeconds = secondsUntilEdge(zone, feet, dt);
  const p = (pathSeconds + marginSeconds) / Math.max(0.1, edgeSeconds);
  out.score = 0.9 * (p < 0 ? 0 : p > 1 ? 1 : p);
  out.circle = next;
  return out;
}

/** Seconds until the shrinking circle's edge reaches the bot (the full remaining wait + shrink when it never does). */
export function secondsUntilEdge(zone: ZoneState, feet: Vec3, dt: number): number {
  const phase = zone.phase;
  if (!phase || zone.next === null) return Infinity;
  const shrinkTicks = Math.max(1, phase.shrinkEndTick - phase.shrinkStartTick);
  let wait = 0;
  let f0 = 0;
  if (zone.stage === "waiting") wait = zone.ticksToChange * dt;
  else if (zone.stage === "shrinking") f0 = 1 - zone.ticksToChange / shrinkTicks;
  else return Infinity;
  const from = phase.from;
  const to = phase.to;
  for (let i = 0; i <= SAMPLES; i++) {
    const f = f0 + ((1 - f0) * i) / SAMPLES;
    const cx = from.cx + (to.cx - from.cx) * f;
    const cz = from.cz + (to.cz - from.cz) * f;
    const r = from.r + (to.r - from.r) * f;
    if (horizontal(feet, cx, cz) > r) return wait + (f - f0) * shrinkTicks * dt;
  }
  return wait + (1 - f0) * shrinkTicks * dt;
}

function safePoint(feet: Vec3, circle: ZoneCircle, distance: number, out: MutVec3): void {
  if (distance < 1e-3) {
    out.x = circle.cx;
    out.z = circle.cz;
    return;
  }
  const depth = Math.min(distance, circle.r * SAFE_DEPTH);
  out.x = circle.cx + ((feet.x - circle.cx) / distance) * depth;
  out.z = circle.cz + ((feet.z - circle.cz) / distance) * depth;
}

function horizontal(p: Vec3, x: number, z: number): number {
  const dx = p.x - x;
  const dz = p.z - z;
  return Math.sqrt(dx * dx + dz * dz);
}
