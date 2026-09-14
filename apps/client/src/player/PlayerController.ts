import { Observable, TargetCamera, Vector3, type PhysicsBody, type Scene } from "@babylonjs/core";
import {
  AccumulatorClock,
  Btn,
  CAMERA,
  MOVEMENT,
  OPEN_MOVE_GATES,
  PlayerInputRing,
  TICK_SECONDS,
  createMoveState,
  createWeaponState,
  deriveMoveModifiers,
  eyeHeightFor,
  landingSpeed,
  len2,
  moveInputFrom,
  quantizePitch,
  quantizeYaw,
  type LevelData,
  type MoveGates,
  type MoveInput,
  type MoveState,
  type PlayerDebugState,
  type PlayerInput,
  type SpawnPoint,
  type TickClock,
  type Vec3,
  type WeaponState,
} from "@twobullets/shared";
import { CharacterBody, stepPlayer } from "@twobullets/sim";
import type { InputManager } from "../input/InputManager";

export type { MoveGates } from "@twobullets/shared";

const DEG_TO_RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const MAX_PITCH = CAMERA.maxPitchDegrees * DEG_TO_RAD;
/** CAMERA FOVs are horizontal at this aspect; wider screens see more horizontally (Hor+), narrower ones less. */
const FOV_REFERENCE_ASPECT = 16 / 9;
/** Grounded vertical jumps smaller than this (m) are left alone; bigger ones (steps, snaps) are smoothed for the camera. */
const STEP_SMOOTH_THRESHOLD = 0.02;
/** Cap on the accumulated smoothing offset (running up stairs stacks a few steps), m. */
const MAX_STEP_OFFSET = MOVEMENT.maxStepHeight * 2;
/** Weapon state movement sees when no combat link is attached. */
const UNARMED: WeaponState = createWeaponState([null]);

/** Babylon cameras take a vertical FOV in radians. */
function verticalFovFromHorizontal(horizontalDegrees: number): number {
  return 2 * Math.atan(Math.tan((horizontalDegrees * DEG_TO_RAD) / 2) / FOV_REFERENCE_ASPECT);
}

/** Frame-rate independent exponential blend factor. */
function blendFactor(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Emitted after every fixed movement tick, so other tick-based systems (weapons) run in lockstep with movement. */
export interface PlayerTick {
  readonly dt: number;
  /** The tick's movement input (derived from `playerInput`); yaw/pitch are the dequantized aim the sim used. */
  readonly input: MoveInput;
  /** The sampled wire input of this tick (move + combat buttons + quantized aim). */
  readonly playerInput: PlayerInput;
  readonly state: MoveState;
  /** Downward speed at touchdown if the player landed this tick, else 0, m/s (fall damage). */
  readonly landingSpeed: number;
}

/** Render-side modifiers other systems set on the player every frame. Movement speed/sprint come from the tick (R3). */
export interface PlayerModifiers {
  allowJump: boolean;
  /** Multiplier on mouse sensitivity. */
  sensitivityScale: number;
}

/** Combat side of a tick: start-of-tick weapon state for movement modifiers, and this tick's queued combat input. */
export interface PlayerCombatLink {
  readonly weaponState: WeaponState;
  /** Consumes the combat input queued for one tick into `out` (Btn fire/aim/reload bits, select 0 or slot index + 1). */
  takeCombatInput(out: { buttons: number; select: number }): void;
}

export interface PlayerControllerOptions {
  /** Tick source; default the offline accumulator. Networked play passes NetClock. */
  readonly clock?: TickClock;
  /**
   * Who places the player (R12). "local" (offline): random level spawn at start and on respawn, and a respawn below
   * killY. "server": the controller never teleports itself; call `respawnAt`/`restore` when the server says so.
   */
  readonly spawnAuthority?: "local" | "server";
  /**
   * Networked movement parity: the fixed weapon state and gates the server steps movement with. When set, ticks and
   * replays ignore the combat link's weapon state, the gate source and `modifiers.allowJump` for movement.
   */
  readonly movement?: { readonly weapon: WeaponState; readonly gates: MoveGates };
}

/**
 * Local player: mouse look every render frame, movement on a fixed 60 Hz tick through the shared `stepPlayer`, one
 * `PlayerInput` sampled per tick into a history ring, and a camera interpolated between the last two ticks.
 */
export class PlayerController {
  readonly camera: TargetCamera;
  readonly onTick = new Observable<PlayerTick>();
  readonly modifiers: PlayerModifiers = { allowJump: true, sensitivityScale: 1 };
  /** Sampled inputs by tick (R4): what networked play sends with redundancy and replays after corrections. */
  readonly inputHistory = new PlayerInputRing();

  private readonly body: CharacterBody;
  private readonly clock: TickClock;
  private readonly spawnAuthority: "local" | "server";
  private readonly fixedMovement: { readonly weapon: WeaponState; readonly gates: MoveGates } | null;
  private readonly input: InputManager;
  private readonly level: LevelData;
  private state: MoveState = createMoveState();
  private gates: (() => MoveGates) | null = null;
  private combat: PlayerCombatLink | null = null;
  private readonly combatScratch = { buttons: 0, select: 0 };
  private yaw = 0;
  private pitch = 0;
  /** A jump tap seen on a render frame, held until the next tick consumes it so short taps between ticks aren't lost. */
  private jumpQueued = false;

  private readonly previousFeet = new Vector3();
  private readonly currentFeet = new Vector3();
  private eyeHeight: number = MOVEMENT.standEyeHeight;
  /** Camera-only vertical offset that eases out step-ups and ground snaps. */
  private stepOffset = 0;
  private sprintBlend = 0;
  private bobPhase = 0;
  private bobWeight = 0;
  private zoomFovDegrees: number = CAMERA.fovDegrees;
  private zoomBlend = 0;
  private readonly punch = new Vector3();
  /** Render-only correction offset (networked reconciliation smoothing), added to the camera position. */
  private readonly renderOffset = new Vector3();

  constructor(scene: Scene, input: InputManager, level: LevelData, options: PlayerControllerOptions = {}) {
    this.input = input;
    this.level = level;
    this.clock = options.clock ?? new AccumulatorClock();
    this.spawnAuthority = options.spawnAuthority ?? "local";
    this.fixedMovement = options.movement ?? null;
    const spawn = level.spawnPoints[0];
    if (!spawn) throw new Error(`Level "${level.name}" has no spawn points`);
    this.camera = new TargetCamera("playerCamera", Vector3.Zero(), scene);
    this.camera.minZ = 0.05;
    this.camera.fov = verticalFovFromHorizontal(CAMERA.fovDegrees);
    const [x, y, z] = spawn.position;
    this.body = new CharacterBody(scene, { x, y, z });
    if (this.spawnAuthority === "local") this.respawn();
    else this.respawnAt(spawn);
  }

  update(dt: number): void {
    this.applyLook();
    if (this.input.isLocked && this.input.wasActionPressed("jump")) this.jumpQueued = true;

    for (let ticks = this.clock.advance(dt); ticks > 0; ticks--) this.tick(this.clock.nextTick());

    this.updateCamera(dt, this.clock.alpha);
  }

  /** Source of tick-time movement gates (derived from tick state, not render state), or null. */
  setMoveGates(source: (() => MoveGates) | null): void {
    this.gates = source;
  }

  /** Weapon state and combat input for the tick (CombatSystem), or null for an unarmed player with no combat input. */
  setCombatLink(link: PlayerCombatLink | null): void {
    this.combat = link;
  }

  /** Respawns at a random spawn point of the level. Offline only; a server-placed player ignores it (R12). */
  respawn(): void {
    if (this.spawnAuthority !== "local") return;
    const points = this.level.spawnPoints;
    const spawn = points[Math.floor(Math.random() * points.length)];
    if (spawn) this.respawnAt(spawn);
  }

  /** Teleports to `spawn` standing still, facing its yaw, with fresh movement state. */
  respawnAt(spawn: SpawnPoint): void {
    const [x, y, z] = spawn.position;
    this.body.teleport({ x, y, z });
    this.state = createMoveState();
    this.yaw = spawn.yaw;
    this.pitch = 0;
    this.jumpQueued = false;
    this.body.getFeetToRef(this.currentFeet);
    this.previousFeet.copyFrom(this.currentFeet);
    this.eyeHeight = MOVEMENT.standEyeHeight;
    this.stepOffset = 0;
    this.sprintBlend = 0;
    this.updateCamera(0, 1);
  }

  /** Current aim in radians (pitch + = down). This is the raw gameplay aim; ticks simulate its quantized value. */
  getAim(): { readonly yaw: number; readonly pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  /** Tick-accurate feet (ground contact) position. */
  getFeetToRef(result: Vector3): Vector3 {
    return result.copyFrom(this.currentFeet);
  }

  /** Tick-accurate (not interpolated or smoothed) eye position, for spawning shots. */
  getEyeToRef(result: Vector3): Vector3 {
    return result.set(this.currentFeet.x, this.currentFeet.y + eyeHeightFor(this.state.stance), this.currentFeet.z);
  }

  get moveState(): MoveState {
    return this.state;
  }

  /** Tick-accurate feet after the last tick, replay or restore (networked prediction reads it without copying). */
  get tickFeet(): Readonly<Vec3> {
    return this.currentFeet;
  }

  /**
   * Networked reconciliation: puts the body and movement state exactly into `state` at `feet` (R5 restore). Aim, camera
   * blends and the input history are untouched.
   */
  restoreMove(feet: Vec3, state: MoveState): void {
    this.body.restore(feet, state.velocity, state.stance);
    this.state = state;
    this.body.getFeetToRef(this.currentFeet);
    this.previousFeet.copyFrom(this.currentFeet);
  }

  /** Re-simulates one recorded tick after a restore (R11): no `onTick` observers, so no combat, FX or audio. */
  replayTick(playerInput: PlayerInput): MoveState {
    const weapon = this.fixedMovement?.weapon ?? this.combat?.weaponState ?? UNARMED;
    this.previousFeet.copyFrom(this.currentFeet);
    this.state = stepPlayer(this.body, { move: this.state, weapon }, playerInput, TICK_SECONDS, { replay: true, gates: this.tickGates() }).state.move;
    this.body.getFeetToRef(this.currentFeet);
    return this.state;
  }

  /** Render-only position offset (m) for correction smoothing; set every frame, never affects simulation. */
  setRenderOffset(x: number, y: number, z: number): void {
    this.renderOffset.set(x, y, z);
  }

  get physicsBody(): PhysicsBody {
    return this.body.physicsBody;
  }

  /** Permanently rotates the aim (weapon recoil). Positive `up` raises the aim, positive `right` turns right. */
  kickAim(up: number, right: number): void {
    this.yaw = (this.yaw + right) % TWO_PI;
    this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch - up));
  }

  /** Blends the camera FOV toward `fovDegrees` (horizontal, like CAMERA.fovDegrees) by `blend` 0..1, e.g. for ADS. */
  setZoom(fovDegrees: number, blend: number): void {
    this.zoomFovDegrees = fovDegrees;
    this.zoomBlend = Math.min(1, Math.max(0, blend));
  }

  /** Visual-only camera rotation offset in radians (x = pitch, y = yaw, z = roll); doesn't affect aim. Set every frame. */
  setCameraPunch(pitch: number, yaw: number, roll: number): void {
    this.punch.set(pitch, yaw, roll);
  }

  getDebugState(): PlayerDebugState {
    const { x, y, z } = this.currentFeet;
    const v = this.state.velocity;
    return {
      position: [x, y, z],
      horizontalSpeed: len2(v.x, v.z),
      verticalSpeed: v.y,
      grounded: this.state.grounded,
      stance: this.state.stance,
      sprinting: this.state.sprinting,
    };
  }

  dispose(): void {
    this.onTick.clear();
    this.body.dispose();
    this.camera.dispose();
  }

  private applyLook(): void {
    const { dx, dy } = this.input.lookDelta();
    if (dx === 0 && dy === 0) return;
    const sensitivity = CAMERA.mouseSensitivity * this.modifiers.sensitivityScale;
    this.yaw = (this.yaw + dx * sensitivity) % TWO_PI;
    this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch + dy * sensitivity));
  }

  /** One tick of player intent: movement keys, queued jump, combat input and the quantized aim. */
  private sampleInput(tick: number): PlayerInput {
    const input = this.input;
    const combat = this.combatScratch;
    combat.buttons = 0;
    combat.select = 0;
    this.combat?.takeCombatInput(combat);
    let forward: -1 | 0 | 1 = 0;
    let right: -1 | 0 | 1 = 0;
    let buttons = combat.buttons;
    if (input.isLocked) {
      forward = axis(input.isActionDown("forward"), input.isActionDown("back"));
      right = axis(input.isActionDown("right"), input.isActionDown("left"));
      if (this.jumpQueued || input.isActionDown("jump")) buttons |= Btn.jump;
      if (input.isActionDown("sprint")) buttons |= Btn.sprint;
      if (input.isActionDown("crouch")) buttons |= Btn.crouch;
    }
    return {
      tick,
      forward,
      right,
      buttons,
      select: combat.select,
      yawQ: quantizeYaw(this.yaw),
      pitchQ: quantizePitch(this.pitch),
      viewOffset8: 0,
      action: null,
    };
  }

  private tick(tickNumber: number): void {
    const playerInput = this.inputHistory.push(this.sampleInput(tickNumber));
    this.jumpQueued = false;
    const previous = this.state;
    const wasGrounded = previous.grounded;
    const weapon = this.fixedMovement?.weapon ?? this.combat?.weaponState ?? UNARMED;
    const gates = this.tickGates();

    this.previousFeet.copyFrom(this.currentFeet);
    this.state = stepPlayer(this.body, { move: previous, weapon }, playerInput, TICK_SECONDS, { replay: false, gates }).state.move;
    this.body.getFeetToRef(this.currentFeet);

    if (this.spawnAuthority === "local" && this.currentFeet.y < this.level.killY) {
      this.respawn();
      return;
    }

    // Vertical motion the velocity doesn't explain (step-ups, ground snaps) is a discontinuity. Remove it from the
    // interpolation and let the camera ease through it instead. Landings (downward, from the air) stay crisp.
    if (this.state.grounded) {
      const jump = this.currentFeet.y - this.previousFeet.y - this.state.velocity.y * TICK_SECONDS;
      if (Math.abs(jump) > STEP_SMOOTH_THRESHOLD && (wasGrounded || jump > 0)) {
        this.previousFeet.y += jump;
        this.stepOffset = Math.max(-MAX_STEP_OFFSET, Math.min(MAX_STEP_OFFSET, this.stepOffset - jump));
      }
    }

    const input = moveInputFrom(playerInput, deriveMoveModifiers(weapon, playerInput), gates);
    this.onTick.notifyObservers({ dt: TICK_SECONDS, input, playerInput, state: this.state, landingSpeed: landingSpeed(previous, this.state) });
  }

  /** This tick's movement gates, with the render-side jump modifier folded in. */
  private tickGates(): MoveGates {
    if (this.fixedMovement) return this.fixedMovement.gates;
    const gates = this.gates?.() ?? OPEN_MOVE_GATES;
    return this.modifiers.allowJump || !gates.allowJump ? gates : { ...gates, allowJump: false };
  }

  private updateCamera(dt: number, alpha: number): void {
    const v = this.state.velocity;
    const speed = len2(v.x, v.z);

    this.eyeHeight += (eyeHeightFor(this.state.stance) - this.eyeHeight) * blendFactor(CAMERA.crouchBlendRate, dt);
    this.stepOffset -= this.stepOffset * blendFactor(CAMERA.stepSmoothRate, dt);

    const sprintTarget = this.state.sprinting && speed > MOVEMENT.walkSpeed ? 1 : 0;
    this.sprintBlend += (sprintTarget - this.sprintBlend) * blendFactor(CAMERA.fovBlendRate, dt);
    const moveFov = CAMERA.fovDegrees + (CAMERA.sprintFovDegrees - CAMERA.fovDegrees) * this.sprintBlend;
    this.camera.fov = verticalFovFromHorizontal(moveFov + (this.zoomFovDegrees - moveFov) * this.zoomBlend);

    let bob = 0;
    if (CAMERA.headBob) {
      const bobbing = this.state.grounded && speed > 0.5;
      this.bobWeight += ((bobbing ? Math.min(speed / MOVEMENT.walkSpeed, 1.5) : 0) - this.bobWeight) * blendFactor(10, dt);
      if (bobbing) this.bobPhase = (this.bobPhase + (speed * dt * TWO_PI) / CAMERA.headBobStride) % TWO_PI;
      bob = Math.sin(this.bobPhase) * CAMERA.headBobAmplitude * this.bobWeight;
    }

    const feet = Vector3.LerpToRef(this.previousFeet, this.currentFeet, alpha, this.camera.position);
    feet.addInPlace(this.renderOffset);
    feet.y += this.eyeHeight + this.stepOffset + bob;
    this.camera.rotation.set(this.pitch + this.punch.x, this.yaw + this.punch.y, this.punch.z);
  }
}

function axis(positive: boolean, negative: boolean): -1 | 0 | 1 {
  return positive === negative ? 0 : positive ? 1 : -1;
}
