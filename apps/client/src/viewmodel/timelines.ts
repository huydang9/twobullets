import type { WeaponDef, WeaponId } from "@twobullets/shared";
import { clamp } from "./Spring";

/**
 * Timing shared by the viewmodel animation, shell ejection and audio so sounds land on the motion that makes them.
 * Reload cue positions are fractions (0..1) of the reload duration.
 */
export type ReloadCueKind = "magOut" | "magIn" | "shellInsert" | "pump" | "boltOpen" | "boltClose" | "slide" | "charge";

export interface ReloadCue {
  /** Start of the motion, fraction of the reload. */
  readonly at: number;
  readonly kind: ReloadCueKind;
  /** Length of multi-part motions (pump, bolt), fraction of the reload. */
  readonly span?: number;
}

export const RELOAD_CUES: Readonly<Record<WeaponId, readonly ReloadCue[]>> = {
  rifle: [
    { at: 0.2, kind: "magOut" },
    { at: 0.6, kind: "magIn" },
    { at: 0.84, kind: "charge" },
  ],
  pistol: [
    { at: 0.18, kind: "magOut" },
    { at: 0.58, kind: "magIn" },
    { at: 0.8, kind: "slide" },
  ],
  shotgun: [
    { at: 0.3, kind: "shellInsert" },
    { at: 0.48, kind: "shellInsert" },
    { at: 0.66, kind: "shellInsert" },
    { at: 0.8, kind: "pump", span: 0.14 },
  ],
  sniper: [
    { at: 0.06, kind: "boltOpen", span: 0.14 },
    { at: 0.32, kind: "magOut" },
    { at: 0.62, kind: "magIn" },
    { at: 0.76, kind: "boltClose", span: 0.12 },
  ],
};

export function reloadCueAt(id: WeaponId, kind: ReloadCueKind, fallback: number): number {
  for (const cue of RELOAD_CUES[id]) {
    if (cue.kind === kind) return cue.at;
  }
  return fallback;
}

/** Post-shot manual action (bolt or pump). Times in seconds after the shot. */
export interface ActionCycle {
  readonly kind: "bolt" | "pump";
  readonly delay: number;
  readonly duration: number;
  /** Fraction of the duration at which the spent shell leaves the gun. */
  readonly ejectAt: number;
}

export function actionCycleFor(def: WeaponDef): ActionCycle | null {
  const interval = 60 / def.roundsPerMinute;
  if (def.fireMode === "bolt") {
    return { kind: "bolt", delay: 0.16, duration: clamp(interval - 0.25, 0.45, 1.0), ejectAt: 0.42 };
  }
  if (def.id === "shotgun") {
    return { kind: "pump", delay: 0.09, duration: clamp(interval - 0.15, 0.3, 0.55), ejectAt: 0.35 };
  }
  return null;
}
