import {
  poseHitboxes,
  RIG_BUFFER_LENGTH,
  segmentNearRig,
  segmentVsRigInto,
  type HitPose,
  type MutableRigHit,
} from "@twobullets/shared/hitreg/rig";

// Hitbox pose history for shooter-time rewind (netcode.md §5.2–5.3, ADR 0205). The server records every player's
// replicated pose each tick; a bullet fired with view delay D is tested at server tick T + k against poses sampled at
// T + k − D, with D clamped to MAX_REWIND. Samples between ticks interpolate (shortest-arc yaw). Posed rigs are cached
// per (target, sample tick) because all of a shooter's bullets share D. Typed arrays, no allocation after construction.

/** netcode.md §5.2 / architecture.md D7. */
export const MAX_REWIND_MS = 200;
export const MAX_REWIND_TICKS = 12;
/** Ring depth: 533 ms, so MAX_REWIND can be tuned without resizing. */
export const LAG_COMP_HISTORY_TICKS = 32;
/** Claimed D may differ from the server's expectation by at most this (ticks) before it is clamped. */
export const VIEW_DELAY_SLACK_TICKS = 2;

const STRIDE = 6; // x, y, z, yaw, pitch, stanceBlend
const FLAG_VALID = 1;
/** The pose teleported since the previous tick (spawn, revive placement): never interpolate into it. */
const FLAG_DISCONTINUOUS = 2;
const TAU = Math.PI * 2;

export interface LagCompHistoryOptions {
  /** Player slots. Default 16. */
  readonly maxSlots?: number;
  /** Ring depth in ticks, a power of two ≥ maxRewindTicks + 2. Default 32. */
  readonly historyTicks?: number;
  readonly maxRewindTicks?: number;
  /** Posed rigs cached per slot. Default 4. */
  readonly cacheEntries?: number;
}

export interface LagCompStats {
  /** Rewinds whose D exceeded maxRewindTicks (or was negative). */
  rewindClamps: number;
  poseEvals: number;
  cacheHits: number;
}

export class LagCompHistory {
  readonly maxSlots: number;
  readonly historyTicks: number;
  readonly maxRewindTicks: number;
  readonly stats: LagCompStats = { rewindClamps: 0, poseEvals: 0, cacheHits: 0 };

  private readonly mask: number;
  private readonly poses: Float64Array;
  private readonly ticks: Float64Array;
  private readonly flags: Uint8Array;
  private readonly cacheEntries: number;
  private readonly cacheTick: Float64Array;
  private readonly cacheViews: Float64Array[] = [];
  private readonly cacheNext: Uint8Array;
  private readonly scratchA: HitPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, stanceBlend: 0 };

  constructor(options: LagCompHistoryOptions = {}) {
    const slots = options.maxSlots ?? 16;
    const ticks = options.historyTicks ?? LAG_COMP_HISTORY_TICKS;
    const maxRewind = options.maxRewindTicks ?? MAX_REWIND_TICKS;
    if ((ticks & (ticks - 1)) !== 0 || ticks < maxRewind + 2) throw new RangeError("historyTicks must be a power of two ≥ maxRewindTicks + 2");
    this.maxSlots = slots;
    this.historyTicks = ticks;
    this.maxRewindTicks = maxRewind;
    this.mask = ticks - 1;
    this.poses = new Float64Array(slots * ticks * STRIDE);
    this.ticks = new Float64Array(slots * ticks).fill(-1);
    this.flags = new Uint8Array(slots * ticks);
    this.cacheEntries = options.cacheEntries ?? 4;
    this.cacheTick = new Float64Array(slots * this.cacheEntries).fill(NaN);
    this.cacheNext = new Uint8Array(slots);
    const cache = new Float64Array(slots * this.cacheEntries * RIG_BUFFER_LENGTH);
    for (let i = 0; i < slots * this.cacheEntries; i++) this.cacheViews.push(cache.subarray(i * RIG_BUFFER_LENGTH, (i + 1) * RIG_BUFFER_LENGTH));
  }

  /**
   * Records `slot`'s pose at server tick `tick` (after the tick's movement). `continuous = false` marks a teleport, so
   * samples between the previous tick and this one snap instead of sweeping. Re-recording a tick overwrites it.
   */
  record(tick: number, slot: number, pose: Readonly<HitPose>, continuous = true): void {
    const i = slot * this.historyTicks + (tick & this.mask);
    const o = i * STRIDE;
    const p = this.poses;
    p[o] = pose.x;
    p[o + 1] = pose.y;
    p[o + 2] = pose.z;
    p[o + 3] = pose.yaw;
    p[o + 4] = pose.pitch;
    p[o + 5] = pose.stanceBlend;
    this.ticks[i] = tick;
    this.flags[i] = continuous ? FLAG_VALID : FLAG_VALID | FLAG_DISCONTINUOUS;
    this.invalidateCache(slot);
  }

  /** The slot left or its character was removed: no rewind hits against any recorded tick. */
  clear(slot: number): void {
    const from = slot * this.historyTicks;
    this.ticks.fill(-1, from, from + this.historyTicks);
    this.flags.fill(0, from, from + this.historyTicks);
    this.invalidateCache(slot);
  }

  /** True when an exact pose for `tick` is stored. */
  has(slot: number, tick: number): boolean {
    const i = slot * this.historyTicks + (tick & this.mask);
    return this.ticks[i] === tick && (this.flags[i]! & FLAG_VALID) !== 0;
  }

  /** D (fractional ticks) clamped to [0, maxRewindTicks]; counts clamps. */
  clampRewind(viewDelayTicks: number): number {
    if (viewDelayTicks > this.maxRewindTicks) {
      this.stats.rewindClamps++;
      return this.maxRewindTicks;
    }
    if (!(viewDelayTicks >= 0)) {
      this.stats.rewindClamps++;
      return 0;
    }
    return viewDelayTicks;
  }

  /** Sample tick for a segment tested at `presentTick` by a shooter with view delay D. */
  rewindTick(presentTick: number, viewDelayTicks: number): number {
    return presentTick - this.clampRewind(viewDelayTicks);
  }

  /**
   * Pose at fractional tick `t`: exact at integer ticks, interpolated between (shortest-arc yaw), snapped to the nearer
   * tick across a teleport. False when a needed tick isn't stored.
   */
  sample(slot: number, t: number, out: HitPose): boolean {
    const t0 = Math.floor(t);
    const frac = t - t0;
    const i0 = slot * this.historyTicks + (t0 & this.mask);
    if (this.ticks[i0] !== t0 || (this.flags[i0]! & FLAG_VALID) === 0) return false;
    if (frac === 0) {
      this.readPose(i0, out);
      return true;
    }
    const t1 = t0 + 1;
    const i1 = slot * this.historyTicks + (t1 & this.mask);
    if (this.ticks[i1] !== t1 || (this.flags[i1]! & FLAG_VALID) === 0) return false;
    if ((this.flags[i1]! & FLAG_DISCONTINUOUS) !== 0) {
      this.readPose(frac < 0.5 ? i0 : i1, out);
      return true;
    }
    const p = this.poses;
    const a = i0 * STRIDE;
    const b = i1 * STRIDE;
    out.x = p[a]! + (p[b]! - p[a]!) * frac;
    out.y = p[a + 1]! + (p[b + 1]! - p[a + 1]!) * frac;
    out.z = p[a + 2]! + (p[b + 2]! - p[a + 2]!) * frac;
    let dYaw = (p[b + 3]! - p[a + 3]!) % TAU;
    if (dYaw > Math.PI) dYaw -= TAU;
    else if (dYaw < -Math.PI) dYaw += TAU;
    out.yaw = p[a + 3]! + dYaw * frac;
    out.pitch = p[a + 4]! + (p[b + 4]! - p[a + 4]!) * frac;
    out.stanceBlend = p[a + 5]! + (p[b + 5]! - p[a + 5]!) * frac;
    return true;
  }

  /**
   * The posed rig (`poseHitboxes` layout) of `slot` at fractional tick `t`, cached until the slot's next `record`.
   * The buffer is owned by the cache: read it before posing more than `cacheEntries` other ticks of this slot.
   */
  posedRig(slot: number, t: number): Float64Array | null {
    const base = slot * this.cacheEntries;
    for (let k = 0; k < this.cacheEntries; k++) {
      if (this.cacheTick[base + k] === t) {
        this.stats.cacheHits++;
        return this.cacheViews[base + k]!;
      }
    }
    const pose = this.scratchA;
    if (!this.sample(slot, t, pose)) return null;
    const k = this.cacheNext[slot]!;
    this.cacheNext[slot] = (k + 1) % this.cacheEntries;
    const view = this.cacheViews[base + k]!;
    poseHitboxes(pose, view);
    this.cacheTick[base + k] = t;
    this.stats.poseEvals++;
    return view;
  }

  /**
   * Nearest hit of segment a→b with `slot`'s rig at fractional tick `t` (bounding-sphere broadphase, then the posed rig).
   * Writes `out` and returns true on a hit.
   */
  segmentVsRig(slot: number, t: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: MutableRigHit): boolean {
    const pose = this.scratchA;
    if (!this.sample(slot, t, pose)) return false;
    if (!segmentNearRig(pose.x, pose.y, pose.z, ax, ay, az, bx, by, bz)) return false;
    const rig = this.posedRig(slot, t);
    return rig !== null && segmentVsRigInto(rig, ax, ay, az, bx, by, bz, out);
  }

  private readPose(i: number, out: HitPose): void {
    const p = this.poses;
    const o = i * STRIDE;
    out.x = p[o]!;
    out.y = p[o + 1]!;
    out.z = p[o + 2]!;
    out.yaw = p[o + 3]!;
    out.pitch = p[o + 4]!;
    out.stanceBlend = p[o + 5]!;
  }

  private invalidateCache(slot: number): void {
    const base = slot * this.cacheEntries;
    for (let k = 0; k < this.cacheEntries; k++) this.cacheTick[base + k] = NaN;
  }
}

/**
 * Server-side D for a shot (netcode.md §5.2): the client's claim (`viewOffset8 / 8` ticks) clamped to the expectation
 * ± VIEW_DELAY_SLACK_TICKS, where expected = (RTT_ewma + inputBufferMs + clampedInterpDelayMs) / tick ms, then to
 * [0, maxRewindTicks]. Compare the result with the claim to count clamps (backtrack telemetry).
 */
export function clampViewDelayTicks(claimedTicks: number, expectedTicks: number, maxRewindTicks = MAX_REWIND_TICKS): number {
  const lo = expectedTicks - VIEW_DELAY_SLACK_TICKS;
  const hi = expectedTicks + VIEW_DELAY_SLACK_TICKS;
  const claim = claimedTicks === claimedTicks ? claimedTicks : expectedTicks;
  let d = claim < lo ? lo : claim > hi ? hi : claim;
  if (!(d >= 0)) d = 0;
  return d > maxRewindTicks ? maxRewindTicks : d;
}
