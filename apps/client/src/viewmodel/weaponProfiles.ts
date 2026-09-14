import type { WeaponId } from "@twobullets/shared";

export type Vec3Tuple = readonly [x: number, y: number, z: number];

/**
 * Viewmodel feel per weapon. Positions in meters (camera space: +X right, +Y up, +Z forward), rotations in radians
 * (x + = muzzle down, y + = muzzle right, z + = roll counter-clockwise). Kick values are the approximate peak the
 * spring overshoots to after one shot.
 */
export interface ViewmodelProfile {
  /**
   * A point on the sight line in instance-root space at the first idle frame (the pose the asset pipeline measures
   * anchors in). In that pose every gun body's +Z is exactly the root's +Z, so the sight line is parallel to it and
   * aiming only has to translate this point onto the camera ray. Pivot of all procedural rotations.
   * "scopeLens" reads `anchors.scopeLens` from the manifest.
   */
  readonly sight: Vec3Tuple | "scopeLens";
  /** Camera-space position of the sight point at the hip. */
  readonly hipSight: Vec3Tuple;
  /** Extra rotation at the hip, blended out while aiming. */
  readonly hipRotation: Vec3Tuple;
  /** Distance from the eye to the sight point while fully aimed. */
  readonly adsEyeDistance: number;
  /** Glass for the meshes under `nodes.scopeLens` (replaces the asset's lens material), and an optional red dot. */
  readonly optic?: {
    readonly glass: { readonly tint: Vec3Tuple; readonly alpha: number };
    readonly dot?: RedDotSettings;
  };
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

/*
 * Sight points (instance-root meters, from the headless mesh analysis of the published GLBs at the first idle frame):
 * - rifle: red-dot lens center, `anchors.scopeLens` (0, 0.221, 0.048). The dot is collimated, so the lens axis is the
 *   sight line.
 * - sniper: scope eyepiece lens center, `anchors.scopeLens` (0, 0.172, -0.140).
 * - pistol: top of the rear sight notch posts. Slide vertices peak at body y 9.36 cm at both the rear sight
 *   (z -1..0 cm) and the front post (z 18..19.6 cm), so the line is level with the bore; body origin sits at
 *   (0, 0.0402, 0.1698) → (0, 0.1338, 0.165).
 * - shotgun: top of the rear sight (body z 10–11 cm, y 8.51) and the front bead (z 80–81, y 8.45) are level within
 *   0.6 mm; body origin (0, -0.0004, -0.0505) → (0, 0.0845, 0.0545).
 * Hip positions keep the milestone-2 framing: the sight sits where the procedural guns' sights were, nudged for the
 * real guns' length so the stock and upper arms stay out of frame.
 */
/** Collimated dot drawn on the lens. Sizes are pixels at 1080p screen height (scaled with resolution). */
export interface RedDotSettings {
  /** Crisp core diameter. 2 MOA at the rifle's 62° ADS FOV is ~1 px, so this is a readable game-scale "2 MOA". */
  diameterPx: number;
  /** Radius of the faint halo around the core. */
  glowPx: number;
  /** Linear RGB; values above 1 feed the bloom a little. */
  color: [number, number, number];
}

export const VIEWMODEL_PROFILES: Readonly<Record<WeaponId, ViewmodelProfile>> = {
  rifle: {
    sight: "scopeLens",
    // Further out, a touch left and rolled slightly clockwise so the support hand under the handguard reads.
    hipSight: [0.11, -0.045, 0.3],
    hipRotation: [0, -0.04, -0.1],
    // Red-dot housing at a realistic eye relief (was 0.16: the tube filled too much of the view).
    adsEyeDistance: 0.26,
    optic: {
      glass: { tint: [0.6, 0.72, 0.78], alpha: 0.06 },
      dot: { diameterPx: 3.5, glowPx: 10, color: [2.4, 0.12, 0.06] },
    },
    sprintOffset: [-0.03, -0.045, -0.03],
    sprintRotation: [0.3, -0.55, 0.35],
    recoil: { back: 0.022, up: 0.004, pitch: 0.035, yaw: 0.01, roll: 0.03, frequency: 11, damping: 0.5, adsScale: 0.45 },
    cameraPunch: { pitch: 0.006, yaw: 0.002, roll: 0.004 },
    muzzleFlash: { size: 0.055, length: 0.16, light: 1.6 },
    tracer: { width: 0.012, length: 7 },
  },
  shotgun: {
    sight: [0, 0.0845, 0.0545],
    hipSight: [0.13, -0.085, 0.24],
    hipRotation: [0, -0.03, 0],
    adsEyeDistance: 0.22,
    sprintOffset: [-0.03, -0.05, -0.03],
    sprintRotation: [0.3, -0.55, 0.35],
    recoil: { back: 0.05, up: 0.01, pitch: 0.11, yaw: 0.02, roll: 0.06, frequency: 7.5, damping: 0.55, adsScale: 0.5 },
    cameraPunch: { pitch: 0.018, yaw: 0.004, roll: 0.012 },
    muzzleFlash: { size: 0.085, length: 0.22, light: 2.6 },
    tracer: { width: 0.007, length: 4 },
  },
  pistol: {
    sight: [0, 0.1338, 0.165],
    hipSight: [0.1, -0.07, 0.3],
    hipRotation: [0, -0.04, 0],
    adsEyeDistance: 0.26,
    sprintOffset: [-0.02, -0.04, -0.05],
    sprintRotation: [0.7, -0.2, 0.15],
    recoil: { back: 0.014, up: 0.006, pitch: 0.075, yaw: 0.012, roll: 0.035, frequency: 15, damping: 0.45, adsScale: 0.5 },
    cameraPunch: { pitch: 0.005, yaw: 0.0015, roll: 0.003 },
    muzzleFlash: { size: 0.045, length: 0.1, light: 1.3 },
    tracer: { width: 0.011, length: 6 },
  },
  sniper: {
    sight: "scopeLens",
    hipSight: [0.14, -0.085, 0.22],
    hipRotation: [0, -0.03, 0],
    adsEyeDistance: 0.09,
    // Coated eyepiece: darker than the red dot's glass since the scope tube behind it is dark.
    optic: { glass: { tint: [0.25, 0.32, 0.3], alpha: 0.35 } },
    sprintOffset: [-0.03, -0.05, -0.04],
    sprintRotation: [0.32, -0.6, 0.35],
    recoil: { back: 0.07, up: 0.012, pitch: 0.16, yaw: 0.02, roll: 0.07, frequency: 6, damping: 0.55, adsScale: 0.6 },
    cameraPunch: { pitch: 0.024, yaw: 0.004, roll: 0.014 },
    muzzleFlash: { size: 0.1, length: 0.3, light: 3 },
    tracer: { width: 0.022, length: 12 },
  },
};
