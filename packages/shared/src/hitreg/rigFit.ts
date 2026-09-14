import type { HitZone } from "../weapons/types";

// Hand-fitted soldier rig (ADR 0003): the 13 SOLDIER_HITBOXES shapes (apps/client/src/targets/soldierRig.ts, same
// order, zones and sizes at the 1.8 m soldier scale) placed in the player's local frame for the stand, crouch and
// prone (knocked crawl) poses at level aim. Local frame: feet origin, +X right, +Y up, +Z forward. Replaced by the
// generated fit (`soldierRigFit.generated.ts`, tools/assets/fit-hitbox-rig.ts) in M4; values here are eyeballed from the
// SWAT idle-aim, crouch-aim and a flat crawl pose, generous by a few centimetres.

type V3 = readonly [x: number, y: number, z: number];

export interface RigFitShape {
  readonly name: string;
  readonly kind: "sphere" | "capsule" | "box";
  readonly zone: HitZone;
  /** Sphere/box centre, or capsule start. */
  readonly a: V3;
  /** Capsule end (ignored otherwise). */
  readonly b: V3;
  /** Sphere/capsule radius, m. */
  readonly radius: number;
  /** Box half extents along the box's local X (lateral), Y (along the bone) and Z (depth), m. */
  readonly half: V3;
  /** Box forward tilt around local X, radians (+ tips the top forward). */
  readonly lean: number;
}

export interface RigFitPose {
  readonly shapes: readonly RigFitShape[];
  /** Aim pitch rotates the upper body around this point (shoulder line centre). */
  readonly pivot: V3;
  /** Multiplier on every shape's pitch share (0 = aim pitch doesn't move the rig). */
  readonly pitchScale: number;
}

/** Bind metres (1.78 m model) → world metres (MOVEMENT.standHeight 1.8). */
const S = 1.8 / 1.78;

const HEAD_R = 0.125 * S;
const NECK_R = 0.07 * S;
const UPPER_ARM_R = 0.07 * S;
const FOREARM_R = 0.055 * S;
const THIGH_R = 0.1 * S;
const SHIN_R = 0.075 * S;
const CHEST_HALF: V3 = [0.2 * S, 0.145 * S, 0.185 * S];
const ABDOMEN_HALF: V3 = [0.2 * S, 0.09 * S, 0.18 * S];
const PELVIS_HALF: V3 = [0.21 * S, 0.12 * S, 0.16 * S];
const NONE: V3 = [0, 0, 0];

/** Share of the aim pitch each shape follows, in SOLDIER_HITBOXES order. */
export const RIG_PITCH_SHARE: readonly number[] = [0.6, 0.4, 0.25, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0];

function sphere(name: string, zone: HitZone, a: V3, radius: number): RigFitShape {
  return { name, kind: "sphere", zone, a, b: a, radius, half: NONE, lean: 0 };
}

function capsule(name: string, zone: HitZone, a: V3, b: V3, radius: number): RigFitShape {
  return { name, kind: "capsule", zone, a, b, radius, half: NONE, lean: 0 };
}

function box(name: string, a: V3, half: V3, lean: number): RigFitShape {
  return { name, kind: "box", zone: "body", a, b: a, radius: 0, half, lean };
}

const DEG = Math.PI / 180;

export const RIG_FIT_STAND: RigFitPose = {
  pivot: [0, 1.42, 0.02],
  pitchScale: 1,
  shapes: [
    sphere("head", "head", [0, 1.665, 0.035], HEAD_R),
    capsule("neck", "body", [0, 1.49, 0.0], [0, 1.565, 0.02], NECK_R),
    box("chest", [0, 1.3, 0.02], CHEST_HALF, 4 * DEG),
    box("abdomen", [0, 1.11, 0.0], ABDOMEN_HALF, 0),
    box("pelvis", [0, 0.96, -0.01], PELVIS_HALF, 0),
    capsule("upperArmL", "limb", [-0.2, 1.42, 0.0], [-0.21, 1.19, 0.15], UPPER_ARM_R),
    capsule("upperArmR", "limb", [0.2, 1.42, 0.0], [0.23, 1.18, 0.12], UPPER_ARM_R),
    capsule("forearmL", "limb", [-0.21, 1.19, 0.15], [0.01, 1.33, 0.46], FOREARM_R),
    capsule("forearmR", "limb", [0.23, 1.18, 0.12], [0.12, 1.28, 0.42], FOREARM_R),
    capsule("thighL", "limb", [-0.1, 0.93, 0.0], [-0.11, 0.51, 0.03], THIGH_R),
    capsule("thighR", "limb", [0.1, 0.93, 0.0], [0.12, 0.51, 0.01], THIGH_R),
    capsule("shinL", "limb", [-0.11, 0.51, 0.03], [-0.12, 0.08, -0.03], SHIN_R),
    capsule("shinR", "limb", [0.12, 0.51, 0.01], [0.13, 0.08, -0.05], SHIN_R),
  ],
};

export const RIG_FIT_CROUCH: RigFitPose = {
  pivot: [0, 0.76, 0.1],
  pitchScale: 1,
  shapes: [
    sphere("head", "head", [0, 0.965, 0.14], HEAD_R),
    capsule("neck", "body", [0, 0.8, 0.08], [0, 0.875, 0.11], NECK_R),
    box("chest", [0, 0.65, 0.07], CHEST_HALF, 18 * DEG),
    box("abdomen", [0, 0.48, 0.0], ABDOMEN_HALF, 22 * DEG),
    box("pelvis", [0, 0.36, -0.08], PELVIS_HALF, 25 * DEG),
    capsule("upperArmL", "limb", [-0.2, 0.76, 0.1], [-0.22, 0.54, 0.25], UPPER_ARM_R),
    capsule("upperArmR", "limb", [0.2, 0.76, 0.1], [0.24, 0.53, 0.22], UPPER_ARM_R),
    capsule("forearmL", "limb", [-0.22, 0.54, 0.25], [0.01, 0.66, 0.55], FOREARM_R),
    capsule("forearmR", "limb", [0.24, 0.53, 0.22], [0.12, 0.61, 0.5], FOREARM_R),
    capsule("thighL", "limb", [-0.1, 0.36, -0.06], [-0.14, 0.46, 0.34], THIGH_R),
    capsule("thighR", "limb", [0.1, 0.36, -0.06], [0.15, 0.1, 0.22], THIGH_R),
    capsule("shinL", "limb", [-0.14, 0.46, 0.34], [-0.14, 0.08, 0.22], SHIN_R),
    capsule("shinR", "limb", [0.15, 0.1, 0.22], [0.15, 0.08, -0.2], SHIN_R),
  ],
};

/** Knocked crawl: lying flat along +Z, head forward, arms reaching ahead. */
export const RIG_FIT_PRONE: RigFitPose = {
  pivot: [0, 0.22, 0.55],
  pitchScale: 0,
  shapes: [
    sphere("head", "head", [0, 0.25, 0.8], HEAD_R),
    capsule("neck", "body", [0, 0.2, 0.6], [0, 0.22, 0.67], NECK_R),
    box("chest", [0, 0.19, 0.42], CHEST_HALF, 90 * DEG),
    box("abdomen", [0, 0.18, 0.19], ABDOMEN_HALF, 90 * DEG),
    box("pelvis", [0, 0.17, -0.03], PELVIS_HALF, 90 * DEG),
    capsule("upperArmL", "limb", [-0.21, 0.2, 0.55], [-0.3, 0.1, 0.78], UPPER_ARM_R),
    capsule("upperArmR", "limb", [0.21, 0.2, 0.55], [0.3, 0.1, 0.78], UPPER_ARM_R),
    capsule("forearmL", "limb", [-0.3, 0.1, 0.78], [-0.22, 0.07, 1.12], FOREARM_R),
    capsule("forearmR", "limb", [0.3, 0.1, 0.78], [0.22, 0.07, 1.12], FOREARM_R),
    capsule("thighL", "limb", [-0.1, 0.14, -0.14], [-0.14, 0.11, -0.56], THIGH_R),
    capsule("thighR", "limb", [0.1, 0.14, -0.14], [0.14, 0.11, -0.56], THIGH_R),
    capsule("shinL", "limb", [-0.14, 0.11, -0.56], [-0.17, 0.08, -0.98], SHIN_R),
    capsule("shinR", "limb", [0.14, 0.11, -0.56], [0.17, 0.08, -0.98], SHIN_R),
  ],
};

/** Poses by stance blend key: 0 stand, 1 crouch, 2 prone. */
export const RIG_FIT_POSES: readonly [RigFitPose, RigFitPose, RigFitPose] = [RIG_FIT_STAND, RIG_FIT_CROUCH, RIG_FIT_PRONE];

/** Every posed shape lies within this distance of (feet + RIG_BOUNDS_CENTER_Y), m (checked by the rig tests). */
export const RIG_BOUNDS_RADIUS = 1.5;
export const RIG_BOUNDS_CENTER_Y = 0.9;
