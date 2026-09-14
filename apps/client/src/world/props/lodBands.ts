/** Level index of an instance that isn't drawn (past the cull distance). */
export const CULLED = -1;

/**
 * One prop's LOD switch distances, cull distance and shadow band as squared thresholds with hysteresis: an instance
 * moves to a coarser level only past `switch × (1 + h)` and back to a finer one only inside `switch × (1 − h)`, so
 * standing or strafing at a switch distance can't flip it back and forth. Pure, allocation-free per query.
 */
export class LodBands {
  readonly levelCount: number;
  /** Squared distance to cross boundary b outward / inward; boundary b leads into level b, boundary levelCount culls. */
  private readonly outward: Float64Array;
  private readonly inward: Float64Array;
  private readonly shadowOutward: number;
  private readonly shadowInward: number;

  /**
   * @param switches camera distance from which each level is used, ascending (the first is 0), m
   * @param castsShadow per level; impostors usually don't
   * @param shadowDistance instances cast shadows only nearer than this (0: never), m
   * @param hysteresis fraction of each switch distance, e.g. 0.1; narrowed where two boundaries would overlap
   */
  constructor(
    switches: readonly number[],
    cullDistance: number,
    private readonly castsShadow: readonly boolean[],
    shadowDistance: number,
    hysteresis: number,
  ) {
    const n = switches.length;
    this.levelCount = n;
    const boundary = (b: number) => (b <= 0 ? 0 : b >= n ? cullDistance : Math.min(switches[b]!, cullDistance));
    this.outward = new Float64Array(n + 1);
    this.inward = new Float64Array(n + 1);
    for (let b = 1; b <= n; b++) {
      const t = boundary(b);
      const below = boundary(b - 1);
      const above = b < n ? boundary(b + 1) : Infinity;
      // Keeps t·(1 + h) of one boundary at or below the next boundary's t·(1 − h).
      const h = Math.min(hysteresis, t + below > 0 ? (t - below) / (t + below) : 0, above === Infinity ? 1 : (above - t) / (above + t));
      this.outward[b] = (t * (1 + h)) ** 2;
      this.inward[b] = (t * (1 - h)) ** 2;
    }
    this.shadowOutward = (shadowDistance * (1 + hysteresis)) ** 2;
    this.shadowInward = (shadowDistance * (1 - hysteresis)) ** 2;
  }

  /** Level for a squared camera distance, given the instance's current level (or CULLED). */
  select(distanceSq: number, current: number): number {
    const c = current === CULLED ? this.levelCount : current;
    for (let b = 1; b <= this.levelCount; b++) {
      if (distanceSq < (c >= b ? this.inward[b]! : this.outward[b]!)) return b - 1;
    }
    return CULLED;
  }

  /** Whether an instance at `level` casts a shadow, given whether it does now. */
  casts(distanceSq: number, level: number, current: boolean): boolean {
    return level !== CULLED && this.castsShadow[level] === true && distanceSq < (current ? this.shadowOutward : this.shadowInward);
  }
}

/**
 * LOD distance divisor for a zoomed camera: the magnification against the unzoomed field of view, rounded down to a
 * power of two (1, 2, 4, 8) so iron sights and sprint FOV changes don't re-select anything and a scope switches once.
 * Vertical FOVs in radians.
 */
export function lodZoom(fov: number, referenceFov: number, maxZoom = 8): number {
  const magnification = Math.tan(referenceFov / 2) / Math.tan(Math.max(1e-3, fov) / 2);
  if (!(magnification >= 2)) return 1;
  return Math.min(maxZoom, 2 ** Math.floor(Math.log2(magnification)));
}
