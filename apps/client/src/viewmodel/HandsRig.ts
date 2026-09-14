import { Matrix, Quaternion, TransformNode, Vector3, type AbstractMesh, type Scene } from "@babylonjs/core";
import { getWeaponDef } from "@twobullets/shared";
import type { AssetLibrary } from "../assets";
import type { Environment } from "../world/environment";
import { prepareViewmodelMesh } from "./Viewmodel";
import { VIEWMODEL_PROFILES } from "./weaponProfiles";
import { WeaponRig } from "./WeaponRig";

/** The pistol's arms hold its grip two-handed at the first idle frame; the grenade or item sits in that grip. */
const SOURCE_WEAPON = "pistol";
/**
 * Centre of the right hand's grip in pistol instance-root space at the first idle frame: the mean of the palm,
 * middle finger, pinky and thumb joints (headless bone probe of the published GLB).
 */
const GRIP_POINT = new Vector3(0.008, 0.027, 0.186);
const LEFT_SHOULDER = "L_arm_00";
const LEFT_HAND = "L_middle1_012";
const RIGHT_HAND = "R_middle1_037";

/**
 * First-person arms without a gun, for throwables and item use. Built from a second pistol instance with every gun
 * mesh disabled and its clips stopped on the idle frame, so the arms are posed procedurally:
 * - `root` is the grip point (where the held item goes); the caller poses it in camera space.
 * - `setLeftArm` swings the whole left arm about its shoulder joint, in `root` space, for the pin pull and to drop
 *   the support hand out of view.
 */
export class HandsRig {
  readonly root: TransformNode;
  readonly meshes: readonly AbstractMesh[];

  private readonly rig: WeaponRig;
  private readonly leftShoulder: TransformNode | null;
  private readonly leftHand: TransformNode | null;
  private readonly rightHand: TransformNode | null;
  private readonly leftRest = new Quaternion();
  private leftPitch = 0;
  private leftYaw = 0;
  private leftRoll = 0;
  private enabled = true;

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

  private constructor(scene: Scene, rig: WeaponRig, environment: Pick<Environment, "skyFill">) {
    this.rig = rig;
    this.root = new TransformNode("vm_hands_root", scene);
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

    const nodes = rig.attach.getDescendants(false) as TransformNode[];
    const find = (name: string) => nodes.find((node) => node.name === name && node.getClassName() === "TransformNode") ?? null;
    this.leftShoulder = find(LEFT_SHOULDER);
    this.leftHand = find(LEFT_HAND);
    this.rightHand = find(RIGHT_HAND);
    if (this.leftShoulder) {
      this.leftShoulder.rotationQuaternion ??= Quaternion.FromEulerVector(this.leftShoulder.rotation);
      this.leftRest.copyFrom(this.leftShoulder.rotationQuaternion);
    }
    scene.onAfterRenderObservable.addOnce(() => rig.freezeMaterials());
  }

  /** Arms from the pistol asset, or null when assets are unavailable (the caller shows the item alone). */
  static create(scene: Scene, assets: AssetLibrary | null, environment: Pick<Environment, "skyFill">): HandsRig | null {
    if (!assets) return null;
    try {
      const rig = WeaponRig.fromInstance(scene, assets.instantiateWeapon(SOURCE_WEAPON), getWeaponDef(SOURCE_WEAPON), VIEWMODEL_PROFILES[SOURCE_WEAPON]);
      return new HandsRig(scene, rig, environment);
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

  /**
   * Left arm swing about the shoulder, radians in `root` space: pitch + lowers the hand, yaw − moves it left (out),
   * roll turns the forearm. Applied by `update`.
   */
  setLeftArm(pitch: number, yaw: number, roll = 0): void {
    this.leftPitch = pitch;
    this.leftYaw = yaw;
    this.leftRoll = roll;
  }

  /** After `root` is posed for the frame: applies the bone offsets and refreshes world matrices. */
  update(): void {
    if (!this.enabled) return;
    this.root.computeWorldMatrix(true);
    const shoulder = this.leftShoulder;
    if (!shoulder?.parent || !shoulder.rotationQuaternion) return;
    shoulder.rotationQuaternion.copyFrom(this.leftRest);
    computeChain(shoulder);
    if (this.leftPitch === 0 && this.leftYaw === 0 && this.leftRoll === 0) return;

    // newLocal = local · parentInRoot · T(-o) · R · T(o) · parentInRoot⁻¹, all relative to `root`, so the
    // camera's FOV scaling above `root` never enters the decomposition.
    this.root.getWorldMatrix().invertToRef(this.rootInverse);
    shoulder.getWorldMatrix().multiplyToRef(this.rootInverse, this.nodeInRoot);
    (shoulder.parent as TransformNode).getWorldMatrix().multiplyToRef(this.rootInverse, this.parentInRoot);
    // Vector-ref Babylon calls throughout: loose doubles across non-inlined calls get boxed every frame.
    this.nodeInRoot.getTranslationToRef(this.origin);
    this.euler.set(this.leftPitch, this.leftYaw, this.leftRoll);
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
    // Unit-scale joint: the upper 3×3 is a pure rotation, and the joint's translation is unchanged by construction.
    Quaternion.FromRotationMatrixToRef(this.nodeInRoot, shoulder.rotationQuaternion);
    computeChain(shoulder);
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
    this.rig.dispose();
    this.root.dispose();
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
