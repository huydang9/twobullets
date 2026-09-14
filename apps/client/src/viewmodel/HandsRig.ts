import { Matrix, Quaternion, TransformNode, Vector3, type AbstractMesh, type Scene } from "@babylonjs/core";
import { getWeaponDef } from "@twobullets/shared";
import type { AssetLibrary, ThrowArmsInstance } from "../assets";
import type { Environment } from "../world/environment";
import { prepareViewmodelMesh } from "./Viewmodel";
import { VIEWMODEL_PROFILES } from "./weaponProfiles";
import { WeaponRig } from "./WeaponRig";

/** Fallback: the pistol's arms hold its grip two-handed at the first idle frame; the grenade or item sits in that grip. */
const SOURCE_WEAPON = "pistol";
/**
 * Centre of the right hand's grip in pistol instance-root space at the first idle frame: the mean of the palm,
 * middle finger, pinky and thumb joints (headless bone probe of the published GLB).
 */
const GRIP_POINT = new Vector3(0.008, 0.027, 0.186);
/** DJMaesen rigs share joint names up to a numeric suffix (L_arm_00 in the pistol, L_arm_01 in the throw arms). */
const LEFT_SHOULDER = /^L_arm_\d+$/;
const RIGHT_SHOULDER = /^R_arm_\d+$/;
const LEFT_HAND = /^L_middle1_\d+$/;
const RIGHT_HAND = /^R_middle1_\d+$/;

/** A root-space swing of one joint about its own position, re-applied every update on top of the clip or rest pose. */
class JointSwing {
  pitch = 0;
  yaw = 0;
  roll = 0;
  readonly rest = new Quaternion();

  constructor(readonly joint: TransformNode | null) {
    if (joint) {
      joint.rotationQuaternion ??= Quaternion.FromEulerVector(joint.rotation);
      this.rest.copyFrom(joint.rotationQuaternion);
    }
  }

  get active(): boolean {
    return this.pitch !== 0 || this.yaw !== 0 || this.roll !== 0;
  }
}

/**
 * First-person arms for throwables and item use, posed procedurally on top of an optional clip:
 * - With the equipment art: DJMaesen's "Arms throwing" rig. `setFrame` poses its single baked throw clip; the held item
 *   goes under `grip` (inside the right fist, animated with the hand). `root` is the arms' source origin.
 * - Fallback: a second pistol instance with every gun mesh disabled and its clips stopped on the idle frame; `root` is
 *   the grip point and `grip === root`.
 * On both, `setLeftArm`/`setRightArm` swing a whole arm about its shoulder in `root` space (pin pull, dropping the
 * support hand, the underhand swing) and `setRightWrist` turns the fist (to show the item). The caller poses `root` in
 * camera space.
 */
export class HandsRig {
  readonly root: TransformNode;
  readonly meshes: readonly AbstractMesh[];
  /** Where held items attach. */
  readonly grip: TransformNode;
  /** The clip rig, or null for the static pistol-arms fallback. */
  readonly clip: ThrowArmsInstance | null;

  private readonly rig: WeaponRig | null;
  private readonly left: JointSwing;
  private readonly right: JointSwing;
  private readonly wrist: TransformNode | null;
  private readonly leftHand: TransformNode | null;
  private readonly rightHand: TransformNode | null;
  private frame = 0;
  private enabled = true;

  private readonly wristEuler = new Vector3();
  private readonly wristTwist = new Quaternion();
  private readonly rootInverse = new Matrix();
  private readonly nodeInRoot = new Matrix();
  private readonly parentInRoot = new Matrix();
  private readonly delta = new Matrix();
  private readonly pivot = new Matrix();
  private readonly pivotBack = new Matrix();
  private readonly local = new Matrix();
  private readonly deltaQuaternion = new Quaternion();
  private readonly origin = new Vector3();
  private readonly negated = new Vector3();
  private readonly euler = new Vector3();

  private constructor(scene: Scene, source: { rig: WeaponRig } | { clip: ThrowArmsInstance }, environment: Pick<Environment, "skyFill">) {
    this.root = new TransformNode("vm_hands_root", scene);
    let nodes: TransformNode[];
    if ("clip" in source) {
      const clip = source.clip;
      this.clip = clip;
      this.rig = null;
      clip.root.parent = this.root;
      for (const mesh of clip.meshes) prepareViewmodelMesh(mesh, environment);
      this.meshes = clip.meshes;
      this.grip = clip.nodes.grip;
      this.wrist = clip.nodes.rightHand;
      nodes = clip.root.getDescendants(false) as TransformNode[];
      clip.pose(clip.asset.clips.ready[0]);
    } else {
      const rig = source.rig;
      this.clip = null;
      this.rig = rig;
      rig.attach.parent = this.root;
      rig.attach.position.copyFrom(rig.sight).subtractInPlace(GRIP_POINT);
      const arms: AbstractMesh[] = [];
      for (const mesh of rig.meshes) {
        if (mesh.skeleton) {
          prepareViewmodelMesh(mesh, environment);
          arms.push(mesh);
        } else {
          mesh.setEnabled(false);
        }
      }
      this.meshes = arms;
      this.grip = this.root;
      this.wrist = null;
      nodes = rig.attach.getDescendants(false) as TransformNode[];
      scene.onAfterRenderObservable.addOnce(() => rig.freezeMaterials());
    }
    const find = (pattern: RegExp) => nodes.find((node) => pattern.test(node.name) && node.getClassName() === "TransformNode") ?? null;
    this.left = new JointSwing(find(LEFT_SHOULDER));
    this.right = new JointSwing(find(RIGHT_SHOULDER));
    this.leftHand = find(LEFT_HAND);
    this.rightHand = find(RIGHT_HAND);
    if (this.wrist) this.wrist.rotationQuaternion ??= Quaternion.FromEulerVector(this.wrist.rotation);
  }

  /** The throw arms when the equipment art loaded, else the pistol's arms, or null without assets (items alone). */
  static create(scene: Scene, assets: AssetLibrary | null, environment: Pick<Environment, "skyFill">): HandsRig | null {
    if (!assets) return null;
    if (assets.hasThrowArms) {
      try {
        const clip = assets.instantiateThrowArms();
        if (clip) return new HandsRig(scene, { clip }, environment);
      } catch (error) {
        console.error("[viewmodel] could not build the throw arms; using the pistol's arms", error);
      }
    }
    try {
      const rig = WeaponRig.fromInstance(scene, assets.instantiateWeapon(SOURCE_WEAPON), getWeaponDef(SOURCE_WEAPON), VIEWMODEL_PROFILES[SOURCE_WEAPON]);
      return new HandsRig(scene, { rig }, environment);
    } catch (error) {
      console.error("[viewmodel] could not build throwable hands; showing items without arms", error);
      return null;
    }
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.root.setEnabled(enabled);
  }

  /** Source frame of the throw clip to pose (clip rig only; see ThrowArmsAsset.clips). */
  setFrame(frame: number): void {
    this.frame = frame;
  }

  /**
   * Left arm swing about the shoulder, radians in `root` space: pitch + lowers the hand, yaw − moves it left (out),
   * roll turns the forearm. Applied by `update`.
   */
  setLeftArm(pitch: number, yaw: number, roll = 0): void {
    this.left.pitch = pitch;
    this.left.yaw = yaw;
    this.left.roll = roll;
  }

  /** Right arm swing about the shoulder, same axes as `setLeftArm` (pitch + lowers the hand). */
  setRightArm(pitch: number, yaw: number, roll = 0): void {
    this.right.pitch = pitch;
    this.right.yaw = yaw;
    this.right.roll = roll;
  }

  /** Extra right-wrist rotation in the wrist's own frame (clip rig only), e.g. turning the fist to show the grenade. */
  setRightWrist(x: number, y: number, z: number): void {
    this.wristEuler.set(x, y, z);
  }

  /** After `root` is posed for the frame: poses the clip, applies the offsets and refreshes world matrices. */
  update(): void {
    if (!this.enabled) return;
    this.root.computeWorldMatrix(true);
    if (this.clip) {
      this.clip.pose(this.frame);
      const wrist = this.wrist;
      if (wrist?.rotationQuaternion && (this.wristEuler.x !== 0 || this.wristEuler.y !== 0 || this.wristEuler.z !== 0)) {
        Quaternion.FromEulerVectorToRef(this.wristEuler, this.wristTwist);
        wrist.rotationQuaternion.multiplyInPlace(this.wristTwist);
      }
    }
    this.applySwing(this.left);
    this.applySwing(this.right);
    if (this.clip) computeChain(this.grip);
  }

  /** Left hand (middle knuckle) in `root` space, after `update`. */
  getLeftHandToRef(result: Vector3): boolean {
    return this.nodeToRoot(this.leftHand, result);
  }

  /** Left hand (middle knuckle) world position, after `update`. */
  getLeftHandWorldToRef(result: Vector3): boolean {
    if (!this.leftHand) return false;
    computeChain(this.leftHand);
    this.leftHand.getWorldMatrix().getTranslationToRef(result);
    return true;
  }

  /** Right hand (middle knuckle) in `root` space, after `update`. */
  getRightHandToRef(result: Vector3): boolean {
    return this.nodeToRoot(this.rightHand, result);
  }

  dispose(): void {
    this.rig?.dispose();
    this.clip?.dispose();
    this.root.dispose();
  }

  private applySwing(swing: JointSwing): void {
    const joint = swing.joint;
    if (!joint?.parent || !joint.rotationQuaternion) return;
    // The static rig has no clip resetting the joint each frame: start from its rest rotation.
    if (!this.clip) joint.rotationQuaternion.copyFrom(swing.rest);
    computeChain(joint);
    if (!swing.active) return;

    // newLocal = local · parentInRoot · T(-o) · R · T(o) · parentInRoot⁻¹, all relative to `root`, so the
    // camera's FOV scaling above `root` never enters the decomposition.
    this.root.getWorldMatrix().invertToRef(this.rootInverse);
    joint.getWorldMatrix().multiplyToRef(this.rootInverse, this.nodeInRoot);
    (joint.parent as TransformNode).getWorldMatrix().multiplyToRef(this.rootInverse, this.parentInRoot);
    // Vector-ref Babylon calls throughout: loose doubles across non-inlined calls get boxed every frame.
    this.nodeInRoot.getTranslationToRef(this.origin);
    this.euler.set(swing.pitch, swing.yaw, swing.roll);
    Quaternion.FromEulerVectorToRef(this.euler, this.deltaQuaternion);
    this.origin.scaleToRef(-1, this.negated);
    Matrix.IdentityToRef(this.pivot);
    this.pivot.setTranslation(this.negated);
    this.deltaQuaternion.toRotationMatrix(this.delta);
    Matrix.IdentityToRef(this.pivotBack);
    this.pivotBack.setTranslation(this.origin);
    this.nodeInRoot.multiplyToRef(this.pivot, this.local);
    this.local.multiplyToRef(this.delta, this.nodeInRoot);
    this.nodeInRoot.multiplyToRef(this.pivotBack, this.local);
    this.parentInRoot.invert();
    this.local.multiplyToRef(this.parentInRoot, this.nodeInRoot);
    // The local matrix carries the parent's scale ratio (the throw arms' cm skeleton sits under a 0.01 root, the joint
    // itself is unit scale), so normalise the rotation part before extracting the quaternion.
    this.nodeInRoot.decompose(undefined, joint.rotationQuaternion, undefined);
    computeChain(joint);
  }

  private nodeToRoot(node: TransformNode | null, result: Vector3): boolean {
    if (!node) return false;
    computeChain(node);
    this.root.getWorldMatrix().invertToRef(this.rootInverse);
    node.getWorldMatrix().multiplyToRef(this.rootInverse, this.nodeInRoot);
    result.set(this.nodeInRoot.m[12]!, this.nodeInRoot.m[13]!, this.nodeInRoot.m[14]!);
    return true;
  }
}

/** Recomputes world matrices from the top of the hierarchy down to `node` without allocating. */
function computeChain(node: TransformNode): void {
  const parent = node.parent as TransformNode | null;
  if (parent) computeChain(parent);
  node.computeWorldMatrix(true);
}
