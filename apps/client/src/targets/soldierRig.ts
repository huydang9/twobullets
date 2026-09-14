import type { Node, TransformNode } from "@babylonjs/core";
import { MOVEMENT, type HitZone } from "@twobullets/shared";
import type { CharacterAsset, CharacterBoneRole, CharacterClipName } from "../assets";

/**
 * Static tuning for the SWAT soldier rig (Mixamo skeleton, 1.78 m bind height, facing +Z).
 * Lengths here are in bind-pose meters; multiply by `soldierScale()` for world units.
 */

export const SOLDIER_HEIGHT = MOVEMENT.standHeight;

export function soldierScale(asset: CharacterAsset): number {
  return SOLDIER_HEIGHT / asset.height;
}

/**
 * Hitbox shapes are placed along a bone's +Y axis (Mixamo bones point +Y at their child), starting at the joint.
 * Boxes: `width` spans the bone's X axis (lateral on spine bones), `depth` its Z axis.
 */
export type SoldierHitboxShape =
  | { readonly kind: "sphere"; readonly at: number; readonly radius: number }
  | { readonly kind: "capsule"; readonly from: number; readonly to: number; readonly radius: number }
  | { readonly kind: "box"; readonly from: number; readonly to: number; readonly width: number; readonly depth: number };

export interface SoldierHitboxDef {
  readonly name: string;
  readonly zone: HitZone;
  readonly bone: CharacterBoneRole;
  readonly shape: SoldierHitboxShape;
}

/** Sized from skinned bind-pose cross sections of swat.glb (vest and helmet included). */
export const SOLDIER_HITBOXES: readonly SoldierHitboxDef[] = [
  { name: "head", zone: "head", bone: "head", shape: { kind: "sphere", at: 0.095, radius: 0.125 } },
  { name: "neck", zone: "body", bone: "neck", shape: { kind: "capsule", from: 0, to: 0.07, radius: 0.07 } },
  { name: "chest", zone: "body", bone: "chest", shape: { kind: "box", from: -0.15, to: 0.14, width: 0.4, depth: 0.37 } },
  { name: "abdomen", zone: "body", bone: "spine", shape: { kind: "box", from: 0, to: 0.18, width: 0.4, depth: 0.36 } },
  { name: "pelvis", zone: "body", bone: "hips", shape: { kind: "box", from: -0.14, to: 0.1, width: 0.42, depth: 0.32 } },
  { name: "upperArmL", zone: "limb", bone: "leftUpperArm", shape: { kind: "capsule", from: 0, to: 0.277, radius: 0.07 } },
  { name: "upperArmR", zone: "limb", bone: "rightUpperArm", shape: { kind: "capsule", from: 0, to: 0.277, radius: 0.07 } },
  // Forearms run through the gloved hand.
  { name: "forearmL", zone: "limb", bone: "leftForeArm", shape: { kind: "capsule", from: 0, to: 0.36, radius: 0.055 } },
  { name: "forearmR", zone: "limb", bone: "rightForeArm", shape: { kind: "capsule", from: 0, to: 0.36, radius: 0.055 } },
  { name: "thighL", zone: "limb", bone: "leftUpLeg", shape: { kind: "capsule", from: 0, to: 0.418, radius: 0.1 } },
  { name: "thighR", zone: "limb", bone: "rightUpLeg", shape: { kind: "capsule", from: 0, to: 0.418, radius: 0.1 } },
  // Shins reach down past the ankle; the caps cover most of the boot.
  { name: "shinL", zone: "limb", bone: "leftLeg", shape: { kind: "capsule", from: 0, to: 0.43, radius: 0.075 } },
  { name: "shinR", zone: "limb", bone: "rightLeg", shape: { kind: "capsule", from: 0, to: 0.43, radius: 0.075 } },
];

export type LocomotionClip = Extract<
  CharacterClipName,
  | "walk_fwd"
  | "walk_back"
  | "walk_left"
  | "walk_right"
  | "run_fwd"
  | "run_back"
  | "run_left"
  | "run_right"
  | "sprint_fwd"
  | "crouch_walk_fwd"
>;

export type ActionName = "fire" | "reload" | "hit";

/** Upper-body one-shots. Times are clip seconds; fades are real seconds. */
export interface ActionSpec {
  readonly clip: Extract<CharacterClipName, "fire" | "reload" | "hit">;
  readonly start: number;
  /** Clip time the action ends at (the rest of the clip is skipped). Defaults to the clip end. */
  readonly end?: number;
  readonly speed: number;
  readonly fadeIn: number;
  readonly fadeOut: number;
  /** Peak upper-body influence. */
  readonly weight: number;
}

export const ACTIONS: Readonly<Record<ActionName, ActionSpec>> = {
  fire: { clip: "fire", start: 0, speed: 1, fadeIn: 0.03, fadeOut: 0.1, weight: 1 },
  reload: { clip: "reload", start: 0, speed: 1, fadeIn: 0.2, fadeOut: 0.3, weight: 1 },
  // The clip is a 2.3 s stagger; its first 1.35 s (flinch back and recover) played fast reads as a flinch.
  hit: { clip: "hit", start: 0, end: 1.35, speed: 1.8, fadeIn: 0.05, fadeOut: 0.3, weight: 0.85 },
};

/** jump_up opens with a 0.27 s squat we skip, since the jump has already left the ground. */
export const JUMP_UP_START = 0.27;
/** jump_down holds the air pose for 0.33 s before the landing impact. */
export const JUMP_DOWN_START = 0.33;

/**
 * Upper-body layer influence per skeleton node name: 1 from the chest up (arms, neck, head), easing in along the
 * spine chain below it so layered clips twist the torso without detaching it from the hips.
 */
export function upperBodyWeights(bones: Readonly<Record<CharacterBoneRole, TransformNode>>): Map<string, number> {
  const weights = new Map<string, number>([[bones.chest.name, 1]]);
  for (const node of bones.chest.getDescendants(false)) weights.set(node.name, 1);

  // Spine chain from `spine` up to, not including, `chest`: Spine 1/3, Spine1 2/3 on the Mixamo rig.
  const chain: Node[] = [];
  for (let node = bones.chest.parent; node && node !== bones.hips; node = node.parent) {
    chain.unshift(node);
    if (node === bones.spine) break;
  }
  chain.forEach((node, i) => weights.set(node.name, (i + 1) / (chain.length + 1)));
  return weights;
}
