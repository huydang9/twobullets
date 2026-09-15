import type { Node, TransformNode } from "@babylonjs/core";
import { MOVEMENT, type ConsumableItemId, type HitZone } from "@twobullets/shared";
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

export type ActionName = "fire" | "reload" | "hit" | "throwStand" | "throwCrouch" | "pickUp";

/** Upper-body one-shots. Times are clip seconds; fades are real seconds. */
export interface ActionSpec {
  readonly clip: Extract<CharacterClipName, "fire" | "reload" | "hit" | "throw_stand" | "throw_crouch" | "pick_up">;
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
  // Throws are triggered by the release event, so they join late in the wind-up: the hand opens at clip 0.87 s.
  throwStand: { clip: "throw_stand", start: 0.55, speed: 1.2, fadeIn: 0.08, fadeOut: 0.35, weight: 1 },
  throwCrouch: { clip: "throw_crouch", start: 0.55, speed: 1.2, fadeIn: 0.08, fadeOut: 0.35, weight: 1 },
  // A running grab into the pack: reads over any locomotion.
  pickUp: { clip: "pick_up", start: 0, speed: 1.1, fadeIn: 0.12, fadeOut: 0.25, weight: 0.9 },
};

/** Upper-body one-shots that take the hands off the rifle (the prop is hidden while they play). */
export const HANDS_BUSY_ACTIONS: ReadonlySet<ActionName> = new Set<ActionName>(["throwStand", "throwCrouch", "pickUp"]);

/** Held activities, driven by state rather than events (item use, giving CPR). */
export type SoldierActivity = "kneelHeal" | "bandage" | "drink" | "cpr";

export interface ActivitySpec {
  readonly clip: Extract<CharacterClipName, "heal_kneel" | "bandage" | "drink" | "cpr_give">;
  /** Kneeling clips stay full body while moving; standing ones drop to the upper body so the legs can walk. */
  readonly kneeling: boolean;
}

export const ACTIVITIES: Readonly<Record<SoldierActivity, ActivitySpec>> = {
  kneelHeal: { clip: "heal_kneel", kneeling: true },
  bandage: { clip: "bandage", kneeling: false },
  drink: { clip: "drink", kneeling: false },
  cpr: { clip: "cpr_give", kneeling: true },
};

export function activityForItem(item: ConsumableItemId): SoldierActivity {
  switch (item) {
    case "medkit":
    case "first_aid":
      return "kneelHeal";
    case "bandage":
      return "bandage";
    case "energy_drink":
    case "painkiller":
      return "drink";
  }
}

/**
 * Full-body clips the downed/revive graph uses. Lying clips put the head toward −Z (docs/assets-pipeline.md).
 * `writhe` (flat on the back) is not used: at a distance it read as a dead body.
 */
export const DOWNED = {
  /** The crawl is authored In Place; its planted hands travel about this fast, m/s. */
  crawlClipSpeed: 0.5,
  minCrawlPlayback: 0.6,
  maxCrawlPlayback: 2.4,
  /** Crawl starts above this speed and holds `crawlHold` seconds after dropping below it. */
  crawlStartSpeed: 0.25,
  crawlHold: 0.35,
  /** Seconds before the end of knock_down / get_up where the next pose starts blending in. */
  knockBlend: 0.35,
  getUpBlend: 0.4,
  /**
   * Knocked and still: the crawl settles on a frame with both hands and knees planted (crawl clip seconds) and sways
   * a little around it, so a knocked soldier stays up on all fours (~0.5 m) and visibly alive.
   */
  crawlRestTimes: [0.45, 1.35],
  swayAmplitude: 0.06,
  swayPeriod: 3.2,
} as const;

/** Dead-body presentation: flat and still, unlike the knocked crawl. */
export const DEAD = {
  /** knock_down clip second where the body lies flat face down (head 0.25 m, hips 0.15 m); later frames lift the head. */
  proneTime: 1.85,
  /** Weight rate of the collapse from the knocked crawl onto the prone frame, 1/s (slower than a death clip's fade). */
  collapseRate: 4,
  /** The body darkens slightly this long after death, in `tintSteps` shared material steps over `tintDuration`. */
  tintDelay: 2,
  tintDuration: 1.5,
  tintSteps: 4,
  /** Final albedo multiplier. */
  tintFactor: 0.7,
} as const;

/** Clip seconds forward from `time` to the next planted crawl frame (wrapping at `duration`). */
export function crawlRestAhead(time: number, duration: number): number {
  let best = Infinity;
  for (const rest of DOWNED.crawlRestTimes) {
    const ahead = (((rest - time) % duration) + duration) % duration;
    if (ahead < best) best = ahead;
  }
  return best;
}

/** Crawl clip second of the idle sway `clock` seconds after settling on `anchor`, wrapped into [0, duration). */
export function crawlSwayTime(anchor: number, clock: number, duration: number): number {
  const t = anchor + DOWNED.swayAmplitude * Math.sin((clock * Math.PI * 2) / DOWNED.swayPeriod);
  return ((t % duration) + duration) % duration;
}

/** Tint step (0 = untouched … `DEAD.tintSteps`) for a body dead for `seconds`. */
export function deadTintStep(seconds: number): number {
  if (!(seconds > DEAD.tintDelay)) return 0;
  return Math.min(DEAD.tintSteps, Math.ceil(((seconds - DEAD.tintDelay) / DEAD.tintDuration) * DEAD.tintSteps));
}

/** Albedo multiplier of a tint step. */
export function deadTintFactor(step: number): number {
  return 1 - ((1 - DEAD.tintFactor) * Math.min(step, DEAD.tintSteps)) / DEAD.tintSteps;
}

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
