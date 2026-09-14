import { FALL_DAMAGE, MOVEMENT } from "../constants";
import { len2 } from "../equipment/math";
import type { MoveEnvironment, MoveInput, MoveState, Stance } from "./types";

/** Ground normals flatter than this (normal.y below it) are not used for slope following. */
const MIN_GROUND_NORMAL_Y = 0.2;

export function createMoveState(): MoveState {
  return {
    velocity: { x: 0, y: 0, z: 0 },
    stance: "stand",
    grounded: false,
    sprinting: false,
    jumpHeld: false,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    groundIgnoreTimer: 0,
    fallSpeed: 0,
  };
}

/**
 * Pure movement step: given the previous state, this tick's input and engine query results, return
 * the next state whose velocity is the desired velocity to hand to the collision solver.
 * Engine-free and deterministic so the server can run identical code for authority and the client
 * for prediction.
 */
export function computeDesiredVelocity(state: MoveState, input: MoveInput, env: MoveEnvironment, dt: number): MoveState {
  let groundIgnoreTimer = Math.max(0, state.groundIgnoreTimer - dt);
  let grounded = env.supported && groundIgnoreTimer === 0;

  const stance = resolveStance(state.stance, input, env);

  // Wish direction: clamp analog input to the unit circle so diagonals are not faster.
  let forward = clamp(input.forward, -1, 1);
  let right = clamp(input.right, -1, 1);
  const inputLength = len2(forward, right);
  if (inputLength > 1) {
    forward /= inputLength;
    right /= inputLength;
  }
  const wishAmount = Math.min(inputLength, 1);
  const sinYaw = Math.sin(input.yaw);
  const cosYaw = Math.cos(input.yaw);
  const wishX = forward * sinYaw + right * cosYaw;
  const wishZ = forward * cosYaw - right * sinYaw;

  // Sprint starts only on the ground but carries through jumps.
  const sprintAllowed = input.sprint && stance === "stand" && wishAmount > 0 && forward / wishAmount >= MOVEMENT.sprintMinForward;
  const sprinting = sprintAllowed && (grounded || state.sprinting);
  const baseSpeed = stance === "prone" ? MOVEMENT.crawlSpeed : stance === "crouch" ? MOVEMENT.crouchSpeed : sprinting ? MOVEMENT.sprintSpeed : MOVEMENT.walkSpeed;
  const targetSpeed = baseSpeed * wishAmount * clamp(input.speedScale, 0, MOVEMENT.maxSpeedScale);

  let { x: vx, y: vy, z: vz } = state.velocity;

  if (grounded) {
    const targetX = wishX * targetSpeed;
    const targetZ = wishZ * targetSpeed;
    const speedSq = vx * vx + vz * vz;
    const braking = wishAmount === 0 || targetX * vx + targetZ * vz < 0 || targetSpeed * targetSpeed < speedSq;
    const rate = braking ? MOVEMENT.groundDeceleration : MOVEMENT.groundAcceleration;
    [vx, vz] = approach(vx, vz, targetX, targetZ, rate * dt);

    // Ride the ground plane: pick the vertical speed that keeps the velocity tangent to the surface.
    // Horizontal speed is preserved on slopes, and there is no leftover vertical speed to launch off crests or ski down ramps.
    const n = env.groundNormal;
    if (n.y > MIN_GROUND_NORMAL_Y) {
      const maxRise = len2(vx, vz) * Math.tan((MOVEMENT.maxSlopeDegrees * Math.PI) / 180);
      vy = clamp(-(n.x * vx + n.z * vz) / n.y, -maxRise, maxRise);
    } else {
      vy = 0;
    }
  } else {
    if (wishAmount > 0) {
      // Steer toward the wish direction while keeping momentum: the target magnitude is never below the current speed.
      const airSpeed = Math.max(len2(vx, vz), targetSpeed);
      [vx, vz] = approach(vx, vz, wishX * airSpeed, wishZ * airSpeed, MOVEMENT.airAcceleration * dt);
    }
    vy = Math.max(vy - MOVEMENT.gravity * dt, -MOVEMENT.maxFallSpeed);
  }

  // Edge detection follows the raw key, so a jump held through a gate doesn't fire when the gate lifts.
  const canJump = input.allowJump !== false && stance !== "prone";
  const jumpPressed = input.jump && !state.jumpHeld;
  let jumpBufferTimer = !canJump ? 0 : jumpPressed ? MOVEMENT.jumpBufferTime : Math.max(0, state.jumpBufferTimer - dt);
  let coyoteTimer = grounded ? MOVEMENT.coyoteTime : Math.max(0, state.coyoteTimer - dt);

  if (jumpBufferTimer > 0 && coyoteTimer > 0 && groundIgnoreTimer === 0) {
    vy = MOVEMENT.jumpVelocity;
    jumpBufferTimer = 0;
    coyoteTimer = 0;
    groundIgnoreTimer = MOVEMENT.jumpGroundIgnoreTime;
    grounded = false;
  }

  return {
    velocity: { x: vx, y: vy, z: vz },
    stance,
    grounded,
    sprinting,
    jumpHeld: input.jump,
    coyoteTimer,
    jumpBufferTimer,
    groundIgnoreTimer,
    fallSpeed: grounded ? 0 : Math.max(0, -vy),
  };
}

/** Crawl forces prone. Getting up goes as far toward the wanted stance as the headroom allows. */
function resolveStance(current: Stance, input: MoveInput, env: MoveEnvironment): Stance {
  if (input.crawl) return "prone";
  const wanted: Stance = input.crouch ? "crouch" : "stand";
  if (current === "stand" || current === wanted) return wanted;
  if (wanted === "stand" && env.canStand) return "stand";
  if (current === "crouch") return "crouch";
  return env.canCrouch ?? true ? "crouch" : "prone";
}

export function capsuleHeightFor(stance: Stance): number {
  return stance === "prone" ? MOVEMENT.proneHeight : stance === "crouch" ? MOVEMENT.crouchHeight : MOVEMENT.standHeight;
}

export function capsuleRadiusFor(stance: Stance): number {
  return stance === "prone" ? MOVEMENT.proneRadius : MOVEMENT.capsuleRadius;
}

export function eyeHeightFor(stance: Stance): number {
  return stance === "prone" ? MOVEMENT.proneEyeHeight : stance === "crouch" ? MOVEMENT.crouchEyeHeight : MOVEMENT.standEyeHeight;
}

/** Downward speed at touchdown when `next` is the first grounded tick after `previous`, else 0, m/s. */
export function landingSpeed(previous: MoveState, next: MoveState): number {
  return !previous.grounded && next.grounded ? previous.fallSpeed : 0;
}

/** Fall damage for a landing speed: 0 up to FALL_DAMAGE.minSpeed, growing with impact energy to lethal at lethalSpeed. */
export function fallDamage(speed: number): number {
  const { minSpeed, lethalSpeed, lethalDamage } = FALL_DAMAGE;
  if (!(speed > minSpeed)) return 0;
  const energy = (speed * speed - minSpeed * minSpeed) / (lethalSpeed * lethalSpeed - minSpeed * minSpeed);
  return Math.round(lethalDamage * energy * 10) / 10;
}

/** Moves (x, z) toward (tx, tz) by at most maxDelta. */
function approach(x: number, z: number, tx: number, tz: number, maxDelta: number): [number, number] {
  const dx = tx - x;
  const dz = tz - z;
  const distance = len2(dx, dz);
  if (distance <= maxDelta) return [tx, tz];
  const s = maxDelta / distance;
  return [x + dx * s, z + dz * s];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
