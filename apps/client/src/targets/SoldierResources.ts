import { Matrix, Mesh, Quaternion, Vector3, type AnimationGroupMask, type Node, type TransformNode } from "@babylonjs/core";
import type { AssetLibrary } from "../assets";
import { createUpperBodyMask } from "./SoldierAnimator";
import { soldierScale, upperBodyWeights } from "./soldierRig";

/** Rifle pose relative to the right-hand bone (decomposed; the bone space is mirrored by the glTF root). */
export interface GripTransform {
  readonly position: Vector3;
  readonly rotation: Quaternion;
  readonly scaling: Vector3;
}

/**
 * Data shared by every soldier of a scene: the third-person rifle mesh (merged once, cloned per soldier with
 * shared geometry and materials), where it sits in the right hand, and the upper-body layer weights.
 */
export class SoldierResources {
  readonly upperWeights: ReadonlyMap<string, number>;
  readonly upperMask: AnimationGroupMask;
  /** Null when the weapon asset couldn't provide a separable gun. */
  readonly rifle: Mesh | null;
  readonly grip: GripTransform | null;

  constructor(readonly assets: AssetLibrary) {
    // A throwaway instance, posed at the first rifle_idle frame, to calibrate against.
    const probe = assets.instantiateCharacter("swat");
    try {
      probe.root.scaling.scaleInPlace(soldierScale(probe.asset));
      this.upperWeights = upperBodyWeights(probe.bones);
      this.upperMask = createUpperBodyMask(this.upperWeights);
      const idle = probe.animations.get("rifle_idle");
      if (!idle) throw new Error("Soldier: rifle_idle missing");
      idle.start(false, 1, idle.from, idle.to);
      idle.goToFrame(idle.from);
      idle.pause();
      computeWorldMatrices(probe.root);

      const rifle = extractRifle(assets);
      this.rifle = rifle?.mesh ?? null;
      this.grip = rifle
        ? solveGrip(rifle.rightWrist, rifle.leftWrist, probe.bones.rightHand, probe.bones.leftHand)
        : null;
    } finally {
      probe.dispose();
    }
  }

  dispose(): void {
    const material = this.rifle?.material;
    this.rifle?.dispose();
    // The merged multi-material only references the template's materials.
    if (material?.getClassName() === "MultiMaterial") material.dispose();
  }
}

interface ExtractedRifle {
  readonly mesh: Mesh;
  /** Viewmodel wrist positions in gun space, i.e. where the hands hold the gun. */
  readonly rightWrist: Vector3;
  readonly leftWrist: Vector3;
}

/**
 * The rifle GLB is first-person arms plus gun. The gun (`nodes.body` and its part meshes) is separable: merge its
 * parts at the idle pose into one mesh in gun space (meters, +Z forward), and read the viewmodel wrists for the grip.
 */
function extractRifle(assets: AssetLibrary): ExtractedRifle | null {
  const weapon = assets.instantiateWeapon("rifle");
  try {
    const idle = weapon.asset.clips.idle;
    if (idle) weapon.goToFrame(idle[0]);
    computeWorldMatrices(weapon.root);

    const wrist = (pattern: RegExp) => weapon.root.getDescendants(false, (n) => pattern.test(n.name))[0] as TransformNode | undefined;
    const rightWrist = wrist(/^R_wrist/);
    const leftWrist = wrist(/^L_wrist/);
    const parts = weapon.nodes.body.getChildMeshes(false).filter((m): m is Mesh => m instanceof Mesh && m.getTotalVertices() > 0);
    if (!rightWrist || !leftWrist || parts.length === 0) {
      console.warn("[soldier] rifle asset has no separable gun or wrists; soldiers are unarmed");
      return null;
    }

    const multiMaterial = new Set(parts.map((m) => m.material)).size > 1;
    const mesh = Mesh.MergeMeshes(parts, false, true, undefined, false, multiMaterial);
    if (!mesh) return null;
    mesh.name = "soldierRifleTemplate";
    mesh.isPickable = false;
    mesh.setEnabled(false);
    return { mesh, rightWrist: rightWrist.getAbsolutePosition().clone(), leftWrist: leftWrist.getAbsolutePosition().clone() };
  } finally {
    weapon.dispose();
  }
}

/**
 * Rigid transform that puts the viewmodel wrists on the character's hands: the right wrists coincide, the
 * right→left wrist axes align, and gun up stays as close to world up as that allows. Expressed in hand-bone space.
 */
function solveGrip(gunRight: Vector3, gunLeft: Vector3, handRight: TransformNode, handLeft: TransformNode): GripTransform {
  const charRight = handRight.getAbsolutePosition();
  const charLeft = handLeft.getAbsolutePosition();
  const gunBasis = basis(gunLeft.subtract(gunRight));
  const charBasis = basis(charLeft.subtract(charRight));

  const gunToChar = Matrix.Translation(-gunRight.x, -gunRight.y, -gunRight.z)
    .multiply(gunBasis.transpose())
    .multiply(charBasis)
    .multiply(Matrix.Translation(charRight.x, charRight.y, charRight.z));
  const local = gunToChar.multiply(handRight.getWorldMatrix().clone().invert());

  const grip = { position: new Vector3(), rotation: new Quaternion(), scaling: new Vector3() };
  local.decompose(grip.scaling, grip.rotation, grip.position);
  return grip;
}

/** Orthonormal rotation whose rows are (forward × up, up, forward) for a forward direction. */
function basis(forward: Vector3): Matrix {
  const z = forward.normalize();
  const x = Vector3.Cross(Vector3.Up(), z).normalize();
  const y = Vector3.Cross(z, x);
  return Matrix.FromValues(x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1);
}

function computeWorldMatrices(root: Node): void {
  root.computeWorldMatrix(true);
  for (const node of root.getDescendants(false)) node.computeWorldMatrix(true);
}
