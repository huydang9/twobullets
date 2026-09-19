import { hash32 } from "../equipment/math";

/**
 * Phase-shifting glazed panes (`wall_glass`).
 *
 * One transparent wall, two modes, swapping on a clock: for `holdSeconds` a pane stops bullets dead, for the next
 * `holdSeconds` they go straight through it. It replaces the pair of look-alike panels the maze used to carry (the
 * shoot-through pane and its bulletproof twin), where the deception was fixed and a player who had shot a given pane
 * once knew it forever. Now every pane lies to everyone, and the answer keeps changing.
 *
 * Two rules the owner set, and everything here follows from them:
 *
 * 1. **Panes never flip together.** A single global clock would hand everyone the same safe window, and the whole map
 *    would learn it. So each pane carries its own phase, taken from where it stands (`glassPhaseBucket`): the panes
 *    split into `buckets` groups whose cycles are evenly staggered, so at any instant half the map's panes stop bullets
 *    and half don't, and a flip happens somewhere every `holdSeconds / 2` seconds.
 * 2. **You can see which mode a pane is in.** The client tints a blocking pane (`world/props/PhaseGlass.ts`), so this
 *    is a timing problem, not a coin toss: you read the wall, you wait, you shoot.
 *
 * Determinism: the mode is a pure function of the pane's position and the match clock. No wall clock, no RNG, no state
 * and nothing in `MapData` — the headless server and every client derive the same answer for every pane at every tick
 * with nothing sent over the wire.
 */
export const GLASS_PHASE = {
  /** Seconds a pane holds one mode. A fight across a corridor is about this long, so a pane flips inside one. */
  holdSeconds: 10,
  /**
   * Phase groups. Each one is an extra Havok shape and static body per prop and scale, on the client and on the server,
   * which is a handful against the maze's thirty-odd collider groups. Four is the smallest count that keeps the map
   * mixed at every instant (two groups blocking, two passing) while spacing the flips 5 s apart — two groups would flip
   * twenty panes at once every ten seconds, which is the global safe window the owner ruled out, and eight would fire a
   * flip every 2.5 s without a player being able to tell the groups apart.
   */
  buckets: 4,
  /**
   * The lattice a pane's phase is read off, m: the maze's finest lane width, so every wall line lands on it. See
   * `glassPhaseBucket`. It was 4 while every lane was a multiple of 4 m; the maze's common lane is 2 m now
   * (map/mazeBr.ts), so lines land on multiples of 2 and neighbouring lines have to hash apart at that step.
   */
  grid: 2,
} as const;

/**
 * The pane props whose mode shifts: one glazed wall in two lengths (a 4 m piece and the 2 m piece the maze's narrow
 * lanes need). Both are the same pane — same box depth, same resting shoot-through mode, same clock.
 */
export const PHASE_GLASS_PROPS: readonly string[] = ["wall_glass", "wall_glass_2"];
/** The 4 m glazed pane. Kept as a named export for the places that want one representative id. */
export const PHASE_GLASS_PROP = PHASE_GLASS_PROPS[0]!;

/** True for props whose collider mask follows `glassBlocksAt` instead of staying put. */
export function isPhaseGlass(prop: string): boolean {
  return PHASE_GLASS_PROPS.includes(prop);
}

/**
 * Phase group of the pane standing at (x, z) with yaw `yaw`, 0…`buckets` - 1. A pure function of the placement, so
 * nothing has to be stored or sent and every client and the server derive the same answer.
 *
 * The group comes from the **wall line** the pane stands on, not from the cell or the piece: every piece of one wall
 * has to agree, or half a pane would stop bullets while the other half let them through, which reads as a bug. A wall
 * runs along its own local X, so `yaw` names its axis — yaw 0 is a wall along world X standing on a constant-Z line,
 * ±π/2 is a wall along Z on a constant-X line — and the line's coordinate, quantised to `grid`, is the group's key.
 *
 * `yaw` replaced a positional trick (a line coordinate landed on the grid and its pieces landed half a step off it,
 * so the coordinate that was on the lattice named the line). That only worked while every piece was exactly one grid
 * step long. The maze mixes 2 m and 4 m pieces on a 2 m lattice now, where a 4 m piece's centre also lands on the
 * lattice, and the trick silently picked the wrong axis. The yaw is already carried on every instance
 * (`INSTANCE_STRIDE`), so this is the same information with none of the inference.
 */
export function glassPhaseBucket(x: number, z: number, yaw: number): number {
  // |cos yaw| > 1/2 ⇒ the wall runs along world X ⇒ it stands on a constant-Z line.
  const alongX = Math.abs(Math.cos(yaw)) > 0.5;
  const line = (alongX ? z : x) / GLASS_PHASE.grid;
  return hash32(Math.round(line), alongX ? 1 : 0) % GLASS_PHASE.buckets;
}

/**
 * True when panes in `bucket` stop bullets at `seconds` of match time; false when rounds pass through them. Both modes
 * block movement and sight-block nothing: only bullets, and only the bots' world rays, tell the difference.
 */
export function glassBlocksAt(bucket: number, seconds: number): boolean {
  return glassPhaseAt(bucket, seconds) >= GLASS_PHASE.holdSeconds;
}

/**
 * Seconds until the panes in `bucket` switch mode, in (0, `holdSeconds`]. The client's tell blinks over the last of
 * them, which is what makes the pane a timing problem rather than a coin toss.
 */
export function glassPhaseRemaining(bucket: number, seconds: number): number {
  const phase = glassPhaseAt(bucket, seconds);
  return phase >= GLASS_PHASE.holdSeconds ? GLASS_PHASE.holdSeconds * 2 - phase : GLASS_PHASE.holdSeconds - phase;
}

/**
 * 1 - 1/φ, the low-discrepancy step. Spacing the groups' cycles by even fractions would make two of them turn over at
 * the same instant — one opening as another closed, every five seconds, a beat the whole lobby would learn. Stepping by
 * the golden ratio instead lands the four flips at 0, 2.4, 4.7, 7.1… seconds: no two ever coincide, the map is never
 * all-blocking or all-open, and the rhythm does not repeat inside a mode.
 */
const GOLDEN = 0.3819660112501051;

/** Position in the bucket's own two-mode cycle, 0…`holdSeconds` * 2: shoot-through below the hold, blocking above it. */
function glassPhaseAt(bucket: number, seconds: number): number {
  const cycle = GLASS_PHASE.holdSeconds * 2;
  const group = (((bucket % GLASS_PHASE.buckets) + GLASS_PHASE.buckets) % GLASS_PHASE.buckets) * GOLDEN;
  return (((seconds + (group % 1) * cycle) % cycle) + cycle) % cycle;
}
