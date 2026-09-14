export type OutOfBoundsEvent = "left" | "returned" | "expired";

/**
 * Playable-square enforcement: leaving starts a grace countdown, returning cancels it, and running it out fires
 * `expired` (the runtime respawns the player at the nearest spawn). Pure state; rendering is the caller's job.
 */
export class OutOfBounds {
  private remaining: number | null = null;

  constructor(
    /** Half size of the playable square, m. */
    private readonly halfExtent: number,
    private readonly graceSeconds: number,
  ) {}

  /** Seconds left before the respawn, or null while inside. */
  get secondsLeft(): number | null {
    return this.remaining;
  }

  isInside(x: number, z: number): boolean {
    return Math.abs(x) <= this.halfExtent && Math.abs(z) <= this.halfExtent;
  }

  update(dt: number, x: number, z: number): OutOfBoundsEvent | null {
    if (this.isInside(x, z)) {
      if (this.remaining === null) return null;
      this.remaining = null;
      return "returned";
    }
    if (this.remaining === null) {
      this.remaining = this.graceSeconds;
      return "left";
    }
    this.remaining -= dt;
    if (this.remaining > 0) return null;
    this.remaining = null;
    return "expired";
  }
}
