import {
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  PhysicsShapeCapsule,
  PhysicsShapeSphere,
  Quaternion,
  TransformNode,
  Vector3,
  type Node,
  type Observer,
  type PhysicsShape,
  type Scene,
} from "@babylonjs/core";
import type { HitZone } from "@twobullets/shared";
import type { CharacterInstance } from "../assets";
import { CollisionLayer, type Damageable, type HitboxRegistry } from "../combat/hitboxes";
import { SOLDIER_HITBOXES, type SoldierHitboxDef } from "./soldierRig";

export interface SoldierHitboxPart {
  readonly name: string;
  readonly zone: HitZone;
  readonly colliderId: string;
  /** Root-level node the body follows; its position is the shape center. */
  readonly node: TransformNode;
  /** Skeleton node the shape is placed along; its world matrix stays current every frame, even while disabled. */
  readonly bone: TransformNode;
}

interface Part extends SoldierHitboxPart {
  readonly body: PhysicsBody;
  /** Shape center along the bone's +Y axis, world meters. */
  readonly offset: number;
}

const axisX = new Vector3();
const axisY = new Vector3();
const axisZ = new Vector3();

/**
 * Havok trigger shapes that follow the skeleton. After animations are evaluated and before the physics step (same
 * render), each shape is placed along its bone; ANIMATED bodies pick the new transform up in that step, so bullet
 * rays in the next frame's ticks test exactly the pose that was rendered.
 */
export class SoldierHitboxes {
  readonly parts: readonly SoldierHitboxPart[];
  private readonly items: Part[] = [];
  private readonly shapes: PhysicsShape[] = [];
  /** Ancestors of the tracked bones, parents first, whose world matrices must be fresh before placing shapes. */
  private readonly chain: Node[];
  private readonly observer: Observer<Scene>;
  private active = true;

  constructor(
    scene: Scene,
    root: TransformNode,
    character: CharacterInstance,
    scale: number,
    private readonly registry: HitboxRegistry,
    owner: Damageable,
    idPrefix: string,
    defs: readonly SoldierHitboxDef[] = SOLDIER_HITBOXES,
  ) {
    this.chain = ancestorChain(root, defs.map((def) => character.bones[def.bone]));
    this.refreshWorldMatrices();

    for (const def of defs) {
      const bone = character.bones[def.bone];
      const node = new TransformNode(`${idPrefix}_hitbox_${def.name}`, scene);
      node.rotationQuaternion = Quaternion.Identity();
      const { shape, offset } = createShape(scene, def, scale);
      shape.isTrigger = true;
      shape.filterMembershipMask = CollisionLayer.hitbox;
      this.shapes.push(shape);

      const part = { name: def.name, zone: def.zone, colliderId: `${idPrefix}/${def.name}`, node, bone, offset };
      place(part);
      const body = new PhysicsBody(node, PhysicsMotionType.ANIMATED, false, scene);
      body.shape = shape;
      // Teleported to the node before every physics step; simulation results are never written back.
      body.disablePreStep = false;
      body.disableSync = true;
      registry.add(body, { colliderId: part.colliderId, owner, zone: def.zone });
      this.items.push({ ...part, body });
    }
    this.parts = this.items;
    this.observer = scene.onAfterAnimationsObservable.add(() => this.update());
  }

  get enabled(): boolean {
    return this.active;
  }

  /** Filter changes apply to queries immediately; disabled shapes also stop following the pose. */
  setEnabled(enabled: boolean): void {
    if (this.active === enabled) return;
    this.active = enabled;
    for (const shape of this.shapes) shape.filterMembershipMask = enabled ? CollisionLayer.hitbox : 0;
    if (enabled) this.update();
  }

  update(): void {
    // Kept fresh while disabled too: attachments like blood wounds follow these bones on a dead body.
    this.refreshWorldMatrices();
    if (!this.active) return;
    for (const part of this.items) place(part);
  }

  dispose(): void {
    this.observer.remove();
    for (const part of this.items) {
      this.registry.remove(part.body);
      part.body.dispose();
      part.node.dispose();
    }
    for (const shape of this.shapes) shape.dispose();
    this.items.length = 0;
    this.shapes.length = 0;
  }

  private refreshWorldMatrices(): void {
    for (const node of this.chain) node.computeWorldMatrix(true);
  }
}

function createShape(scene: Scene, def: SoldierHitboxDef, scale: number): { shape: PhysicsShape; offset: number } {
  const s = def.shape;
  switch (s.kind) {
    case "sphere":
      return { shape: new PhysicsShapeSphere(Vector3.Zero(), s.radius * scale, scene), offset: s.at * scale };
    case "capsule": {
      const half = ((s.to - s.from) / 2) * scale;
      const shape = new PhysicsShapeCapsule(new Vector3(0, -half, 0), new Vector3(0, half, 0), s.radius * scale, scene);
      return { shape, offset: ((s.from + s.to) / 2) * scale };
    }
    case "box": {
      const size = new Vector3(s.width, s.to - s.from, s.depth).scaleInPlace(scale);
      return { shape: new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), size, scene), offset: ((s.from + s.to) / 2) * scale };
    }
  }
}

/** Centers the node on the bone axis with the bone's orientation (re-orthonormalized, mirror removed). */
function place(part: Pick<Part, "bone" | "node" | "offset">): void {
  const m = part.bone.getWorldMatrix().m;
  axisY.set(m[4]!, m[5]!, m[6]!).normalize();
  const d = m[0]! * axisY.x + m[1]! * axisY.y + m[2]! * axisY.z;
  axisX.set(m[0]! - axisY.x * d, m[1]! - axisY.y * d, m[2]! - axisY.z * d).normalize();
  Vector3.CrossToRef(axisX, axisY, axisZ);
  const { node, offset } = part;
  node.position.set(m[12]! + axisY.x * offset, m[13]! + axisY.y * offset, m[14]! + axisY.z * offset);
  Quaternion.RotationQuaternionFromAxisToRef(axisX, axisY, axisZ, node.rotationQuaternion!);
}

function ancestorChain(root: Node, bones: readonly Node[]): Node[] {
  const depth = new Map<Node, number>();
  for (const bone of bones) {
    const path: Node[] = [];
    for (let node: Node | null = bone; node; node = node.parent) {
      path.push(node);
      if (node === root) break;
    }
    path.reverse().forEach((node, i) => depth.set(node, i));
  }
  return [...depth.keys()].sort((a, b) => depth.get(a)! - depth.get(b)!);
}
