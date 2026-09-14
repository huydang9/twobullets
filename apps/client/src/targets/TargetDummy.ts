import { PhysicsBody, PhysicsMotionType, PhysicsShapeCapsule, Quaternion, TransformNode, Vector3, type Scene } from "@babylonjs/core";
import type { TargetSpawn } from "@twobullets/shared";
import { CollisionLayer, type DamageHit, type DamageResult, type Damageable, type HitboxRegistry } from "../combat/hitboxes";
import type { Environment } from "../world/environment";
import { SoldierCharacter } from "./SoldierCharacter";
import type { SoldierResources } from "./SoldierResources";
import { SOLDIER_HEIGHT } from "./soldierRig";

export const DUMMY_MAX_HEALTH = 100;

const RESPAWN_SECONDS = 3;
/** Hitboxes come back once the get-up blend has mostly settled. */
const REVIVE_SECONDS = 0.4;

/** Fraction of each strafe half-leg spent at constant speed; the rest eases into the turnaround. */
const STRAFE_LINEAR_FRACTION = 0.7;
const DEFAULT_STRAFE_DISTANCE = 5;
const DEFAULT_STRAFE_SPEED = 3;

const BLOCKER_RADIUS = 0.3;

/** Fire ticks every 0.5 s; flinch at most this often while burning, s. */
const BURN_FLINCH_INTERVAL = 1.2;

type Phase = "alive" | "down" | "reviving";

/**
 * Practice target: a soldier with skeleton-driven hitboxes. Static ones hold the rifle idle stance behind a solid
 * blocker; strafers walk or run sideways along their local X and ease through each turnaround.
 */
export class TargetDummy implements Damageable {
  readonly maxHealth = DUMMY_MAX_HEALTH;
  readonly displayName = "Soldier";
  readonly soldier: SoldierCharacter;
  private currentHealth = DUMMY_MAX_HEALTH;
  private phase: Phase = "alive";
  private phaseTime = 0;
  private flinchCooldown = 0;

  /** Static dummies only: a teleporting blocker would pass through a standing player rather than push them. */
  private readonly blocker: PhysicsBody | null = null;

  private readonly origin: Vector3;
  private readonly right: Vector3;
  private readonly strafeDistance: number;
  private readonly strafeSpeed: number;
  private strafeTime = 0;
  private strafeOffset = 0;
  private readonly tmp = new Vector3();

  constructor(
    scene: Scene,
    readonly id: string,
    spawn: TargetSpawn,
    resources: SoldierResources,
    registry: HitboxRegistry,
    environment: Environment,
  ) {
    this.origin = new Vector3(...spawn.position);
    this.right = new Vector3(Math.cos(spawn.yaw), 0, -Math.sin(spawn.yaw));
    this.strafeDistance = spawn.motion === "strafe" ? (spawn.strafeDistance ?? DEFAULT_STRAFE_DISTANCE) : 0;
    this.strafeSpeed = spawn.strafeSpeed ?? DEFAULT_STRAFE_SPEED;

    this.soldier = new SoldierCharacter(scene, resources, environment, { name: id, damage: { registry, owner: this } });
    const root = this.soldier.root;
    root.rotationQuaternion = Quaternion.RotationAxis(Vector3.UpReadOnly, spawn.yaw);
    this.updateStrafe(0);
    // Strafers stay relaxed; static soldiers hold their aim.
    this.soldier.motion.aiming = this.strafeDistance <= 0;
    root.computeWorldMatrix(true);
    this.soldier.hitboxes?.update();

    if (this.strafeDistance <= 0) {
      // Solid capsule so players can't walk through; bullets filter it out.
      const node = new TransformNode(`${id}_blocker`, scene);
      node.parent = root;
      node.position.y = SOLDIER_HEIGHT / 2;
      const half = SOLDIER_HEIGHT / 2 - BLOCKER_RADIUS;
      const shape = new PhysicsShapeCapsule(new Vector3(0, -half, 0), new Vector3(0, half, 0), BLOCKER_RADIUS, scene);
      shape.filterMembershipMask = CollisionLayer.blocker;
      node.computeWorldMatrix(true);
      const body = new PhysicsBody(node, PhysicsMotionType.ANIMATED, false, scene);
      body.shape = shape;
      body.disablePreStep = false;
      body.disableSync = true;
      this.blocker = body;
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
    this.currentHealth = Math.max(0, this.currentHealth - hit.amount);
    const killed = this.currentHealth <= 0;
    if (killed) {
      // For blasts the direction runs from the explosion, so it picks death_front/back the same way a shot does.
      this.soldier.die(hit.direction);
      this.setPhase("down");
      if (this.blocker?.shape) this.blocker.shape.filterMembershipMask = 0;
    } else if (hit.kind !== "fire" || this.flinchCooldown <= 0) {
      // Bullets and blasts flinch every time; burning flinches now and then instead of on every fire tick.
      if (hit.kind === "fire") this.flinchCooldown = BURN_FLINCH_INTERVAL;
      this.soldier.hit();
    }
    return { amount: hit.amount, remainingHealth: this.currentHealth, killed };
  }

  update(dt: number): void {
    this.phaseTime += dt;
    this.flinchCooldown = Math.max(0, this.flinchCooldown - dt);
    if (this.phase === "down" && this.phaseTime >= RESPAWN_SECONDS) {
      this.currentHealth = this.maxHealth;
      this.soldier.revive();
      this.setPhase("reviving");
    } else if (this.phase === "reviving" && this.phaseTime >= REVIVE_SECONDS) {
      this.setPhase("alive");
      this.soldier.setHitboxesEnabled(true);
      if (this.blocker?.shape) this.blocker.shape.filterMembershipMask = CollisionLayer.blocker;
    }

    const motion = this.soldier.motion;
    if (this.phase === "alive" && this.strafeDistance > 0 && dt > 0) {
      const previous = this.strafeOffset;
      this.updateStrafe(dt);
      motion.velocityX = (this.strafeOffset - previous) / dt;
    } else {
      motion.velocityX = 0;
    }
    this.soldier.update(dt);
  }

  dispose(): void {
    const shape = this.blocker?.shape;
    this.blocker?.dispose();
    shape?.dispose();
    // Also disposes the blocker node parented under the soldier root.
    this.soldier.dispose();
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseTime = 0;
  }

  /**
   * Constant speed along local X with eased turnarounds: a triangle wave whose ends are replaced by parabolic
   * segments, so velocity reaches zero exactly at each end.
   */
  private updateStrafe(dt: number): void {
    const root = this.soldier.root;
    if (this.strafeDistance <= 0) {
      root.position.copyFrom(this.origin);
      return;
    }
    const k = STRAFE_LINEAR_FRACTION;
    const halfSpan = this.strafeDistance / 2;
    const period = (4 * this.strafeDistance) / ((1 + k) * this.strafeSpeed);
    this.strafeTime = (this.strafeTime + dt) % period;

    const phase = this.strafeTime / period;
    const u = phase < 0.25 ? 4 * phase : phase < 0.75 ? 2 - 4 * phase : 4 * phase - 4; // triangle wave in [-1, 1]
    const a = Math.abs(u);
    const w = Math.max(0, (a - k) / (1 - k));
    const shaped = Math.min(a, k) + (1 - k) * (w - (w * w) / 2);
    this.strafeOffset = Math.sign(u) * halfSpan * (shaped / ((1 + k) / 2));
    root.position.copyFrom(this.origin).addInPlace(this.tmp.copyFrom(this.right).scaleInPlace(this.strafeOffset));
  }
}
