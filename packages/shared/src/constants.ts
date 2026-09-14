/** Gameplay tuning shared by client (prediction) and server (authority). Units: meters, seconds. */

export const SIMULATION = {
  /** Fixed simulation rate, ticks per second. */
  tickRate: 60,
  /** Max ticks simulated per rendered frame; any larger backlog is dropped (prevents a death spiral after a hitch). */
  maxTicksPerFrame: 5,
} as const;

export const MOVEMENT = {
  /** Downward acceleration while airborne, m/s². */
  gravity: 24,
  /** Terminal fall speed, m/s. */
  maxFallSpeed: 50,

  /** Target horizontal speeds, m/s. */
  walkSpeed: 6.5,
  sprintSpeed: 9.5,
  crouchSpeed: 3.2,
  /** Sprint only engages when the normalized wish direction's forward component is at least this (0.5 = within 60° of forward). */
  sprintMinForward: 0.5,

  /** Rate the horizontal velocity approaches the target while grounded and pushing, m/s². */
  groundAcceleration: 70,
  /** Rate used when stopping, reversing or shedding excess speed on the ground, m/s². */
  groundDeceleration: 90,
  /** Steering rate in the air, m/s². Air control never adds speed beyond max(current, target). */
  airAcceleration: 14,

  /** Vertical launch speed, m/s. Apex height = v² / (2g) ≈ 1.2 m. */
  jumpVelocity: 7.6,
  /** Grace period after walking off a ledge during which a jump still works, s. */
  coyoteTime: 0.1,
  /** A jump pressed this long before landing still fires on touchdown, s. */
  jumpBufferTime: 0.1,
  /** Ground contact is ignored this long after a jump so the takeoff isn't re-snapped to the floor, s. */
  jumpGroundIgnoreTime: 0.1,

  /** Capsule dimensions, m. Heights are total (tip to tip). */
  capsuleRadius: 0.35,
  standHeight: 1.8,
  crouchHeight: 1.1,
  /** Eye height above the feet, m. */
  standEyeHeight: 1.65,
  crouchEyeHeight: 0.95,

  /** Tallest ledge climbed automatically, m (stairs are ≤ 0.3). */
  maxStepHeight: 0.35,
  /** Steepest walkable slope, degrees. Steeper surfaces make the player slide. */
  maxSlopeDegrees: 50,
} as const;

export const CAMERA = {
  /** Horizontal FOV at a 16:9 reference aspect, degrees. Wider screens see more (Hor+). */
  fovDegrees: 90,
  sprintFovDegrees: 98,
  /** Exponential blend rate for the sprint FOV kick, 1/s. */
  fovBlendRate: 8,
  /** Radians of rotation per pixel of mouse movement. */
  mouseSensitivity: 0.0022,
  maxPitchDegrees: 89,
  /** Exponential blend rate for eye height when crouching/standing, 1/s. */
  crouchBlendRate: 14,
  /** Decay rate of the camera offset that smooths step-ups, 1/s. */
  stepSmoothRate: 20,
  headBob: true,
  /** Vertical bob amplitude at walk speed, m. */
  headBobAmplitude: 0.018,
  /** Distance travelled per bob cycle, m. */
  headBobStride: 2.2,
} as const;
