import { Observable, TargetCamera, Vector3, type PhysicsBody, type Scene } from "@babylonjs/core";
import {
  CAMERA,
  MOVEMENT,
  SIMULATION,
  createMoveState,
  eyeHeightFor,
  landingSpeed,
  type LevelData,
  type MoveInput,
  type MoveState,
  type PlayerDebugState,
  type SpawnPoint,
} from "@twobullets/shared";
import type { InputManager } from "../input/InputManager";
import { CharacterBody } from "./CharacterBody";

const TICK_SECONDS = 1 / SIMULATION.tickRate;
const DEG_TO_RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;
const MAX_PITCH = CAMERA.maxPitchDegrees * DEG_TO_RAD;
/** CAMERA FOVs are horizontal at this aspect; wider screens see more horizontally (Hor+), narrower ones less. */
const FOV_REFERENCE_ASPECT = 16 / 9;
/** Grounded vertical jumps smaller than this (m) are left alone; bigger ones (steps, snaps) are smoothed for the camera. */
const STEP_SMOOTH_THRESHOLD = 0.02;
/** Cap on the accumulated smoothing offset (running up stairs stacks a few steps), m. */
const MAX_STEP_OFFSET = MOVEMENT.maxStepHeight * 2;

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
  readonly input: MoveInput;
  readonly state: MoveState;
  /** Downward speed at touchdown if the player landed this tick, else 0, m/s (fall damage). */
  readonly landingSpeed: number;
}

/** Gameplay modifiers other systems apply to the player every render frame (e.g. aiming down sights). */
export interface PlayerModifiers {
  /** Multiplier on ground speed, 0..MOVEMENT.maxSpeedScale. */
  speedScale: number;
  allowSprint: boolean;
  allowJump: boolean;
  /** Multiplier on mouse sensitivity. */
  sensitivityScale: number;
}

/** Movement gates read at tick time from simulation state (healing, knocked, boost); EquipmentModifiers satisfies it. */
export interface MoveGates {
  readonly speedScale: number;
  readonly allowSprint: boolean;
  readonly allowJump: boolean;
  /** Knocked: prone crawl at MOVEMENT.crawlSpeed. `speedScale` is ignored while crawling (the stance sets the speed). */
  readonly crawl: boolean;
}

const OPEN_GATES: MoveGates = { speedScale: 1, allowSprint: true, allowJump: true, crawl: false };

/**
 * Local player: mouse look every render frame, movement on a fixed 60 Hz tick driven by MoveInput snapshots,
 * and a camera interpolated between the last two ticks.
 */
export class PlayerController {
  readonly camera: TargetCamera;
  readonly onTick = new Observable<PlayerTick>();
  readonly modifiers: PlayerModifiers = { speedScale: 1, allowSprint: true, allowJump: true, sensitivityScale: 1 };

  private readonly body: CharacterBody;
  private state: MoveState = createMoveState();
  private gates: (() => MoveGates) | null = null;
  private yaw = 0;
  private pitch = 0;
  private accumulator = 0;
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

  constructor(
    scene: Scene,
    private readonly input: InputManager,
    private readonly level: LevelData,
  ) {
    const spawn = level.spawnPoints[0];
    if (!spawn) throw new Error(`Level "${level.name}" has no spawn points`);
    this.camera = new TargetCamera("playerCamera", Vector3.Zero(), scene);
    this.camera.minZ = 0.05;
    this.camera.fov = verticalFovFromHorizontal(CAMERA.fovDegrees);
    const [x, y, z] = spawn.position;
    this.body = new CharacterBody(scene, { x, y, z });
    this.respawn();
  }

  update(dt: number): void {
    this.applyLook();
    if (this.input.isLocked && this.input.wasActionPressed("jump")) this.jumpQueued = true;

    this.accumulator += dt;
    let ticks = 0;
    while (this.accumulator >= TICK_SECONDS && ticks < SIMULATION.maxTicksPerFrame) {
      this.tick();
      this.accumulator -= TICK_SECONDS;
      ticks++;
    }
    if (this.accumulator >= TICK_SECONDS) this.accumulator %= TICK_SECONDS;

    this.updateCamera(dt, this.accumulator / TICK_SECONDS);
  }

  /** Source of tick-time movement gates (architecture R3: derived from tick state, not render state), or null. */
  setMoveGates(source: (() => MoveGates) | null): void {
    this.gates = source;
  }

  /** Respawns at a random spawn point of the level. */
  respawn(): void {
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

  /** Current aim in radians (pitch + = down). This is the gameplay aim; camera punch is not included. */
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
      horizontalSpeed: Math.hypot(v.x, v.z),
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

  /** Snapshot of player intent for one tick, with this tick's gates applied; this is what will be sent to the server. */
  private sampleInput(): MoveInput {
    const input = this.input;
    const gates = this.gates?.() ?? OPEN_GATES;
    const { crawl } = gates;
    const allowJump = gates.allowJump && this.modifiers.allowJump;
    if (!input.isLocked) {
      return { forward: 0, right: 0, jump: false, sprint: false, crouch: false, speedScale: 1, allowJump, crawl, yaw: this.yaw, pitch: this.pitch };
    }
    const axis = (positive: boolean, negative: boolean): number => (positive ? 1 : 0) - (negative ? 1 : 0);
    return {
      forward: axis(input.isActionDown("forward"), input.isActionDown("back")),
      right: axis(input.isActionDown("right"), input.isActionDown("left")),
      jump: this.jumpQueued || input.isActionDown("jump"),
      sprint: input.isActionDown("sprint") && this.modifiers.allowSprint && gates.allowSprint,
      crouch: input.isActionDown("crouch"),
      speedScale: this.modifiers.speedScale * (crawl ? 1 : gates.speedScale),
      allowJump,
      crawl,
      yaw: this.yaw,
      pitch: this.pitch,
    };
  }

  private tick(): void {
    const moveInput = this.sampleInput();
    this.jumpQueued = false;
    const previous = this.state;
    const wasGrounded = previous.grounded;

    this.previousFeet.copyFrom(this.currentFeet);
    this.state = this.body.step(previous, moveInput, TICK_SECONDS);
    this.body.getFeetToRef(this.currentFeet);

    if (this.currentFeet.y < this.level.killY) {
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

    this.onTick.notifyObservers({ dt: TICK_SECONDS, input: moveInput, state: this.state, landingSpeed: landingSpeed(previous, this.state) });
  }

  private updateCamera(dt: number, alpha: number): void {
    const v = this.state.velocity;
    const speed = Math.hypot(v.x, v.z);

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
    feet.y += this.eyeHeight + this.stepOffset + bob;
    this.camera.rotation.set(this.pitch + this.punch.x, this.yaw + this.punch.y, this.punch.z);
  }
}
