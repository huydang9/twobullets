import {
  CorrectionSmoother,
  createReconcileResult,
  ownerMoveWithinTolerance,
  PredictionHistory,
  reconcile,
  ReconcileKind,
  type ReplayHooks,
} from "@twobullets/netcode/prediction";
import type { Mutable, OwnerMoveBlock } from "@twobullets/protocol/messages/snapshot";
import type { PlayerInput } from "@twobullets/shared/input";
import type { MoveState, Vec3 } from "@twobullets/shared/movement/types";
import { copyOwnerBlock, createOwnerBlock, moveStateFromOwner, ownerFeetInto, quantizeOwnerInto } from "./netMovement";

/** The local player as prediction sees it: PlayerController in the browser, a headless body in tests. */
export interface PredictedBody {
  /** Tick-accurate feet after the last tick, replay or restore. */
  readonly tickFeet: Readonly<Vec3>;
  readonly moveState: MoveState;
  restoreMove(feet: Vec3, state: MoveState): void;
  /** One recorded tick with `replay: true` and no observers (R11: no recoil, FX or audio). */
  replayTick(input: PlayerInput): MoveState;
  /** Render-only smoothing offset, m. */
  setRenderOffset(x: number, y: number, z: number): void;
}

interface PredictedTick {
  tick: number;
  readonly block: Mutable<OwnerMoveBlock>;
  /** Full-precision predicted state (sim-owned immutable object). */
  move: MoveState | null;
}

const HISTORY = 128;
const CORRECTION_WINDOW = 256;

export interface LocalPlayerNetStats {
  /** Replays + snaps + resets after the initial placement. */
  corrections: number;
  replays: number;
  snaps: number;
  resets: number;
  replayedTicks: number;
  /** Size of the last correction's visual jump, m. */
  lastCorrectionM: number;
  sumCorrectionM: number;
}

/**
 * Client prediction glue (netcode.md §3): records `{tick, input, quantized predicted state}` per tick, reconciles each
 * owner block against it with netcode's `reconcile` (restore + `replayTick`), and smooths the visual jump on the
 * render side with τ = 100 ms (snap beyond 1 m). Allocation-free except the restored MoveState on a correction.
 */
export class LocalPlayerNet {
  readonly stats: LocalPlayerNetStats = { corrections: 0, replays: 0, snaps: 0, resets: 0, replayedTicks: 0, lastCorrectionM: 0, sumCorrectionM: 0 };
  readonly smoother = new CorrectionSmoother();
  private readonly body: PredictedBody;
  private readonly history = new PredictionHistory<PredictedTick, PlayerInput>(HISTORY);
  private readonly pool: PredictedTick[] = [];
  private readonly auth: PredictedTick = { tick: -1, block: createOwnerBlock(), move: null };
  private readonly result = createReconcileResult<PredictedTick>();
  private readonly hooks: ReplayHooks<PredictedTick, PlayerInput>;
  private readonly feet = { x: 0, y: 0, z: 0 };
  /** Correction times (ms) for the per-minute rate. */
  private readonly correctionTimes = new Float64Array(CORRECTION_WINDOW);
  private correctionHead = 0;
  private restored = false;
  private lastAuthTick = -1;

  constructor(body: PredictedBody) {
    this.body = body;
    for (let i = 0; i < HISTORY; i++) this.pool.push({ tick: -1, block: createOwnerBlock(), move: null });
    this.correctionTimes.fill(-Infinity);
    this.hooks = {
      step: (_state, input, tick) => {
        const move = this.body.replayTick(input);
        this.stats.replayedTicks++;
        return this.fill(tick, move);
      },
      restore: (state, tick) => this.restoreFrom(state.block, tick),
      withinTolerance: (predicted, authoritative) => ownerMoveWithinTolerance(predicted.block, authoritative.block),
    };
  }

  get newestPredictedTick(): number {
    return this.history.newestTick;
  }

  /** Quantized predicted state still held for `tick`, or null. */
  predictedBlock(tick: number): OwnerMoveBlock | null {
    return this.history.stateAt(tick)?.block ?? null;
  }

  /** Places the body at the server's state before prediction starts (server-owned spawn, R12). */
  startFrom(owner: OwnerMoveBlock): void {
    this.history.clear();
    ownerFeetInto(owner, this.feet);
    this.body.restoreMove(this.feet, moveStateFromOwner(owner, null));
    this.smoother.reset();
    this.body.setRenderOffset(0, 0, 0);
    this.lastAuthTick = -1;
  }

  /** Call after every predicted (non-replay) tick with the input it simulated. */
  recordTick(input: PlayerInput): void {
    this.history.record(input.tick, input, this.fill(input.tick, this.body.moveState));
  }

  /** Hard resync: predictions made on the old tick alignment are useless. */
  clearHistory(): void {
    this.history.clear();
    this.lastAuthTick = -1;
  }

  /** Reconciles the owner block of snapshot `serverTick` (the state after input tick `serverTick`). */
  onOwnerState(serverTick: number, owner: OwnerMoveBlock, nowMs: number): ReconcileKind | -1 {
    if (serverTick <= this.lastAuthTick || this.history.newestTick < 0) return -1;
    this.lastAuthTick = serverTick;
    const auth = this.auth;
    auth.tick = serverTick;
    auth.move = null;
    copyOwnerBlock(owner, auth.block);
    const beforeX = this.body.tickFeet.x;
    const beforeY = this.body.tickFeet.y;
    const beforeZ = this.body.tickFeet.z;
    this.restored = false;
    const r = reconcile(this.history, serverTick, auth, this.hooks, this.result);
    // reconcile stores the scratch `auth` at its tick; move it into that tick's pool entry.
    if (this.history.stateAt(serverTick) === auth) {
      const entry = this.pool[serverTick & (HISTORY - 1)]!;
      entry.tick = serverTick;
      copyOwnerBlock(auth.block, entry.block);
      entry.move = null;
      this.history.setState(serverTick, entry);
    }
    if (!this.restored) return r.kind;
    if (r.kind === ReconcileKind.replayed) this.stats.replays++;
    else if (r.kind === ReconcileKind.snapped) this.stats.snaps++;
    else if (r.kind === ReconcileKind.reset) this.stats.resets++;
    const dx = beforeX - this.body.tickFeet.x;
    const dy = beforeY - this.body.tickFeet.y;
    const dz = beforeZ - this.body.tickFeet.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.stats.corrections++;
    this.stats.lastCorrectionM = d;
    this.stats.sumCorrectionM += d;
    this.correctionTimes[this.correctionHead] = nowMs;
    this.correctionHead = (this.correctionHead + 1) % CORRECTION_WINDOW;
    this.smoother.add(dx, dy, dz);
    return r.kind;
  }

  /** Per render frame: decays the correction offset and hands it to the body. */
  update(dtSec: number): void {
    this.smoother.update(dtSec);
    this.body.setRenderOffset(this.smoother.x, this.smoother.y, this.smoother.z);
  }

  /** Corrections in the last 60 s (capped at the window size). */
  correctionsPerMinute(nowMs: number): number {
    const from = nowMs - 60_000;
    let n = 0;
    for (let i = 0; i < CORRECTION_WINDOW; i++) if (this.correctionTimes[i]! >= from) n++;
    return n;
  }

  private fill(tick: number, move: MoveState): PredictedTick {
    const entry = this.pool[tick & (HISTORY - 1)]!;
    entry.tick = tick;
    entry.move = move;
    quantizeOwnerInto(this.body.tickFeet, move, entry.block);
    return entry;
  }

  private restoreFrom(block: OwnerMoveBlock, tick: number): void {
    const predicted = this.pool[tick & (HISTORY - 1)]!;
    const move = predicted.tick === tick ? predicted.move : null;
    ownerFeetInto(block, this.feet);
    this.body.restoreMove(this.feet, moveStateFromOwner(block, move));
    this.restored = true;
  }
}
