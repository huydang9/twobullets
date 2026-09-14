import type { WeaponId } from "@twobullets/shared";
import type { SoundId } from "./audioManifest";
import type { GunId } from "./weaponMix";
import type { AcousticSurface, FootstepStance } from "./types";

export { WEAPON_SOUNDS, firstPersonShot, type WeaponSound } from "./weaponMix";

// weaponMix.ts is dependency-free for the offline tools; fail to compile if its gun list drifts from WeaponId.
true satisfies [WeaponId, GunId] extends [GunId, WeaponId] ? true : never;

export const FOOTSTEP_SOUND: Readonly<Record<AcousticSurface, SoundId>> = {
  concrete: "step.concrete",
  dirt: "step.dirt",
  grass: "step.grass",
  gravel: "step.gravel",
  wood: "step.wood",
  metal: "step.metal",
};

/** Surface-specific level trims (the source packs were recorded at different distances). */
export const FOOTSTEP_TRIM: Readonly<Record<AcousticSurface, number>> = {
  concrete: 1,
  dirt: 0.9,
  grass: 0.85,
  gravel: 0.8,
  wood: 1,
  metal: 0.55,
};

export const STANCE: Readonly<Record<FootstepStance, { readonly gain: number; readonly range: number; readonly rate: number }>> = {
  crouch: { gain: 0.22, range: 8, rate: 1.04 },
  walk: { gain: 0.4, range: 20, rate: 1 },
  run: { gain: 0.55, range: 30, rate: 0.98 },
  sprint: { gain: 0.72, range: 40, rate: 0.95 },
};

export const IMPACT_SOUND: Readonly<Record<AcousticSurface | "flesh", SoundId>> = {
  concrete: "impact.concrete",
  gravel: "impact.dirt",
  dirt: "impact.dirt",
  grass: "impact.dirt",
  wood: "impact.wood",
  metal: "impact.metal",
  flesh: "impact.flesh",
};

/** Level of the local player's own sounds (non-spatial). */
export const LOCAL_MIX = {
  footstep: 0.55,
  landing: 0.7,
  jump: 0.35,
  mechanical: 0.6,
  casing: 0.25,
} as const;
