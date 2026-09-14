import { TICK_SECONDS } from "../tickClock";
import type { FiredShot, WeaponSlotState, WeaponState } from "./types";

// Owner weapon-state reconciliation (netcode.md §3.4, §3.6): compare the client's predicted WeaponState with the
// server's for the same tick, restore the server's for a replay, and never re-emit shots a replay fires again (R11).

/** Tolerances of netcode.md §3.4. Everything else (slots, ammo, active slot, phase, shot counter, trigger) is exact. */
export const WEAPON_TOLERANCE = {
  /** phaseTimer and cooldown: ±1 tick (cooldown carries a fractional overshoot). */
  timerSeconds: TICK_SECONDS,
  bloomDegrees: 0.02,
  adsBlend: 0.02,
} as const;

/** Bits of `diffWeaponState`; 0 means within tolerance. */
export const WeaponDiff = {
  /** Slot count, a slot's weapon id, or filled/empty. */
  slots: 1,
  /** Magazine or reserve of any slot. */
  ammo: 2,
  activeIndex: 4,
  phase: 8,
  shotCounter: 16,
  triggerHeld: 32,
  phaseTimer: 64,
  cooldown: 128,
  bloom: 256,
  adsBlend: 512,
} as const;

/** Mask of fields where `predicted` and `authoritative` disagree beyond WEAPON_TOLERANCE. Allocation-free. */
export function diffWeaponState(predicted: WeaponState, authoritative: WeaponState): number {
  let diff = 0;
  const a = predicted.slots;
  const b = authoritative.slots;
  if (a.length !== b.length) diff |= WeaponDiff.slots;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const sa = a[i] ?? null;
    const sb = b[i] ?? null;
    if (sa === sb) continue;
    if (sa === null || sb === null || sa.id !== sb.id) {
      diff |= WeaponDiff.slots;
      continue;
    }
    if (sa.magazine !== sb.magazine || sa.reserve !== sb.reserve) diff |= WeaponDiff.ammo;
  }
  if (predicted.activeIndex !== authoritative.activeIndex) diff |= WeaponDiff.activeIndex;
  if (predicted.phase !== authoritative.phase) diff |= WeaponDiff.phase;
  if (predicted.shotCounter !== authoritative.shotCounter) diff |= WeaponDiff.shotCounter;
  if (predicted.triggerHeld !== authoritative.triggerHeld) diff |= WeaponDiff.triggerHeld;
  const t = WEAPON_TOLERANCE;
  if (!near(predicted.phaseTimer, authoritative.phaseTimer, t.timerSeconds)) diff |= WeaponDiff.phaseTimer;
  if (!near(predicted.cooldown, authoritative.cooldown, t.timerSeconds)) diff |= WeaponDiff.cooldown;
  if (!near(predicted.bloom, authoritative.bloom, t.bloomDegrees)) diff |= WeaponDiff.bloom;
  if (!near(predicted.adsBlend, authoritative.adsBlend, t.adsBlend)) diff |= WeaponDiff.adsBlend;
  return diff;
}

export function weaponWithinTolerance(predicted: WeaponState, authoritative: WeaponState): boolean {
  return diffWeaponState(predicted, authoritative) === 0;
}

/**
 * The state to restore before a replay (allocates; corrections only): the authoritative state, except that float fields
 * whose prediction for the same tick is within tolerance keep the full-precision predicted value, so a value that went
 * through wire quantization can't flip a `<= epsilon` timer check or a cooldown by a tick during the replay. Discrete
 * fields always come from `authoritative`. The result shares nothing mutable with either input.
 */
export function restoreWeapon(authoritative: WeaponState, predicted: WeaponState | null): WeaponState {
  const t = WEAPON_TOLERANCE;
  const keep = (auth: number, pred: number | undefined, tolerance: number): number => (pred !== undefined && near(pred, auth, tolerance) ? pred : auth);
  const samePhase = predicted !== null && predicted.phase === authoritative.phase;
  const slots: (WeaponSlotState | null)[] = [];
  for (const slot of authoritative.slots) slots.push(slot ? { id: slot.id, magazine: slot.magazine, reserve: slot.reserve } : null);
  return {
    slots,
    activeIndex: authoritative.activeIndex,
    phase: authoritative.phase,
    phaseTimer: authoritative.phase === "ready" ? 0 : keep(authoritative.phaseTimer, samePhase ? predicted.phaseTimer : undefined, t.timerSeconds),
    cooldown: keep(authoritative.cooldown, predicted?.cooldown, t.timerSeconds),
    triggerHeld: authoritative.triggerHeld,
    bloom: keep(authoritative.bloom, predicted?.bloom, t.bloomDegrees),
    adsBlend: keep(authoritative.adsBlend, predicted?.adsBlend, t.adsBlend),
    shotCounter: authoritative.shotCounter,
  };
}

/**
 * Emits each shot id at most once (R11): the client plays recoil (`kickAim`), muzzle flash, tracers and audio only for
 * live shots with `shotId > lastEmittedShotId`. A correction that rewinds the shot counter makes the replay (and live
 * ticks after it) fire ids that were already shown; those stay silent.
 */
export class ShotEmitter {
  lastEmittedShotId = -1;

  /** True the first time a shot id is seen; records it. */
  accept(shot: FiredShot): boolean {
    if (shot.shotId <= this.lastEmittedShotId) return false;
    this.lastEmittedShotId = shot.shotId;
    return true;
  }

  /** New weapon state stream (spawn, respawn, loadout rebuilt with shotCounter 0): `nextShotCounter` is the next id. */
  reset(nextShotCounter = 0): void {
    this.lastEmittedShotId = nextShotCounter - 1;
  }
}

function near(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance + 1e-9;
}
