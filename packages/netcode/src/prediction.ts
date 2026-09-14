import type { OwnerMoveBlock } from "@twobullets/protocol/messages/snapshot";

// Client prediction and reconciliation (netcode.md §3). Generic over the player state and input so it never imports
// the sim: the client glue supplies `step` (the shared PlayerSim), `restore` (teleport + resetForReplay) and the
// tolerance compare. Tick = input sequence number; the owner block in snapshot S is the state after simulating tick S.

export interface PredictionEntry<S, I> {
  tick: number;
  input: I;
  state: S;
}

/** Ring of `{tick, input, state after input}` indexed by tick. Stores references; callers pass immutable values. */
export class PredictionHistory<S, I> {
  private readonly mask: number;
  private readonly ticks: Float64Array;
  private readonly inputs: (I | undefined)[];
  private readonly states: (S | undefined)[];
  private newest = -1;
  private oldest = -1;

  constructor(capacity = 128) {
    if ((capacity & (capacity - 1)) !== 0) throw new RangeError("capacity must be a power of two");
    this.mask = capacity - 1;
    this.ticks = new Float64Array(capacity).fill(-1);
    this.inputs = new Array<I | undefined>(capacity);
    this.states = new Array<S | undefined>(capacity);
  }

  get capacity(): number {
    return this.mask + 1;
  }
  get newestTick(): number {
    return this.newest;
  }
  /** Oldest tick still stored (−1 when empty). */
  get oldestTick(): number {
    return this.oldest;
  }

  record(tick: number, input: I, state: S): void {
    const i = tick & this.mask;
    this.ticks[i] = tick;
    this.inputs[i] = input;
    this.states[i] = state;
    if (tick > this.newest) this.newest = tick;
    if (this.oldest < 0 || tick < this.oldest) this.oldest = tick;
    if (this.newest - this.oldest > this.mask) this.oldest = this.newest - this.mask;
  }

  has(tick: number): boolean {
    return tick >= 0 && this.ticks[tick & this.mask] === tick;
  }
  inputAt(tick: number): I | undefined {
    return this.has(tick) ? this.inputs[tick & this.mask] : undefined;
  }
  stateAt(tick: number): S | undefined {
    return this.has(tick) ? this.states[tick & this.mask] : undefined;
  }
  /** Replaces the predicted state after a replay (the input stays). */
  setState(tick: number, state: S): void {
    if (this.has(tick)) this.states[tick & this.mask] = state;
  }

  /** Forgets ticks ≤ `tick` (states only matter for comparison; inputs ≤ an acked tick are never resent). */
  dropThrough(tick: number): void {
    if (this.oldest < 0 || tick < this.oldest) return;
    for (let t = this.oldest; t <= tick && t <= this.newest; t++) {
      const i = t & this.mask;
      if (this.ticks[i] === t) {
        this.ticks[i] = -1;
        this.inputs[i] = undefined;
        this.states[i] = undefined;
      }
    }
    this.oldest = tick + 1 > this.newest ? -1 : tick + 1;
    if (this.oldest < 0) this.newest = -1;
  }

  clear(): void {
    this.ticks.fill(-1);
    this.inputs.fill(undefined);
    this.states.fill(undefined);
    this.newest = -1;
    this.oldest = -1;
  }
}

export interface ReplayHooks<S, I> {
  /** One simulation tick (replay: no FX, audio or shot emission). */
  step(state: S, input: I, tick: number): S;
  /** Makes the simulation's hidden state (Havok character controller) match `state` at `tick`. */
  restore(state: S, tick: number): void;
  /** Predicted vs authoritative state within tolerance (quantize the prediction the same way first). */
  withinTolerance(predicted: S, authoritative: S): boolean;
}

export const ReconcileKind = {
  /** Prediction matched; history through the tick was dropped. */
  match: 0,
  /** Mismatch: restored and replayed up to the current tick. */
  replayed: 1,
  /** Mismatch too old to replay (> maxReplayTicks): restored and history cleared. */
  snapped: 2,
  /** No prediction for that tick (too old, or a resync): restored and history cleared. */
  reset: 3,
  /** Authoritative tick is beyond the newest prediction; ignored. */
  ahead: 4,
  /** Older than the oldest kept prediction (a reordered snapshot after a newer one reconciled); ignored. */
  stale: 5,
} as const;
export type ReconcileKind = (typeof ReconcileKind)[keyof typeof ReconcileKind];

export interface ReconcileResult<S> {
  kind: ReconcileKind;
  /** Ticks re-simulated. */
  replayed: number;
  /** State at the newest tick after reconciliation (unchanged prediction on match). */
  state: S | undefined;
}

export interface ReconcileOptions {
  /** netcode.md §3.3: 20. */
  readonly maxReplayTicks?: number;
}

/**
 * Reconciles one authoritative owner state for `authTick` (the snapshot's server tick) against the history, replaying
 * recorded inputs through `newestTick`. `out` is reused to avoid allocation.
 */
export function reconcile<S, I>(
  history: PredictionHistory<S, I>,
  authTick: number,
  authState: S,
  hooks: ReplayHooks<S, I>,
  out: ReconcileResult<S>,
  options: ReconcileOptions = {},
): ReconcileResult<S> {
  const newest = history.newestTick;
  out.replayed = 0;
  if (newest >= 0 && authTick > newest) {
    out.kind = ReconcileKind.ahead;
    out.state = history.stateAt(newest);
    return out;
  }
  if (newest >= 0 && authTick < history.oldestTick) {
    out.kind = ReconcileKind.stale;
    out.state = history.stateAt(newest);
    return out;
  }
  const predicted = history.stateAt(authTick);
  if (predicted === undefined) {
    hooks.restore(authState, authTick);
    history.clear();
    out.kind = ReconcileKind.reset;
    out.state = authState;
    return out;
  }
  if (hooks.withinTolerance(predicted, authState)) {
    history.dropThrough(authTick - 1);
    out.kind = ReconcileKind.match;
    out.state = history.stateAt(newest);
    return out;
  }
  hooks.restore(authState, authTick);
  if (newest - authTick > (options.maxReplayTicks ?? 20)) {
    history.clear();
    out.kind = ReconcileKind.snapped;
    out.state = authState;
    return out;
  }
  let state = authState;
  history.setState(authTick, authState);
  let lastInput = history.inputAt(authTick);
  for (let t = authTick + 1; t <= newest; t++) {
    const input = history.inputAt(t) ?? lastInput;
    if (input === undefined) break;
    state = hooks.step(state, input, t);
    history.setState(t, state);
    lastInput = input;
    out.replayed++;
  }
  history.dropThrough(authTick - 1);
  out.kind = ReconcileKind.replayed;
  out.state = state;
  return out;
}

export function createReconcileResult<S>(): ReconcileResult<S> {
  return { kind: ReconcileKind.match, replayed: 0, state: undefined };
}

/** netcode.md §3.4 movement tolerances on quantized owner state. */
export const MOVE_TOLERANCE = { positionMm: 10, velocityMmS: 50, timerTicks: 1 } as const;

/** Owner move block compare: position 10 mm, velocity 50 mm/s per axis, discrete exact, timers ±1 tick. */
export function ownerMoveWithinTolerance(predicted: OwnerMoveBlock, auth: OwnerMoveBlock, tol = MOVE_TOLERANCE): boolean {
  return (
    Math.abs(predicted.xMm - auth.xMm) <= tol.positionMm &&
    Math.abs(predicted.yMm - auth.yMm) <= tol.positionMm &&
    Math.abs(predicted.zMm - auth.zMm) <= tol.positionMm &&
    Math.abs(predicted.vxMmS - auth.vxMmS) <= tol.velocityMmS &&
    Math.abs(predicted.vyMmS - auth.vyMmS) <= tol.velocityMmS &&
    Math.abs(predicted.vzMmS - auth.vzMmS) <= tol.velocityMmS &&
    predicted.stance === auth.stance &&
    predicted.grounded === auth.grounded &&
    predicted.sprinting === auth.sprinting &&
    predicted.jumpHeld === auth.jumpHeld &&
    predicted.moveMode === auth.moveMode &&
    Math.abs(predicted.coyoteTicks - auth.coyoteTicks) <= tol.timerTicks &&
    Math.abs(predicted.jumpBufferTicks - auth.jumpBufferTicks) <= tol.timerTicks &&
    Math.abs(predicted.groundIgnoreTicks - auth.groundIgnoreTicks) <= tol.timerTicks
  );
}

export interface CorrectionSmoothingOptions {
  /** Exponential decay time constant, s (netcode.md §3.5: 0.1). */
  readonly tauSec?: number;
  /** Offsets longer than this snap to zero, m. */
  readonly snapDistance?: number;
}

/**
 * Render-side visual offset after a correction: `offset += oldRender − newRender`, decaying with τ; beyond 1 m it
 * snaps. Add the offset to the rendered body/camera position. Never smooth aim.
 */
export class CorrectionSmoother {
  x = 0;
  y = 0;
  z = 0;
  corrections = 0;
  snaps = 0;
  private readonly tau: number;
  private readonly snap2: number;

  constructor(options: CorrectionSmoothingOptions = {}) {
    this.tau = options.tauSec ?? 0.1;
    const d = options.snapDistance ?? 1;
    this.snap2 = d * d;
  }

  /** `before − after` of the rendered position across a correction. Returns false when it snapped. */
  add(dx: number, dy: number, dz: number): boolean {
    this.corrections++;
    const x = this.x + dx;
    const y = this.y + dy;
    const z = this.z + dz;
    if (x * x + y * y + z * z > this.snap2) {
      this.x = this.y = this.z = 0;
      this.snaps++;
      return false;
    }
    this.x = x;
    this.y = y;
    this.z = z;
    return true;
  }

  update(dtSec: number): void {
    const k = Math.exp(-dtSec / this.tau);
    this.x *= k;
    this.y *= k;
    this.z *= k;
    if (this.x * this.x + this.y * this.y + this.z * this.z < 1e-10) this.x = this.y = this.z = 0;
  }

  get magnitude(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  reset(): void {
    this.x = this.y = this.z = 0;
  }
}
