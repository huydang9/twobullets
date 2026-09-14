import { Color3, MeshBuilder, Quaternion, StandardMaterial, Vector3, type InstancedMesh, type Mesh, type Scene } from "@babylonjs/core";
import { MAX_ENTITY_SLOTS } from "@twobullets/protocol/messages/snapshot";
import { RIG_SHAPE_COUNT, RIG_SHAPE_STRIDE, RigShapeKind } from "@twobullets/shared/hitreg/rig";
import type { RemoteHitboxes } from "../net/RemoteHitboxes";
import type { RemotePlayers } from "../net/RemotePlayers";
import { SOLDIER_HITBOXES, soldierScale, type SoldierHitboxDef } from "../targets/soldierRig";

type ShapeKind = "sphere" | "capsule" | "box";

interface Templates {
  readonly sphere: Mesh;
  readonly capsule: Mesh;
  readonly box: Mesh;
}

const up = Vector3.UpReadOnly;
const axisX = new Vector3();
const axisY = new Vector3();
const axisZ = new Vector3();
const direction = new Vector3();

/**
 * DEV `?debug=hitboxes`: for every remote player, the shared procedural rig the server tests (green, posed from the
 * interpolated network state) over the Mixamo bone-driven `SOLDIER_HITBOXES` placement of the rendered soldier (red).
 * Where they disagree, cosmetic hit prediction and what the player sees differ. Pooled instances; debug only.
 */
export class HitboxOverlay {
  private readonly rig: Templates;
  private readonly bones: Templates;
  private readonly rigInstances: (InstancedMesh[] | null)[] = [];
  private readonly boneInstances: (InstancedMesh[] | null)[] = [];

  constructor(
    scene: Scene,
    private readonly hitboxes: RemoteHitboxes,
    private readonly remotes: RemotePlayers,
  ) {
    this.rig = templates(scene, "hitboxRig", new Color3(0.2, 1, 0.3));
    this.bones = templates(scene, "hitboxBone", new Color3(1, 0.25, 0.2));
    for (let i = 0; i < MAX_ENTITY_SLOTS; i++) {
      this.rigInstances.push(null);
      this.boneInstances.push(null);
    }
    console.info("[debug] hitbox overlay: green = shared procedural rig (network), red = bone-driven SOLDIER_HITBOXES");
  }

  /** Per frame after the remote avatars updated. */
  update(): void {
    for (let slot = 0; slot < MAX_ENTITY_SLOTS; slot++) {
      const posed = this.hitboxes.posed[slot] === 1;
      const rig = posed ? (this.rigInstances[slot] ??= this.createRig(slot)) : this.rigInstances[slot];
      if (rig) {
        for (let i = 0; i < rig.length; i++) rig[i]!.setEnabled(posed);
        if (posed) this.placeRig(rig, this.hitboxes.shapes[slot]!);
      }
      const soldier = posed ? this.remotes.soldierOf(slot) : null;
      const bones = soldier ? (this.boneInstances[slot] ??= this.createBones(slot)) : this.boneInstances[slot];
      if (bones) {
        for (const mesh of bones) mesh.setEnabled(soldier !== null);
        if (soldier) {
          const scale = soldierScale(soldier.model.asset);
          SOLDIER_HITBOXES.forEach((def, i) => placeBoneShape(bones[i]!, def, soldier.model.bones[def.bone].getWorldMatrix().m, scale));
        }
      }
    }
  }

  dispose(): void {
    for (const list of [...this.rigInstances, ...this.boneInstances]) for (const mesh of list ?? []) mesh.dispose();
    for (const t of [this.rig, this.bones]) {
      t.sphere.material?.dispose();
      t.sphere.dispose();
      t.capsule.dispose();
      t.box.dispose();
    }
  }

  private createRig(slot: number): InstancedMesh[] {
    const shapes = this.hitboxes.shapes[slot]!;
    const list: InstancedMesh[] = [];
    for (let i = 0; i < RIG_SHAPE_COUNT; i++) {
      const kind = shapes[i * RIG_SHAPE_STRIDE]!;
      const template = kind === RigShapeKind.sphere ? this.rig.sphere : kind === RigShapeKind.capsule ? this.rig.capsule : this.rig.box;
      list.push(instance(template, `hitboxRig${slot}_${i}`));
    }
    return list;
  }

  private createBones(slot: number): InstancedMesh[] {
    return SOLDIER_HITBOXES.map((def, i) => instance(this.bones[def.shape.kind as ShapeKind], `hitboxBone${slot}_${i}`));
  }

  private placeRig(meshes: InstancedMesh[], shapes: Float64Array): void {
    for (let i = 0; i < RIG_SHAPE_COUNT; i++) {
      const o = i * RIG_SHAPE_STRIDE;
      const mesh = meshes[i]!;
      const kind = shapes[o]!;
      const q = mesh.rotationQuaternion!;
      if (kind === RigShapeKind.sphere) {
        mesh.position.set(shapes[o + 2]!, shapes[o + 3]!, shapes[o + 4]!);
        mesh.scaling.setAll(shapes[o + 8]! * 2);
        q.set(0, 0, 0, 1);
      } else if (kind === RigShapeKind.capsule) {
        const ax = shapes[o + 2]!;
        const ay = shapes[o + 3]!;
        const az = shapes[o + 4]!;
        direction.set(shapes[o + 5]! - ax, shapes[o + 6]! - ay, shapes[o + 7]! - az);
        const length = direction.length();
        const r = shapes[o + 8]!;
        mesh.position.set(ax + direction.x / 2, ay + direction.y / 2, az + direction.z / 2);
        mesh.scaling.set(r * 2, length + r * 2, r * 2);
        if (length > 1e-6) Quaternion.FromUnitVectorsToRef(up, direction.scaleInPlace(1 / length), q);
        else q.set(0, 0, 0, 1);
      } else {
        mesh.position.set(shapes[o + 2]!, shapes[o + 3]!, shapes[o + 4]!);
        mesh.scaling.set(shapes[o + 9]! * 2, shapes[o + 10]! * 2, shapes[o + 11]! * 2);
        q.set(shapes[o + 12]!, shapes[o + 13]!, shapes[o + 14]!, shapes[o + 15]!);
      }
    }
  }
}

function templates(scene: Scene, name: string, color: Color3): Templates {
  const material = new StandardMaterial(`${name}Material`, scene);
  material.wireframe = true;
  material.disableLighting = true;
  material.emissiveColor = color;
  const make = (mesh: Mesh): Mesh => {
    mesh.material = material;
    mesh.isPickable = false;
    // Hidden source, visible instances (a disabled source would hide its instances too).
    mesh.isVisible = false;
    return mesh;
  };
  return {
    sphere: make(MeshBuilder.CreateSphere(`${name}Sphere`, { diameter: 1, segments: 8 }, scene)),
    capsule: make(MeshBuilder.CreateCylinder(`${name}Capsule`, { height: 1, diameter: 1, tessellation: 10 }, scene)),
    box: make(MeshBuilder.CreateBox(`${name}Box`, { size: 1 }, scene)),
  };
}

function instance(template: Mesh, name: string): InstancedMesh {
  const mesh = template.createInstance(name);
  mesh.rotationQuaternion = Quaternion.Identity();
  mesh.isPickable = false;
  return mesh;
}

/** Same placement as SoldierHitboxes: along the bone's +Y from the joint, oriented by the bone (mirror removed). */
function placeBoneShape(mesh: InstancedMesh, def: SoldierHitboxDef, m: Float32Array | ArrayLike<number>, scale: number): void {
  axisY.set(m[4]!, m[5]!, m[6]!).normalize();
  const d = m[0]! * axisY.x + m[1]! * axisY.y + m[2]! * axisY.z;
  axisX.set(m[0]! - axisY.x * d, m[1]! - axisY.y * d, m[2]! - axisY.z * d).normalize();
  Vector3.CrossToRef(axisX, axisY, axisZ);
  const s = def.shape;
  let offset = 0;
  if (s.kind === "sphere") {
    offset = s.at * scale;
    mesh.scaling.setAll(s.radius * 2 * scale);
  } else if (s.kind === "capsule") {
    offset = ((s.from + s.to) / 2) * scale;
    mesh.scaling.set(s.radius * 2 * scale, (s.to - s.from + s.radius * 2) * scale, s.radius * 2 * scale);
  } else {
    offset = ((s.from + s.to) / 2) * scale;
    mesh.scaling.set(s.width * scale, (s.to - s.from) * scale, s.depth * scale);
  }
  mesh.position.set(m[12]! + axisY.x * offset, m[13]! + axisY.y * offset, m[14]! + axisY.z * offset);
  Quaternion.RotationQuaternionFromAxisToRef(axisX, axisY, axisZ, mesh.rotationQuaternion!);
}
