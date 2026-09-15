import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CharacterSupportedState, PhysicsCharacterController, type CharacterSurfaceInfo } from "@babylonjs/core/Physics/v2/characterController.js";
import type { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeCapsule, PhysicsShapeSphere, type PhysicsShape } from "@babylonjs/core/Physics/v2/physicsShape.js";
import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsRaycastResult, type IRaycastQuery } from "@babylonjs/core/Physics/physicsRaycastResult.js";
import { ShapeCastResult } from "@babylonjs/core/Physics/shapeCastResult.js";
import type { Scene } from "@babylonjs/core/scene.js";
import { MOVEMENT } from "@twobullets/shared/constants";
import { len2 } from "@twobullets/shared/equipment/math";
import { capsuleHeightFor, capsuleRadiusFor, computeDesiredVelocity } from "@twobullets/shared/movement/movement";
import type { MoveInput, MoveState, Stance, Vec3 } from "@twobullets/shared/movement/types";
import { CollisionLayer } from "./collisionLayers";
import { havokPluginOf } from "./level/shapes";

const DOWN = new Vector3(0, -1, 0);
const IDENTITY = Quaternion.Identity();
/** Controller skin: the capsule is kept this far from surfaces, m. */
export const KEEP_DISTANCE = 0.05;
/** Max distance a grounded player is pulled down per tick to stay glued to ramps and stairs, m. */
const GROUND_SNAP_DISTANCE = MOVEMENT.maxStepHeight;
/** A grounded move that achieves less than this fraction of the requested distance counts as blocked. */
const BLOCKED_RATIO = 0.9;
/** How far past the capsule's edge the step probe ray looks for a step top, m. */
const STEP_PROBE_AHEAD = 0.1;
/** Rises smaller than this are left to the capsule's rounded bottom, m. */
const MIN_STEP_RISE = 0.02;
/** The headroom probe starts at least this far above the capsule bottom, so a low (prone) start doesn't touch the floor, m. */
const HEAD_PROBE_FLOOR_CLEARANCE = 0.1;
const STANCES: readonly Stance[] = ["stand", "crouch", "prone"];

/**
 * What movement queries collide with. Player capsules are excluded for now: every body's Havok transform is only
 * synced by a world step, so other players would be hit at stale positions.
 * TODO(body blocking): include CollisionLayer.player once SimWorld syncs other bodies before each step (see
 * `CharacterBody` docs).
 */
const MOVEMENT_COLLIDE_MASK = ~CollisionLayer.player;

/** Babylon's controller private state that carries between integrate() calls (characterController.js, 9.26.0). */
interface ControllerHiddenState {
  _manifold: unknown[];
  _stepUpSavedManifold: unknown[];
  _lastDisplacement: Vector3;
  _lastVelocity: Vector3;
  _lastInvDeltaTime: number;
  _bodyPositionTracking: Map<unknown, unknown>;
  _body: PhysicsBody;
}

/** Babylon's controller private fields the lazy proximity query needs (characterController.js, 9.26.0). */
interface ControllerQueryState {
  _scene: Scene;
  _shape: PhysicsShape;
  _orientation: Quaternion;
  _startCollector: unknown;
  _body: PhysicsBody;
}

interface HavokQueryNative {
  HP_World_ShapeProximityWithCollector(world: unknown, collector: unknown, query: unknown[]): void;
}

/**
 * Exposes the protected manifold refresh so hidden solver state can be rebuilt from the position alone (R5).
 *
 * Also makes the start-contact proximity query lazy. Babylon runs one with every cast inside integrate(), but only
 * `_updateManifold` reads its result, and the recast's is always overwritten before being read. The query runs when
 * `_updateManifold` needs it, and not at all when the collector already holds the result for the same position and
 * shape (the refresh at the start of a step). The static world doesn't change between queries, so manifolds are
 * bit-identical to Babylon's order (see test/characterBodyFastPaths.test.ts).
 */
class ReplayableController extends PhysicsCharacterController {
  private proximityPending = false;
  private readonly pendingPosition = new Vector3();
  private pendingShape: PhysicsShape | null = null;
  private collectorValid = false;
  private readonly collectorPosition = new Vector3();
  private collectorShape: PhysicsShape | null = null;
  /** Proximity queries actually run / skipped (tests and benches). */
  proximityQueries = 0;
  proximitySkipped = 0;

  protected override _castWithCollectors(startPos: Vector3, endPos: Vector3, castCollector: unknown, startCollector?: unknown): void {
    const self = this as unknown as ControllerQueryState;
    if (CharacterBody.fastPaths && startCollector != null && startCollector === self._startCollector) {
      if (this.proximityPending) this.proximitySkipped++;
      this.proximityPending = true;
      this.pendingPosition.copyFrom(startPos);
      this.pendingShape = self._shape;
      super._castWithCollectors(startPos, endPos, castCollector);
      return;
    }
    super._castWithCollectors(startPos, endPos, castCollector, startCollector);
  }

  protected override _updateManifold(startCollector: unknown, castCollector: unknown, castPath: Vector3): number {
    if (startCollector === (this as unknown as ControllerQueryState)._startCollector) this.flushProximity();
    return super._updateManifold(startCollector, castCollector, castPath);
  }

  protected override _refreshManifoldAtPosition(position: Vector3): void {
    this.proximityPending = false;
    this.proximityQueries++;
    super._refreshManifoldAtPosition(position);
    this.collectorValid = true;
    this.collectorPosition.copyFrom(position);
    this.collectorShape = (this as unknown as ControllerQueryState)._shape;
  }

  private flushProximity(): void {
    if (!this.proximityPending) return;
    this.proximityPending = false;
    const p = this.pendingPosition;
    const shape = this.pendingShape!;
    const c = this.collectorPosition;
    if (this.collectorValid && this.collectorShape === shape && c.x === p.x && c.y === p.y && c.z === p.z) {
      this.proximitySkipped++;
      return;
    }
    // The same query as PhysicsCharacterController._castWithCollectors.
    const self = this as unknown as ControllerQueryState;
    const hk = self._scene.getPhysicsEngine()!.getPhysicsPlugin() as unknown as { _hknp: HavokQueryNative; world: unknown };
    const o = self._orientation;
    hk._hknp.HP_World_ShapeProximityWithCollector(hk.world, self._startCollector, [
      shape._pluginData,
      [p.x, p.y, p.z],
      [o.x, o.y, o.z, o.w],
      this.keepDistance + this.keepContactTolerance,
      false,
      [(self._body._pluginData as { hpBodyId: unknown[] }).hpBodyId[0]],
    ]);
    this.proximityQueries++;
    this.collectorValid = true;
    c.copyFrom(p);
    this.collectorShape = shape;
  }

  resetHiddenState(): void {
    const self = this as unknown as ControllerHiddenState;
    self._stepUpSavedManifold.length = 0;
    self._lastDisplacement.setAll(0);
    self._lastVelocity.setAll(0);
    self._lastInvDeltaTime = 1 / 60;
    self._bodyPositionTracking.clear();
    // Clears the manifold and fills it from a proximity query at the current position.
    this._refreshManifoldAtPosition(this.getPosition());
  }

  /**
   * Empties the contact manifold. The refreshed manifold holds every proximity hit (on a heightfield, neighbouring
   * triangles' edge contacts with tilted normals); integrate() would treat those as walls. From an empty manifold,
   * integrate's own merge keeps only the closest start contact plus cast hits, as it does in continuous play.
   */
  clearManifold(): void {
    (this as unknown as ControllerHiddenState)._manifold.length = 0;
  }

  get body(): PhysicsBody {
    return (this as unknown as ControllerHiddenState)._body;
  }
}

/**
 * Engine side of player movement: wraps Havok's PhysicsCharacterController (support queries, collide-and-slide,
 * slope limits), ground snapping, step climbing and the crouch/prone capsules. Feet positions are ground-contact points.
 *
 * Replay (R5): every `step` starts from state derived from the feet alone (`resetForReplay` for the support query, an
 * empty manifold for collide-and-slide, a center re-derived from the feet), so `restore(feet, velocity, stance)` + the
 * same inputs reproduce a tick bit for bit on client and server.
 *
 * Player body blocking (product rule; not built yet): give capsules `collideWith` including `CollisionLayer.player`,
 * and before stepping a player move every other player's body to its current feet in Havok directly
 * (`HavokPlugin.setPhysicsBodyTransformation`), since no world step runs between players' ticks. On the client, remote
 * players are interpolated in the past, so their contacts will mispredict; keep their capsules on the server-side
 * separation path first (netcode.md §1.3) and measure corrections.
 */
export class CharacterBody {
  /**
   * The bit-identical shortcuts (rest steps, lazy proximity queries). Tests turn them off to compare against Babylon's
   * plain path.
   */
  static fastPaths = true;

  private readonly controller: ReplayableController;
  private readonly plugin: HavokPlugin;
  private readonly capsules: Readonly<Record<Stance, PhysicsShapeCapsule>>;
  private readonly surface: CharacterSurfaceInfo = {
    isSurfaceDynamic: false,
    supportedState: CharacterSupportedState.UNSUPPORTED,
    averageSurfaceNormal: new Vector3(),
    averageSurfaceVelocity: new Vector3(),
    averageAngularSurfaceVelocity: new Vector3(),
  };
  private readonly gravity = new Vector3(0, -MOVEMENT.gravity, 0);
  /** Swept upward to test whether a taller capsule fits; slightly thinner than the capsule so wall contact doesn't count. */
  private readonly headProbe: PhysicsShapeSphere;
  private readonly ray = new PhysicsRaycastResult();
  private readonly rayQuery: IRaycastQuery;
  private readonly castInput = new ShapeCastResult();
  private readonly castHit = new ShapeCastResult();
  private readonly moveStart = new Vector3();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly tmpVelocity = new Vector3();
  private readonly feetValue = { x: 0, y: 0, z: 0 };
  private currentStance: Stance = "stand";

  constructor(scene: Scene, feet: Vec3) {
    this.plugin = havokPluginOf(scene);

    // One capsule per stance, created once and swapped in (setShapeOptions would allocate a WASM shape per change).
    const capsule = (stance: Stance): PhysicsShapeCapsule => {
      const h = capsuleHeightFor(stance);
      const r = capsuleRadiusFor(stance);
      const shape = new PhysicsShapeCapsule(new Vector3(0, h * 0.5 - r, 0), new Vector3(0, -h * 0.5 + r, 0), r, scene);
      shape.filterMembershipMask = CollisionLayer.player;
      shape.filterCollideMask = MOVEMENT_COLLIDE_MASK;
      return shape;
    };
    this.capsules = { stand: capsule("stand"), crouch: capsule("crouch"), prone: capsule("prone") };

    this.controller = new ReplayableController(
      this.centerFor(feet, "stand", this.tmpA),
      { capsuleHeight: MOVEMENT.standHeight, capsuleRadius: MOVEMENT.capsuleRadius, shape: this.capsules.stand },
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
    this.headProbe.filterCollideMask = MOVEMENT_COLLIDE_MASK;
    this.rayQuery = { ignoreBody: cc.body, collideWith: MOVEMENT_COLLIDE_MASK };
    this.syncFeet();
    this.restFeet.x = this.feetValue.x;
    this.restFeet.y = this.feetValue.y;
    this.restFeet.z = this.feetValue.z;
  }

  /** Feet (ground contact) position after the last step or restore. */
  get feet(): Readonly<Vec3> {
    return this.feetValue;
  }

  get stance(): Stance {
    return this.currentStance;
  }

  getFeetToRef(result: Vector3): Vector3 {
    return result.set(this.feetValue.x, this.feetValue.y, this.feetValue.z);
  }

  getVelocity(): Vec3 {
    const { x, y, z } = this.controller.getVelocity();
    return { x, y, z };
  }

  /** Standing still at `feet` (spawns, respawns). */
  teleport(feet: Vec3): void {
    this.restore(feet, ZERO, "stand");
  }

  /**
   * Puts the body exactly into a snapshotted state (R5): `stance` is applied as given (never forced to stand), then
   * position and velocity, then the controller's hidden solver state is rebuilt from the position.
   */
  restore(feet: Vec3, velocity: Vec3, stance: Stance): void {
    this.setStance(stance);
    this.surface.supportedState = CharacterSupportedState.UNSUPPORTED;
    this.controller.setPosition(this.centerFor(feet, stance, this.tmpA));
    this.controller.setVelocity(this.tmpVelocity.set(velocity.x, velocity.y, velocity.z));
    this.resetForReplay();
    this.feetValue.x = feet.x;
    this.feetValue.y = feet.y;
    this.feetValue.z = feet.z;
    this.restState = null;
    this.restFeet.x = feet.x;
    this.restFeet.y = feet.y;
    this.restFeet.z = feet.z;
  }

  /**
   * Clears what Babylon's controller remembers between integrations (manifold, last displacement/velocity/dt, moving
   * body tracking) and rebuilds the contact manifold from a proximity query at the current position.
   */
  resetForReplay(): void {
    this.controller.resetHiddenState();
  }

  /**
   * One fixed simulation tick: canonical solver state -> engine queries -> pure movement step -> collide-and-slide ->
   * step/snap fixups. Returns the next state carrying the collision-resolved velocity.
   */
  step(state: MoveState, input: MoveInput, dt: number): MoveState {
    // A body at rest whose last step changed nothing, stepped again from the same state with the same input, would
    // compute the same thing again: the step is a pure function of feet, state, input and dt against static geometry.
    if (this.restState !== null && state === this.restState && CharacterBody.fastPaths && this.sameRestInput(input, dt)) {
      this.restSkips++;
      return state;
    }
    const next = this.stepBody(state, input, dt);
    const f = this.feetValue;
    const feetBefore = this.restFeet;
    if (f.x === feetBefore.x && f.y === feetBefore.y && f.z === feetBefore.z && sameMoveState(state, next)) {
      this.restState = next;
      this.saveRestInput(input, dt);
    } else {
      this.restState = null;
    }
    feetBefore.x = f.x;
    feetBefore.y = f.y;
    feetBefore.z = f.z;
    return next;
  }

  /** Steps skipped at rest; proximity queries run and skipped (tests and benches). */
  get queryStats(): { readonly restSkips: number; readonly proximityQueries: number; readonly proximitySkipped: number } {
    return { restSkips: this.restSkips, proximityQueries: this.controller.proximityQueries, proximitySkipped: this.controller.proximitySkipped };
  }

  private restSkips = 0;
  /** The state a rest step returned (unchanged from its input), or null when the last step moved something. */
  private restState: MoveState | null = null;
  /** Feet before the last step. */
  private readonly restFeet = { x: NaN, y: NaN, z: NaN };
  private readonly restInput = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, speedScale: 0, allowJump: true as boolean | undefined, crawl: false as boolean | undefined, yaw: 0, wishX: 0, wishZ: 0, dt: 0 };

  private saveRestInput(input: MoveInput, dt: number): void {
    const r = this.restInput;
    r.forward = input.forward;
    r.right = input.right;
    r.jump = input.jump;
    r.sprint = input.sprint;
    r.crouch = input.crouch;
    r.speedScale = input.speedScale;
    r.allowJump = input.allowJump;
    r.crawl = input.crawl;
    r.yaw = input.yaw;
    const s = Math.sin(input.yaw);
    const c = Math.cos(input.yaw);
    r.wishX = input.forward * s + input.right * c;
    r.wishZ = input.forward * c - input.right * s;
    r.dt = dt;
  }

  /**
   * Same movement input as the saved rest step. Yaw (and pitch, which movement never reads) only matter through the
   * wish direction; with no move keys that is a signed zero, so a still bot turning to aim keeps its rest state as long
   * as the zeros' signs match.
   */
  private sameRestInput(input: MoveInput, dt: number): boolean {
    const r = this.restInput;
    if (!Object.is(r.forward, input.forward) || !Object.is(r.right, input.right) || r.jump !== input.jump || r.sprint !== input.sprint || r.crouch !== input.crouch) return false;
    if (!Object.is(r.speedScale, input.speedScale) || r.allowJump !== input.allowJump || r.crawl !== input.crawl || !Object.is(r.dt, dt)) return false;
    if (Object.is(r.yaw, input.yaw)) return true;
    if (input.forward !== 0 || input.right !== 0) return false;
    const s = Math.sin(input.yaw);
    const c = Math.cos(input.yaw);
    return Object.is(r.wishX, input.forward * s + input.right * c) && Object.is(r.wishZ, input.forward * c - input.right * s);
  }

  private stepBody(state: MoveState, input: MoveInput, dt: number): MoveState {
    const cc = this.controller;
    // The stance and body can be out of step with `state` after a restore from another source; the state wins.
    if (state.stance !== this.currentStance) this.setStance(state.stance);
    this.resetForReplay();
    cc.checkSupportToRef(dt, DOWN, this.surface);
    const n = this.surface.averageSurfaceNormal;
    const next = computeDesiredVelocity(
      state,
      input,
      {
        supported: this.surface.supportedState === CharacterSupportedState.SUPPORTED,
        groundNormal: { x: n.x, y: n.y, z: n.z },
        canStand: state.stance !== "stand" && !input.crouch && !input.crawl ? this.fits("stand") : true,
        canCrouch: state.stance === "prone" && !input.crawl ? this.fits("crouch") : true,
      },
      dt,
    );
    this.setStance(next.stance);

    const desired = next.velocity;
    const start = this.moveStart.copyFrom(cc.getPosition());
    cc.setVelocity(this.tmpVelocity.set(desired.x, desired.y, desired.z));
    // Support comes from the full proximity manifold; collide-and-slide starts from an empty one (see clearManifold).
    cc.clearManifold();
    cc.integrate(dt, this.surface, this.gravity);

    if (next.grounded) {
      if (this.tryStepUp(start, desired, dt)) {
        // Keep momentum through the step instead of the solver's clipped velocity.
        cc.setVelocity(this.tmpVelocity.set(desired.x, 0, desired.z));
      } else {
        this.snapToGround();
      }
    }
    this.syncFeet();
    this.canonicalizeCenter();
    return { ...next, velocity: this.getVelocity() };
  }

  /** The player's own physics body, for queries (e.g. bullet raycasts) that must ignore it. */
  get physicsBody(): PhysicsBody {
    return this.controller.body;
  }

  dispose(): void {
    this.headProbe.dispose();
    this.controller.dispose();
    for (const stance of STANCES) this.capsules[stance].dispose();
  }

  /** True when the capsule of a taller `stance` would fit at the current feet position. */
  private fits(stance: Stance): boolean {
    const height = capsuleHeightFor(stance);
    const currentHeight = capsuleHeightFor(this.currentStance);
    if (height <= currentHeight) return true;
    const r = MOVEMENT.capsuleRadius;
    const probeRadius = r - KEEP_DISTANCE;
    const center = this.controller.getPosition();
    const bottom = center.y - this.controller.footOffset;
    const fromY = Math.max(bottom + currentHeight - r, bottom + probeRadius + HEAD_PROBE_FLOOR_CLEARANCE);
    const from = this.tmpA.set(center.x, fromY, center.z);
    const to = this.tmpVelocity.set(center.x, bottom + height - r + KEEP_DISTANCE, center.z);
    return !this.shapeCast(this.headProbe, from, to);
  }

  /** Swaps in the stance's precreated capsule, keeping the feet planted (position, velocity and contacts carry over). */
  private setStance(stance: Stance): void {
    if (stance === this.currentStance) return;
    this.currentStance = stance;
    this.controller.setShapeOptions({ capsuleHeight: capsuleHeightFor(stance), capsuleRadius: capsuleRadiusFor(stance), shape: this.capsules[stance] }, true);
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
    const wanted = len2(desired.x, desired.z) * dt;
    if (wanted < 1e-3) return false;
    const dirX = (desired.x * dt) / wanted;
    const dirZ = (desired.z * dt) / wanted;
    const achieved = (center.x - start.x) * dirX + (center.z - start.z) * dirZ;
    if (achieved >= wanted * BLOCKED_RATIO) return false;

    const feetY = center.y - cc.footOffset - KEEP_DISTANCE;
    const reach = capsuleRadiusFor(this.currentStance) + STEP_PROBE_AHEAD;
    const probeX = center.x + dirX * reach;
    const probeZ = center.z + dirZ * reach;
    this.plugin.raycast(
      this.tmpA.set(probeX, feetY + MOVEMENT.maxStepHeight + KEEP_DISTANCE, probeZ),
      this.tmpVelocity.set(probeX, feetY + MIN_STEP_RISE, probeZ),
      this.ray,
      this.rayQuery,
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
      { shape, rotation: IDENTITY, startPosition: from, endPosition: to, shouldHitTriggers: false, ignoreBody: this.controller.body },
      this.castInput,
      this.castHit,
    );
    return this.castHit.hasHit;
  }

  private centerFor(feet: Vec3, stance: Stance, result: Vector3): Vector3 {
    return result.set(feet.x, feet.y + centerHeight(stance), feet.z);
  }

  private syncFeet(): void {
    const center = this.controller.getPosition();
    this.feetValue.x = center.x;
    this.feetValue.y = center.y - centerHeight(this.currentStance);
    this.feetValue.z = center.z;
  }

  /**
   * Re-derives the capsule center from the feet, so the center is exactly what `restore(feet)` computes: y + h - h
   * isn't always y in floating point, and a 1-ULP different center would break bitwise replay.
   */
  private canonicalizeCenter(): void {
    const center = this.controller.getPosition();
    const y = this.feetValue.y + centerHeight(this.currentStance);
    if (y !== center.y) this.controller.setPosition(this.tmpA.set(center.x, y, center.z));
  }
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/** Bitwise-equal movement states (signed zeros differ). */
function sameMoveState(a: MoveState, b: MoveState): boolean {
  return (
    Object.is(a.velocity.x, b.velocity.x) &&
    Object.is(a.velocity.y, b.velocity.y) &&
    Object.is(a.velocity.z, b.velocity.z) &&
    a.stance === b.stance &&
    a.grounded === b.grounded &&
    a.sprinting === b.sprinting &&
    a.jumpHeld === b.jumpHeld &&
    Object.is(a.coyoteTimer, b.coyoteTimer) &&
    Object.is(a.jumpBufferTimer, b.jumpBufferTimer) &&
    Object.is(a.groundIgnoreTimer, b.groundIgnoreTimer) &&
    Object.is(a.fallSpeed, b.fallSpeed)
  );
}

/** Feet to capsule center height for a stance (the controller's footOffset plus the skin), m. */
function centerHeight(stance: Stance): number {
  return stance === "stand" ? STAND_CENTER : stance === "crouch" ? CROUCH_CENTER : PRONE_CENTER;
}

const STAND_CENTER = KEEP_DISTANCE + capsuleHeightFor("stand") / 2;
const CROUCH_CENTER = KEEP_DISTANCE + capsuleHeightFor("crouch") / 2;
const PRONE_CENTER = KEEP_DISTANCE + capsuleHeightFor("prone") / 2;
