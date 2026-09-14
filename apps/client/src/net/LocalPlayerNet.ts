import {
  CorrectionSmoother,
  createReconcileResult,
  ownerMoveWithinTolerance,
  PredictionHistory,
  reconcile,
  ReconcileKind,
  type ReplayHooks,
} from "@twobullets/netcode/prediction";
import { weaponStateFromOwner, writeOwnerWeapon } from "@twobullets/netcode/replication";
import { LifeCode } from "@twobullets/protocol/codes";
import {
  copyOwnerWeapon,
  createOwnerWeaponBlock,
  ownerWeaponEqual,
  type MutableOwnerWeaponBlock,
  type Mutable,
  type OwnerMoveBlock,
  type OwnerWeaponBlock,
} from "@twobullets/protocol/messages/snapshot";
import type { PlayerInput } from "@twobullets/shared/input";
import type { MoveState, Vec3 } from "@twobullets/shared/movement/types";
import { diffWeaponState, restoreWeapon, ShotEmitter, WeaponDiff } from "@twobullets/shared/weapons/reconcile";
import type { WeaponState } from "@twobullets/shared/weapons/types";
import { copyOwnerBlock, createOwnerBlock, moveStateFromOwner, ownerFeetInto, quantizeOwnerInto } from "./netMovement";

/** The local player as prediction sees it: PlayerController + CombatSystem in the browser, a headless body in tests. */
export interface PredictedBody {
  /** Tick-accurate feet after the last tick, replay or restore. */
  readonly tickFeet: Readonly<Vec3>;
  readonly moveState: MoveState;
  /**
   * Predicted weapon state after the last tick, replay or restore (the weapon half of `stepPlayer(..., { weapons:
   * true })`), or null when only movement is predicted.
   */
  readonly weaponState: WeaponState | null;
  restoreMove(feet: Vec3, state: MoveState): void;
  /** Puts the weapon exactly into `state` (a correction or the server's spawn loadout). */
  restoreWeapon(state: WeaponState): void;
  /** One recorded tick, movement and weapon, with `replay: true` and no observers (R11: no recoil, FX, audio or shots). */
  replayTick(input: PlayerInput): MoveState;
  /** Render-only smoothing offset, m. */
  setRenderOffset(x: number, y: number, z: number): void;
}

interface PredictedTick {
  tick: number;
  readonly block: Mutable<OwnerMoveBlock>;
  /** Full-precision predicted state (sim-owned immutable object). */
  move: MoveState | null;
  readonly weaponBlock: MutableOwnerWeaponBlock;
  hasWeapon: boolean;
  /** Full-precision predicted weapon state (sim-owned immutable object), or null. */
  weapon: WeaponState | null;
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
  /** Corrections whose weapon state was out of tolerance (netcode.md §3.4; M4 DoD: < 1 per 10 min at "typical"). */
  weaponCorrections: number;
  /** `WeaponDiff` bits of the last weapon correction, and of all of them. */
  lastWeaponDiff: number;
  weaponDiffMask: number;
  /** Respawns (owner life dead → alive): prediction restarted from the server's state. */
  respawns: number;
}

function createTick(): PredictedTick {
  return { tick: -1, block: createOwnerBlock(), move: null, weaponBlock: createOwnerWeaponBlock(), hasWeapon: false, weapon: null };
}

/**
 * Client prediction glue (netcode.md §3): records `{tick, input, quantized predicted state}` per tick (movement and,
 * with M4 weapon prediction, the owner weapon group), reconciles each owner block against it with netcode's
 * `reconcile` (restore + `replayTick`), and smooths the visual jump on the render side with τ = 100 ms (snap beyond
 * 1 m). Weapon state compares quantized first (allocation-free when equal), then `weaponStateFromOwner` →
 * `diffWeaponState` → `restoreWeapon`. `shots` suppresses recoil and FX of shot ids already shown (R11).
 */
export class LocalPlayerNet {
  readonly stats: LocalPlayerNetStats = {
    corrections: 0,
    replays: 0,
    snaps: 0,
    resets: 0,
    replayedTicks: 0,
    lastCorrectionM: 0,
    sumCorrectionM: 0,
    weaponCorrections: 0,
    lastWeaponDiff: 0,
    weaponDiffMask: 0,
    respawns: 0,
  };
  readonly smoother = new CorrectionSmoother();
  /** Recoil, muzzle flash, tracers and audio only for shot ids never shown before. */
  readonly shots = new ShotEmitter();
  private readonly body: PredictedBody;
  private readonly history = new PredictionHistory<PredictedTick, PlayerInput>(HISTORY);
  private readonly pool: PredictedTick[] = [];
  private readonly auth: PredictedTick = createTick();
  private readonly result = createReconcileResult<PredictedTick>();
  private readonly hooks: ReplayHooks<PredictedTick, PlayerInput>;
  private readonly feet = { x: 0, y: 0, z: 0 };
  /** Correction times (ms) for the per-minute rates. */
  private readonly correctionTimes = new Float64Array(CORRECTION_WINDOW);
  private readonly weaponCorrectionTimes = new Float64Array(CORRECTION_WINDOW);
  private correctionHead = 0;
  private weaponCorrectionHead = 0;
  private restored = false;
  private lastAuthTick = -1;
  private life: number = LifeCode.alive;
  /** Weapon diff of the current reconcile's compare, and the authoritative state it built (reused by restore). */
  private pendingWeaponDiff = 0;
  private authWeapon: WeaponState | null = null;

  constructor(body: PredictedBody) {
    this.body = body;
    for (let i = 0; i < HISTORY; i++) this.pool.push(createTick());
    this.correctionTimes.fill(-Infinity);
    this.weaponCorrectionTimes.fill(-Infinity);
    this.hooks = {
      step: (_state, input, tick) => {
        const move = this.body.replayTick(input);
        this.stats.replayedTicks++;
        return this.fill(tick, move);
      },
      restore: (state, tick) => this.restoreFrom(state, tick),
      withinTolerance: (predicted, authoritative) => {
        const moveOk = ownerMoveWithinTolerance(predicted.block, authoritative.block);
        this.pendingWeaponDiff = this.weaponDiff(predicted, authoritative);
        return moveOk && this.pendingWeaponDiff === 0;
      },
    };
  }

  get newestPredictedTick(): number {
    return this.history.newestTick;
  }

  /** Owner life code of the newest reconciled snapshot. */
  get ownerLife(): number {
    return this.life;
  }

  /** Quantized predicted state still held for `tick`, or null. */
  predictedBlock(tick: number): OwnerMoveBlock | null {
    return this.history.stateAt(tick)?.block ?? null;
  }

  /** Quantized predicted weapon group still held for `tick`, or null. */
  predictedWeaponBlock(tick: number): OwnerWeaponBlock | null {
    const entry = this.history.stateAt(tick);
    return entry?.hasWeapon ? entry.weaponBlock : null;
  }

  /** Places the body (and weapon) at the server's state before prediction starts (server-owned spawn, R12). */
  startFrom(owner: OwnerMoveBlock, weapon: OwnerWeaponBlock | null = null, life: number = LifeCode.alive): void {
    this.history.clear();
    this.place(owner, weapon);
    const state = this.body.weaponState;
    if (state) this.shots.reset(state.shotCounter);
    this.smoother.reset();
    this.body.setRenderOffset(0, 0, 0);
    this.lastAuthTick = -1;
    this.life = life;
  }

  /** Call after every predicted (non-replay) tick with the input it simulated. Dead players aren't predicted. */
  recordTick(input: PlayerInput): void {
    if (this.life === LifeCode.dead) return;
    this.history.record(input.tick, input, this.fill(input.tick, this.body.moveState));
  }

  /** Hard resync: predictions made on the old tick alignment are useless. */
  clearHistory(): void {
    this.history.clear();
    this.lastAuthTick = -1;
  }

  /**
   * Reconciles the owner block of snapshot `serverTick` (the state after input tick `serverTick`), with its weapon group
   * and the owner's life from the same snapshot. Dead: the server doesn't step the player, so the body is held at the
   * server's state without prediction; dead → alive (respawn) restarts prediction from the server's state.
   */
  onOwnerState(serverTick: number, owner: OwnerMoveBlock, nowMs: number, weapon: OwnerWeaponBlock | null = null, life: number = LifeCode.alive): ReconcileKind | -1 {
    if (serverTick <= this.lastAuthTick) return -1;
    const previousLife = this.life;
    if (life === LifeCode.dead) {
      this.life = life;
      this.lastAuthTick = serverTick;
      // The body is frozen server-side: place it on death and again only if the server moved it.
      if (previousLife !== LifeCode.dead || !ownerMoveWithinTolerance(this.auth.block, owner)) {
        copyOwnerBlock(owner, this.auth.block);
        this.history.clear();
        this.place(owner, null);
        this.smoother.reset();
        this.body.setRenderOffset(0, 0, 0);
      }
      return -1;
    }
    if (previousLife === LifeCode.dead) {
      this.startFrom(owner, weapon, life);
      this.lastAuthTick = serverTick;
      this.stats.respawns++;
      return -1;
    }
    this.life = life;
    if (this.history.newestTick < 0) return -1;
    this.lastAuthTick = serverTick;
    const auth = this.auth;
    auth.tick = serverTick;
    auth.move = null;
    auth.weapon = null;
    copyOwnerBlock(owner, auth.block);
    auth.hasWeapon = weapon !== null;
    if (weapon !== null) copyOwnerWeapon(weapon, auth.weaponBlock);
    const beforeX = this.body.tickFeet.x;
    const beforeY = this.body.tickFeet.y;
    const beforeZ = this.body.tickFeet.z;
    this.restored = false;
    this.pendingWeaponDiff = 0;
    this.authWeapon = null;
    const r = reconcile(this.history, serverTick, auth, this.hooks, this.result);
    // reconcile stores the scratch `auth` at its tick; move it into that tick's pool entry.
    if (this.history.stateAt(serverTick) === auth) {
      const entry = this.pool[serverTick & (HISTORY - 1)]!;
      entry.tick = serverTick;
      copyOwnerBlock(auth.block, entry.block);
      entry.move = null;
      entry.hasWeapon = auth.hasWeapon;
      if (auth.hasWeapon) copyOwnerWeapon(auth.weaponBlock, entry.weaponBlock);
      entry.weapon = null;
      this.history.setState(serverTick, entry);
    }
    this.authWeapon = null;
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
    if (this.pendingWeaponDiff !== 0 && r.kind !== ReconcileKind.reset) {
      this.stats.weaponCorrections++;
      this.stats.lastWeaponDiff = this.pendingWeaponDiff;
      this.stats.weaponDiffMask |= this.pendingWeaponDiff;
      this.weaponCorrectionTimes[this.weaponCorrectionHead] = nowMs;
      this.weaponCorrectionHead = (this.weaponCorrectionHead + 1) % CORRECTION_WINDOW;
    }
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
    return countSince(this.correctionTimes, nowMs - 60_000);
  }

  /** Weapon-state mispredictions in the last 60 s. */
  weaponCorrectionsPerMinute(nowMs: number): number {
    return countSince(this.weaponCorrectionTimes, nowMs - 60_000);
  }

  private fill(tick: number, move: MoveState): PredictedTick {
    const entry = this.pool[tick & (HISTORY - 1)]!;
    entry.tick = tick;
    entry.move = move;
    quantizeOwnerInto(this.body.tickFeet, move, entry.block);
    const weapon = this.body.weaponState;
    entry.weapon = weapon;
    entry.hasWeapon = weapon !== null;
    if (weapon !== null) writeOwnerWeapon(weapon, entry.weaponBlock);
    return entry;
  }

  /** `WeaponDiff` bits between a predicted tick and the server's weapon group (0 = within tolerance or not compared). */
  private weaponDiff(predicted: PredictedTick, auth: PredictedTick): number {
    if (!auth.hasWeapon || !predicted.hasWeapon) return 0;
    if (ownerWeaponEqual(predicted.weaponBlock, auth.weaponBlock)) return 0;
    if (predicted.weapon === null) return WeaponDiff.shotCounter;
    const authState = weaponStateFromOwner(auth.weaponBlock, predicted.weapon.shotCounter);
    this.authWeapon = authState;
    return diffWeaponState(predicted.weapon, authState);
  }

  private restoreFrom(state: PredictedTick, tick: number): void {
    const entry = this.pool[tick & (HISTORY - 1)]!;
    const predicted = entry.tick === tick ? entry : null;
    ownerFeetInto(state.block, this.feet);
    this.body.restoreMove(this.feet, moveStateFromOwner(state.block, predicted?.move ?? null));
    if (state.hasWeapon) {
      const predictedWeapon = predicted?.weapon ?? null;
      const reference = predictedWeapon?.shotCounter ?? this.body.weaponState?.shotCounter ?? -1;
      const authState = this.authWeapon ?? weaponStateFromOwner(state.weaponBlock, reference);
      this.body.restoreWeapon(restoreWeapon(authState, predictedWeapon));
    }
    this.restored = true;
  }

  /** Server placement without prediction (spawn, respawn, dead body). */
  private place(owner: OwnerMoveBlock, weapon: OwnerWeaponBlock | null): void {
    ownerFeetInto(owner, this.feet);
    this.body.restoreMove(this.feet, moveStateFromOwner(owner, null));
    // A fresh loadout: the 16-bit shot counter isn't unwrapped against the previous life's.
    if (weapon !== null) this.body.restoreWeapon(weaponStateFromOwner(weapon, -1));
  }
}

function countSince(times: Float64Array, from: number): number {
  let n = 0;
  for (let i = 0; i < times.length; i++) if (times[i]! >= from) n++;
  return n;
}
