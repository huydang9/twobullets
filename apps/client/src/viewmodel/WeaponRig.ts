import {
  Color3,
  CreateBox,
  Matrix,
  PBRMaterial,
  Quaternion,
  StandardMaterial,
  TransformNode,
  Vector3,
  type AbstractMesh,
  type Material,
  type Scene,
} from "@babylonjs/core";
import type { WeaponDef, WeaponId } from "@twobullets/shared";
import type { PlayClipOptions, WeaponClipName, WeaponInstance } from "../assets";
import { PLACEHOLDER_PLANS, buildWeaponPlans, type ClipPlan, type WeaponPlans } from "./clipPlans";
import type { ViewmodelProfile } from "./weaponProfiles";

/** What happens when a clip sequence finishes: return to the idle loop, or hold the last frame. */
export type SequenceEnd = "idle" | "hold";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const NO_CLIPS: readonly WeaponClipName[] = [];
const FORWARD = new Vector3(0, 0, 1);
const IDENTITY = Quaternion.Identity();

/**
 * One first-person weapon, posed by the Viewmodel through this node chain:
 *
 *   attach (origin = sight point, posed procedurally) → offset (-sight) → stabilizer (ADS correction) → asset root
 *
 * Plays event-driven clip sequences on the WeaponInstance and exposes muzzle/ejection sockets that follow the
 * animated gun body. A placeholder (boxes, no clips) stands in when the asset is unavailable.
 */
export class WeaponRig {
  readonly id: WeaponId;
  readonly attach: TransformNode;
  readonly animated: boolean;
  readonly plans: WeaponPlans;
  /** Sight point in asset-root space (see ViewmodelProfile.sight). */
  readonly sight: Vector3;
  readonly muzzle: TransformNode;
  readonly ejection: TransformNode;
  readonly meshes: readonly AbstractMesh[];
  /** Optic lens node and its half-aperture (m, asset-root space), when the weapon has one. */
  readonly lens: TransformNode | null;
  readonly lensRadius: number;

  private readonly instance: WeaponInstance | null;
  /** Viewmodel-only material clones (textures shared with the template), safe to freeze. */
  private readonly ownMaterials: Material[] = [];
  private readonly offset: TransformNode;
  private readonly stabilizer: TransformNode;
  /** attach → … → gun body, in parent-first order, for forced world-matrix updates. */
  private readonly chain: TransformNode[];
  /** Nodes below the body down to the lens. */
  private readonly lensChain: TransformNode[];
  private readonly body: TransformNode;
  /** Body transform in asset-root parent space at the first idle frame. */
  private readonly restBody = new Matrix();
  private stabilized = false;
  /** ±1: the body's local +Z maps to forward or (through the glTF handedness flip) backward. */
  private readonly boreSign: number;

  private sequence: readonly WeaponClipName[] = NO_CLIPS;
  private readonly single: WeaponClipName[] = ["idle"];
  private index = 0;
  private speed = 1;
  private end: SequenceEnd = "idle";
  /**
   * Sequences advance on this clock rather than on Babylon's end notifications: clip starts land exactly on
   * schedule (no per-boundary frame of latency), and nothing is started from inside the animation step.
   */
  private clock = 0;
  private nextAt = 0;
  private readonly playOptions: Mutable<PlayClipOptions> = { loop: false, speed: 1 };

  private readonly invStabilizer = new Matrix();
  private readonly liveBody = new Matrix();
  private readonly correction = new Matrix();
  private readonly scaleTmp = new Vector3();
  private readonly rotationTmp = new Quaternion();
  private readonly positionTmp = new Vector3();

  private constructor(
    scene: Scene,
    id: WeaponId,
    parts: {
      root: TransformNode;
      body: TransformNode;
      muzzle: TransformNode;
      ejection: TransformNode;
      lens?: TransformNode | undefined;
      meshes: readonly AbstractMesh[];
    },
    sight: Vector3,
    instance: WeaponInstance | null,
    plans: WeaponPlans,
  ) {
    this.id = id;
    this.instance = instance;
    this.animated = instance !== null;
    this.plans = plans;
    this.sight = sight;
    this.muzzle = parts.muzzle;
    this.ejection = parts.ejection;
    this.meshes = parts.meshes;
    this.body = parts.body;
    if (instance) {
      // Template materials are shared with other instances (e.g. the soldiers' rifle); the viewmodel lights them
      // differently (no shadows, no sky fill) and freezes them, so it gets its own copies. Like
      // instantiateModelsToScene(cloneMaterials), textures are cloned as wrappers over the same GPU texture.
      const clones = new Map<Material, Material>();
      for (const mesh of parts.meshes) {
        const material = mesh.material;
        if (!material) continue;
        let clone = clones.get(material);
        if (!clone) {
          clone = material.clone(`vm_${material.name}`) ?? material;
          clones.set(material, clone);
          if (clone !== material) this.ownMaterials.push(clone);
        }
        mesh.material = clone;
      }
    }

    // Measure the rest pose before re-parenting, while the asset root is at the scene origin.
    instance?.goToFrame(instance.asset.clips.idle?.[0] ?? 0);
    const fromRoot: TransformNode[] = [];
    for (let node: TransformNode | null = parts.body; node; node = node.parent as TransformNode | null) {
      fromRoot.unshift(node);
      if (node === parts.root) break;
    }
    for (const node of fromRoot) node.computeWorldMatrix(true);
    this.restBody.copyFrom(parts.body.getWorldMatrix());
    this.boreSign = Vector3.TransformNormal(FORWARD, this.restBody).z < 0 ? -1 : 1;

    this.attach = new TransformNode(`vm_${id}_attach`, scene);
    this.offset = new TransformNode(`vm_${id}_offset`, scene);
    this.stabilizer = new TransformNode(`vm_${id}_stabilizer`, scene);
    this.stabilizer.rotationQuaternion = Quaternion.Identity();
    this.offset.parent = this.attach;
    this.offset.position.set(-sight.x, -sight.y, -sight.z);
    this.stabilizer.parent = this.offset;
    parts.root.parent = this.stabilizer;
    this.chain = [this.attach, this.offset, this.stabilizer, ...fromRoot];

    this.lens = parts.lens ?? null;
    this.lensChain = [];
    for (let node = this.lens; node && node !== parts.body; node = node.parent as TransformNode | null) this.lensChain.unshift(node);
    this.lensRadius = this.lens ? apertureRadius(this.lens) : 0;
  }

  static fromInstance(scene: Scene, instance: WeaponInstance, def: WeaponDef, profile: ViewmodelProfile): WeaponRig {
    const sight = profile.sight === "scopeLens" ? instance.asset.anchors.scopeLens : profile.sight;
    if (!sight) throw new Error(`Weapon ${instance.id}: profile wants anchors.scopeLens but the manifest has none`);
    const { root, nodes, meshes } = instance;
    const rig = new WeaponRig(
      scene,
      instance.id,
      { root, body: nodes.body, muzzle: nodes.muzzle, ejection: nodes.ejection, lens: nodes.scopeLens, meshes },
      new Vector3(sight[0], sight[1], sight[2]),
      instance,
      buildWeaponPlans(instance, def),
    );
    if (profile.optic && rig.lens) rig.useGlass(scene, profile.optic.glass);
    return rig;
  }

  /** Untextured stand-in gun used only when the weapon asset failed to load. */
  static placeholder(scene: Scene, id: WeaponId, material: Material): WeaponRig {
    const length = PLACEHOLDER_LENGTH[id];
    const root = new TransformNode(`vm_${id}_placeholder`, scene);
    const box = (name: string, size: [number, number, number], center: [number, number, number]) => {
      const mesh = CreateBox(`vm_${id}_${name}`, { width: size[0], height: size[1], depth: size[2] }, scene);
      mesh.position.set(...center);
      mesh.material = material;
      mesh.parent = root;
      return mesh;
    };
    const meshes = [
      box("receiver", [0.045, 0.07, length * 0.4], [0, -0.02, length * 0.2]),
      box("barrel", [0.02, 0.02, length * 0.6], [0, 0, length * 0.7]),
      box("grip", [0.035, 0.1, 0.04], [0, -0.09, length * 0.12]),
      box("sight", [0.02, 0.025, 0.03], [0, 0.03, 0.03]),
    ];
    const muzzle = new TransformNode(`vm_${id}_muzzle`, scene);
    muzzle.parent = root;
    muzzle.position.set(0, 0, length);
    const ejection = new TransformNode(`vm_${id}_ejection`, scene);
    ejection.parent = root;
    ejection.position.set(0.025, 0, length * 0.25);
    return new WeaponRig(scene, id, { root, body: root, muzzle, ejection, meshes }, new Vector3(0, 0.043, 0.03), null, PLACEHOLDER_PLANS);
  }

  static createPlaceholderMaterial(scene: Scene): StandardMaterial {
    const material = new StandardMaterial("vm_placeholder", scene);
    material.diffuseColor = new Color3(0.16, 0.16, 0.17);
    material.specularColor = new Color3(0.25, 0.25, 0.25);
    return material;
  }

  /**
   * Replaces the asset's lens material (rifle: an opaque disc with a baked orange ring; sniper: opaque tinted) with
   * see-through glass: nearly transparent base, IBL reflections kept over alpha, no depth write so the red dot and
   * the world behind stay visible. Drawn after the opaque viewmodel meshes in the same rendering group.
   */
  useGlass(scene: Scene, settings: { readonly tint: readonly [number, number, number]; readonly alpha: number }): void {
    if (!this.lens) return;
    const glass = new PBRMaterial(`vm_${this.id}_glass`, scene);
    glass.albedoColor.set(...settings.tint);
    glass.alpha = settings.alpha;
    glass.metallic = 0;
    glass.roughness = 0.04;
    glass.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    glass.useRadianceOverAlpha = true;
    glass.useSpecularOverAlpha = true;
    glass.disableDepthWrite = true;
    for (const mesh of this.lens.getChildMeshes(false)) {
      const previous = mesh.material;
      mesh.material = glass;
      mesh.alphaIndex = 1;
      if (previous && !this.meshes.some((m) => m.material === previous)) {
        const index = this.ownMaterials.indexOf(previous);
        if (index >= 0) this.ownMaterials.splice(index, 1);
        previous.dispose(false, true);
      }
    }
    this.ownMaterials.push(glass);
  }

  /** World-space lens center and unit bore axis; false when the weapon has no optic. */
  getLensToRef(position: Vector3, bore: Vector3): boolean {
    if (!this.lens) return false;
    this.lens.getWorldMatrix().getTranslationToRef(position);
    Vector3.TransformNormalToRef(FORWARD, this.body.getWorldMatrix(), bore);
    bore.normalize().scaleInPlace(this.boreSign);
    return true;
  }

  setEnabled(enabled: boolean): void {
    this.attach.setEnabled(enabled);
  }

  hasClip(clip: WeaponClipName): boolean {
    return this.instance?.hasClip(clip) ?? false;
  }

  clipDuration(clip: WeaponClipName): number {
    return this.instance?.hasClip(clip) ? this.instance.clipDuration(clip) : 0;
  }

  play(plan: ClipPlan, end: SequenceEnd = "idle"): void {
    this.start(plan.clips, plan.speed, end);
  }

  /** Plays one clip so that it lasts `seconds`. */
  playFor(clip: WeaponClipName, seconds: number, end: SequenceEnd = "idle"): void {
    if (!this.hasClip(clip)) return;
    this.single[0] = clip;
    this.start(this.single, this.clipDuration(clip) / Math.max(seconds, 1e-3), end);
  }

  idle(): void {
    this.sequence = NO_CLIPS;
    if (!this.instance?.hasClip("idle")) return;
    this.playOptions.loop = true;
    this.playOptions.speed = 1;
    this.instance.play("idle", this.playOptions);
  }

  /** Stops playback, holding the current frame (for guns that are put away). */
  stop(): void {
    this.sequence = NO_CLIPS;
    this.instance?.stop();
  }

  /** Per frame before scene.render: starts the next clip of the sequence when its time comes. */
  update(dt: number): void {
    this.clock += dt;
    while (this.sequence !== NO_CLIPS && this.clock >= this.nextAt) this.next();
  }

  /**
   * Blends in a correction that puts the animated gun body back on its rest pose (and so the sight on the camera
   * ray), weight 0..1. Call after the animation step with the attach node's parents up to date.
   */
  stabilize(weight: number): void {
    if (!this.animated) return;
    if (weight <= 1e-3) {
      if (this.stabilized) {
        this.stabilizer.position.setAll(0);
        this.stabilizer.rotationQuaternion?.set(0, 0, 0, 1);
        this.stabilized = false;
      }
      return;
    }
    this.computeChain();
    // body.world = L·R·C·parents and stabilizer.world = C·parents, so this yields L·R: the live body in asset-root
    // parent space independent of the correction C already applied.
    this.stabilizer.getWorldMatrix().invertToRef(this.invStabilizer);
    this.body.getWorldMatrix().multiplyToRef(this.invStabilizer, this.liveBody);
    this.liveBody.invert().multiplyToRef(this.restBody, this.correction);
    this.correction.decompose(this.scaleTmp, this.rotationTmp, this.positionTmp);
    const rotation = this.stabilizer.rotationQuaternion as Quaternion;
    Quaternion.SlerpToRef(IDENTITY, this.rotationTmp, weight, rotation);
    this.positionTmp.scaleToRef(weight, this.stabilizer.position);
    this.stabilized = true;
  }

  /** Refreshes world matrices down to the sockets for this frame's pose and animation. */
  updateSockets(): void {
    this.computeChain();
    this.muzzle.computeWorldMatrix(true);
    this.ejection.computeWorldMatrix(true);
    for (const node of this.lensChain) node.computeWorldMatrix(true);
  }

  getMuzzleToRef(position: Vector3, forward: Vector3): void {
    this.muzzle.getWorldMatrix().getTranslationToRef(position);
    Vector3.TransformNormalToRef(FORWARD, this.body.getWorldMatrix(), forward);
    forward.normalize().scaleInPlace(this.boreSign);
  }

  getEjectionToRef(position: Vector3): void {
    this.ejection.getWorldMatrix().getTranslationToRef(position);
  }

  freezeMaterials(): void {
    for (const material of this.ownMaterials) material.freeze();
  }

  dispose(): void {
    this.instance?.dispose();
    // Cloned Texture wrappers share the template's GPU textures through the engine cache (refcounted).
    for (const material of this.ownMaterials) material.dispose(false, true);
    if (!this.instance) {
      for (const mesh of this.meshes) mesh.dispose();
      this.body.dispose();
    }
    this.stabilizer.dispose();
    this.offset.dispose();
    this.attach.dispose();
  }

  private start(clips: readonly WeaponClipName[], speed: number, end: SequenceEnd): void {
    if (!this.instance || clips.length === 0) return;
    this.sequence = clips;
    this.index = 0;
    this.speed = speed;
    this.end = end;
    this.nextAt = this.clock;
    this.next();
  }

  private next(): void {
    const instance = this.instance as WeaponInstance;
    const clip = this.sequence[this.index];
    if (clip === undefined) {
      this.sequence = NO_CLIPS;
      if (this.end === "idle") this.idle();
      return;
    }
    this.index++;
    this.nextAt += instance.clipDuration(clip) / this.speed;
    this.playOptions.loop = false;
    this.playOptions.speed = this.speed;
    instance.play(clip, this.playOptions);
  }

  private computeChain(): void {
    for (const node of this.chain) node.computeWorldMatrix(true);
  }
}

/** Half the smaller cross-section extent of the lens meshes, in the asset root's parent space. */
function apertureRadius(lens: TransformNode): number {
  let radius = Infinity;
  for (const mesh of lens.getChildMeshes(false)) {
    mesh.computeWorldMatrix(true);
    const extent = mesh.getBoundingInfo().boundingBox.extendSizeWorld;
    radius = Math.min(radius, extent.x, extent.y);
  }
  return Number.isFinite(radius) ? radius : 0.015;
}

const PLACEHOLDER_LENGTH: Readonly<Record<WeaponId, number>> = { rifle: 0.75, shotgun: 0.9, pistol: 0.22, sniper: 1.05 };
