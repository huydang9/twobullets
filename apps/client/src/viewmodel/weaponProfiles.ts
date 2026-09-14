import type { WeaponId } from "@twobullets/shared";
import type { Vec3Tuple } from "./MeshKit";

/**
 * Viewmodel feel per weapon. Positions in meters (camera space: +X right, +Y up, +Z forward), rotations in radians
 * (x + = muzzle down, y + = muzzle right, z + = roll counter-clockwise). Kick values are the approximate peak the
 * spring overshoots to after one shot.
 */
export interface ViewmodelProfile {
  /** Model origin in camera space at the hip. */
  readonly hip: Vec3Tuple;
  /** Distance from the eye to the sight point while aiming. */
  readonly adsEyeDistance: number;
  readonly sprintOffset: Vec3Tuple;
  readonly sprintRotation: Vec3Tuple;
  readonly recoil: {
    readonly back: number;
    readonly up: number;
    /** Muzzle rise, radians. */
    readonly pitch: number;
    /** Random ± yaw and roll. */
    readonly yaw: number;
    readonly roll: number;
    readonly frequency: number;
    readonly damping: number;
    /** Multiplier while aiming down sights. */
    readonly adsScale: number;
  };
  /** Visual-only camera kick, radians. */
  readonly cameraPunch: { readonly pitch: number; readonly yaw: number; readonly roll: number };
  readonly muzzleFlash: { readonly size: number; readonly length: number; readonly light: number };
  readonly tracer: { readonly width: number; readonly length: number };
}

export const VIEWMODEL_PROFILES: Readonly<Record<WeaponId, ViewmodelProfile>> = {
  rifle: {
    hip: [0.12, -0.105, 0.28],
    adsEyeDistance: 0.12,
    sprintOffset: [-0.03, -0.045, -0.03],
    sprintRotation: [0.3, -0.55, 0.35],
    recoil: { back: 0.022, up: 0.004, pitch: 0.035, yaw: 0.01, roll: 0.03, frequency: 11, damping: 0.5, adsScale: 0.45 },
    cameraPunch: { pitch: 0.006, yaw: 0.002, roll: 0.004 },
    muzzleFlash: { size: 0.055, length: 0.16, light: 1.6 },
    tracer: { width: 0.012, length: 7 },
  },
  shotgun: {
    hip: [0.125, -0.11, 0.27],
    adsEyeDistance: 0.14,
    sprintOffset: [-0.03, -0.05, -0.03],
    sprintRotation: [0.3, -0.55, 0.35],
    recoil: { back: 0.05, up: 0.01, pitch: 0.11, yaw: 0.02, roll: 0.06, frequency: 7.5, damping: 0.55, adsScale: 0.5 },
    cameraPunch: { pitch: 0.018, yaw: 0.004, roll: 0.012 },
    muzzleFlash: { size: 0.085, length: 0.22, light: 2.6 },
    tracer: { width: 0.007, length: 4 },
  },
  pistol: {
    hip: [0.105, -0.1, 0.25],
    adsEyeDistance: 0.25,
    sprintOffset: [-0.02, -0.04, -0.05],
    sprintRotation: [0.7, -0.2, 0.15],
    recoil: { back: 0.014, up: 0.006, pitch: 0.075, yaw: 0.012, roll: 0.035, frequency: 15, damping: 0.45, adsScale: 0.5 },
    cameraPunch: { pitch: 0.005, yaw: 0.0015, roll: 0.003 },
    muzzleFlash: { size: 0.045, length: 0.1, light: 1.3 },
    tracer: { width: 0.011, length: 6 },
  },
  sniper: {
    hip: [0.13, -0.11, 0.26],
    adsEyeDistance: 0.075,
    sprintOffset: [-0.03, -0.05, -0.04],
    sprintRotation: [0.32, -0.6, 0.35],
    recoil: { back: 0.07, up: 0.012, pitch: 0.16, yaw: 0.02, roll: 0.07, frequency: 6, damping: 0.55, adsScale: 0.6 },
    cameraPunch: { pitch: 0.024, yaw: 0.004, roll: 0.014 },
    muzzleFlash: { size: 0.1, length: 0.3, light: 3 },
    tracer: { width: 0.022, length: 12 },
  },
};
