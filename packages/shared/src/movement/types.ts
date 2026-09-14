export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** One tick of player intent. This is exactly what the client will send to the server in milestone 3. */
export interface MoveInput {
  /** -1..1, +1 = forward. */
  readonly forward: number;
  /** -1..1, +1 = strafe right. */
  readonly right: number;
  /** Held this tick (or tapped since the previous tick). Jumps trigger on the rising edge. */
  readonly jump: boolean;
  readonly sprint: boolean;
  readonly crouch: boolean;
  /** Multiplier on target ground speed (e.g. 0.6 while aiming down sights, ×1.06 at high boost). 1 = unmodified; clamped to 0..MOVEMENT.maxSpeedScale. */
  readonly speedScale: number;
  /**
   * Tick-derived gates from the player's state (healing, knocked), not raw intent: the server derives the same values.
   * `allowJump` false ignores jump presses (default true). `crawl` forces the prone stance with no sprint or jump (default false).
   */
  readonly allowJump?: boolean;
  readonly crawl?: boolean;
  /** Look yaw in radians (around +Y, 0 = facing +Z, positive turns right). */
  readonly yaw: number;
  /** Look pitch in radians (+ = look down, Babylon convention). */
  readonly pitch: number;
}

/** `prone` is the knocked-down crawl. */
export type Stance = "stand" | "crouch" | "prone";

/** Simulation state carried between ticks. Plain data so it can be snapshotted, sent and replayed. */
export interface MoveState {
  /** World velocity, m/s. After a tick, the engine replaces this with the collision-resolved velocity. */
  readonly velocity: Vec3;
  readonly stance: Stance;
  readonly grounded: boolean;
  readonly sprinting: boolean;
  /** Previous tick's jump input, for edge detection. */
  readonly jumpHeld: boolean;
  /** Seconds left in which a jump is still allowed after leaving the ground. */
  readonly coyoteTimer: number;
  /** Seconds left in which a buffered jump press will fire on landing. */
  readonly jumpBufferTimer: number;
  /** Seconds left during which ground support is ignored right after a jump. */
  readonly groundIgnoreTimer: number;
  /**
   * Downward speed this tick before collision, while airborne (0 when grounded), m/s. The collision-resolved velocity
   * is already ~0 on the tick that hits the ground, so landings read this from the last airborne tick.
   */
  readonly fallSpeed: number;
}

/** Results of engine-side queries for this tick, fed into the pure movement step. */
export interface MoveEnvironment {
  /** The physics controller reports walkable support under the player (steep slopes do not count). */
  readonly supported: boolean;
  /** Average normal of the supporting surface; only meaningful when supported. */
  readonly groundNormal: Vec3;
  /** A standing capsule fits at the current position. Only consulted when leaving crouch or prone toward standing. */
  readonly canStand: boolean;
  /** A crouching capsule fits (default true). Only consulted when leaving prone. */
  readonly canCrouch?: boolean;
}

export interface PlayerDebugState {
  readonly position: readonly [number, number, number];
  readonly horizontalSpeed: number;
  readonly verticalSpeed: number;
  readonly grounded: boolean;
  readonly stance: Stance;
  readonly sprinting: boolean;
}
