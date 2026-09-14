import {
  PhysicsBody,
  PhysicsMotionType,
  PhysicsShapeBox,
  PhysicsShapeCapsule,
  PhysicsShapeSphere,
  Quaternion,
  TransformNode,
  Vector3,
  type Mesh,
  type PhysicsShape,
  type Scene,
} from "@babylonjs/core";
import type { TargetSpawn } from "@twobullets/shared";
import { CollisionLayer, type DamageHit, type DamageResult, type Damageable, type HitboxRegistry } from "../combat/hitboxes";
import type { Environment } from "../world/environment";
import { STAND_HEIGHT, type DummyAssets } from "./DummyAssets";
import { HUMANOID_HEIGHT, HUMANOID_PARTS, type HitboxShape, type PartSpec } from "./humanoid";

export const DUMMY_MAX_HEALTH = 100;

const FLASH_SECONDS = 0.09;
const FALL_SECONDS = 0.45;
/** Lying-down tilt; slightly short of 90° so it reads as slumped against the ground. */
const FALL_ANGLE = (84 * Math.PI) / 180;
const KNOCKBACK_METERS = 0.35;
/** Raises the pivot while lying down so the backpack doesn't sink into the floor. */
const FALL_LIFT = 0.16;
const RESPAWN_SECONDS = 3;
const RISE_SECONDS = 0.4;

/** Hit wobble: a damped spring on the body tilt, radians. */
const WOBBLE_STIFFNESS = 160;
const WOBBLE_DAMPING = 13;
const WOBBLE_KICK = 1.6;
const WOBBLE_MAX_STEP = 1 / 60;

/** Fraction of each strafe half-leg spent at constant speed; the rest eases into the turnaround. */
const STRAFE_LINEAR_FRACTION = 0.7;
const DEFAULT_STRAFE_DISTANCE = 5;
const DEFAULT_STRAFE_SPEED = 3;

const BLOCKER_RADIUS = 0.3;

const UP = Vector3.UpReadOnly;

interface Part {
  readonly spec: PartSpec;
  readonly colliderId: string;
  readonly mesh: Mesh;
  readonly body: PhysicsBody;
  flashTimer: number;
}

type Phase = "alive" | "down" | "rising";

/**
 * Stylized practice dummy with per-zone hitboxes. Visuals and hitboxes hang off one pivot, so strafing, hit wobble
 * and the death fall move both together. Hitboxes are ANIMATED trigger bodies teleported to their nodes before each
 * physics step (default prestep), so bullets see the pose that was rendered.
 */
export class TargetDummy implements Damageable {
  readonly maxHealth = DUMMY_MAX_HEALTH;
  private currentHealth = DUMMY_MAX_HEALTH;
  private phase: Phase = "alive";
  private phaseTime = 0;

  private readonly root: TransformNode;
  private readonly rig: TransformNode;
  private readonly stand: Mesh;
  private readonly parts: Part[] = [];
  private readonly shapes: PhysicsShape[] = [];
  /** Static dummies only: a teleporting blocker would pass through a standing player rather than push them. */
  private readonly blocker: PhysicsBody | null = null;

  private readonly origin: Vector3;
  private readonly yaw: number;
  private readonly right: Vector3;
  private readonly strafeDistance: number;
  private readonly strafeSpeed: number;
  private strafeTime = 0;

  /** Horizontal tilt in root-local space: direction = lean direction, length = angle. */
  private readonly wobble = new Vector3();
  private readonly wobbleVelocity = new Vector3();
  /** Root-local unit direction of the killing shot. */
  private readonly fallDirection = new Vector3(0, 0, -1);
  private readonly tmp = new Vector3();
  private readonly tiltTarget = new Vector3();

  constructor(
    scene: Scene,
    readonly id: string,
    spawn: TargetSpawn,
    private readonly assets: DummyAssets,
    private readonly registry: HitboxRegistry,
    environment: Environment,
  ) {
    const scheme = spawn.motion === "strafe" ? "strafe" : "static";
    this.origin = new Vector3(...spawn.position);
    this.yaw = spawn.yaw;
    this.right = new Vector3(Math.cos(spawn.yaw), 0, -Math.sin(spawn.yaw));
    this.strafeDistance = spawn.motion === "strafe" ? (spawn.strafeDistance ?? DEFAULT_STRAFE_DISTANCE) : 0;
    this.strafeSpeed = spawn.strafeSpeed ?? DEFAULT_STRAFE_SPEED;

    this.root = new TransformNode(`${id}_root`, scene);
    this.root.position.copyFrom(this.origin);
    this.root.rotationQuaternion = Quaternion.RotationAxis(UP, spawn.yaw);
    this.rig = new TransformNode(`${id}_rig`, scene);
    this.rig.parent = this.root;
    this.rig.position.y = STAND_HEIGHT;
    this.rig.rotationQuaternion = Quaternion.Identity();
    this.updateStrafe(0);
    this.syncTransforms();

    this.stand = assets.createStand(`${id}_stand`);
    this.stand.parent = this.root;
    environment.addShadowCaster(this.stand);

    for (const spec of HUMANOID_PARTS) {
      const mesh = assets.createPart(scheme, spec.name, `${id}_${spec.name}`);
      mesh.parent = this.rig;
      environment.addShadowCaster(mesh);

      const node = new TransformNode(`${id}_${spec.name}_hitbox`, scene);
      node.parent = this.rig;
      const shape = createHitboxShape(scene, spec.hitbox, node);
      shape.isTrigger = true;
      shape.filterMembershipMask = CollisionLayer.hitbox;
      const body = this.createKinematicBody(scene, node, shape);

      const colliderId = `${id}/${spec.name}`;
      registry.add(body, { colliderId, owner: this, zone: spec.zone });
      this.parts.push({ spec, colliderId, mesh, body, flashTimer: 0 });
    }

    if (this.strafeDistance <= 0) {
      // Solid capsule so players can't walk through the dummy; bullets filter it out.
      const blockerNode = new TransformNode(`${id}_blocker`, scene);
      blockerNode.parent = this.root;
      blockerNode.position.y = STAND_HEIGHT + HUMANOID_HEIGHT / 2;
      const half = HUMANOID_HEIGHT / 2 - BLOCKER_RADIUS;
      const blockerShape = new PhysicsShapeCapsule(new Vector3(0, -half, 0), new Vector3(0, half, 0), BLOCKER_RADIUS, scene);
      blockerShape.filterMembershipMask = CollisionLayer.blocker;
      this.blocker = this.createKinematicBody(scene, blockerNode, blockerShape);
    }
  }

  get alive(): boolean {
    return this.phase === "alive";
  }

  get health(): number {
    return this.currentHealth;
  }

  applyDamage(hit: DamageHit): DamageResult | null {
    if (this.phase !== "alive") return null;
    const part = this.parts.find((p) => p.colliderId === hit.colliderId);
    if (part) part.flashTimer = FLASH_SECONDS;

    const local = this.toLocalDirection(hit.direction, this.tmp);
    this.currentHealth = Math.max(0, this.currentHealth - hit.amount);
    const killed = this.currentHealth <= 0;
    if (killed) {
      if (local.lengthSquared() > 1e-6) this.fallDirection.copyFrom(local).normalize();
      this.setPhase("down");
      this.setHitboxesEnabled(false);
    } else {
      this.wobbleVelocity.addInPlace(local.scaleInPlace(WOBBLE_KICK * (part?.spec.zone === "head" ? 1.4 : 1)));
    }
    return { amount: hit.amount, remainingHealth: this.currentHealth, killed };
  }

  update(dt: number): void {
    this.phaseTime += dt;
    if (this.phase === "down" && this.phaseTime >= RESPAWN_SECONDS) {
      this.currentHealth = this.maxHealth;
      this.setPhase("rising");
    } else if (this.phase === "rising" && this.phaseTime >= RISE_SECONDS) {
      this.setPhase("alive");
      this.setHitboxesEnabled(true);
    }

    if (this.phase === "alive") this.updateStrafe(dt);
    this.updatePose(dt);
    this.syncTransforms();

    for (const part of this.parts) {
      part.flashTimer = Math.max(0, part.flashTimer - dt);
      const material = part.flashTimer > 0 ? this.assets.flashMaterial : this.assets.material;
      if (part.mesh.material !== material) part.mesh.material = material;
    }
  }

  dispose(): void {
    for (const part of this.parts) {
      this.registry.remove(part.body);
      part.body.dispose();
    }
    this.blocker?.dispose();
    for (const shape of this.shapes) shape.dispose();
    // Disposes the stand, part meshes and hitbox nodes parented below it.
    this.root.dispose();
    this.parts.length = 0;
    this.shapes.length = 0;
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseTime = 0;
  }

  private setHitboxesEnabled(enabled: boolean): void {
    // Filter changes take effect immediately in queries, unlike transforms which wait for the physics step.
    for (const part of this.parts) {
      if (part.body.shape) part.body.shape.filterMembershipMask = enabled ? CollisionLayer.hitbox : 0;
    }
    if (this.blocker?.shape) this.blocker.shape.filterMembershipMask = enabled ? CollisionLayer.blocker : 0;
  }

  /**
   * Constant speed along local X with eased turnarounds: a triangle wave whose ends are replaced by parabolic
   * segments, so velocity reaches zero exactly at each end.
   */
  private updateStrafe(dt: number): void {
    if (this.strafeDistance <= 0) return;
    const k = STRAFE_LINEAR_FRACTION;
    const halfSpan = this.strafeDistance / 2;
    const period = (4 * this.strafeDistance) / ((1 + k) * this.strafeSpeed);
    this.strafeTime = (this.strafeTime + dt) % period;

    const phase = this.strafeTime / period;
    const u = phase < 0.25 ? 4 * phase : phase < 0.75 ? 2 - 4 * phase : 4 * phase - 4; // triangle wave in [-1, 1]
    const a = Math.abs(u);
    const w = Math.max(0, (a - k) / (1 - k));
    const shaped = Math.min(a, k) + (1 - k) * (w - (w * w) / 2);
    const offset = Math.sign(u) * halfSpan * (shaped / ((1 + k) / 2));
    this.root.position.copyFrom(this.origin).addInPlace(this.tmp.copyFrom(this.right).scaleInPlace(offset));
  }

  private updatePose(dt: number): void {
    const rig = this.rig;
    if (this.phase === "alive") {
      // Integrate in small steps so the stiff spring stays stable through frame hitches.
      for (let remaining = dt; remaining > 0; remaining -= WOBBLE_MAX_STEP) {
        const h = Math.min(remaining, WOBBLE_MAX_STEP);
        const w = this.wobble;
        const v = this.wobbleVelocity;
        v.x += (-WOBBLE_STIFFNESS * w.x - WOBBLE_DAMPING * v.x) * h;
        v.z += (-WOBBLE_STIFFNESS * w.z - WOBBLE_DAMPING * v.z) * h;
        w.x += v.x * h;
        w.z += v.z * h;
      }
      const angle = this.wobble.length();
      rig.position.set(0, STAND_HEIGHT, 0);
      this.tilt(angle > 1e-5 ? this.tmp.copyFrom(this.wobble).scaleInPlace(1 / angle) : this.tmp.set(0, 0, 1), angle);
      return;
    }

    this.wobble.setAll(0);
    this.wobbleVelocity.setAll(0);
    let fall: number; // 0 = upright, 1 = lying down
    if (this.phase === "down") {
      const p = Math.min(this.phaseTime / FALL_SECONDS, 1);
      const settle = Math.min(Math.max((this.phaseTime - FALL_SECONDS) / 0.25, 0), 1);
      fall = p * p - 0.08 * Math.sin(settle * Math.PI);
    } else {
      fall = 1 - easeOutBack(Math.min(this.phaseTime / RISE_SECONDS, 1));
    }
    const slide = KNOCKBACK_METERS * Math.min(Math.max(fall, 0), 1);
    const dir = this.fallDirection;
    rig.position.set(dir.x * slide, STAND_HEIGHT + FALL_LIFT * Math.max(fall, 0), dir.z * slide);
    this.tilt(dir, FALL_ANGLE * fall);
  }

  /** Leans the rig by `angle` toward a root-local horizontal unit direction. */
  private tilt(direction: Vector3, angle: number): void {
    const sin = Math.sin(angle);
    const target = this.tiltTarget.set(direction.x * sin, Math.cos(angle), direction.z * sin).normalize();
    const rotation = this.rig.rotationQuaternion ?? (this.rig.rotationQuaternion = Quaternion.Identity());
    Quaternion.FromUnitVectorsToRef(UP, target, rotation);
  }

  private toLocalDirection(world: Vector3, result: Vector3): Vector3 {
    // Inverse of the root's yaw; only the horizontal part matters for tilting.
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return result.set(world.x * c - world.z * s, 0, world.x * s + world.z * c);
  }

  private syncTransforms(): void {
    this.root.computeWorldMatrix(true);
    this.rig.computeWorldMatrix(true);
  }

  private createKinematicBody(scene: Scene, node: TransformNode, shape: PhysicsShape): PhysicsBody {
    node.computeWorldMatrix(true);
    const body = new PhysicsBody(node, PhysicsMotionType.ANIMATED, false, scene);
    body.shape = shape;
    // Teleport the body to its node before every physics step; never write simulation results back.
    body.disablePreStep = false;
    body.disableSync = true;
    this.shapes.push(shape);
    return body;
  }
}

/** Shape centered on `node`, which is moved to the hitbox center. */
function createHitboxShape(scene: Scene, hitbox: HitboxShape, node: TransformNode): PhysicsShape {
  node.position.set(...hitbox.center);
  return hitbox.kind === "sphere"
    ? new PhysicsShapeSphere(Vector3.Zero(), hitbox.radius, scene)
    : new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(...hitbox.size), scene);
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
