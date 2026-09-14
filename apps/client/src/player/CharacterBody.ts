import {
  CharacterSupportedState,
  PhysicsCharacterController,
  PhysicsRaycastResult,
  PhysicsShapeSphere,
  Quaternion,
  ShapeCastResult,
  Vector3,
  type CharacterSurfaceInfo,
  type HavokPlugin,
  type PhysicsBody,
  type PhysicsShape,
  type Scene,
} from "@babylonjs/core";
import { MOVEMENT, computeDesiredVelocity, type MoveInput, type MoveState, type Stance, type Vec3 } from "@twobullets/shared";

const DOWN = new Vector3(0, -1, 0);
const IDENTITY = Quaternion.Identity();
/** Controller skin: the capsule is kept this far from surfaces, m. */
const KEEP_DISTANCE = 0.05;
/** Max distance a grounded player is pulled down per tick to stay glued to ramps and stairs, m. */
const GROUND_SNAP_DISTANCE = MOVEMENT.maxStepHeight;
/** A grounded move that achieves less than this fraction of the requested distance counts as blocked. */
const BLOCKED_RATIO = 0.9;
/** How far past the capsule's edge the step probe ray looks for a step top, m. */
const STEP_PROBE_AHEAD = 0.1;
/** Rises smaller than this are left to the capsule's rounded bottom, m. */
const MIN_STEP_RISE = 0.02;

const heightOf = (stance: Stance): number => (stance === "crouch" ? MOVEMENT.crouchHeight : MOVEMENT.standHeight);

/**
 * Engine side of player movement: wraps Havok's PhysicsCharacterController (support queries, collide-and-slide,
 * slope limits), ground snapping, step climbing and the crouch capsule. Feet positions are ground-contact points.
 */
export class CharacterBody {
  private readonly controller: PhysicsCharacterController;
  private readonly plugin: HavokPlugin;
  private readonly surface: CharacterSurfaceInfo = {
    isSurfaceDynamic: false,
    supportedState: CharacterSupportedState.UNSUPPORTED,
    averageSurfaceNormal: new Vector3(),
    averageSurfaceVelocity: new Vector3(),
    averageAngularSurfaceVelocity: new Vector3(),
  };
  private readonly gravity = new Vector3(0, -MOVEMENT.gravity, 0);
  /** Swept upward to test whether a standing capsule fits; slightly thinner than the capsule so wall contact doesn't count. */
  private readonly headProbe: PhysicsShapeSphere;
  private readonly ray = new PhysicsRaycastResult();
  private readonly castInput = new ShapeCastResult();
  private readonly castHit = new ShapeCastResult();
  private readonly moveStart = new Vector3();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpVelocity = new Vector3();
  private currentStance: Stance = "stand";

  constructor(scene: Scene, feet: Vec3) {
    const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
    if (!plugin || !("shapeCast" in plugin)) throw new Error("CharacterBody requires the Havok physics plugin (v2)");
    this.plugin = plugin as HavokPlugin;

    this.controller = new PhysicsCharacterController(
      this.centerFor(feet, "stand", this.tmpA),
      { capsuleHeight: MOVEMENT.standHeight, capsuleRadius: MOVEMENT.capsuleRadius },
      scene,
    );
    const cc = this.controller;
    cc.keepDistance = KEEP_DISTANCE;
    cc.keepContactTolerance = 0.1;
    cc.maxSlopeCosine = Math.cos((MOVEMENT.maxSlopeDegrees * Math.PI) / 180);
    // Hard cap on what the controller climbs by itself. Its built-in step-up only moves one tick forward and then
    // lands on the step's edge with the rounded capsule bottom, so it rarely succeeds; `tryStepUp` below does the real work.
    cc.maxStepHeight = MOVEMENT.maxStepHeight;
    // Slide along walls: no sticking (static) and the into-wall part of velocity is removed, not redirected (dynamic = 1).
    cc.staticFriction = 0;
    cc.dynamicFriction = 1;

    this.headProbe = new PhysicsShapeSphere(Vector3.Zero(), MOVEMENT.capsuleRadius - KEEP_DISTANCE, scene);
  }

  getFeetToRef(result: Vector3): Vector3 {
    const center = this.controller.getPosition();
    return result.set(center.x, center.y - this.controller.footOffset - KEEP_DISTANCE, center.z);
  }

  getVelocity(): Vec3 {
    const { x, y, z } = this.controller.getVelocity();
    return { x, y, z };
  }

  teleport(feet: Vec3): void {
    this.setStance("stand");
    this.surface.supportedState = CharacterSupportedState.UNSUPPORTED;
    this.controller.setPosition(this.centerFor(feet, "stand", this.tmpA));
    this.controller.setVelocity(Vector3.ZeroReadOnly);
  }

  /**
   * One fixed simulation tick: engine queries -> pure movement step -> collide-and-slide -> step/snap fixups.
   * Returns the next state carrying the collision-resolved velocity.
   */
  step(state: MoveState, input: MoveInput, dt: number): MoveState {
    const cc = this.controller;
    cc.checkSupportToRef(dt, DOWN, this.surface);
    const n = this.surface.averageSurfaceNormal;
    const next = computeDesiredVelocity(
      state,
      input,
      {
        supported: this.surface.supportedState === CharacterSupportedState.SUPPORTED,
        groundNormal: { x: n.x, y: n.y, z: n.z },
        canStand: state.stance === "crouch" && !input.crouch ? this.canStand() : true,
      },
      dt,
    );
    this.setStance(next.stance);

    const desired = next.velocity;
    const start = this.moveStart.copyFrom(cc.getPosition());
    cc.setVelocity(this.tmpVelocity.set(desired.x, desired.y, desired.z));
    cc.integrate(dt, this.surface, this.gravity);

    if (next.grounded) {
      if (this.tryStepUp(start, desired, dt)) {
        // Keep momentum through the step instead of the solver's clipped velocity.
        cc.setVelocity(this.tmpVelocity.set(desired.x, 0, desired.z));
      } else {
        this.snapToGround();
      }
    }
    return { ...next, velocity: this.getVelocity() };
  }

  /** True when a standing capsule would fit at the current feet position. */
  private canStand(): boolean {
    if (this.currentStance === "stand") return true;
    const r = MOVEMENT.capsuleRadius;
    const center = this.controller.getPosition();
    const bottom = center.y - this.controller.footOffset;
    const from = this.tmpA.set(center.x, bottom + MOVEMENT.crouchHeight - r, center.z);
    const to = this.tmpVelocity.set(center.x, bottom + MOVEMENT.standHeight - r + KEEP_DISTANCE, center.z);
    return !this.shapeCast(this.headProbe, from, to);
  }

  /**
   * Resizes the capsule in place, keeping the feet planted. The controller supports this directly through
   * setShapeOptions, so it isn't recreated (position, velocity and contacts carry over).
   */
  private setStance(stance: Stance): void {
    if (stance === this.currentStance) return;
    this.currentStance = stance;
    this.controller.setShapeOptions({ capsuleHeight: heightOf(stance), capsuleRadius: MOVEMENT.capsuleRadius }, true);
  }

  dispose(): void {
    this.headProbe.dispose();
    this.controller.dispose();
  }

  /**
   * The controller treats every contact within its tolerance as touching, so a player comes to rest anywhere from
   * ~0 to ~0.15 m above the floor depending on landing speed, and floats off ramps and stairs when moving down.
   * While grounded, sweep the capsule down and settle it exactly KEEP_DISTANCE above walkable ground.
   */
  private snapToGround(): void {
    const center = this.controller.getPosition();
    const castLength = GROUND_SNAP_DISTANCE + KEEP_DISTANCE;
    const to = this.tmpA.set(center.x, center.y - castLength, center.z);
    if (!this.shapeCast(this.controller.shape, center, to)) return;
    // Fraction 0 means we already overlap something; the controller's penetration recovery handles that.
    if (this.castHit.hitFraction <= 0 || this.castHit.hitNormal.y < this.controller.maxSlopeCosine) return;
    const drop = this.castHit.hitFraction * castLength - KEEP_DISTANCE;
    if (Math.abs(drop) > 1e-4) this.controller.setPosition(to.set(center.x, center.y - drop, center.z));
  }

  /**
   * If a grounded move was blocked by a ledge no taller than maxStepHeight, lift the capsule onto it and complete the
   * move. Probes the step top with a ray just past the capsule, then checks headroom and forward clearance.
   */
  private tryStepUp(start: Vector3, desired: Vec3, dt: number): boolean {
    const cc = this.controller;
    const center = cc.getPosition();
    const wanted = Math.hypot(desired.x, desired.z) * dt;
    if (wanted < 1e-3) return false;
    const dirX = (desired.x * dt) / wanted;
    const dirZ = (desired.z * dt) / wanted;
    const achieved = (center.x - start.x) * dirX + (center.z - start.z) * dirZ;
    if (achieved >= wanted * BLOCKED_RATIO) return false;

    const feetY = center.y - cc.footOffset - KEEP_DISTANCE;
    const reach = MOVEMENT.capsuleRadius + STEP_PROBE_AHEAD;
    const probeX = center.x + dirX * reach;
    const probeZ = center.z + dirZ * reach;
    this.plugin.raycast(
      this.tmpA.set(probeX, feetY + MOVEMENT.maxStepHeight + KEEP_DISTANCE, probeZ),
      this.tmpVelocity.set(probeX, feetY + MIN_STEP_RISE, probeZ),
      this.ray,
      { ignoreBody: this.ownBody() },
    );
    if (!this.ray.hasHit || this.ray.hitNormalWorld.y < cc.maxSlopeCosine) return false;
    const rise = this.ray.hitPointWorld.y - feetY;
    if (rise < MIN_STEP_RISE || rise > MOVEMENT.maxStepHeight) return false;

    const lifted = this.tmpB.set(center.x, center.y + rise, center.z);
    if (this.shapeCast(cc.shape, center, this.tmpA.set(center.x, lifted.y + KEEP_DISTANCE, center.z))) return false;

    const remaining = wanted - Math.max(0, achieved);
    const forwardEnd = this.tmpA.set(lifted.x + dirX * (remaining + KEEP_DISTANCE), lifted.y, lifted.z + dirZ * (remaining + KEEP_DISTANCE));
    const free = this.shapeCast(cc.shape, lifted, forwardEnd) ? this.castHit.hitFraction * (remaining + KEEP_DISTANCE) - KEEP_DISTANCE : remaining;
    if (free <= 0) return false;

    cc.setPosition(lifted.set(lifted.x + dirX * free, lifted.y, lifted.z + dirZ * free));
    return true;
  }

  /** Sweeps `shape` between two points, ignoring our own body. Details land in castHit. */
  private shapeCast(shape: PhysicsShape, from: Vector3, to: Vector3): boolean {
    this.plugin.shapeCast(
      { shape, rotation: IDENTITY, startPosition: from, endPosition: to, shouldHitTriggers: false, ignoreBody: this.ownBody() },
      this.castInput,
      this.castHit,
    );
    return this.castHit.hasHit;
  }

  private centerFor(feet: Vec3, stance: Stance, result: Vector3): Vector3 {
    return result.set(feet.x, feet.y + KEEP_DISTANCE + heightOf(stance) / 2, feet.z);
  }

  /** The player's own physics body, for queries (e.g. bullet raycasts) that must ignore it. */
  get physicsBody(): PhysicsBody {
    return this.ownBody();
  }

  /** The controller doesn't expose its body, but queries need it so they ignore our own capsule. */
  private ownBody(): PhysicsBody {
    return (this.controller as unknown as { _body: PhysicsBody })._body;
  }
}
