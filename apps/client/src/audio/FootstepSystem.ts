import { MOVEMENT, type MoveState } from "@twobullets/shared";
import { AUDIBLE_RANGE, distance, strideLength, type Vec3Like } from "./acoustics";
import type { GameAudio } from "./GameAudio";
import type { FootstepStance } from "./types";

/** Below this horizontal speed nobody is walking (m/s). */
const MIN_STEP_SPEED = 0.8;
/** Slower than this (but moving) counts as walking; the default movement speed is a run. */
const WALK_BELOW = 4.6;
/** Airborne at least this long before a touchdown plays a landing. */
const MIN_AIR_SECONDS = 0.18;
const REMOTE_CULL = AUDIBLE_RANGE.footstepSprint + 5;

/** Movement state of a character that makes footsteps (target soldiers now, remote players later). */
export interface FootstepEmitterState {
  readonly id: string;
  /** Feet position. */
  readonly position: Vec3Like;
  readonly grounded: boolean;
  readonly crouched: boolean;
  readonly sprinting: boolean;
  readonly alive: boolean;
}

export interface FootstepEmitterSource {
  forEachEmitter(visit: (state: FootstepEmitterState) => void): void;
}

interface Tracker {
  x: number;
  y: number;
  z: number;
  travelled: number;
  grounded: boolean;
  airTime: number;
  fallSpeed: number;
  seen: number;
}

/**
 * Turns movement into footfalls: stride timing from distance travelled, stance from speed/crouch/sprint, jump and
 * landing from grounded edges. The same tracker serves the local player (non-spatial) and world emitters (spatial),
 * so network-interpolated remote players can plug in as another FootstepEmitterSource.
 */
export class FootstepSystem {
  readonly sources: FootstepEmitterSource[] = [];
  private readonly local: Tracker = createTracker();
  private readonly remote = new Map<string, Tracker>();
  private readonly feet = { x: 0, y: 0, z: 0 };
  private frame = 0;

  constructor(private readonly audio: GameAudio) {}

  /** `eye` is the camera position; feet are derived from the stance's eye height. */
  update(dt: number, eye: Vec3Like, move: MoveState): void {
    this.frame++;
    const eyeHeight = move.stance === "crouch" ? MOVEMENT.crouchEyeHeight : MOVEMENT.standEyeHeight;
    this.feet.x = eye.x;
    this.feet.y = eye.y - eyeHeight;
    this.feet.z = eye.z;
    const speed = Math.hypot(move.velocity.x, move.velocity.z);
    const stance = stanceOf(speed, move.stance === "crouch", move.sprinting);
    this.step(this.local, dt, this.feet, speed, move.grounded, stance, true, -move.velocity.y);

    const listener = this.audio.listenerPosition;
    for (const source of this.sources) {
      source.forEachEmitter((state) => {
        if (!state.alive || distance(state.position, listener) > REMOTE_CULL) {
          this.remote.delete(state.id);
          return;
        }
        let tracker = this.remote.get(state.id);
        if (!tracker) {
          tracker = createTracker(state.position);
          this.remote.set(state.id, tracker);
        }
        const dx = state.position.x - tracker.x;
        const dy = state.position.y - tracker.y;
        const dz = state.position.z - tracker.z;
        const remoteSpeed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
        tracker.seen = this.frame;
        this.step(tracker, dt, state.position, remoteSpeed, state.grounded, stanceOf(remoteSpeed, state.crouched, state.sprinting), false, dt > 0 ? -dy / dt : 0);
        tracker.x = state.position.x;
        tracker.y = state.position.y;
        tracker.z = state.position.z;
      });
    }
    for (const [id, tracker] of this.remote) if (tracker.seen !== this.frame) this.remote.delete(id);
  }

  private step(t: Tracker, dt: number, feet: Vec3Like, speed: number, grounded: boolean, stance: FootstepStance, isLocal: boolean, downSpeed: number): void {
    if (!grounded) {
      if (t.grounded && downSpeed < -3) this.audio.playJump({ position: feet, isLocal });
      t.airTime += dt;
      t.fallSpeed = Math.max(t.fallSpeed, downSpeed);
      t.grounded = false;
      return;
    }
    if (!t.grounded) {
      if (t.airTime >= MIN_AIR_SECONDS) {
        this.audio.playLanding({ position: feet, fallSpeed: t.fallSpeed, isLocal });
        t.travelled = 0;
      }
      t.airTime = 0;
      t.fallSpeed = 0;
      t.grounded = true;
    }
    if (speed < MIN_STEP_SPEED) {
      // Standing still: the first step after starting to move comes after half a stride.
      t.travelled = strideLength(MIN_STEP_SPEED) * 0.5;
      return;
    }
    t.travelled += speed * dt;
    const stride = strideLength(speed);
    if (t.travelled >= stride) {
      t.travelled -= stride;
      this.audio.playFootstep({ position: feet, stance, isLocal });
    }
  }
}

function stanceOf(speed: number, crouched: boolean, sprinting: boolean): FootstepStance {
  if (crouched) return "crouch";
  if (sprinting && speed > MOVEMENT.walkSpeed) return "sprint";
  return speed < WALK_BELOW ? "walk" : "run";
}

function createTracker(at?: Vec3Like): Tracker {
  return { x: at?.x ?? 0, y: at?.y ?? 0, z: at?.z ?? 0, travelled: 0, grounded: true, airTime: 0, fallSpeed: 0, seen: 0 };
}
