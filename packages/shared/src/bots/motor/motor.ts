import { Btn } from "../../input";
import type { BotInput, BotWorldView, NavAvoidCircle, NavPath, NavQuery, PathStatus, PerceivedActor, TeammateView } from "../types";
import { NavFlag } from "../types";
import type { ZoneCircle } from "../../match/types";
import type { PerceptionState } from "../perception/perception";
import { copyVec, vec3, wrapAngle, type BotRandom, type MutVec3 } from "../brain/util";

// Motor (design.md §5.5): every tick turns "go there" / "move this way" into PlayerInput axes and movement buttons.
// Path following is pure pursuit on the NavPath with a look-ahead; axes are −1/0/1 relative to the aim yaw, dithered
// between the two nearest of 8 sectors so the average path is straight.
//
// Robustness rules (tuning round 2): goals are snapped to a nav node by probing heights first (a goal at the bot's own
// feet height can be tens of metres off the terrain); a failed or truncated path continues from where it ended or
// detours through a sampled reachable point toward the target; the bot never stands without input for long while it
// has somewhere to go; being stuck is measured by displacement, not speed.

export const NAV_PATH_CAPACITY = 256;
const LOOKAHEAD = 1.6;
const ARRIVE_RADIUS = 0.6;
const REPLAN_GOAL_MOVE = 3;
const REPLAN_DRIFT_FRACTION = 0.15;
const REPLAN_MIN_TICKS = 45;
const OFF_PATH = 2.5;
const SEPARATION = 0.9;
/** Goal snapping: height offsets probed around the requested y, m, each with this horizontal/3D reach. */
const SNAP_HEIGHTS = [0, 3, -3, 7, -7, 12, -12, 20, -20, 30, -30, 45, -45] as const;
const SNAP_REACH = 6;
/** Waiting for a path longer than this, the bot walks straight toward the target when that is possible. */
const PENDING_WALK_TICKS = 0;
/** A path request unanswered for this long is re-issued. */
const PENDING_TIMEOUT_TICKS = 300;
const RETRY_TICKS = 45;
const DETOUR_MIN = 10;
const DETOUR_MAX = 35;
/** Displacement checks for stuck detection. */
const PROGRESS_WINDOW_TICKS = 40;
const PROGRESS_MIN = 0.6;
const SIDESTEP_TICKS = 50;
const GOAL_PROGRESS_TICKS = 240;
const CROUCH_HOLD_TICKS = 45;
const ANCHOR_RADIUS = 2;
const CRUMBS = 16;
const CRUMB_SPACING = 1.5;
const RETRACE_CRUMBS = 8;
const RETRACE_STEP_TICKS = 90;
const RETRACE_COOLDOWN_TICKS = 300;
const ANCHOR_TICKS = 300;
const BAD_SPOTS = 6;
const BAD_SPOT_RADIUS = 1.5;
const BAD_SPOT_COST = 60;
const BAD_SPOT_TICKS = 60 * 60;
/** Vertical distance beyond which a waypoint on another floor isn't treated as reached. */
const FLOOR_GAP = 1.4;

const EMPTY_MATES: readonly TeammateView[] = [];
const EMPTY_TRACKS: readonly PerceivedActor[] = [];

const SECTOR_F = [1, 1, 0, -1, -1, -1, 0, 1] as const;
const SECTOR_R = [0, 1, 1, 1, 0, -1, -1, -1] as const;

export type MotorStatus = "idle" | "pending" | "moving" | "arrived" | "failed";

export interface MoveOptions {
  sprint: boolean;
  preferCover: number;
  zone: ZoneCircle | null;
  /** Stop within this distance of the goal, m. */
  arriveRadius: number;
  allowPartial: boolean;
}

export function createMoveOptions(): MoveOptions {
  return { sprint: false, preferCover: 0, zone: null, arriveRadius: ARRIVE_RADIUS, allowPartial: true };
}

interface MutablePathOptions {
  maxLength?: number;
  allowCrouchOnly?: boolean;
  avoid?: readonly NavAvoidCircle[];
  preferCover?: number;
  zone?: ZoneCircle | null;
  partial?: boolean;
}

export function createNavPath(capacity = NAV_PATH_CAPACITY): NavPath {
  return { points: new Float32Array(capacity * 3), flags: new Uint8Array(capacity), count: 0, length: 0 };
}

export class Motor {
  readonly path: NavPath = createNavPath();
  /** What the caller asked for (snapped to the nav when possible). */
  readonly target: MutVec3 = vec3();
  /** Current path goal: the target, or a detour point toward it. */
  readonly goal: MutVec3 = vec3();
  readonly moveTarget: MutVec3 = vec3();
  status: MotorStatus = "idle";
  /** Set when the unstuck ladder or repeated failures gave up this tick (behaviors skip the target). */
  gaveUp = false;
  /** Desired world move direction this tick (unit), valid when `moving`. */
  moveX = 0;
  moveZ = 0;
  moving = false;
  /** Desired yaw of the move direction (for looking where you walk). */
  moveYaw = 0;
  private gaveUpNext = false;
  /** Seconds the bot has been pushing without getting anywhere (debug, tests). */
  stuckSeconds = 0;

  private handle = -1;
  private pathValid = false;
  private index = 0;
  private requestTick = -100000;
  private wantGoal = false;
  private directX = 0;
  private directZ = 0;
  private wantDirect = false;
  private sprint = false;
  private crouch = false;
  private jump = false;
  private arriveRadius = ARRIVE_RADIUS;
  private readonly options: MutablePathOptions = {};
  /** Spots where the bot got stuck (a blocked nav link, a jammed doorway): paths avoid them for a while. */
  private readonly avoid: NavAvoidCircle[] = [];
  private readonly badSpots: { x: number; z: number; radius: number; cost: number; untilTick: number }[] = [];
  private dither = 0;
  private detouring = false;
  private failures = 0;
  private retryTick = 0;
  /** Distance to the target when the current request was made (progress check for truncated paths). */
  private requestDistance = 0;
  private progressTick = 0;
  /** Best 3D distance to the path goal seen, and when; no 1 m of progress for 4 s counts as stuck. */
  private bestGoalDistance = Infinity;
  private bestGoalTick = 0;
  private readonly progressPos: MutVec3 = vec3();
  private pushTicks = 0;
  private stuckWindows = 0;
  private sidestepTicks = 0;
  private readonly sidestep: MutVec3 = vec3();
  private readonly ring = new Float32Array(3 * 12);
  private readonly scratch: MutVec3 = vec3();
  private readonly probeFrom: MutVec3 = vec3();
  private readonly probeTo: MutVec3 = vec3();
  private readonly snapped: MutVec3 = vec3();
  private directOk = false;
  /** Path done, target within a few metres: walk straight at it. */
  private finalApproach = false;
  private tightLeg = false;
  private requestedX = 0;
  private readonly anchor: MutVec3 = vec3();
  private readonly crumbs = new Float32Array(CRUMBS * 3);
  private crumbHead = 0;
  private crumbCount = 0;
  private retraceLeft = 0;
  private retraceSlot = 0;
  private retraceTicks = 0;
  private lastRetraceTick = -100000;
  private anchorTick = 0;
  private anchorPush = 0;
  private requestedZ = 0;
  /** Stay crouched a little past low openings (the stance change lags the waypoint). */
  private crouchUntil = 0;
  private nav: NavQuery | null = null;

  reset(): void {
    if (this.nav && this.handle >= 0) this.nav.releasePath(this.handle);
    this.handle = -1;
    this.pathValid = false;
    this.path.count = 0;
    this.path.length = 0;
    this.status = "idle";
    this.index = 0;
    this.requestTick = -100000;
    this.wantGoal = false;
    this.wantDirect = false;
    this.sidestepTicks = 0;
    this.stuckWindows = 0;
    this.stuckSeconds = 0;
    this.pushTicks = 0;
    this.gaveUp = false;
    this.gaveUpNext = false;
    this.avoid.length = 0;
    this.badSpots.length = 0;
    this.dither = 0;
    this.detouring = false;
    this.failures = 0;
    this.crumbCount = 0;
    this.retraceLeft = 0;
  }

  /** Clears this tick's wishes; call before behaviors run. */
  beginTick(): void {
    this.wantGoal = false;
    this.wantDirect = false;
    this.sprint = false;
    this.crouch = false;
    this.jump = false;
    // Give-ups detected while writing last tick's output reach this tick's behaviors.
    this.gaveUp = this.gaveUpNext;
    this.gaveUpNext = false;
  }

  /** Path toward a point this tick. Replans when the target moved > 3 m. Returns the status. */
  moveTo(view: BotWorldView, x: number, y: number, z: number, options: MoveOptions): MotorStatus {
    this.wantGoal = true;
    this.sprint = options.sprint;
    this.arriveRadius = options.arriveRadius;
    this.options.preferCover = options.preferCover;
    this.options.zone = options.zone;
    this.options.partial = options.allowPartial;
    const self = view.self.feet;
    // Compared with what was asked, not the snapped node (a snap can move the target a few metres).
    const moved = dx2(this.requestedX, this.requestedZ, x, z);
    // Far targets tolerate proportionally more drift, and a moving target doesn't re-queue a search every tick:
    // each request restarts the time-sliced search and the queue is shared by every bot.
    const far = dx2(self.x, self.z, x, z);
    const drift = Math.max(REPLAN_GOAL_MOVE, far * REPLAN_DRIFT_FRACTION);
    const throttled = view.tick - this.requestTick < (far > 60 ? REPLAN_MIN_TICKS * 3 : REPLAN_MIN_TICKS) && this.status !== "arrived";
    if (this.status === "idle" || (moved > drift && !throttled)) {
      this.requestedX = x;
      this.requestedZ = z;
      this.setTarget(view, x, y, z);
      this.request(view);
    } else if (moved > 0.05) {
      // Small drift: keep the path, update the final point.
      this.target.x = x;
      this.target.z = z;
      if (!this.detouring) {
        this.goal.x = x;
        this.goal.z = z;
      }
    }
    const toTarget = dx2(self.x, self.z, this.target.x, this.target.z);
    if (toTarget <= this.arriveRadius && Math.abs(self.y - this.target.y) < FLOOR_GAP) {
      this.status = "arrived";
      this.failures = 0;
      this.finalApproach = false;
    } else if (this.status === "arrived") {
      // Pushed or walked away from a reached target: walk back (a path when far).
      if (toTarget > Math.max(this.arriveRadius, 2.5) + 2) this.request(view);
      else {
        this.status = "moving";
        this.finalApproach = true;
      }
    }
    return this.status;
  }

  /** Move in a world direction this tick without a path (strafe, separation, short dodges). */
  moveDirect(x: number, z: number, sprint: boolean): void {
    const len = Math.sqrt(x * x + z * z);
    if (len < 1e-6) return;
    this.wantDirect = true;
    this.directX = x / len;
    this.directZ = z / len;
    this.sprint = sprint;
  }

  setCrouch(value: boolean): void {
    this.crouch = value;
  }

  /** Drops the current goal and path. */
  stop(view: BotWorldView): void {
    if (this.handle >= 0) view.nav.releasePath(this.handle);
    this.handle = -1;
    this.pathValid = false;
    this.path.count = 0;
    this.status = "idle";
    this.detouring = false;
    this.failures = 0;
  }

  /** Writes axes and movement buttons (jump, sprint, crouch) into `input` for this tick. */
  output(view: BotWorldView, input: BotInput, lookYaw: number, perception: PerceptionState, rng: BotRandom, aiming: boolean): void {
    const self = view.self;
    const tick = view.tick;
    let wx = 0;
    let wz = 0;
    let sprint = false;
    let crouch = this.crouch;
    this.moving = false;
    this.tightLeg = false;

    if (this.wantDirect) {
      wx = this.directX;
      wz = this.directZ;
      sprint = this.sprint;
    } else if (this.wantGoal && this.status !== "arrived") {
      this.pollPath(view, rng);
      if (this.retraceLeft > 0) {
        // Walking back along our own footsteps: a route that physically worked a moment ago.
        const o = this.retraceSlot * 3;
        wx = this.crumbs[o]! - self.feet.x;
        wz = this.crumbs[o + 2]! - self.feet.z;
        this.retraceTicks--;
        if (wx * wx + wz * wz < 0.36 || this.retraceTicks <= 0) this.nextRetrace(view);
      } else if (this.sidestepTicks > 0) {
        this.sidestepTicks--;
        wx = this.sidestep.x - self.feet.x;
        wz = this.sidestep.z - self.feet.z;
        if (wx * wx + wz * wz < 0.09) this.sidestepTicks = 0;
      } else if (this.finalApproach && this.status === "moving") {
        wx = this.target.x - self.feet.x;
        wz = this.target.z - self.feet.z;
        copyVec(this.moveTarget, this.target);
      } else if (this.pathValid && this.path.count > 0 && this.status === "moving") {
        const flags = this.followPath(view, rng);
        wx = this.moveTarget.x - self.feet.x;
        wz = this.moveTarget.z - self.feet.z;
        if ((flags & NavFlag.crouchOnly) !== 0) this.crouchUntil = tick + CROUCH_HOLD_TICKS;
        if (tick < this.crouchUntil) crouch = true;
        this.tightLeg = (flags & (NavFlag.door | NavFlag.stairs | NavFlag.crouchOnly)) !== 0;
        sprint = this.sprint && (flags & (NavFlag.stairs | NavFlag.door | NavFlag.indoor)) === 0;
      } else if (this.status === "pending" || this.status === "failed") {
        // Waiting for a path or retrying: never stand still when a straight walk is possible.
        if (this.directOk && tick - this.requestTick >= (this.status === "failed" ? 0 : PENDING_WALK_TICKS)) {
          wx = this.goal.x - self.feet.x;
          wz = this.goal.z - self.feet.z;
          copyVec(this.moveTarget, this.goal);
          sprint = this.sprint;
        }
        if (this.status === "pending" && tick - this.requestTick > PENDING_TIMEOUT_TICKS) this.request(view);
        if (this.status === "failed" && tick >= this.retryTick) this.retry(view, rng);
      }
    }

    const len = Math.sqrt(wx * wx + wz * wz);
    if (len > 1e-4) {
      wx /= len;
      wz /= len;
      // Separation from nearby actors (body blocking is off for bots). Not on path legs through doors or stairs,
      // where two bots pushing each other sideways jam the opening.
      let px = 0;
      let pz = 0;
      const mates = this.tightLeg ? EMPTY_MATES : view.teammates;
      for (let i = 0; i < mates.length; i++) {
        const m = mates[i]!;
        if (m.slot === self.slot || m.life === "dead") continue;
        const d = dx2(self.feet.x, self.feet.z, m.feet.x, m.feet.z);
        if (d < SEPARATION && d > 1e-3) {
          const w = ((SEPARATION - d) / SEPARATION) * 1.5;
          px += ((self.feet.x - m.feet.x) / d) * w;
          pz += ((self.feet.z - m.feet.z) / d) * w;
        }
      }
      const tracks = this.tightLeg ? EMPTY_TRACKS : perception.actors;
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i]!;
        if (!t.visible || !t.hostile) continue;
        const d = dx2(self.feet.x, self.feet.z, t.position.x, t.position.z);
        if (d < SEPARATION && d > 1e-3) {
          const w = (SEPARATION - d) / SEPARATION;
          px += ((self.feet.x - t.position.x) / d) * w;
          pz += ((self.feet.z - t.position.z) / d) * w;
        }
      }
      if (px !== 0 || pz !== 0) {
        wx += px;
        wz += pz;
        const l2 = Math.sqrt(wx * wx + wz * wz);
        if (l2 > 1e-4) {
          wx /= l2;
          wz /= l2;
        }
      }
      this.moving = true;
      this.moveX = wx;
      this.moveZ = wz;
      this.moveYaw = Math.atan2(wx, wz);
      this.writeAxes(input, lookYaw);
    } else {
      input.forward = 0;
      input.right = 0;
    }

    this.recordCrumb(self.feet);
    const jump = this.updateStuck(view, input, rng) || this.jump;
    if (this.wantGoal && !this.wantDirect && this.status !== "arrived") this.checkGoalProgress(view, rng);
    else this.bestGoalDistance = Infinity;
    this.checkAnchor(view, input, rng);
    const turning = Math.abs(wrapAngle(this.moveYaw - lookYaw)) > 0.6;
    let buttons = input.buttons & ~(Btn.jump | Btn.sprint | Btn.crouch);
    if (jump) buttons |= Btn.jump;
    if (sprint && this.moving && !aiming && !crouch && !turning && input.forward === 1) buttons |= Btn.sprint;
    if (crouch) buttons |= Btn.crouch;
    input.buttons = buttons;
  }

  /**
   * Displacement-based unstuck ladder while pushing a path: jump after ~0.7 s without progress, sidestep toward an open
   * ring point after ~1.3 s, replan around the spot after ~2 s, give up on the target (behaviors skip it) after ~4 s.
   * Returns whether to jump this tick.
   */
  private updateStuck(view: BotWorldView, input: BotInput, rng: BotRandom): boolean {
    const self = view.self;
    const tick = view.tick;
    const pushing = input.forward !== 0 || input.right !== 0;
    if (pushing) this.pushTicks++;
    if (tick - this.progressTick < PROGRESS_WINDOW_TICKS) return false;
    const moved = dx2(self.feet.x, self.feet.z, this.progressPos.x, this.progressPos.z) + Math.abs(self.feet.y - this.progressPos.y);
    const pushedMost = this.pushTicks > PROGRESS_WINDOW_TICKS * 0.6;
    this.progressTick = tick;
    copyVec(this.progressPos, self.feet);
    this.pushTicks = 0;
    if (!pushedMost || moved >= PROGRESS_MIN || !self.move.grounded) {
      this.stuckWindows = 0;
      this.stuckSeconds = 0;
      return false;
    }
    this.stuckWindows++;
    this.stuckSeconds = (this.stuckWindows * PROGRESS_WINDOW_TICKS) / 60;
    let jump = true;
    if (this.stuckWindows === 2 || this.stuckWindows === 5) this.startSidestep(view, rng, this.stuckWindows === 2 ? 1.2 : 3);
    if (this.stuckWindows === 3 && this.wantGoal) {
      this.markBadSpotHere(self.feet, tick);
      this.request(view);
      jump = false;
    }
    if (this.stuckWindows >= 6) {
      this.stuckWindows = 0;
      this.gaveUpNext = true;
      if (this.wantGoal) this.detour(view, rng);
    }
    return jump;
  }

  /**
   * Last line of defense, independent of goals and replans (a moving target resets the other detectors): pushing for
   * most of 5 s without leaving a 2 m circle is stuck.
   */
  private checkAnchor(view: BotWorldView, input: BotInput, rng: BotRandom): void {
    const feet = view.self.feet;
    const tick = view.tick;
    if (this.retraceLeft > 0) {
      this.anchorTick = 0;
      return;
    }
    if (input.forward !== 0 || input.right !== 0) this.anchorPush++;
    const d = dx2(feet.x, feet.z, this.anchor.x, this.anchor.z) + Math.abs(feet.y - this.anchor.y) * 0.5;
    if (d > ANCHOR_RADIUS || this.anchorTick === 0) {
      copyVec(this.anchor, feet);
      this.anchorTick = tick;
      this.anchorPush = 0;
      return;
    }
    if (tick - this.anchorTick < ANCHOR_TICKS) return;
    const pushed = this.anchorPush > ANCHOR_TICKS * 0.6;
    copyVec(this.anchor, feet);
    this.anchorTick = tick;
    this.anchorPush = 0;
    if (!pushed || this.wantDirect) return;
    this.gaveUpNext = true;
    this.markBadSpotHere(feet, tick);
    if (this.wantGoal) this.detour(view, rng);
    if (!this.startRetrace(tick)) this.startSidestep(view, rng, 4);
  }

  /** Walking in place near an obstacle can dodge the displacement check; no progress toward the goal for 4 s can't. */
  private checkGoalProgress(view: BotWorldView, rng: BotRandom): void {
    const feet = view.self.feet;
    const tick = view.tick;
    if (this.retraceLeft > 0) {
      this.bestGoalDistance = Infinity;
      return;
    }
    const dx = this.goal.x - feet.x;
    const dy = this.goal.y - feet.y;
    const dz = this.goal.z - feet.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < this.bestGoalDistance - 1) {
      this.bestGoalDistance = d;
      this.bestGoalTick = tick;
      return;
    }
    if (this.bestGoalDistance === Infinity) {
      this.bestGoalDistance = d;
      this.bestGoalTick = tick;
      return;
    }
    if (tick - this.bestGoalTick < GOAL_PROGRESS_TICKS) return;
    this.bestGoalDistance = Infinity;
    this.gaveUpNext = true;
    this.markBadSpotHere(feet, tick);
    this.stuckSeconds = GOAL_PROGRESS_TICKS / 60;
    this.detour(view, rng);
    if (!this.startRetrace(tick)) this.startSidestep(view, rng, 3);
  }

  /** Marks where the bot is stuck; the waypoint it was pushing toward is usually the broken spot, so mark it too. */
  private markBadSpotHere(feet: { readonly x: number; readonly z: number }, tick: number): void {
    this.markBadSpot(feet.x, feet.z, tick);
    const m = this.moveTarget;
    const d = dx2(feet.x, feet.z, m.x, m.z);
    if (d > 0.5 && d < 4) this.markBadSpot(m.x, m.z, tick);
  }

  private markBadSpot(x: number, z: number, tick: number): void {
    let spot = this.badSpots.length < BAD_SPOTS ? null : this.badSpots[0]!;
    for (let i = 0; i < this.badSpots.length; i++) {
      const b = this.badSpots[i]!;
      if (dx2(b.x, b.z, x, z) < 1) spot = b;
      else if (spot !== null && b.untilTick < spot.untilTick && this.badSpots.length >= BAD_SPOTS) spot = b;
    }
    if (!spot) {
      spot = { x, z, radius: BAD_SPOT_RADIUS, cost: BAD_SPOT_COST, untilTick: 0 };
      this.badSpots.push(spot);
    }
    spot.x = x;
    spot.z = z;
    spot.untilTick = tick + BAD_SPOT_TICKS;
  }

  /** Axes for the world direction (moveX, moveZ) relative to `yaw`. */
  private writeAxes(input: BotInput, yaw: number): void {
    const wx = this.moveX;
    const wz = this.moveZ;
    const s = Math.sin(yaw);
    const c = Math.cos(yaw);
    const f = wx * s + wz * c;
    const r = wx * c - wz * s;
    const sector = Math.atan2(r, f) / (Math.PI / 4);
    const lo = Math.floor(sector);
    const frac = sector - lo;
    this.dither += frac;
    let k = lo;
    if (this.dither >= 0.5) {
      k = lo + 1;
      this.dither -= 1;
    }
    k = ((k % 8) + 8) % 8;
    input.forward = SECTOR_F[k]!;
    input.right = SECTOR_R[k]!;
  }

  private setTarget(view: BotWorldView, x: number, y: number, z: number): void {
    this.target.x = x;
    this.target.y = y;
    this.target.z = z;
    if (this.snap(view, this.target)) copyVec(this.target, this.snapped);
    copyVec(this.goal, this.target);
    this.detouring = false;
    this.failures = 0;
    this.bestGoalDistance = Infinity;
  }

  /** Nearest nav node around `p`, probing heights. Writes `snapped`. */
  private snap(view: BotWorldView, p: MutVec3): boolean {
    const s = this.scratch;
    for (let i = 0; i < SNAP_HEIGHTS.length; i++) {
      s.x = p.x;
      s.y = p.y + SNAP_HEIGHTS[i]!;
      s.z = p.z;
      if (view.nav.nearest(s, SNAP_REACH, this.snapped) >= 0) return true;
    }
    return false;
  }

  private request(view: BotWorldView): void {
    if (this.handle >= 0) view.nav.releasePath(this.handle);
    this.nav = view.nav;
    const o = this.options;
    o.allowCrouchOnly = true;
    o.partial = true;
    // Live bad spots become avoid circles (the array objects are reused).
    this.avoid.length = 0;
    for (let i = 0; i < this.badSpots.length; i++) if (this.badSpots[i]!.untilTick > view.tick) this.avoid.push(this.badSpots[i]!);
    o.avoid = this.avoid.length > 0 ? this.avoid : undefined;
    const feet = view.self.feet;
    this.handle = view.nav.requestPath(feet, this.goal, o);
    this.requestTick = view.tick;
    this.pathValid = false;
    this.finalApproach = false;
    this.index = 0;
    this.requestDistance = dx2(feet.x, feet.z, this.target.x, this.target.z);
    this.directOk = view.nav.lineWalkable(feet, this.goal);
    if (this.handle < 0) this.fail(view);
    else this.status = "pending";
  }

  private fail(view: BotWorldView): void {
    this.status = "failed";
    this.handle = -1;
    this.pathValid = false;
    this.failures++;
    this.retryTick = view.tick + RETRY_TICKS;
    if (this.failures >= 6) {
      this.gaveUpNext = true;
      this.failures = 0;
    }
  }

  /** After a failure: detour through a reachable point toward the target, or ask again. */
  private retry(view: BotWorldView, rng: BotRandom): void {
    if (this.failures % 2 === 1) this.detour(view, rng);
    else {
      copyVec(this.goal, this.target);
      this.detouring = false;
      this.request(view);
    }
  }

  /** Picks a sampled reachable point 10–35 m away that gets closer to the target and paths there. */
  private detour(view: BotWorldView, rng: BotRandom): void {
    const feet = view.self.feet;
    const n = view.nav.sampleRing(feet, DETOUR_MIN, DETOUR_MAX, (rng.next() * 0xffffffff) >>> 0, this.ring, 12);
    let best = -1;
    let bestScore = dx2(feet.x, feet.z, this.target.x, this.target.z);
    for (let i = 0; i < n; i++) {
      const x = this.ring[i * 3]!;
      const z = this.ring[i * 3 + 2]!;
      // Closer to the target, with some randomness so repeated detours explore.
      const score = dx2(x, z, this.target.x, this.target.z) + rng.next() * 6;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0 && n > 0) best = Math.floor(rng.next() * n);
    if (best < 0) {
      this.retryTick = view.tick + RETRY_TICKS;
      return;
    }
    this.goal.x = this.ring[best * 3]!;
    this.goal.y = this.ring[best * 3 + 1]!;
    this.goal.z = this.ring[best * 3 + 2]!;
    this.detouring = true;
    this.request(view);
  }

  private pollPath(view: BotWorldView, rng: BotRandom): void {
    if (this.status !== "pending") return;
    if (this.handle < 0) {
      this.fail(view);
      return;
    }
    const status: PathStatus = view.nav.readPath(this.handle, this.path);
    if (status === "found" || status === "partial") {
      view.nav.releasePath(this.handle);
      this.handle = -1;
      this.pathValid = this.path.count > 0;
      this.index = this.path.count > 1 ? 1 : 0;
      if (this.pathValid) this.status = "moving";
      else this.fail(view);
    } else if (status === "unreachable" || status === "released") {
      this.fail(view);
      if (this.failures === 1) this.detour(view, rng);
    }
  }

  /** Advances along the path and writes the look-ahead point. Returns the flags of the current waypoint. */
  private followPath(view: BotWorldView, rng: BotRandom): number {
    const self = view.self.feet;
    const p = this.path.points;
    const count = this.path.count;
    // Advance past waypoints inside the look-ahead on the same floor (shorter look-ahead on stairs and doors).
    while (this.index < count - 1) {
      const i3 = this.index * 3;
      const tight = (this.path.flags[this.index]! & (NavFlag.stairs | NavFlag.door)) !== 0;
      const d = dx2(self.x, self.z, p[i3]!, p[i3 + 2]!);
      if (d < (tight ? 0.6 : LOOKAHEAD) && Math.abs(self.y - p[i3 + 1]!) < FLOOR_GAP) this.index++;
      else break;
    }
    const i3 = this.index * 3;
    this.moveTarget.x = p[i3]!;
    this.moveTarget.y = p[i3 + 1]!;
    this.moveTarget.z = p[i3 + 2]!;
    if (this.index === count - 1) {
      // A found path may end at the nearest walkable node; the final approach aims at the goal itself.
      const endGap = dx2(p[i3]!, p[i3 + 2]!, this.goal.x, this.goal.z);
      if (endGap < 1 && dx2(self.x, self.z, p[i3]!, p[i3 + 2]!) < LOOKAHEAD) copyVec(this.moveTarget, this.goal);
    }

    // Off the path: replan.
    if (this.index > 0) {
      const a3 = (this.index - 1) * 3;
      const off = pointSegmentDistance(self.x, self.z, p[a3]!, p[a3 + 2]!, p[i3]!, p[i3 + 2]!);
      if (off > OFF_PATH && view.tick - this.requestTick > 30) this.request(view);
    }
    if (this.index === count - 1 && this.status === "moving") {
      const d = dx2(self.x, self.z, p[i3]!, p[i3 + 2]!);
      if (d <= Math.max(this.arriveRadius, 0.5)) this.endOfPath(view, rng);
    }
    let flags = this.path.flags[this.index]!;
    for (let k = 1; k <= 2 && this.index + k < count; k++) {
      const f = this.path.flags[this.index + k]!;
      const k3 = (this.index + k) * 3;
      // Doors and stairs count only for the next waypoint; a low opening counts when it is close.
      if (k === 1) flags |= f;
      else if ((f & NavFlag.crouchOnly) !== 0 && dx2(self.x, self.z, p[k3]!, p[k3 + 2]!) < 2) flags |= NavFlag.crouchOnly;
    }
    return flags;
  }

  /** Reached the last waypoint: arrived, a detour leg done, or a truncated/partial path to continue. */
  private endOfPath(view: BotWorldView, rng: BotRandom): void {
    const feet = view.self.feet;
    const toGoal = dx2(feet.x, feet.z, this.goal.x, this.goal.z);
    if (this.detouring && toGoal <= 3) {
      copyVec(this.goal, this.target);
      this.detouring = false;
      this.request(view);
      return;
    }
    const toTarget = dx2(feet.x, feet.z, this.target.x, this.target.z);
    if (toTarget <= Math.max(this.arriveRadius, 2.5)) {
      if (Math.abs(feet.y - this.target.y) < FLOOR_GAP * 2) {
        if (toTarget <= this.arriveRadius) this.status = "arrived";
        else this.finalApproach = true;
        this.failures = 0;
      } else {
        // Under or over the target on another floor the path can't reach: give the target up.
        this.fail(view);
        this.gaveUpNext = true;
      }
      return;
    }
    // Truncated or partial: continue if the leg made progress, detour otherwise.
    if (this.requestDistance - toTarget > 4) {
      this.failures = 0;
      copyVec(this.goal, this.target);
      this.detouring = false;
      this.request(view);
    } else {
      this.fail(view);
      this.detour(view, rng);
    }
  }

  /** Breadcrumbs every 1.5 m of travel, newest last in a ring. */
  private recordCrumb(feet: { readonly x: number; readonly y: number; readonly z: number }): void {
    if (this.retraceLeft > 0) return;
    if (this.crumbCount > 0) {
      const o = this.crumbHead * 3;
      const dx = feet.x - this.crumbs[o]!;
      const dz = feet.z - this.crumbs[o + 2]!;
      if (dx * dx + dz * dz < CRUMB_SPACING * CRUMB_SPACING) return;
      this.crumbHead = (this.crumbHead + 1) % CRUMBS;
    }
    const o = this.crumbHead * 3;
    this.crumbs[o] = feet.x;
    this.crumbs[o + 1] = feet.y;
    this.crumbs[o + 2] = feet.z;
    if (this.crumbCount < CRUMBS) this.crumbCount++;
  }

  /** Starts walking back over up to 8 crumbs; false when there aren't enough. The path request resumes after. */
  private startRetrace(tick: number): boolean {
    if (this.crumbCount < 3 || tick - this.lastRetraceTick < RETRACE_COOLDOWN_TICKS) return false;
    this.lastRetraceTick = tick;
    this.retraceLeft = Math.min(RETRACE_CRUMBS, this.crumbCount - 1);
    // The newest crumb is where we are stuck; start from the one before it.
    this.retraceSlot = (this.crumbHead - 1 + CRUMBS) % CRUMBS;
    this.retraceTicks = RETRACE_STEP_TICKS;
    this.sidestepTicks = 0;
    return true;
  }

  private nextRetrace(view: BotWorldView): void {
    this.retraceLeft--;
    this.retraceTicks = RETRACE_STEP_TICKS;
    this.retraceSlot = (this.retraceSlot - 1 + CRUMBS) % CRUMBS;
    if (this.retraceLeft <= 0) {
      // Forget the retraced trail (it would be retraced again) and ask for a path from here.
      this.crumbCount = 0;
      if (this.wantGoal) this.request(view);
    }
  }

  /**
   * Walks straight to a nearby point that is physically open: nav-walkable and clear of static geometry at knee and
   * chest height (the static raycast catches nav links that cut through walls). Prefers points toward the goal.
   */
  private startSidestep(view: BotWorldView, rng: BotRandom, radius: number): void {
    const self = view.self.feet;
    const n = view.nav.sampleRing(self, radius * 0.4, radius, (rng.next() * 0xffffffff) >>> 0, this.ring, 12);
    let best = -1;
    let bestScore = Infinity;
    const from = this.probeFrom;
    const to = this.probeTo;
    for (let i = 0; i < n; i++) {
      const x = this.ring[i * 3]!;
      const y = this.ring[i * 3 + 1]!;
      const z = this.ring[i * 3 + 2]!;
      let open = true;
      for (let h = 0; h < 2 && open; h++) {
        from.x = self.x;
        from.y = self.y + (h === 0 ? 0.5 : 1.3);
        from.z = self.z;
        to.x = x;
        to.y = y + (h === 0 ? 0.5 : 1.3);
        to.z = z;
        if (view.raycast(from, to) !== null) open = false;
      }
      if (!open) continue;
      const score = dx2(x, z, this.goal.x, this.goal.z) + rng.next() * 3;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return;
    this.sidestep.x = this.ring[best * 3]!;
    this.sidestep.y = this.ring[best * 3 + 1]!;
    this.sidestep.z = this.ring[best * 3 + 2]!;
    this.sidestepTicks = SIDESTEP_TICKS;
  }
}

function dx2(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

function pointSegmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return dx2(px, pz, ax + dx * t, az + dz * t);
}
