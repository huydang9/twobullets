import { Color3, Matrix, TransformNode, Vector3, type Scene } from "@babylonjs/core";
import type { ConsumableItemId, ThrowableKind, ThrowPhase } from "@twobullets/shared";
import { HandsRig } from "../../viewmodel/HandsRig";
import { clamp, lerp, pulse, smoothstep } from "../../viewmodel/Spring";
import { prepareViewmodelMesh } from "../../viewmodel/Viewmodel";
import type { AssetLibrary } from "../../assets";
import type { Environment } from "../../world/environment";
import { EqCell, FLAME_FRAMES } from "./equipmentAtlas";
import type { EquipmentFx } from "./fxPools";
import type { HeldItem, HeldItemKind, ItemMeshLibrary } from "./itemMeshes";

type Tuple3 = readonly [number, number, number];

/** A hand pose: grip point position and rotation in camera space (m, radians), left arm swing (pitch, yaw). */
export interface HandPose {
  readonly position: Tuple3;
  readonly rotation: Tuple3;
  readonly left: readonly [pitch: number, yaw: number];
}

/**
 * Tunable poses (DEV: edit `__twobullets.presentation.equipment.hands.poses` live). Camera space: +X right, +Y up,
 * +Z forward; rotation x + tips the hand forward/down, y + turns it right, z + rolls counter-clockwise.
 */
export const HAND_POSES = {
  /** Below the screen, where draws start and put-aways end. */
  hidden: { position: [0.1, -0.46, 0.24], rotation: [0.9, -0.3, -0.35], left: [0.9, -0.1] },
  /** Grenade held in front, support hand on it. */
  ready: { position: [0.105, -0.125, 0.33], rotation: [0.14, -0.34, -0.22], left: [0, 0] },
  /** Support hand yanking the pin out to the left. */
  pinPull: { position: [0.1, -0.115, 0.31], rotation: [0.05, -0.28, -0.18], left: [0.12, -0.3] },
  /** Arm cocked back by the head, support hand dropped. */
  cockOverhand: { position: [0.2, -0.035, 0.15], rotation: [-0.55, -0.25, -0.55], left: [1.05, -0.15] },
  /** Low swing-back for an aimed (underhand) lob. */
  cockUnderhand: { position: [0.15, -0.27, 0.24], rotation: [0.55, -0.2, -0.12], left: [1.05, -0.15] },
  releaseOverhand: { position: [0.12, 0.0, 0.54], rotation: [0.5, -0.12, -0.1], left: [1.05, -0.1] },
  followOverhand: { position: [-0.06, -0.5, 0.36], rotation: [1.3, 0.25, 0.25], left: [1.05, 0] },
  releaseUnderhand: { position: [0.1, -0.07, 0.5], rotation: [-0.55, -0.1, -0.08], left: [1.05, -0.1] },
  followUnderhand: { position: [0.08, -0.38, 0.5], rotation: [0.6, 0, 0], left: [1.05, 0] },
  /** Both hands low in front working an item. */
  use: { position: [0.0, -0.165, 0.33], rotation: [0.38, -0.04, 0.0], left: [0, 0] },
  /** Can or bottle raised to the mouth. */
  drink: { position: [0.03, -0.045, 0.15], rotation: [-1.0, -0.2, 0.1], left: [1.0, -0.1] },
} satisfies Record<string, HandPose>;

/** How each item sits in the grip: local offset (m) and rotation (radians). */
const ITEM_GRIP: Readonly<Record<HeldItemKind, { readonly position: Tuple3; readonly rotation: Tuple3 }>> = {
  frag: { position: [0, 0.01, 0], rotation: [0.25, 0.4, 0] },
  smoke: { position: [0, 0.0, 0], rotation: [0.25, 0.4, 0] },
  flash: { position: [0, 0.0, 0], rotation: [0.25, 0.4, 0] },
  molotov: { position: [0, -0.02, 0], rotation: [0.2, 0.3, 0] },
  bandage: { position: [0, 0.03, 0.01], rotation: [0, 0.2, 0] },
  first_aid: { position: [0, 0.035, 0.02], rotation: [-0.5, 0, 0] },
  medkit: { position: [0, 0.05, 0.05], rotation: [-0.55, 0, 0] },
  energy_drink: { position: [0, 0.02, 0], rotation: [0.15, 0.3, 0] },
  painkiller: { position: [0, 0.02, 0], rotation: [0.15, 0.3, 0] },
};

const PIN_PULL_SECONDS = 0.2;
const RELEASE_SNAP_SECONDS = 0.07;
const RELEASE_SECONDS = 0.35;
const PUT_AWAY_SECONDS = 0.28;
const SPOON_SECONDS = 0.35;
const FLAME = new Color3(1, 1, 1);

/** What the hands should be doing this frame (from EquipmentView, or a DEV preview script). */
export interface HandsFrame {
  phase: ThrowPhase;
  kind: ThrowableKind | null;
  /** Aim held while the pin is pulled (underhand lob). */
  underhand: boolean;
  /** 0..1 of a cooked fuse. */
  cookProgress: number;
  useItem: ConsumableItemId | null;
  useProgress: number;
}

export function createHandsFrame(): HandsFrame {
  return { phase: "idle", kind: null, underhand: false, cookProgress: 0, useItem: null, useProgress: 0 };
}

/**
 * First-person hands for throwables and item use, fully procedural (the weapon GLBs have no throw clips): the pistol's
 * arms with the gun removed hold a procedural grenade or consumable. Every pose channel follows its target through a
 * damped spring, and the event timestamps (draw, pin pull, cook, release) pick targets and stiffness:
 * draw from below → ready → pin pull (support hand yanks the ring, then drops) → cocked overhand or low underhand
 * (by aim) with a cook tremble → a fast snap through the release point on the release tick → follow-through out of
 * view. Item use lowers both hands in front and animates per item from `progress`.
 */
export class ThrowableViewmodel {
  /** Live-tunable poses. */
  readonly poses = HAND_POSES;

  private readonly root: TransformNode;
  private readonly hands: HandsRig | null;
  private readonly items = new Map<HeldItemKind, HeldItem>();
  private item: HeldItem | null = null;
  private time = 0;
  private active = false;
  private hideAt = Infinity;

  private equipAt = -10;
  private pinAt = -10;
  private cookAt = -10;
  private releaseAt = -10;
  private releaseUnderhand = false;
  private useAt = -10;

  /** Pose channels: grip x, y, z, rotation x, y, z, left arm pitch, yaw. */
  private readonly value = new Float64Array(8);
  private readonly velocity = new Float64Array(8);
  private readonly target = new Float64Array(8);
  private readonly leftHand = new Vector3();
  private readonly itemInverse = new Matrix();
  private readonly flameTip = new Vector3();
  private readonly flameTop = new Vector3();

  constructor(
    scene: Scene,
    parent: TransformNode,
    assets: AssetLibrary | null,
    private readonly environment: Pick<Environment, "skyFill">,
    private readonly library: ItemMeshLibrary,
    private readonly fx: EquipmentFx,
  ) {
    this.hands = HandsRig.create(scene, assets, environment);
    this.root = this.hands?.root ?? new TransformNode("vm_hands_root", scene);
    this.root.parent = parent;
    this.root.setEnabled(false);
    this.hands?.setEnabled(false);
    this.snap(HAND_POSES.hidden);
  }

  /** True while hands are on screen (the gun should be stowed). */
  get visible(): boolean {
    return this.active;
  }

  get hasArms(): boolean {
    return this.hands !== null;
  }

  /** Throwable draw started. */
  equip(kind: ThrowableKind): void {
    this.show(kind);
    if (this.time - this.releaseAt > RELEASE_SECONDS) this.snap(HAND_POSES.hidden);
    this.equipAt = this.time;
    this.pinAt = this.cookAt = -10;
    this.resetParts();
  }

  pinPulled(): void {
    this.pinAt = this.time;
  }

  cookStarted(): void {
    this.cookAt = this.time;
  }

  /** The grenade left the hand (or was dropped / went off in it). */
  released(style: "overhand" | "underhand" | "dropped" | "inHand"): void {
    this.releaseAt = this.time;
    this.releaseUnderhand = style === "underhand";
    if (this.item) this.item.root.setEnabled(false);
    if (style === "dropped" || style === "inHand") this.putAway();
  }

  /** Pin returned, holstered, depleted or an item use ended: hands go down and disappear. */
  putAway(): void {
    if (!this.active || this.hideAt < Infinity) return;
    this.hideAt = this.time + PUT_AWAY_SECONDS;
  }

  useStarted(itemId: ConsumableItemId): void {
    this.show(itemId);
    this.snap(HAND_POSES.hidden);
    this.useAt = this.time;
    this.resetParts();
  }

  /** Per frame after the viewmodel pose (the parent motion node) is up to date. */
  update(dt: number, frame: HandsFrame): void {
    this.time += dt;
    if (!this.active) return;
    if (this.time >= this.hideAt) {
      this.setActive(false);
      return;
    }
    const t = this.time;
    const putting = this.hideAt < Infinity;
    let frequency = 7;
    let damping = 0.8;
    let tremble = 0;

    if (putting) {
      this.setTarget(HAND_POSES.hidden);
      frequency = 6;
    } else if (frame.useItem !== null && this.item?.kind === frame.useItem) {
      frequency = this.useTarget(frame.useItem, frame.useProgress, t - this.useAt);
    } else if (t - this.releaseAt < RELEASE_SECONDS) {
      const since = t - this.releaseAt;
      const snapping = since < RELEASE_SNAP_SECONDS;
      const under = this.releaseUnderhand;
      this.setTarget(snapping ? (under ? HAND_POSES.releaseUnderhand : HAND_POSES.releaseOverhand) : under ? HAND_POSES.followUnderhand : HAND_POSES.followOverhand);
      frequency = snapping ? 16 : 7;
      damping = 1;
    } else if (frame.phase === "primed" || frame.phase === "cooking") {
      const since = t - this.pinAt;
      if (since < PIN_PULL_SECONDS) {
        this.setTarget(HAND_POSES.pinPull);
        frequency = 12;
      } else {
        this.setTarget(frame.underhand ? HAND_POSES.cockUnderhand : HAND_POSES.cockOverhand);
        frequency = 6.5;
        tremble = frame.phase === "cooking" ? 0.3 + 0.7 * frame.cookProgress : 0.15;
      }
    } else if (frame.phase === "equipping" || frame.phase === "ready" || frame.phase === "releasing") {
      if (frame.phase === "releasing" || frame.kind === null) this.setTarget(HAND_POSES.hidden);
      else this.setTarget(HAND_POSES.ready);
      frequency = t - this.equipAt < 0.5 ? 5.5 : 7;
    } else {
      this.putAway();
      this.setTarget(HAND_POSES.hidden);
    }

    // Damped springs toward the target pose, closed form (frame-rate independent), inline over typed arrays so no
    // doubles cross a call boundary.
    const target = this.target;
    const value = this.value;
    const velocity = this.velocity;
    const w = 2 * Math.PI * frequency;
    if (dt > 0) {
      if (damping < 0.9999) {
        const wd = w * Math.sqrt(1 - damping * damping);
        const decay = Math.exp(-damping * w * dt);
        const c = Math.cos(wd * dt);
        const sn = Math.sin(wd * dt);
        for (let i = 0; i < 8; i++) {
          const x = value[i]! - target[i]!;
          const v = velocity[i]!;
          value[i] = target[i]! + decay * (x * c + ((v + damping * w * x) / wd) * sn);
          velocity[i] = decay * (v * c - ((w * w * x + damping * w * v) / wd) * sn);
        }
      } else {
        const decay = Math.exp(-w * dt);
        for (let i = 0; i < 8; i++) {
          const x = value[i]! - target[i]!;
          const v = velocity[i]!;
          const b = v + w * x;
          value[i] = target[i]! + (x + b * dt) * decay;
          velocity[i] = (v - w * b * dt) * decay;
        }
      }
    }
    const shake = tremble * 0.0025;
    const breathe = Math.sin(t * 1.6) * 0.0018;
    this.root.position.set(value[0]! + Math.sin(t * 31) * shake, value[1]! + breathe + Math.sin(t * 27 + 1.3) * shake, value[2]!);
    this.root.rotation.set(value[3]! + breathe * 2, value[4]!, value[5]! + Math.sin(t * 23) * shake * 4);
    this.hands?.setLeftArm(value[6]!, value[7]!);
    this.hands?.update();
    this.animateParts(frame);
  }

  dispose(): void {
    for (const item of this.items.values()) item.root.dispose();
    this.items.clear();
    this.hands?.dispose();
    if (!this.hands) this.root.dispose();
  }

  private show(kind: HeldItemKind): void {
    const item = this.heldItem(kind);
    if (this.item && this.item !== item) this.item.root.setEnabled(false);
    this.item = item;
    item.root.setEnabled(true);
    const grip = ITEM_GRIP[kind];
    item.root.position.set(grip.position[0], grip.position[1], grip.position[2]);
    item.root.rotation.set(grip.rotation[0], grip.rotation[1], grip.rotation[2]);
    this.hideAt = Infinity;
    this.setActive(true);
  }

  private setActive(active: boolean): void {
    this.active = active;
    this.root.setEnabled(active);
    this.hands?.setEnabled(active);
    if (!active) {
      this.hideAt = Infinity;
      this.snap(HAND_POSES.hidden);
    }
  }

  private heldItem(kind: HeldItemKind): HeldItem {
    let item = this.items.get(kind);
    if (!item) {
      item = this.library.createHeld(kind);
      item.root.parent = this.root;
      for (const mesh of item.meshes) prepareViewmodelMesh(mesh, this.environment);
      this.items.set(kind, item);
    }
    return item;
  }

  private resetParts(): void {
    const item = this.item;
    if (!item) return;
    item.root.setEnabled(true);
    if (item.spoon) {
      item.spoon.setEnabled(true);
      item.spoon.position.copyFrom(item.spoonRest);
      item.spoon.rotation.setAll(0);
    }
    if (item.ring) {
      item.ring.setEnabled(true);
      item.ring.position.copyFrom(item.ringRest);
      item.ring.rotation.setAll(0);
    }
  }

  private animateParts(frame: HandsFrame): void {
    const item = this.item;
    if (!item) return;
    const t = this.time;
    // Pin ring: follows the support hand out during the pull, then it's gone with the dropped hand.
    if (item.ring) {
      const since = t - this.pinAt;
      if (this.pinAt > this.equipAt && since >= 0) {
        const follow = smoothstep(0.02, 0.14, since);
        if (since > PIN_PULL_SECONDS + 0.12) {
          item.ring.setEnabled(false);
        } else if (this.hands?.getLeftHandWorldToRef(this.leftHand)) {
          // The ring's rest offset is zero (baked into its vertices), so carry that offset to the hand in item space.
          item.root.computeWorldMatrix(true);
          item.root.getWorldMatrix().invertToRef(this.itemInverse);
          Vector3.TransformCoordinatesToRef(this.leftHand, this.itemInverse, this.leftHand);
          Vector3.LerpToRef(item.ringRest, this.leftHand, follow, item.ring.position);
        } else {
          item.ring.position.set(item.ringRest.x - 0.12 * follow, item.ringRest.y, item.ringRest.z - 0.05 * follow);
        }
      }
    }
    // Spoon: flips off when the fuse starts (cook) or the grenade leaves the hand.
    if (item.spoon) {
      const since = t - Math.max(this.cookAt, this.releaseAt > this.equipAt ? this.releaseAt : -10);
      if (since >= 0 && since < 5) {
        if (since > SPOON_SECONDS) {
          item.spoon.setEnabled(false);
        } else {
          item.spoon.position.set(item.spoonRest.x + since * 0.25, item.spoonRest.y + since * 0.5 - since * since * 3, item.spoonRest.z - since * 0.35);
          item.spoon.rotation.set(since * 22, since * 8, 0);
        }
      }
    }
    // Molotov rag burns once lit (pin pull stands in for the lighter).
    if (item.flameTip && (frame.phase === "primed" || frame.phase === "cooking") && item.root.isEnabled()) {
      item.root.computeWorldMatrix(true);
      Vector3.TransformCoordinatesToRef(item.flameTip, item.root.getWorldMatrix(), this.flameTip);
      for (let i = 0; i < 2; i++) {
        this.flameTop.set(this.flameTip.x + Math.sin(t * 9 + i) * 0.006, this.flameTip.y + 0.07 + 0.02 * Math.sin(t * 15 + i * 2), this.flameTip.z);
        const cell = EqCell.flame0 + (Math.floor(t * 16 + i * 3) % FLAME_FRAMES);
        this.fx.viewmodelBatch.streak(this.flameTip, this.flameTop, 0.022 - i * 0.006, cell, FLAME, 0.9, 1);
      }
    }
  }

  /** Item-use motion targets; returns the spring frequency. */
  private useTarget(itemId: ConsumableItemId, progress: number, elapsed: number): number {
    const base = HAND_POSES.use;
    const target = this.target;
    this.setTarget(base);
    const item = this.item;
    const grip = ITEM_GRIP[itemId];
    if (item) item.root.rotation.set(grip.rotation[0], grip.rotation[1], grip.rotation[2]);
    const t = elapsed;
    switch (itemId) {
      case "bandage": {
        // Wrapping: small circles, the roll turning.
        target[0]! += Math.sin(t * 5) * 0.025;
        target[1]! += Math.cos(t * 5) * 0.015;
        target[7]! = -0.1 + Math.sin(t * 5 + 1) * 0.08;
        if (item) item.root.rotation.x = grip.rotation[0] + t * 5;
        return 9;
      }
      case "first_aid": {
        const open = pulse(0.1, 0.85, progress);
        target[1]! += Math.sin(t * 3) * 0.008;
        target[3]! += 0.25 * open;
        if (item) item.root.rotation.x = grip.rotation[0] + 0.35 * open * Math.abs(Math.sin(t * 2.5));
        return 7;
      }
      case "medkit": {
        const inject = pulse(0.55, 0.9, progress);
        target[1]! += -0.02 + 0.06 * inject;
        target[2]! += -0.07 * inject;
        target[6]! = 0.7 * inject;
        return 6;
      }
      case "energy_drink":
      case "painkiller": {
        const shaking = itemId === "painkiller" ? pulse(0.08, 0.4, progress) : 0;
        target[1]! += Math.sin(t * 30) * 0.012 * shaking;
        const raiseStart = itemId === "painkiller" ? 0.5 : 0.25;
        const raise = smoothstep(raiseStart, raiseStart + 0.15, progress) * (1 - smoothstep(0.85, 0.97, progress));
        this.blendTarget(HAND_POSES.drink, raise);
        return 6;
      }
    }
  }

  private setTarget(pose: HandPose): void {
    const target = this.target;
    target[0] = pose.position[0];
    target[1] = pose.position[1];
    target[2] = pose.position[2];
    target[3] = pose.rotation[0];
    target[4] = pose.rotation[1];
    target[5] = pose.rotation[2];
    target[6] = pose.left[0];
    target[7] = pose.left[1];
  }

  private blendTarget(pose: HandPose, weight: number): void {
    const w = clamp(weight, 0, 1);
    const target = this.target;
    target[0] = lerp(target[0]!, pose.position[0], w);
    target[1] = lerp(target[1]!, pose.position[1], w);
    target[2] = lerp(target[2]!, pose.position[2], w);
    target[3] = lerp(target[3]!, pose.rotation[0], w);
    target[4] = lerp(target[4]!, pose.rotation[1], w);
    target[5] = lerp(target[5]!, pose.rotation[2], w);
    target[6] = lerp(target[6]!, pose.left[0], w);
    target[7] = lerp(target[7]!, pose.left[1], w);
  }

  private snap(pose: HandPose): void {
    this.setTarget(pose);
    this.value.set(this.target);
    this.velocity.fill(0);
  }
}
