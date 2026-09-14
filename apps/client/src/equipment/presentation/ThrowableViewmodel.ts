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

/**
 * A hand pose: rig root position and rotation in camera space (m, radians), left arm swing (pitch, yaw), and for the
 * throw-arms rig a right arm pitch (+ lowers the hand) and a right wrist turn (radians about the wrist's own Z).
 */
export interface HandPose {
  readonly position: Tuple3;
  readonly rotation: Tuple3;
  readonly left: readonly [pitch: number, yaw: number];
  readonly right?: number;
  readonly wrist?: number;
}

/**
 * Tunable poses for the fallback rig (the pistol's arms; root = grip point). DEV: edit
 * `__twobullets.presentation.equipment.hands.poses` live. Camera space: +X right, +Y up, +Z forward; rotation x + tips
 * the hand forward/down, y + turns it right, z + rolls counter-clockwise.
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

export type HandPoseName = keyof typeof HAND_POSES;

/**
 * Poses for the throw-arms rig (DJMaesen "Arms throwing"). Root = the arms' source origin, so positions place the whole
 * rig; the clip supplies the arm motion (wind-up, throw, follow-through) and these add the framing around it. The
 * wrist turn shows the grenade instead of the back of the fist. Same keys and DEV live-tuning as HAND_POSES.
 */
export const ARM_POSES = {
  hidden: { position: [-0.01, -0.3, 0.3], rotation: [0.75, 0, 0], left: [0.3, 0], right: 0, wrist: -1.6 },
  /** Fist low right about 0.35 m out, like the weapons' hip framing; the left hand low left. */
  ready: { position: [-0.03, 0.0, 0.41], rotation: [0, 0, 0], left: [0, 0], right: 0, wrist: -1.6 },
  /** Left hand swings in toward the ring on the right fist (kept level: raising it brings the upper arm into view). */
  pinPull: { position: [-0.03, 0.0, 0.41], rotation: [0, 0, 0], left: [0.05, 0.5], right: 0, wrist: -1.6 },
  /** Clip barely into the wind-up (the full wind-up plays at release): fist still low right. */
  cockOverhand: { position: [-0.02, 0.0, 0.42], rotation: [0, 0, 0], left: [0.35, -0.1], right: 0, wrist: -1.6 },
  /** Aimed lob: fist a little lower, arm pitched down. */
  cockUnderhand: { position: [-0.03, 0.1, 0.42], rotation: [0, 0, 0], left: [0.35, -0.1], right: 0.12, wrist: -1.6 },
  /** Placement while the throw plays, far enough out that the upper arm stays behind the camera. */
  releaseOverhand: { position: [-0.03, -0.02, 0.4], rotation: [0, 0, 0], left: [0.35, -0.1], right: 0, wrist: 0 },
  followOverhand: { position: [-0.03, -0.08, 0.38], rotation: [0.1, 0, 0], left: [0.35, -0.1], right: 0, wrist: 0 },
  releaseUnderhand: { position: [-0.03, 0.0, 0.4], rotation: [-0.1, 0, 0], left: [0.35, -0.1], right: -0.1, wrist: 0 },
  followUnderhand: { position: [-0.03, -0.06, 0.38], rotation: [0, 0, 0], left: [0.35, -0.1], right: 0, wrist: 0 },
  /** The item in the right fist low in front of the chest, the left hand in to help. */
  use: { position: [-0.2, -0.02, 0.41], rotation: [0, 0, 0], left: [0.05, 0.3], right: 0, wrist: -2.2 },
  /** Can or bottle tipped up toward the mouth, still a hand's length from the lens. */
  drink: { position: [-0.2, 0.05, 0.36], rotation: [-0.2, 0, 0], left: [0.4, -0.1], right: 0, wrist: -2.2 },
} satisfies Record<HandPoseName, HandPose>;

/** How each procedural item sits in the fallback rig's grip: local offset (m) and rotation (radians). */
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

/**
 * Items in the throw arms' fist, in grip space (the pipeline's `grip` node: +Y out of the thumb side of the fist). +X
 * moves the item out into the open palm so the fist doesn't hide it (checked by tools/assets/equipment/framing.ts). The
 * grenades' fuse axis already matches it; bottles slide so the fist closes around the body, the medkit case rests
 * flat across the fist like a tray.
 */
const CLIP_ITEM_GRIP: Readonly<Record<HeldItemKind, { readonly position: Tuple3; readonly rotation: Tuple3 }>> = {
  frag: { position: [0.02, 0, 0], rotation: [0, 0, 0] },
  smoke: { position: [0.02, -0.02, 0], rotation: [0, 0, 0] },
  flash: { position: [0.02, -0.02, 0], rotation: [0, 0, 0] },
  molotov: { position: [0.02, -0.05, 0], rotation: [0, 0, 0] },
  bandage: { position: [0.02, 0.03, 0], rotation: [0, 0, 0] },
  first_aid: { position: [0, 0.02, 0.02], rotation: [0, 0, 0] },
  // Counter-rotated against the use pose's wrist turn so the case stays flat.
  medkit: { position: [0, 0, 0.1], rotation: [0, 0, 2.2] },
  energy_drink: { position: [0.02, -0.02, 0], rotation: [0, 0, 0] },
  painkiller: { position: [0.02, 0.01, 0], rotation: [0, 0, 0] },
};

const PIN_PULL_SECONDS = 0.2;
const RELEASE_SNAP_SECONDS = 0.07;
const RELEASE_SECONDS = 0.35;
const PUT_AWAY_SECONDS = 0.28;
const SPOON_SECONDS = 0.35;
const FLAME = new Color3(1, 1, 1);

/** Throw-arms clip timing, time-scaled to the design's 0.35 s release phase (docs/equipment/design.md §3.1). */
const CLIP = {
  /** Wind-up into the hold after the pin pull. */
  windupSeconds: 0.28,
  /**
   * Source frame held while primed or cooking (inside the "windup" clip). Kept near the ready pose: further in, the fist
   * rises past the top of the view and comes within 0.2 m of the camera.
   */
  overhandHoldFrame: 0.5,
  underhandHoldFrame: 0,
  /** From the hold frame through the rest of the wind-up and the release, then "follow" and "recover"; sums to 0.35 s. */
  throwSeconds: 0.1,
  followSeconds: 0.09,
  recoverSeconds: 0.16,
};

const CHANNELS = 10;

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
 * First-person hands for throwables and item use. With the equipment art, DJMaesen's throwing arms play their single
 * throw clip cut into phases (time-scaled to the throw state), the real grenade or consumable sits in the right fist,
 * and procedural layers add what the clip lacks: the draw and put-away (rig springs in from below), the pin pull (left
 * arm swing, ring following the left hand), the cook hold and tremble, the underhand variant (right arm pitch) and the
 * item-use motions. Without it, the pistol's frozen arms hold a procedural item, fully spring-posed (the milestone 2.5
 * behaviour). Every pose channel follows its target through a damped spring; event timestamps pick targets.
 */
export class ThrowableViewmodel {
  /** Live-tunable poses for the rig in use (ARM_POSES or HAND_POSES). */
  readonly poses: Record<HandPoseName, HandPose>;
  /** Live-tunable item placement in the grip. */
  readonly grips: Record<HeldItemKind, { position: Tuple3; rotation: Tuple3 }>;
  /** Live-tunable clip timing (throw-arms rig only). */
  readonly clip = CLIP;

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
  private releaseThrown = false;
  private releaseFromFrame = 0;
  private useAt = -10;
  private frame = 0;

  /** Pose channels: root x, y, z, rotation x, y, z, left arm pitch, yaw, right arm pitch, wrist turn. */
  private readonly value = new Float64Array(CHANNELS);
  private readonly velocity = new Float64Array(CHANNELS);
  private readonly target = new Float64Array(CHANNELS);
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
    this.poses = this.hands?.clip ? ARM_POSES : HAND_POSES;
    this.grips = this.hands?.clip ? { ...CLIP_ITEM_GRIP } : { ...ITEM_GRIP };
    this.root = this.hands?.root ?? new TransformNode("vm_hands_root", scene);
    this.root.parent = parent;
    this.root.setEnabled(false);
    this.hands?.setEnabled(false);
    this.snap(this.poses.hidden);
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
    if (this.time - this.releaseAt > RELEASE_SECONDS) this.snap(this.poses.hidden);
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
    this.releaseFromFrame = this.frame;
    const thrown = style === "overhand" || style === "underhand";
    this.releaseThrown = thrown;
    // The throw clip lets go when its fingers open; otherwise the item is gone now.
    if (this.item && !(thrown && this.hands?.clip)) this.item.root.setEnabled(false);
    if (!thrown) this.putAway();
  }

  /** Pin returned, holstered, depleted or an item use ended: hands go down and disappear. */
  putAway(): void {
    if (!this.active || this.hideAt < Infinity) return;
    this.hideAt = this.time + PUT_AWAY_SECONDS;
  }

  useStarted(itemId: ConsumableItemId): void {
    this.show(itemId);
    this.snap(this.poses.hidden);
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
    const poses = this.poses;
    const t = this.time;
    const putting = this.hideAt < Infinity;
    const releasing = t - this.releaseAt < RELEASE_SECONDS;
    let frequency = 7;
    let damping = 0.8;
    let tremble = 0;

    if (putting) {
      this.setTarget(poses.hidden);
      frequency = 6;
    } else if (frame.useItem !== null && this.item?.kind === frame.useItem) {
      frequency = this.useTarget(frame.useItem, frame.useProgress, t - this.useAt);
    } else if (releasing) {
      const since = t - this.releaseAt;
      const snapping = since < RELEASE_SNAP_SECONDS;
      const under = this.releaseUnderhand;
      this.setTarget(snapping ? (under ? poses.releaseUnderhand : poses.releaseOverhand) : under ? poses.followUnderhand : poses.followOverhand);
      frequency = snapping ? 16 : 7;
      damping = 1;
    } else if (frame.phase === "primed" || frame.phase === "cooking") {
      const since = t - this.pinAt;
      if (since < PIN_PULL_SECONDS) {
        this.setTarget(poses.pinPull);
        frequency = 12;
      } else {
        this.setTarget(frame.underhand ? poses.cockUnderhand : poses.cockOverhand);
        frequency = 6.5;
        tremble = frame.phase === "cooking" ? 0.3 + 0.7 * frame.cookProgress : 0.15;
      }
    } else if (frame.phase === "equipping" || frame.phase === "ready" || frame.phase === "releasing") {
      if (frame.phase === "releasing" || frame.kind === null) this.setTarget(poses.hidden);
      else this.setTarget(poses.ready);
      frequency = t - this.equipAt < 0.5 ? 5.5 : 7;
    } else {
      this.putAway();
      this.setTarget(poses.hidden);
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
        for (let i = 0; i < CHANNELS; i++) {
          const x = value[i]! - target[i]!;
          const v = velocity[i]!;
          value[i] = target[i]! + decay * (x * c + ((v + damping * w * x) / wd) * sn);
          velocity[i] = decay * (v * c - ((w * w * x + damping * w * v) / wd) * sn);
        }
      } else {
        const decay = Math.exp(-w * dt);
        for (let i = 0; i < CHANNELS; i++) {
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
    const hands = this.hands;
    if (hands) {
      hands.setLeftArm(value[6]!, value[7]!);
      if (hands.clip) {
        this.frame = this.clipFrame(frame, t, releasing, putting);
        hands.setFrame(this.frame);
        hands.setRightArm(value[8]!, 0);
        hands.setRightWrist(0, 0, value[9]!);
      }
      hands.update();
      // The item leaves the fist as the clip's fingers open.
      if (releasing && hands.clip && this.item?.root.isEnabled() && this.frame >= hands.clip.asset.releaseFrame && this.releaseFromFrame < hands.clip.asset.releaseFrame) {
        this.item.root.setEnabled(false);
      }
    }
    this.animateParts(frame);
  }

  dispose(): void {
    for (const item of this.items.values()) item.root.dispose();
    this.items.clear();
    this.hands?.dispose();
    if (!this.hands) this.root.dispose();
  }

  /** Source frame of the throw clip for this frame: ready, wind-up into the hold, or the release sequence. */
  private clipFrame(frame: HandsFrame, t: number, releasing: boolean, putting: boolean): number {
    const clip = this.hands!.clip!;
    const clips = clip.asset.clips;
    const timing = this.clip;
    if (releasing && this.releaseThrown) {
      const since = t - this.releaseAt;
      if (since < timing.throwSeconds) return lerp(this.releaseFromFrame, clips.throw[1], since / timing.throwSeconds);
      if (since < timing.throwSeconds + timing.followSeconds) return clip.clipFrame("follow", (since - timing.throwSeconds) / timing.followSeconds);
      return clip.clipFrame("recover", (since - timing.throwSeconds - timing.followSeconds) / timing.recoverSeconds);
    }
    if (putting) return this.frame;
    if (frame.useItem !== null) return clips.ready[0];
    if (frame.phase === "primed" || frame.phase === "cooking") {
      const windup = smoothstep(0, 1, (t - this.pinAt - PIN_PULL_SECONDS) / timing.windupSeconds);
      const hold = frame.underhand ? timing.underhandHoldFrame : timing.overhandHoldFrame;
      return clips.ready[0] + (Math.min(hold, clips.windup[1]) - clips.ready[0]) * windup;
    }
    return clips.ready[0];
  }

  private show(kind: HeldItemKind): void {
    const item = this.heldItem(kind);
    if (this.item && this.item !== item) this.item.root.setEnabled(false);
    this.item = item;
    item.root.setEnabled(true);
    this.placeInGrip(item);
    this.hideAt = Infinity;
    this.setActive(true);
  }

  private placeInGrip(item: HeldItem): void {
    const grip = this.grips[item.kind];
    item.root.position.set(grip.position[0], grip.position[1], grip.position[2]);
    item.root.rotation.set(grip.rotation[0], grip.rotation[1], grip.rotation[2]);
  }

  private setActive(active: boolean): void {
    this.active = active;
    this.root.setEnabled(active);
    this.hands?.setEnabled(active);
    if (!active) {
      this.hideAt = Infinity;
      this.snap(this.poses.hidden);
    }
  }

  private heldItem(kind: HeldItemKind): HeldItem {
    let item = this.items.get(kind);
    if (!item) {
      item = this.library.createHeld(kind);
      item.root.parent = this.hands?.grip ?? this.root;
      // The throw arms' grip lives inside the arms' glTF (mirrored) space, and a real item carries its own glTF → Babylon
      // flip: mirror once more so the two cancel and the model isn't reflected.
      if (this.hands?.clip && item.real) item.root.scaling.x = -1;
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
    const ring = item.ring;
    if (ring) {
      const since = t - this.pinAt;
      if (this.pinAt > this.equipAt && since >= 0) {
        const follow = smoothstep(0.02, 0.14, since);
        if (since > PIN_PULL_SECONDS + 0.12) {
          ring.setEnabled(false);
        } else if (this.hands?.getLeftHandWorldToRef(this.leftHand)) {
          // Carry the ring from its rest position to the hand, in the ring's parent space.
          const space = (ring.parent as TransformNode | null) ?? item.root;
          space.computeWorldMatrix(true);
          space.getWorldMatrix().invertToRef(this.itemInverse);
          Vector3.TransformCoordinatesToRef(this.leftHand, this.itemInverse, this.leftHand);
          Vector3.LerpToRef(item.ringRest, this.leftHand, follow, ring.position);
        } else {
          ring.position.set(item.ringRest.x - 0.12 * follow, item.ringRest.y, item.ringRest.z - 0.05 * follow);
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
    this.setTarget(this.poses.use);
    const target = this.target;
    const item = this.item;
    const grip = this.grips[itemId];
    if (item) item.root.rotation.set(grip.rotation[0], grip.rotation[1], grip.rotation[2]);
    const t = elapsed;
    switch (itemId) {
      case "bandage": {
        // Wrapping: small circles, the roll turning.
        target[0]! += Math.sin(t * 5) * 0.025;
        target[1]! += Math.cos(t * 5) * 0.015;
        target[7]! = -0.1 + Math.sin(t * 5 + 1) * 0.08;
        if (item) item.root.rotation.x = grip.rotation[0] + (item.real ? Math.sin(t * 5) * 0.35 : t * 5);
        return 9;
      }
      case "first_aid": {
        const open = pulse(0.1, 0.85, progress);
        target[1]! += Math.sin(t * 3) * 0.008 - 0.02 * open;
        if (item) item.root.rotation.x = grip.rotation[0] + 0.35 * open * Math.abs(Math.sin(t * 2.5));
        return 7;
      }
      case "medkit": {
        const inject = pulse(0.55, 0.9, progress);
        target[1]! += -0.02 + 0.03 * inject;
        target[2]! += -0.02 * inject;
        target[6]! = 0.7 * inject;
        return 6;
      }
      case "energy_drink":
      case "painkiller": {
        const shaking = itemId === "painkiller" ? pulse(0.08, 0.4, progress) : 0;
        target[1]! += Math.sin(t * 30) * 0.012 * shaking;
        // Raised to the mouth only briefly near the end; held low in front the rest of the time.
        const raiseStart = itemId === "painkiller" ? 0.62 : 0.55;
        const raise = smoothstep(raiseStart, raiseStart + 0.1, progress) * (1 - smoothstep(0.82, 0.92, progress));
        this.blendTarget(this.poses.drink, raise);
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
    target[8] = pose.right ?? 0;
    target[9] = pose.wrist ?? 0;
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
    target[8] = lerp(target[8]!, pose.right ?? 0, w);
    target[9] = lerp(target[9]!, pose.wrist ?? 0, w);
  }

  private snap(pose: HandPose): void {
    this.setTarget(pose);
    this.value.set(this.target);
    this.velocity.fill(0);
  }
}
