import type { Vec3 } from "../../movement/types";
import type { BotWorldView, TeammateView } from "../types";
import { NavFlag } from "../types";
import { vec3, type MutVec3 } from "../brain/util";

// Position picking for cover, flee and regroup (design.md §5.2, §5.4). Candidates come from `NavQuery.sampleRing`;
// every test uses only the static raycast and what the bot believes about the threat.

export const RING_CANDIDATES = 12;
const CROUCH_EYE = 0.95;
const STAND_EYE = 1.6;
/** Cover/loot points closer than this to another actor are skipped (no body blocking between bots). */
const PERSONAL_SPACE = 1;

export class PositionPicker {
  readonly ring = new Float32Array(RING_CANDIDATES * 3);
  private readonly from: MutVec3 = vec3();
  private readonly to: MutVec3 = vec3();
  private readonly candidate: MutVec3 = vec3();
  private readonly scratch: MutVec3 = vec3();

  /**
   * Cover from a threat eye position: the crouched eye at the candidate must be hidden from the threat. Prefers close
   * points, points that allow a standing peek, and points not closer to the threat. Writes `out`; false if none.
   */
  findCover(view: BotWorldView, threatEye: Vec3, minRadius: number, maxRadius: number, seed: number, out: MutVec3): boolean {
    const self = view.self;
    const n = view.nav.sampleRing(self.feet, minRadius, maxRadius, seed, this.ring, RING_CANDIDATES);
    let bestScore = Infinity;
    const selfToThreat = flat(self.feet, threatEye);
    for (let i = 0; i < n; i++) {
      const c = this.readCandidate(i);
      if (nearTeammate(view.teammates, self.slot, c)) continue;
      this.to.x = c.x;
      this.to.y = c.y + CROUCH_EYE;
      this.to.z = c.z;
      if (view.raycast(threatEye, this.to) === null) continue;
      let score = flat(self.feet, c);
      this.to.y = c.y + STAND_EYE;
      if (view.raycast(threatEye, this.to) === null) score -= 1.5;
      const closer = selfToThreat - flat(c, threatEye);
      if (closer > 0) score += closer * 0.8;
      if (score < bestScore) {
        bestScore = score;
        out.x = c.x;
        out.y = c.y;
        out.z = c.z;
      }
    }
    return bestScore < Infinity;
  }

  /** A point 40–80 m away from the threat direction, inside `zone`, preferring cover-flagged cells. */
  findFlee(view: BotWorldView, awayX: number, awayZ: number, zoneX: number, zoneZ: number, zoneR: number, seed: number, out: MutVec3): boolean {
    const self = view.self;
    const n = view.nav.sampleRing(self.feet, 40, 80, seed, this.ring, RING_CANDIDATES);
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      const c = this.readCandidate(i);
      const dx = c.x - self.feet.x;
      const dz = c.z - self.feet.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-3) continue;
      let score = ((dx * awayX + dz * awayZ) / len) * 2;
      const ref = view.nav.nearest(c, 1.5, this.scratch);
      if (ref >= 0 && (view.nav.flagsAt(ref) & (NavFlag.nearObstacle | NavFlag.vegetation | NavFlag.indoor)) !== 0) score += 0.5;
      const zx = c.x - zoneX;
      const zz = c.z - zoneZ;
      if (Math.sqrt(zx * zx + zz * zz) > zoneR) score -= 3;
      if (score > bestScore) {
        bestScore = score;
        out.x = c.x;
        out.y = c.y;
        out.z = c.z;
      }
    }
    return bestScore > -Infinity;
  }

  /** Clear static line between two points at eye height offsets. */
  clearLine(view: BotWorldView, a: Vec3, aHeight: number, b: Vec3, bHeight: number): boolean {
    this.from.x = a.x;
    this.from.y = a.y + aHeight;
    this.from.z = a.z;
    this.to.x = b.x;
    this.to.y = b.y + bHeight;
    this.to.z = b.z;
    return view.raycast(this.from, this.to) === null;
  }

  private readCandidate(i: number): MutVec3 {
    const c = this.candidate;
    c.x = this.ring[i * 3]!;
    c.y = this.ring[i * 3 + 1]!;
    c.z = this.ring[i * 3 + 2]!;
    return c;
  }
}

function nearTeammate(teammates: readonly TeammateView[], selfSlot: number, p: Vec3): boolean {
  for (let i = 0; i < teammates.length; i++) {
    const m = teammates[i]!;
    if (m.slot === selfSlot || m.life === "dead") continue;
    if (flat(m.feet, p) < PERSONAL_SPACE) return true;
  }
  return false;
}

function flat(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}
