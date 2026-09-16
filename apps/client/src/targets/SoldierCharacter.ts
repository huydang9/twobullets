import { Camera, Frustum, Matrix, Plane, Quaternion, TransformNode, Vector3, type AbstractMesh, type Material, type Mesh, type Scene } from "@babylonjs/core";
import { CAMERA, type HitZone } from "@twobullets/shared";
import type { CharacterInstance } from "../assets";
import type { Damageable, HitboxRegistry } from "../combat/hitboxes";
import type { BloodBody } from "../fx/BloodEffects";
import type { Environment } from "../world/environment";
import { SoldierAnimator, createSoldierMotion, type AirState, type DownState, type SoldierMotion, type SoldierPose } from "./SoldierAnimator";
import { SoldierHitboxes } from "./SoldierHitboxes";
import type { SoldierResources } from "./SoldierResources";
import { ANIMATION_LOD, animationLodInterval, deadTintStep, soldierScale, type ActionName } from "./soldierRig";

export interface SoldierCharacterOptions {
  /** Node names and collider ids are prefixed with it (`${name}/${part}`). */
  readonly name: string;
  /** Registers skeleton-driven hitboxes that resolve to `owner`. */
  readonly damage?: { readonly registry: HitboxRegistry; readonly owner: Damageable };
}

const FORWARD = new Vector3(0, 0, 1);
const direction = new Vector3();
/** Unzoomed half field of view tangents: CAMERA.fovDegrees is horizontal at 16:9. */
const HORIZONTAL_HALF_TAN = Math.tan((CAMERA.fovDegrees * Math.PI) / 360);
const VERTICAL_HALF_TAN = HORIZONTAL_HALF_TAN / (16 / 9);

/** Gameplay camera frustum, computed once per render interval for every soldier's level of detail. */
const view = { scene: null as Scene | null, renderId: -1, camera: null as Camera | null, planes: [0, 1, 2, 3, 4, 5].map(() => new Plane(0, 0, 0, 0)), matrix: new Matrix() };

function viewPlanes(scene: Scene, camera: Camera): readonly Plane[] {
  const renderId = scene.getRenderId();
  if (view.scene !== scene || view.renderId !== renderId || view.camera !== camera) {
    view.scene = scene;
    view.renderId = renderId;
    view.camera = camera;
    // The owner moved the camera after the last render: the view matrix is recomputed here if needed.
    camera.getViewMatrix().multiplyToRef(camera.getProjectionMatrix(), view.matrix);
    Frustum.GetPlanesToRef(view.matrix, view.planes);
  }
  return view.planes;
}

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
  /**
   * Poses every frame whatever the level of detail says (the soldier the death camera follows). The spectator camera is
   * written before the bodies update, so distance alone would already keep it at full rate; this makes it a guarantee.
   */
  lodFullRate = false;

  private readonly animator: SoldierAnimator;
  private readonly rifle: Mesh | null = null;
  private rifleShown = true;
  private lives = 0;
  private readonly resources: SoldierResources;
  /** Body meshes and their own materials, restored when the dead tint clears. */
  private readonly skin: { readonly mesh: AbstractMesh; readonly material: Material | null }[];
  private deadTime = 0;
  private tintStep = 0;
  private readonly scene: Scene;
  /** Root placement the hitboxes were last marked for. */
  private readonly placedPosition = new Vector3(NaN, NaN, NaN);
  private readonly placedRotation = new Quaternion(NaN, NaN, NaN, NaN);
  private readonly placedEuler = new Vector3(NaN, NaN, NaN);

  constructor(scene: Scene, resources: SoldierResources, environment: Environment, options: SoldierCharacterOptions) {
    const { name, damage } = options;
    this.scene = scene;
    this.root = new TransformNode(`${name}_root`, scene);
    this.model = resources.assets.instantiateCharacter("swat");
    const scale = soldierScale(this.model.asset);
    this.model.root.parent = this.root;
    // Keeps the loader's handedness flip on Z.
    this.model.root.scaling.scaleInPlace(scale);

    const meshes: AbstractMesh[] = this.model.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
    this.resources = resources;
    this.skin = meshes.map((mesh) => ({ mesh, material: mesh.material }));
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

  /** Seconds between pose evaluations the last `update` chose (0 = every frame); for tests and debugging. */
  get poseInterval(): number {
    return this.animator.poseInterval;
  }

  /** Knocked (up on all fours, animated) vs dead (flat, still) presentation. */
  get pose(): SoldierPose {
    return this.animator.pose;
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
   * Plays a death clip chosen by where the shot came from (or, when knocked, collapses flat from the crawl) and disables
   * hitboxes. The body lies still in its final pose, darkening slightly after a moment, until `revive`.
   * @param shotDirection World-space bullet travel direction.
   * @param settled Lie in the final pose at once, e.g. a body first seen after it died.
   */
  die(shotDirection?: Vector3, settled = false): void {
    if (this.dead) return;
    let fromBehind = false;
    if (shotDirection) {
      this.root.getDirectionToRef(FORWARD, direction);
      fromBehind = Vector3.Dot(direction, shotDirection) > 0;
    }
    this.animator.die(fromBehind ? "back" : "front", settled);
    this.hitboxes?.setEnabled(false);
  }

  /** Blends back to locomotion; hitboxes stay off until `setHitboxesEnabled(true)` so the owner decides when. */
  revive(): void {
    this.animator.revive();
    this.lives++;
    this.deadTime = 0;
    this.setTint(0);
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
    this.animator.poseInterval = this.animationInterval();
    this.animator.update(dt);
    if (this.hitboxes && (this.animator.posed || this.rootMoved())) this.hitboxes.markDirty();
    if (this.animator.dead) {
      this.deadTime += dt;
      const step = deadTintStep(this.deadTime);
      if (step !== this.tintStep) this.setTint(step);
    }
    const show = this.rifleVisible && !this.animator.handsBusy;
    if (this.rifle && show !== this.rifleShown) {
      this.rifleShown = show;
      this.rifle.setEnabled(show);
    }
  }

  /**
   * Animation level of detail (`ANIMATION_LOD`) from the gameplay camera: distance over zoom, and its view frustum.
   * Call after the owner placed the root and the camera.
   */
  private animationInterval(): number {
    if (this.lodFullRate) return 0;
    const camera = this.scene.activeCameras?.[0] ?? this.scene.activeCamera;
    if (!camera) return 0;
    const lod = ANIMATION_LOD;
    // First: refreshes the view matrix, and with it the camera's global position.
    const planes = viewPlanes(this.scene, camera);
    const p = this.root.position;
    const c = camera.globalPosition;
    const cx = p.x;
    const cy = p.y + lod.cullCenterHeight;
    const cz = p.z;
    const dx = cx - c.x;
    const dy = cy - c.y;
    const dz = cz - c.z;
    const reference = camera.fovMode === Camera.FOVMODE_HORIZONTAL_FIXED ? HORIZONTAL_HALF_TAN : VERTICAL_HALF_TAN;
    const magnification = Math.max(1, reference / Math.tan(Math.max(1e-3, camera.fov) / 2));
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) / magnification;
    let inView = true;
    for (let i = 0; i < planes.length; i++) {
      const plane = planes[i]!;
      if (plane.normal.x * cx + plane.normal.y * cy + plane.normal.z * cz + plane.d <= -lod.cullRadius) {
        inView = false;
        break;
      }
    }
    const interval = animationLodInterval(distance, inView);
    return this.animator.pose === "crawlHold" ? Math.max(interval, 1 / lod.crawlHoldHz) : interval;
  }

  private rootMoved(): boolean {
    const p = this.root.position;
    const q = this.root.rotationQuaternion;
    const last = this.placedPosition;
    const lastRotation = this.placedRotation;
    const e = this.root.rotation;
    const euler = this.placedEuler;
    const moved =
      p.x !== last.x ||
      p.y !== last.y ||
      p.z !== last.z ||
      (q ? q.x !== lastRotation.x || q.y !== lastRotation.y || q.z !== lastRotation.z || q.w !== lastRotation.w : e.x !== euler.x || e.y !== euler.y || e.z !== euler.z);
    if (moved) {
      last.copyFrom(p);
      if (q) lastRotation.copyFrom(q);
      else euler.copyFrom(e);
    }
    return moved;
  }

  /** Swaps the body onto the shared darkened material step (0 = own materials). */
  private setTint(step: number): void {
    if (step === this.tintStep) return;
    this.tintStep = step;
    for (const { mesh, material } of this.skin) {
      mesh.material = step === 0 || !material ? material : this.resources.deadMaterial(material, step);
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
