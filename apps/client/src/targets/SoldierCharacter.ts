import { TransformNode, Vector3, type AbstractMesh, type Mesh, type Scene } from "@babylonjs/core";
import type { HitZone } from "@twobullets/shared";
import type { CharacterInstance } from "../assets";
import type { Damageable, HitboxRegistry } from "../combat/hitboxes";
import type { BloodBody } from "../fx/BloodEffects";
import type { Environment } from "../world/environment";
import { SoldierAnimator, createSoldierMotion, type AirState, type DownState, type SoldierMotion } from "./SoldierAnimator";
import { SoldierHitboxes } from "./SoldierHitboxes";
import type { SoldierResources } from "./SoldierResources";
import { soldierScale, type ActionName } from "./soldierRig";

export interface SoldierCharacterOptions {
  /** Node names and collider ids are prefixed with it (`${name}/${part}`). */
  readonly name: string;
  /** Registers skeleton-driven hitboxes that resolve to `owner`. */
  readonly damage?: { readonly registry: HitboxRegistry; readonly owner: Damageable };
}

const FORWARD = new Vector3(0, 0, 1);
const direction = new Vector3();

/**
 * Animated third-person SWAT soldier: the reusable body for target dummies now and remote players later.
 *
 * The owner places `root` (feet, yaw about Y; the model faces +Z) and each frame writes `motion` (movement, `downed`,
 * `beingRevived`, `activity`), triggers events (`fire`, `reload`, `hit`, `throwGrenade`, `pickUp`, `die`, `revive`), then
 * calls `update(dt)` before `scene.render()`. Lying poses put the head toward the model's −Z.
 */
export class SoldierCharacter implements BloodBody {
  readonly root: TransformNode;
  readonly model: CharacterInstance;
  /** Per-frame locomotion input; mutate in place. */
  readonly motion: SoldierMotion = createSoldierMotion();
  readonly hitboxes: SoldierHitboxes | null;
  /** The owner's wish to show the rifle (a gun in hand); it is still hidden while the hands are busy. */
  rifleVisible = true;

  private readonly animator: SoldierAnimator;
  private readonly rifle: Mesh | null = null;
  private rifleShown = true;
  private lives = 0;

  constructor(scene: Scene, resources: SoldierResources, environment: Environment, options: SoldierCharacterOptions) {
    const { name, damage } = options;
    this.root = new TransformNode(`${name}_root`, scene);
    this.model = resources.assets.instantiateCharacter("swat");
    const scale = soldierScale(this.model.asset);
    this.model.root.parent = this.root;
    // Keeps the loader's handedness flip on Z.
    this.model.root.scaling.scaleInPlace(scale);

    const meshes: AbstractMesh[] = this.model.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
    if (resources.rifle && resources.grip) {
      const holder = new TransformNode(`${name}_rifleGrip`, scene);
      holder.parent = this.model.bones.rightHand;
      holder.position.copyFrom(resources.grip.position);
      holder.rotationQuaternion = resources.grip.rotation.clone();
      holder.scaling.copyFrom(resources.grip.scaling);
      this.rifle = resources.rifle.clone(`${name}_rifle`, holder, true);
      this.rifle.setEnabled(true);
      meshes.push(this.rifle);
    }
    for (const mesh of meshes) {
      mesh.isPickable = false;
      environment.addShadowCaster(mesh);
      // PBR materials are lit by the IBL; the hemispheric fill is for non-PBR materials only.
      environment.skyFill.excludedMeshes.push(mesh);
    }

    this.animator = new SoldierAnimator(this.model, this.motion, resources.upperWeights, resources.upperMask);
    this.root.computeWorldMatrix(true);
    this.hitboxes = damage ? new SoldierHitboxes(scene, this.root, this.model, scale, damage.registry, damage.owner, name) : null;
  }

  get dead(): boolean {
    return this.animator.dead;
  }

  /** Increments on every revive, so per-life decorations (blood) know to go. */
  get life(): number {
    return this.lives;
  }

  get pelvis(): TransformNode {
    return this.model.bones.hips;
  }

  get currentAction(): ActionName | null {
    return this.animator.currentAction;
  }

  get airState(): AirState {
    return this.animator.airState;
  }

  get downState(): DownState {
    return this.animator.downState;
  }

  get handsBusy(): boolean {
    return this.animator.handsBusy;
  }

  /** Throw release: standing toss or crouched throw on the upper body. */
  throwGrenade(crouched: boolean): void {
    this.animator.throwGrenade(crouched);
  }

  /** Loot grabbed into the pack. */
  pickUp(): void {
    this.animator.pickUp();
  }

  fire(): void {
    this.animator.fire();
  }

  /** @param seconds Duration to stretch the reload clip to, e.g. the weapon's reload time. */
  reload(seconds?: number): void {
    this.animator.reload(seconds);
  }

  /** Upper-body flinch. */
  hit(): void {
    this.animator.hit();
  }

  /**
   * Plays a death clip chosen by where the shot came from and disables hitboxes. The body stays down, in its
   * final pose, until `revive`.
   * @param shotDirection World-space bullet travel direction.
   */
  die(shotDirection?: Vector3): void {
    if (this.dead) return;
    let fromBehind = false;
    if (shotDirection) {
      this.root.getDirectionToRef(FORWARD, direction);
      fromBehind = Vector3.Dot(direction, shotDirection) > 0;
    }
    this.animator.die(fromBehind ? "back" : "front");
    this.hitboxes?.setEnabled(false);
  }

  /** Blends back to locomotion; hitboxes stay off until `setHitboxesEnabled(true)` so the owner decides when. */
  revive(): void {
    this.animator.revive();
    this.lives++;
  }

  setHitboxesEnabled(enabled: boolean): void {
    this.hitboxes?.setEnabled(enabled);
  }

  /** Bone under the hitbox of `zone` nearest to a world-space hit point (hitbox pose as of the last render). */
  woundBone(point: Vector3, zone: HitZone): TransformNode | null {
    let best: TransformNode | null = null;
    let bestDistance = Infinity;
    for (const part of this.hitboxes?.parts ?? []) {
      if (part.zone !== zone) continue;
      const distance = Vector3.DistanceSquared(part.node.position, point);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = part.bone;
      }
    }
    return best;
  }

  update(dt: number): void {
    this.animator.update(dt);
    const show = this.rifleVisible && !this.animator.handsBusy;
    if (this.rifle && show !== this.rifleShown) {
      this.rifleShown = show;
      this.rifle.setEnabled(show);
    }
  }

  dispose(): void {
    this.hitboxes?.dispose();
    // Clones share geometry and materials with the templates, so only the meshes go.
    this.rifle?.parent?.dispose();
    this.model.dispose();
    this.root.dispose();
  }
}
