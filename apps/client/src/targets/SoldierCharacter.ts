import { Color3, TransformNode, Vector3, type AbstractMesh, type Mesh, type Scene } from "@babylonjs/core";
import type { CharacterInstance } from "../assets";
import type { Damageable, HitboxRegistry } from "../combat/hitboxes";
import type { Environment } from "../world/environment";
import { SoldierAnimator, createSoldierMotion, type AirState, type SoldierMotion } from "./SoldierAnimator";
import { SoldierHitboxes } from "./SoldierHitboxes";
import type { SoldierResources } from "./SoldierResources";
import { soldierScale, type ActionName } from "./soldierRig";

export interface SoldierCharacterOptions {
  /** Node names and collider ids are prefixed with it (`${name}/${part}`). */
  readonly name: string;
  /** Registers skeleton-driven hitboxes that resolve to `owner`. */
  readonly damage?: { readonly registry: HitboxRegistry; readonly owner: Damageable };
}

const FLASH_SECONDS = 0.08;
const FLASH_COLOR = new Color3(1, 0.85, 0.8);
const FLASH_ALPHA = 0.22;
const FORWARD = new Vector3(0, 0, 1);
const direction = new Vector3();

/**
 * Animated third-person SWAT soldier: the reusable body for target dummies now and remote players later.
 *
 * The owner places `root` (feet, yaw about Y; the model faces +Z) and each frame writes `motion`, triggers events
 * (`fire`, `reload`, `hit`, `die`, `revive`), then calls `update(dt)` before `scene.render()`.
 */
export class SoldierCharacter {
  readonly root: TransformNode;
  readonly model: CharacterInstance;
  /** Per-frame locomotion input; mutate in place. */
  readonly motion: SoldierMotion = createSoldierMotion();
  readonly hitboxes: SoldierHitboxes | null;

  private readonly animator: SoldierAnimator;
  private readonly meshes: AbstractMesh[];
  private readonly rifle: Mesh | null = null;
  private flashTimer = 0;

  constructor(scene: Scene, resources: SoldierResources, environment: Environment, options: SoldierCharacterOptions) {
    const { name, damage } = options;
    this.root = new TransformNode(`${name}_root`, scene);
    this.model = resources.assets.instantiateCharacter("swat");
    const scale = soldierScale(this.model.asset);
    this.model.root.parent = this.root;
    // Keeps the loader's handedness flip on Z.
    this.model.root.scaling.scaleInPlace(scale);

    this.meshes = this.model.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
    if (resources.rifle && resources.grip) {
      const holder = new TransformNode(`${name}_rifleGrip`, scene);
      holder.parent = this.model.bones.rightHand;
      holder.position.copyFrom(resources.grip.position);
      holder.rotationQuaternion = resources.grip.rotation.clone();
      holder.scaling.copyFrom(resources.grip.scaling);
      this.rifle = resources.rifle.clone(`${name}_rifle`, holder, true);
      this.rifle.setEnabled(true);
      this.meshes.push(this.rifle);
    }
    for (const mesh of this.meshes) {
      mesh.isPickable = false;
      mesh.overlayColor = FLASH_COLOR;
      mesh.overlayAlpha = FLASH_ALPHA;
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

  get currentAction(): ActionName | null {
    return this.animator.currentAction;
  }

  get airState(): AirState {
    return this.animator.airState;
  }

  fire(): void {
    this.animator.fire();
  }

  /** @param seconds Duration to stretch the reload clip to, e.g. the weapon's reload time. */
  reload(seconds?: number): void {
    this.animator.reload(seconds);
  }

  /** Flinch plus a brief highlight. */
  hit(): void {
    this.animator.hit();
    this.flashTimer = FLASH_SECONDS;
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
    this.flashTimer = FLASH_SECONDS;
    this.hitboxes?.setEnabled(false);
  }

  /** Blends back to locomotion; hitboxes stay off until `setHitboxesEnabled(true)` so the owner decides when. */
  revive(): void {
    this.animator.revive();
  }

  setHitboxesEnabled(enabled: boolean): void {
    this.hitboxes?.setEnabled(enabled);
  }

  update(dt: number): void {
    this.animator.update(dt);
    if (this.flashTimer > 0) {
      // Shared PBR materials stay untouched; the overlay is a per-mesh tint pass.
      const on = this.flashTimer > dt;
      this.flashTimer = on ? this.flashTimer - dt : 0;
      for (const mesh of this.meshes) mesh.renderOverlay = on;
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
