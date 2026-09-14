import { TransformNode, Vector3, type AbstractMesh, type Material, type Scene, type TargetCamera } from "@babylonjs/core";
import { CAMERA, MOVEMENT, getWeaponDef, type Vec3, type WeaponDef, type WeaponId, type WeaponPhase } from "@twobullets/shared";
import type { AssetLibrary } from "../assets";
import type { Environment } from "../world/environment";
import type { ClipPlan } from "./clipPlans";
import { RedDot } from "./RedDot";
import { VIEWMODEL_RENDERING_GROUP } from "./renderGroups";
import { Spring, angleDelta, clamp, lerp, smoothstep } from "./Spring";
import { VIEWMODEL_PROFILES, type ViewmodelProfile } from "./weaponProfiles";
import { WeaponRig } from "./WeaponRig";

export { VIEWMODEL_RENDERING_GROUP } from "./renderGroups";

const WEAPON_IDS: readonly WeaponId[] = ["rifle", "shotgun", "pistol", "sniper"];
const DEG_TO_RAD = Math.PI / 180;
/** The viewmodel is authored for the base FOV; other FOVs (sprint, ADS zoom) are compensated to look identical. */
const REFERENCE_HALF_TAN = Math.tan(2 * Math.atan(Math.tan((CAMERA.fovDegrees * DEG_TO_RAD) / 2) / (16 / 9)) / 2);
/** Scoped weapons disappear past this ADS blend; the HUD draws the scope overlay. */
const SCOPE_HIDE_BLEND = 0.9;
const FALLBACK_EQUIP_SECONDS = 0.35;
/** Weapon switches put the old gun away first when the equip time allows it. */
const HIDE_FRACTION = 0.35;
const MIN_EQUIP_SECONDS_FOR_HIDE = 0.45;
/** The fire clips already kick the gun at the hip; procedural recoil only adds variation there. */
const ANIMATED_HIP_RECOIL_SCALE = 0.4;
const FORWARD = new Vector3(0, 0, 1);

/** Per-frame facts the viewmodel reacts to. Owned and refilled by the caller to avoid allocations. */
export interface ViewmodelFrame {
  weaponId: WeaponId;
  def: WeaponDef;
  phase: WeaponPhase;
  adsBlend: number;
  /** Aim without camera punch, radians. */
  yaw: number;
  pitch: number;
  velocity: Vec3;
  grounded: boolean;
  sprinting: boolean;
}

/**
 * First-person arms and weapon: the animated asset per weapon (clips driven by combat events) with procedural
 * layers summed on top every frame: look sway, movement bob, landing, sprint pose, recoil springs and the hip→ADS
 * blend that lands the sight on the camera ray.
 */
export class Viewmodel {
  /** Visual camera kick (radians) for the caller to forward to the player camera. */
  readonly punch = new Vector3();

  /** Parented to the camera; scaled in X/Y to cancel FOV changes. */
  private readonly fovRoot: TransformNode;
  private readonly pose: TransformNode;
  private readonly rigs: Record<WeaponId, WeaponRig>;
  private readonly placeholderMaterial: Material | null;
  private readonly redDot: RedDot;
  private rig: WeaponRig;
  private profile: ViewmodelProfile;
  private pendingRig: WeaponRig | null = null;
  private switchAt = 0;
  private pendingReadySeconds = 0;

  private time = 0;
  private dt = 0;
  private equipStart = -10;
  private equipSeconds = FALLBACK_EQUIP_SECONDS;
  private reloadStart = -10;
  private reloadSeconds = 0;
  private hasAim = false;
  private lastYaw = 0;
  private lastPitch = 0;
  private recoilYaw = 0;
  private recoilPitch = 0;
  private bobPhase = 0;
  private bobWeight = 0;
  private wasGrounded = true;
  private airVelocityY = 0;
  private hidden = false;

  private readonly recoilBack = new Spring(11, 0.5);
  private readonly recoilUp = new Spring(11, 0.5);
  private readonly recoilPitchSpring = new Spring(11, 0.5);
  private readonly recoilYawSpring = new Spring(11, 0.5);
  private readonly recoilRoll = new Spring(11, 0.5);
  private readonly swayX = new Spring(6, 0.7);
  private readonly swayY = new Spring(6, 0.7);
  private readonly swayPitch = new Spring(6, 0.7);
  private readonly swayYaw = new Spring(6, 0.7);
  private readonly swayRoll = new Spring(6, 0.7);
  private readonly landY = new Spring(5, 0.45);
  private readonly landPitch = new Spring(5, 0.45);
  private readonly sprint = new Spring(4, 0.9);
  private readonly reload = new Spring(6, 1);
  private readonly punchPitch = new Spring(14, 0.55);
  private readonly punchYaw = new Spring(14, 0.55);
  private readonly punchRoll = new Spring(14, 0.55);
  private readonly recoilSprings = [this.recoilBack, this.recoilUp, this.recoilPitchSpring, this.recoilYawSpring, this.recoilRoll];

  constructor(
    scene: Scene,
    private readonly camera: TargetCamera,
    environment: Environment,
    assets: AssetLibrary | null,
    initialWeapon: WeaponId,
  ) {
    scene.setRenderingAutoClearDepthStencil(VIEWMODEL_RENDERING_GROUP, true, true, false);

    this.fovRoot = new TransformNode("vm_fovRoot", scene);
    this.fovRoot.parent = camera;
    this.pose = new TransformNode("vm_pose", scene);
    this.pose.parent = this.fovRoot;
    this.redDot = new RedDot(scene, camera);

    let placeholderMaterial: Material | null = null;
    const rigs = {} as Record<WeaponId, WeaponRig>;
    for (const id of WEAPON_IDS) {
      let rig: WeaponRig | null = null;
      if (assets) {
        try {
          rig = WeaponRig.fromInstance(scene, assets.instantiateWeapon(id), getWeaponDef(id), VIEWMODEL_PROFILES[id]);
        } catch (error) {
          console.error(`[viewmodel] ${id}: could not build the animated viewmodel, using a placeholder gun`, error);
        }
      }
      if (!rig) {
        placeholderMaterial ??= WeaponRig.createPlaceholderMaterial(scene);
        rig = WeaponRig.placeholder(scene, id, placeholderMaterial);
      }
      rig.attach.parent = this.pose;
      for (const mesh of rig.meshes) prepareMesh(mesh, environment);
      rig.setEnabled(false);
      rigs[id] = rig;
    }
    if (!assets) console.error("[viewmodel] weapon assets unavailable; showing placeholder guns");
    this.rigs = rigs;
    this.placeholderMaterial = placeholderMaterial;
    // Materials are fully configured (IBL, lights, no shadows) by the first frame; skip re-validating them after.
    scene.onAfterRenderObservable.addOnce(() => {
      for (const id of WEAPON_IDS) this.rigs[id].freezeMaterials();
    });

    this.rig = rigs[initialWeapon];
    this.profile = VIEWMODEL_PROFILES[initialWeapon];
    this.show(this.rig);
    this.rig.idle();
  }

  get weaponId(): WeaponId {
    return (this.pendingRig ?? this.rig).id;
  }

  /** False while a scoped weapon is fully aimed. */
  get visible(): boolean {
    return !this.hidden;
  }

  get activeProfile(): ViewmodelProfile {
    return this.profile;
  }

  /** Puts the current gun away (if there's time) and brings `id` up so the draw ends after `seconds`. */
  equip(id: WeaponId, seconds: number): void {
    const target = this.rigs[id];
    const current = this.rig;
    seconds = Math.max(0.05, seconds);
    this.equipStart = this.time;
    this.equipSeconds = seconds;
    this.reloadSeconds = 0;
    if (this.pendingRig) {
      // Switched again while the previous gun was still going away: skip straight to the new draw.
      this.pendingRig = null;
    } else if (target !== current && !this.hidden && current.hasClip("hide") && seconds >= MIN_EQUIP_SECONDS_FOR_HIDE) {
      const hideSeconds = seconds * HIDE_FRACTION;
      current.playFor("hide", hideSeconds, "hold");
      this.pendingRig = target;
      this.switchAt = this.time + hideSeconds;
      this.pendingReadySeconds = seconds - hideSeconds;
      return;
    }
    this.show(target);
    target.playFor("ready", seconds);
  }

  /** Plays the shot (and bolt/pump) clips and kicks the recoil springs. Returns the plan for sounds and casings. */
  fire(recoilUp: number, recoilRight: number, adsBlend: number, magazineEmpty: boolean): ClipPlan {
    this.completeSwitch();
    const rig = this.rig;
    const plan = magazineEmpty ? rig.plans.fireLast : rig.plans.fire;
    rig.play(plan);

    const r = this.profile.recoil;
    const hipScale = rig.animated ? ANIMATED_HIP_RECOIL_SCALE : 1;
    const scale = lerp(hipScale, r.adsScale, adsBlend) * (0.9 + Math.random() * 0.2);
    this.recoilBack.kick(-r.back * scale);
    this.recoilUp.kick(r.up * scale);
    this.recoilPitchSpring.kick(-r.pitch * scale);
    this.recoilYawSpring.kick((Math.random() * 2 - 1) * r.yaw * scale);
    this.recoilRoll.kick((Math.random() * 2 - 1) * r.roll * scale);

    const punch = this.profile.cameraPunch;
    const punchScale = lerp(1, 0.6, adsBlend);
    this.punchPitch.kick(-punch.pitch * punchScale);
    this.punchYaw.kick((Math.random() * 2 - 1) * punch.yaw * punchScale);
    this.punchRoll.kick((Math.random() * 2 - 1) * punch.roll * punchScale);

    // Aim recoil isn't mouse look; keep it out of the sway input.
    this.recoilPitch += recoilUp;
    this.recoilYaw += recoilRight;
    return plan;
  }

  /** Starts the reload clips, time-scaled to the gameplay reload. Returns the plan for sounds. */
  startReload(seconds: number, magazineEmpty: boolean): ClipPlan {
    this.completeSwitch();
    const plan = magazineEmpty ? this.rig.plans.reloadEmpty : this.rig.plans.reload;
    this.rig.play(plan);
    this.reloadStart = this.time;
    this.reloadSeconds = seconds;
    return plan;
  }

  cancelReload(): void {
    this.reloadSeconds = 0;
    this.rig.idle();
  }

  onDryFire(): void {
    this.recoilPitchSpring.kick(-0.012);
    this.recoilBack.kick(-0.004);
  }

  /** Before scene.render: advances time, weapon switches and clip sequences. */
  advance(dt: number): void {
    this.time += dt;
    this.dt = dt;
    if (this.pendingRig && this.time >= this.switchAt) {
      const target = this.pendingRig;
      this.pendingRig = null;
      this.show(target);
      target.playFor("ready", this.pendingReadySeconds);
    }
    for (const id of WEAPON_IDS) this.rigs[id].update(dt);
  }

  /** After the animation step (scene.onBeforeRender): composes the pose and refreshes the sockets. */
  update(frame: ViewmodelFrame): void {
    const dt = this.dt;
    if (frame.weaponId !== this.weaponId) this.equip(frame.weaponId, FALLBACK_EQUIP_SECONDS);
    const safeDt = Math.max(dt, 1e-4);
    const profile = this.profile;
    const rig = this.rig;
    const animated = rig.animated;

    const scoped = frame.def.ads.scoped;
    const ads = smoothstep(0, 1, frame.adsBlend);
    this.setHidden(scoped && frame.adsBlend > SCOPE_HIDE_BLEND);
    const reloading = frame.phase === "reloading";

    // FOV compensation: scaling camera-space X/Y by the tangent ratio projects exactly like the reference FOV.
    const fovScale = Math.tan(this.camera.fov / 2) / REFERENCE_HALF_TAN;
    this.fovRoot.scaling.set(fovScale, fovScale, 1);

    // --- Look sway -------------------------------------------------------------------------------------------
    if (!this.hasAim) {
      this.lastYaw = frame.yaw;
      this.lastPitch = frame.pitch;
      this.hasAim = true;
    }
    const yawRate = (angleDelta(frame.yaw, this.lastYaw) - this.recoilYaw) / safeDt;
    const pitchRate = (frame.pitch - this.lastPitch + this.recoilPitch) / safeDt;
    this.lastYaw = frame.yaw;
    this.lastPitch = frame.pitch;
    this.recoilYaw = 0;
    this.recoilPitch = 0;
    const swayScale = 1 - 0.75 * ads;
    const swayX = this.swayX.update(dt, clamp(-yawRate * 0.005, -0.022, 0.022)) * swayScale;
    const swayY = this.swayY.update(dt, clamp(pitchRate * 0.004, -0.018, 0.018)) * swayScale;
    const swayPitch = this.swayPitch.update(dt, clamp(-pitchRate * 0.012, -0.06, 0.06)) * swayScale;
    const swayYaw = this.swayYaw.update(dt, clamp(-yawRate * 0.015, -0.07, 0.07)) * swayScale;
    const swayRoll = this.swayRoll.update(dt, clamp(-yawRate * 0.025, -0.1, 0.1)) * swayScale;

    // --- Movement bob, landing, sprint --------------------------------------------------------------------------
    const v = frame.velocity;
    const speed = Math.hypot(v.x, v.z);
    const bobTarget = frame.grounded ? clamp(speed / MOVEMENT.walkSpeed, 0, 1.5) : 0;
    this.bobWeight += (bobTarget - this.bobWeight) * (1 - Math.exp(-10 * dt));
    if (frame.grounded) this.bobPhase = (this.bobPhase + (speed * dt * Math.PI * 2) / CAMERA.headBobStride) % (Math.PI * 4);

    if (!frame.grounded) this.airVelocityY = v.y;
    if (frame.grounded && !this.wasGrounded) {
      const impact = clamp(-this.airVelocityY / 18, 0, 1);
      this.landY.kick(-0.008 - 0.03 * impact);
      this.landPitch.kick(0.015 + 0.05 * impact);
    } else if (!frame.grounded && this.wasGrounded && v.y > 1) {
      this.landY.kick(-0.012);
      this.landPitch.kick(0.02);
    }
    this.wasGrounded = frame.grounded;
    const landY = this.landY.update(dt);
    const landPitch = this.landPitch.update(dt);

    const sprintTarget = frame.sprinting && speed > MOVEMENT.walkSpeed * 0.8 && ads < 0.3 && !reloading ? 1 : 0;
    const sprint = clamp(this.sprint.update(dt, sprintTarget), 0, 1.2);

    const bobAmount = this.bobWeight * (1 + 0.9 * sprint) * (1 - 0.85 * ads);
    const halfPhase = this.bobPhase * 0.5;
    const bobX = Math.sin(halfPhase) * 0.011 * bobAmount;
    const bobY = Math.sin(this.bobPhase) * 0.006 * bobAmount;
    const bobRoll = Math.sin(halfPhase) * 0.02 * bobAmount;
    const bobPitch = Math.sin(this.bobPhase) * 0.012 * bobAmount;

    // --- Idle breathing (the idle clip breathes at the hip; ADS stabilization removes it, so add it back there) ---
    const breathe = (animated ? 0.4 * ads : 1 - 0.6 * ads) * (1 - Math.min(1, this.bobWeight));
    const breatheY = Math.sin(this.time * 1.7) * 0.0016 * breathe;
    const breatheX = Math.sin(this.time * 0.85) * 0.001 * breathe;
    const breathePitch = Math.sin(this.time * 1.7 + 0.6) * 0.005 * breathe;

    // --- Recoil and camera punch ------------------------------------------------------------------------------
    const recoilBack = this.recoilBack.update(dt);
    const recoilUp = this.recoilUp.update(dt);
    const recoilPitch = this.recoilPitchSpring.update(dt);
    const recoilYaw = this.recoilYawSpring.update(dt);
    const recoilRoll = this.recoilRoll.update(dt);
    this.punch.set(this.punchPitch.update(dt), this.punchYaw.update(dt), this.punchRoll.update(dt));

    // --- Placeholder-only stand-ins for the draw and reload clips -----------------------------------------------
    let equipDown = 0;
    let reload = 0;
    if (!animated) {
      equipDown = 1 - easeOutBack(clamp((this.time - this.equipStart) / this.equipSeconds, 0, 1));
      const p = this.reloadSeconds > 0 ? (this.time - this.reloadStart) / this.reloadSeconds : 1;
      reload = this.reload.update(dt, p < 1 ? smoothstep(0, 0.12, p) * (1 - smoothstep(0.86, 1, p)) : 0);
    }

    // --- Compose: the pose origin is the sight point ------------------------------------------------------------
    const hip = profile.hipSight;
    const hipRotation = profile.hipRotation;
    const so = profile.sprintOffset;
    const sr = profile.sprintRotation;
    const sprintPose = sprint * (1 - ads);
    const hipWeight = 1 - ads;

    this.pose.position.set(
      lerp(hip[0], 0, ads) + so[0] * sprintPose + swayX + bobX + breatheX - 0.02 * reload,
      lerp(hip[1], 0, ads) + so[1] * sprintPose + swayY + bobY + breatheY + landY + recoilUp - 0.045 * reload - 0.22 * equipDown,
      lerp(hip[2], profile.adsEyeDistance, ads) + so[2] * sprintPose + recoilBack - 0.03 * reload - 0.05 * equipDown,
    );
    this.pose.rotation.set(
      hipRotation[0] * hipWeight + sr[0] * sprintPose + swayPitch + bobPitch + breathePitch + landPitch + recoilPitch - 0.12 * reload + 0.9 * equipDown,
      hipRotation[1] * hipWeight + sr[1] * sprintPose + swayYaw + recoilYaw - 0.25 * reload,
      hipRotation[2] * hipWeight + sr[2] * sprintPose + swayRoll + bobRoll + recoilRoll + 0.45 * reload - 0.3 * equipDown,
    );

    this.fovRoot.computeWorldMatrix(true);
    this.pose.computeWorldMatrix(true);
    rig.stabilize(ads);
    rig.updateSockets();
    this.redDot.update(rig, profile.optic?.dot, !this.hidden);
  }

  /** World-space muzzle position and unit bore axis, reflecting this frame's pose and animation. */
  getMuzzleToRef(position: Vector3, forward: Vector3): void {
    this.rig.getMuzzleToRef(position, forward);
  }

  getEjectPortToRef(position: Vector3): void {
    this.rig.getEjectionToRef(position);
  }

  /** Camera basis vectors (world space), for effects authored relative to the view. */
  getCameraAxesToRef(right: Vector3, up: Vector3, forward: Vector3): void {
    const world = this.camera.getWorldMatrix();
    Vector3.TransformNormalToRef(Vector3.RightReadOnly, world, right);
    Vector3.TransformNormalToRef(Vector3.UpReadOnly, world, up);
    Vector3.TransformNormalToRef(FORWARD, world, forward);
    right.normalize();
    up.normalize();
    forward.normalize();
  }

  dispose(): void {
    for (const id of WEAPON_IDS) this.rigs[id].dispose();
    this.placeholderMaterial?.dispose();
    this.redDot.dispose();
    this.pose.dispose();
    this.fovRoot.dispose();
  }

  private completeSwitch(): void {
    if (!this.pendingRig) return;
    const target = this.pendingRig;
    this.pendingRig = null;
    this.show(target);
  }

  private show(rig: WeaponRig): void {
    if (rig !== this.rig) {
      this.rig.setEnabled(false);
      this.rig.stop();
    }
    this.rig = rig;
    this.profile = VIEWMODEL_PROFILES[rig.id];
    rig.setEnabled(!this.hidden);
    const { frequency, damping } = this.profile.recoil;
    for (const spring of this.recoilSprings) {
      spring.tune(frequency, damping);
      spring.reset();
    }
  }

  private setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.rig.setEnabled(!hidden);
  }
}

function prepareMesh(mesh: AbstractMesh, environment: Environment): void {
  mesh.renderingGroupId = VIEWMODEL_RENDERING_GROUP;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.applyFog = false;
  // Camera-parented and always in view; skip culling so the compensated scale and skinning never mis-cull it.
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.doNotSyncBoundingInfo = true;
  // Lit by the IBL; the hemispheric sky fill would add ambient a second time.
  environment.skyFill.excludedMeshes.push(mesh);
}

function easeOutBack(t: number): number {
  const c1 = 1.3;
  const u = t - 1;
  return 1 + (c1 + 1) * u * u * u + c1 * u * u;
}
