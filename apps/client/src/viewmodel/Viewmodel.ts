import { TransformNode, Vector3, type Scene, type TargetCamera } from "@babylonjs/core";
import { CAMERA, MOVEMENT, type Vec3, type WeaponDef, type WeaponId, type WeaponPhase } from "@twobullets/shared";
import { Spring, angleDelta, clamp, lerp, pulse, smoothstep } from "./Spring";
import { createViewmodelMaterials, type ViewmodelMaterials } from "./materials";
import { RELOAD_CUES, actionCycleFor, reloadCueAt, type ActionCycle } from "./timelines";
import { VIEWMODEL_PROFILES, type ViewmodelProfile } from "./weaponProfiles";
import { buildWeaponModel, type WeaponModel } from "./weaponModels";

/** Rendering group drawn after the world with depth cleared, so the gun never clips into walls. */
export const VIEWMODEL_RENDERING_GROUP = 1;

const WEAPON_IDS: readonly WeaponId[] = ["rifle", "shotgun", "pistol", "sniper"];
const DEG_TO_RAD = Math.PI / 180;
/** The viewmodel is authored for the base FOV; other FOVs (sprint, ADS zoom) are compensated to look identical. */
const REFERENCE_HALF_TAN = Math.tan(2 * Math.atan(Math.tan((CAMERA.fovDegrees * DEG_TO_RAD) / 2) / (16 / 9)) / 2);
/** Scoped weapons disappear past this ADS blend; the HUD draws the scope overlay. */
const SCOPE_HIDE_BLEND = 0.9;
const FALLBACK_EQUIP_SECONDS = 0.35;
const FORWARD = new Vector3(0, 0, 1);

/** Per-frame facts the viewmodel reacts to. Owned and refilled by the caller to avoid allocations. */
export interface ViewmodelFrame {
  weaponId: WeaponId;
  def: WeaponDef;
  phase: WeaponPhase;
  phaseProgress: number | null;
  adsBlend: number;
  /** Aim without camera punch, radians. */
  yaw: number;
  pitch: number;
  velocity: Vec3;
  grounded: boolean;
  sprinting: boolean;
}

/** Hand-animated first-person weapon: procedural pose layers summed on top of a hip/ADS base every frame. */
export class Viewmodel {
  /** Visual camera kick (radians) for the caller to forward to the player camera. */
  readonly punch = new Vector3();

  private readonly materials: ViewmodelMaterials;
  /** Parented to the camera; scaled in X/Y to cancel FOV changes. */
  private readonly fovRoot: TransformNode;
  private readonly pose: TransformNode;
  private readonly models: Record<WeaponId, WeaponModel>;
  private model: WeaponModel;
  private profile: ViewmodelProfile;
  private cycle: ActionCycle | null = null;

  private time = 0;
  private lastShotTime = -10;
  private cycleStart = -10;
  private equipStart = -10;
  private equipSeconds = FALLBACK_EQUIP_SECONDS;
  private lastReloadProgress = 0;
  private lastCycleU = 1;
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

  private readonly adsTarget = new Vector3();

  constructor(
    scene: Scene,
    private readonly camera: TargetCamera,
    initialWeapon: WeaponId,
  ) {
    scene.setRenderingAutoClearDepthStencil(VIEWMODEL_RENDERING_GROUP, true, true, false);

    this.materials = createViewmodelMaterials(scene);

    this.fovRoot = new TransformNode("vm_fovRoot", scene);
    this.fovRoot.parent = camera;
    this.pose = new TransformNode("vm_pose", scene);
    this.pose.parent = this.fovRoot;

    const models = {} as Record<WeaponId, WeaponModel>;
    for (const id of WEAPON_IDS) {
      const model = buildWeaponModel(id, scene, this.materials.bySurface, this.pose);
      for (const mesh of model.meshes) {
        mesh.renderingGroupId = VIEWMODEL_RENDERING_GROUP;
        mesh.isPickable = false;
        mesh.receiveShadows = false;
        mesh.applyFog = false;
        // Camera-parented and always in view; skip culling so the compensated scale never mis-culls it.
        mesh.alwaysSelectAsActiveMesh = true;
      }
      model.root.setEnabled(false);
      models[id] = model;
    }
    this.models = models;
    this.model = models[initialWeapon];
    this.profile = VIEWMODEL_PROFILES[initialWeapon];
    this.setWeapon(initialWeapon);
  }

  get weaponId(): WeaponId {
    return this.model.id;
  }

  /** False while a scoped weapon is fully aimed. */
  get visible(): boolean {
    return !this.hidden;
  }

  get activeProfile(): ViewmodelProfile {
    return this.profile;
  }

  setWeapon(id: WeaponId): void {
    this.model.root.setEnabled(false);
    this.model = this.models[id];
    this.profile = VIEWMODEL_PROFILES[id];
    this.model.root.setEnabled(!this.hidden);
    const { frequency, damping } = this.profile.recoil;
    for (const spring of [this.recoilBack, this.recoilUp, this.recoilPitchSpring, this.recoilYawSpring, this.recoilRoll]) {
      spring.tune(frequency, damping);
      spring.reset();
    }
    this.cycle = null;
    this.cycleStart = -10;
    this.lastShotTime = -10;
    this.resetParts();
    this.startEquip(FALLBACK_EQUIP_SECONDS);
  }

  startEquip(seconds: number): void {
    this.equipStart = this.time;
    this.equipSeconds = Math.max(0.05, seconds);
  }

  onShot(def: WeaponDef, recoilUp: number, recoilRight: number, adsBlend: number): void {
    const r = this.profile.recoil;
    const scale = lerp(1, r.adsScale, adsBlend) * (0.9 + Math.random() * 0.2);
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

    this.lastShotTime = this.time;
    this.cycle = actionCycleFor(def);
    if (this.cycle) this.cycleStart = this.time + this.cycle.delay;
  }

  onDryFire(): void {
    this.recoilPitchSpring.kick(-0.012);
    this.recoilBack.kick(-0.004);
  }

  /** Jolt for impacts inside animations (mag slap, bolt close). */
  jolt(strength: number): void {
    this.recoilUp.kick(0.006 * strength);
    this.recoilPitchSpring.kick(-0.03 * strength);
    this.recoilRoll.kick((Math.random() - 0.5) * 0.02 * strength);
  }

  update(dt: number, frame: ViewmodelFrame): void {
    this.time += dt;
    if (frame.weaponId !== this.model.id) this.setWeapon(frame.weaponId);
    const safeDt = Math.max(dt, 1e-4);
    const profile = this.profile;
    const model = this.model;

    const scoped = frame.def.ads.scoped;
    const ads = smoothstep(0, 1, frame.adsBlend);
    this.setHidden(scoped && frame.adsBlend > SCOPE_HIDE_BLEND);
    const reloadProgress = frame.phase === "reloading" ? (frame.phaseProgress ?? 0) : null;

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

    const sprintTarget = frame.sprinting && speed > MOVEMENT.walkSpeed * 0.8 && ads < 0.3 && reloadProgress === null ? 1 : 0;
    const sprint = clamp(this.sprint.update(dt, sprintTarget), 0, 1.2);

    const bobAmount = this.bobWeight * (1 + 0.9 * sprint) * (1 - 0.85 * ads);
    const halfPhase = this.bobPhase * 0.5;
    const bobX = Math.sin(halfPhase) * 0.011 * bobAmount;
    const bobY = Math.sin(this.bobPhase) * 0.006 * bobAmount;
    const bobRoll = Math.sin(halfPhase) * 0.02 * bobAmount;
    const bobPitch = Math.sin(this.bobPhase) * 0.012 * bobAmount;

    // --- Idle breathing ---------------------------------------------------------------------------------------
    const breathe = (1 - 0.6 * ads) * (1 - Math.min(1, this.bobWeight));
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

    // --- Equip ------------------------------------------------------------------------------------------------
    const equipT =
      frame.phase === "equipping" && frame.phaseProgress !== null
        ? frame.phaseProgress
        : clamp((this.time - this.equipStart) / this.equipSeconds, 0, 1);
    const equipDown = 1 - easeOutBack(equipT);

    // --- Reload -----------------------------------------------------------------------------------------------
    const reloadEnvelope =
      reloadProgress === null ? 0 : smoothstep(0, 0.12, reloadProgress) * (1 - smoothstep(0.86, 1, reloadProgress));
    const reload = this.reload.update(dt, reloadEnvelope);
    if (reloadProgress !== null) this.fireReloadJolts(reloadProgress);
    this.lastReloadProgress = reloadProgress ?? 0;

    // --- Action cycle (bolt / pump) ----------------------------------------------------------------------------
    const cycleU = this.cycle ? clamp((this.time - this.cycleStart) / this.cycle.duration, 0, 1) : 1;
    const cycleActive = this.cycle !== null && this.time >= this.cycleStart && cycleU < 1;
    const cyclePulse = cycleActive ? pulse(0, 1, cycleU) : 0;
    if (this.cycle?.kind === "bolt" && this.lastCycleU < 0.78 && cycleU >= 0.78) this.jolt(0.5);
    this.lastCycleU = cycleU;

    // --- Compose pose ------------------------------------------------------------------------------------------
    const sight = model.sightPoint;
    this.adsTarget.set(-sight.x, -sight.y, profile.adsEyeDistance - sight.z);
    const hip = profile.hip;
    const so = profile.sprintOffset;
    const sr = profile.sprintRotation;
    const sprintPose = sprint * (1 - ads);
    const isPistol = model.id === "pistol";

    this.pose.position.set(
      lerp(hip[0], this.adsTarget.x, ads) + so[0] * sprintPose + swayX + bobX + breatheX - 0.02 * reload,
      lerp(hip[1], this.adsTarget.y, ads) +
        so[1] * sprintPose +
        swayY +
        bobY +
        breatheY +
        landY +
        recoilUp -
        0.045 * reload -
        0.22 * equipDown -
        0.012 * cyclePulse,
      lerp(hip[2], this.adsTarget.z, ads) + so[2] * sprintPose + recoilBack - 0.03 * reload - 0.05 * equipDown,
    );
    this.pose.rotation.set(
      sr[0] * sprintPose +
        swayPitch +
        bobPitch +
        breathePitch +
        landPitch +
        recoilPitch -
        (isPistol ? 0.25 : 0.12) * reload +
        0.9 * equipDown +
        (this.cycle?.kind === "pump" ? 0.04 : -0.03) * cyclePulse,
      sr[1] * sprintPose + swayYaw + recoilYaw - (isPistol ? 0.2 : 0.25) * reload,
      sr[2] * sprintPose + swayRoll + bobRoll + recoilRoll + (isPistol ? 0.35 : 0.45) * reload - 0.3 * equipDown + 0.15 * cyclePulse,
    );

    this.animateParts(reloadProgress, cycleActive ? cycleU : -1);
  }

  /** World-space muzzle position and unit forward axis, reflecting this frame's pose. */
  getMuzzleToRef(position: Vector3, forward: Vector3): void {
    const world = this.model.muzzle.computeWorldMatrix(true);
    world.getTranslationToRef(position);
    Vector3.TransformNormalToRef(FORWARD, world, forward);
    forward.normalize();
  }

  getEjectPortToRef(position: Vector3): void {
    this.model.ejectPort.computeWorldMatrix(true).getTranslationToRef(position);
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
    for (const id of WEAPON_IDS) this.models[id].root.dispose(false, false);
    this.pose.dispose();
    this.fovRoot.dispose();
    this.materials.dispose();
  }

  private setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.model.root.setEnabled(!hidden);
  }

  private fireReloadJolts(progress: number): void {
    const previous = this.lastReloadProgress;
    if (progress < previous) return;
    for (const cue of RELOAD_CUES[this.model.id]) {
      // Jolt where the motion lands (end of a pump/bolt stroke, the moment a mag seats).
      const at = cue.at + (cue.span ?? 0);
      if (previous < at && progress >= at && cue.kind !== "magOut") this.jolt(cue.kind === "shellInsert" ? 0.35 : 0.8);
    }
  }

  private resetParts(): void {
    const model = this.model;
    model.leftHand.position.copyFrom(model.leftHandRest);
    model.leftHand.rotation.setAll(0);
    model.mag?.position.copyFrom(model.magRest);
    model.mag?.rotation.setAll(0);
    model.bolt?.position.copyFrom(model.boltRest);
    model.bolt?.rotation.setAll(0);
    model.pump?.position.copyFrom(model.pumpRest);
    model.slide?.position.copyFrom(model.slideRest);
  }

  private animateParts(reloadProgress: number | null, cycleU: number): void {
    const model = this.model;
    const p = reloadProgress ?? -1;
    const reloading = reloadProgress !== null;

    // Magazine swap: out, off-screen, back in; the left hand rides along.
    let magDrop = 0;
    let handOnMag = 0;
    if (reloading && model.mag) {
      const out = reloadCueAt(model.id, "magOut", 0.2);
      const into = reloadCueAt(model.id, "magIn", 0.6);
      magDrop = smoothstep(out - 0.02, out + 0.1, p) - smoothstep(into - 0.14, into, p);
      handOnMag = smoothstep(out - 0.12, out - 0.02, p) - smoothstep(into + 0.02, into + 0.16, p);
    }
    if (model.mag) {
      model.mag.position.set(model.magRest.x, model.magRest.y - 0.26 * magDrop, model.magRest.z + 0.02 * magDrop);
      model.mag.rotation.x = 0.35 * magDrop;
    }

    const hand = model.leftHand;
    const rest = model.leftHandRest;
    if (model.mag) {
      const grabY = model.mag.position.y - 0.07;
      hand.position.set(
        lerp(rest.x, model.mag.position.x, handOnMag),
        lerp(rest.y, grabY, handOnMag),
        lerp(rest.z, model.mag.position.z - 0.01, handOnMag),
      );
      hand.rotation.set(0.25 * handOnMag, 0, -0.3 * handOnMag);
    } else if (model.id === "shotgun") {
      // Thumb three shells into the loading port, then rack.
      const onPort = reloading ? smoothstep(0.12, 0.24, p) - smoothstep(0.7, 0.8, p) : 0;
      let push = 0;
      for (const cue of RELOAD_CUES.shotgun) {
        if (cue.kind === "shellInsert") push += Math.exp(-(((p - cue.at) / 0.035) ** 2));
      }
      const port = model.loadPort;
      hand.position.set(
        lerp(rest.x, port.x, onPort),
        lerp(rest.y, port.y - 0.03 + 0.03 * push, onPort),
        lerp(rest.z, port.z + 0.025 * push, onPort),
      );
      hand.rotation.set(-0.2 * onPort, 0, -0.25 * onPort);
    }

    if (model.pump) {
      let back = 0;
      if (cycleU >= 0) back = smoothstep(0, 0.35, cycleU) - smoothstep(0.45, 0.85, cycleU);
      if (reloading) {
        const rack = reloadCueAt("shotgun", "pump", 0.8);
        back = Math.max(back, pulse(rack, rack + 0.14, p));
      }
      model.pump.position.z = model.pumpRest.z - 0.075 * back;
    }

    if (model.bolt) {
      let lift = 0;
      let back = 0;
      if (cycleU >= 0) {
        lift = smoothstep(0, 0.18, cycleU) - smoothstep(0.78, 0.95, cycleU);
        back = smoothstep(0.18, 0.42, cycleU) - smoothstep(0.5, 0.72, cycleU);
      }
      if (reloading) {
        const open = reloadCueAt("sniper", "boltOpen", 0.06);
        const close = reloadCueAt("sniper", "boltClose", 0.76);
        lift = Math.max(lift, smoothstep(open, open + 0.06, p) - smoothstep(close + 0.08, close + 0.12, p));
        back = Math.max(back, smoothstep(open + 0.06, open + 0.14, p) - smoothstep(close, close + 0.06, p));
      }
      model.bolt.rotation.z = 1.1 * lift;
      model.bolt.position.z = model.boltRest.z - 0.075 * back;
    }

    if (model.slide) {
      const t = this.time - this.lastShotTime;
      let back = t < 0.012 ? t / 0.012 : Math.max(0, 1 - (t - 0.012) / 0.07);
      if (reloading) {
        const release = reloadCueAt("pistol", "slide", 0.8);
        back = Math.max(back, smoothstep(release - 0.1, release - 0.03, p) * (1 - smoothstep(release - 0.01, release, p)));
      }
      model.slide.position.z = model.slideRest.z - 0.026 * back;
    }
  }
}

function easeOutBack(t: number): number {
  const c1 = 1.3;
  const u = t - 1;
  return 1 + (c1 + 1) * u * u * u + c1 * u * u;
}
