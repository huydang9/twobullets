import { Btn } from "../../input";
import type { BotInput, BotWorldView, NavAvoidCircle, NavPath, NavQuery, PathStatus } from "../types";
import { NavFlag } from "../types";
import type { ZoneCircle } from "../../match/types";
import type { PerceptionState } from "../perception/perception";
import { copyVec, vec3, wrapAngle, type BotRandom, type MutVec3 } from "../brain/util";

// Motor (design.md §5.5): every tick turns "go there" / "move this way" into PlayerInput axes and movement buttons.
// Path following is pure pursuit on the NavPath with a 1.2 m look-ahead; axes are −1/0/1 relative to the aim yaw,
// dithered between the two nearest of 8 sectors so the average path is straight.

export const NAV_PATH_CAPACITY = 256;
const LOOKAHEAD = 1.2;
const ARRIVE_RADIUS = 0.6;
const REPLAN_GOAL_MOVE = 3;
const OFF_PATH = 2;
const REPLAN_COOLDOWN_TICKS = 30;
const SEPARATION = 0.9;
const STUCK_SPEED = 0.5;
const STUCK_JUMP_TICKS = 30;
const STUCK_SIDESTEP_TICKS = 60;
const STUCK_GIVE_UP_TICKS = 180;
const SIDESTEP_TICKS = 45;
/** Vertical distance beyond which a waypoint on another floor isn't treated as reached. */
const FLOOR_GAP = 1.4;

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
  readonly goal: MutVec3 = vec3();
  readonly moveTarget: MutVec3 = vec3();
  status: MotorStatus = "idle";
  /** Set when the unstuck ladder gave up this tick (behaviors skip the target). */
  gaveUp = false;
  /** Desired world move direction this tick (unit), valid when `moving`. */
  moveX = 0;
  moveZ = 0;
  moving = false;
  /** Desired yaw of the move direction (for looking where you walk). */
  moveYaw = 0;

  private handle = -1;
  private pathValid = false;
  private index = 0;
  private lastRequestTick = -Infinity;
  private wantGoal = false;
  private directX = 0;
  private directZ = 0;
  private wantDirect = false;
  private sprint = false;
  private crouch = false;
  private jump = false;
  private arriveRadius = ARRIVE_RADIUS;
  private readonly options: MutablePathOptions = {};
  private readonly avoid: NavAvoidCircle[] = [];
  private readonly avoidCircle = { x: 0, z: 0, radius: 1.5, cost: 8 };
  private dither = 0;
  private stuckTicks = 0;
  private sidestepTicks = 0;
  private readonly sidestep: MutVec3 = vec3();
  private readonly ring = new Float32Array(24);
  private readonly scratch: MutVec3 = vec3();
  private directOk = false;
  private nav: NavQuery | null = null;

  reset(): void {
    if (this.nav && this.handle >= 0) this.nav.releasePath(this.handle);
    this.handle = -1;
    this.pathValid = false;
    this.path.count = 0;
    this.path.length = 0;
    this.status = "idle";
    this.index = 0;
    this.lastRequestTick = -Infinity;
    this.wantGoal = false;
    this.wantDirect = false;
    this.stuckTicks = 0;
    this.sidestepTicks = 0;
    this.gaveUp = false;
    this.avoid.length = 0;
    this.dither = 0;
  }

  /** Clears this tick's wishes; call before behaviors run. */
  beginTick(): void {
    this.wantGoal = false;
    this.wantDirect = false;
    this.sprint = false;
    this.crouch = false;
    this.jump = false;
    this.gaveUp = false;
  }

  /** Path toward a point this tick. Replans when the goal moved > 3 m. Returns the status. */
  moveTo(view: BotWorldView, x: number, y: number, z: number, options: MoveOptions): MotorStatus {
    this.wantGoal = true;
    this.sprint = options.sprint;
    this.arriveRadius = options.arriveRadius;
    const self = view.self.feet;
    const moved = dx2(this.goal.x, this.goal.z, x, z);
    const hasGoal = this.status !== "idle";
    if (!hasGoal || moved > REPLAN_GOAL_MOVE || (this.status === "failed" && view.tick - this.lastRequestTick > 120)) {
      this.goal.x = x;
      this.goal.y = y;
      this.goal.z = z;
      this.request(view, options, false);
    } else if (moved > 0.05) {
      // Small goal drift: keep the path, update the final point.
      this.goal.x = x;
      this.goal.y = y;
      this.goal.z = z;
    }
    if (dx2(self.x, self.z, this.goal.x, this.goal.z) <= this.arriveRadius && Math.abs(self.y - this.goal.y) < FLOOR_GAP) this.status = "arrived";
    else if (this.status === "arrived") this.status = "moving";
    this.options.preferCover = options.preferCover;
    this.options.zone = options.zone;
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
  }

  /** Writes axes and movement buttons (jump, sprint, crouch) into `input` for this tick. */
  output(view: BotWorldView, input: BotInput, lookYaw: number, perception: PerceptionState, rng: BotRandom, aiming: boolean): void {
    const self = view.self;
    let wx = 0;
    let wz = 0;
    let sprint = false;
    let crouch = this.crouch;
    this.moving = false;

    if (this.wantDirect) {
      wx = this.directX;
      wz = this.directZ;
      sprint = this.sprint;
    } else if (this.wantGoal && this.status !== "arrived") {
      this.pollPath(view);
      if (this.sidestepTicks > 0) {
        this.sidestepTicks--;
        wx = this.sidestep.x - self.feet.x;
        wz = this.sidestep.z - self.feet.z;
      } else if (this.pathValid && this.path.count > 0) {
        const flags = this.followPath(view);
        wx = this.moveTarget.x - self.feet.x;
        wz = this.moveTarget.z - self.feet.z;
        if ((flags & NavFlag.crouchOnly) !== 0) crouch = true;
        sprint = this.sprint && (flags & (NavFlag.stairs | NavFlag.door | NavFlag.indoor)) === 0;
      } else if (this.status === "pending" && this.directOk) {
        wx = this.goal.x - self.feet.x;
        wz = this.goal.z - self.feet.z;
        copyVec(this.moveTarget, this.goal);
        sprint = this.sprint;
      }
    }

    const len = Math.sqrt(wx * wx + wz * wz);
    if (len > 1e-4) {
      wx /= len;
      wz /= len;
      // Separation from nearby actors (body blocking is off for bots).
      let px = 0;
      let pz = 0;
      const mates = view.teammates;
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
      const tracks = perception.actors;
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

    // Unstuck ladder: jump, sidestep, replan around the spot and give up on the target.
    const pushing = input.forward !== 0 || input.right !== 0;
    const speed = Math.sqrt(self.velocity.x * self.velocity.x + self.velocity.z * self.velocity.z);
    let jump = this.jump;
    if (pushing && speed < STUCK_SPEED && self.move.grounded) {
      this.stuckTicks++;
      if (this.stuckTicks % STUCK_JUMP_TICKS === 0) jump = true;
      if (this.stuckTicks === STUCK_SIDESTEP_TICKS) this.startSidestep(view, rng);
      if (this.stuckTicks >= STUCK_GIVE_UP_TICKS) {
        this.stuckTicks = 0;
        this.gaveUp = true;
        if (this.wantGoal) {
          this.avoidCircle.x = self.feet.x;
          this.avoidCircle.z = self.feet.z;
          this.avoid.length = 0;
          this.avoid.push(this.avoidCircle);
          this.request(view, null, true);
        }
      }
    } else if (!pushing || speed > STUCK_SPEED * 2) {
      this.stuckTicks = 0;
    }

    const turning = Math.abs(wrapAngle(this.moveYaw - lookYaw)) > 0.6;
    let buttons = input.buttons & ~(Btn.jump | Btn.sprint | Btn.crouch);
    if (jump) buttons |= Btn.jump;
    if (sprint && this.moving && !aiming && !crouch && !turning && input.forward === 1) buttons |= Btn.sprint;
    if (crouch) buttons |= Btn.crouch;
    input.buttons = buttons;
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

  private request(view: BotWorldView, options: MoveOptions | null, force: boolean): void {
    const tick = view.tick;
    if (!force && tick - this.lastRequestTick < REPLAN_COOLDOWN_TICKS && this.handle >= 0) return;
    if (this.handle >= 0) view.nav.releasePath(this.handle);
    this.nav = view.nav;
    const o = this.options;
    if (options) {
      o.preferCover = options.preferCover;
      o.zone = options.zone;
      o.partial = options.allowPartial;
    }
    o.allowCrouchOnly = true;
    o.avoid = this.avoid.length > 0 ? this.avoid : undefined;
    this.handle = view.nav.requestPath(view.self.feet, this.goal, o);
    this.lastRequestTick = tick;
    this.pathValid = false;
    this.index = 0;
    this.status = "pending";
    this.directOk = view.nav.lineWalkable(view.self.feet, this.goal);
  }

  private pollPath(view: BotWorldView): void {
    if (this.status !== "pending" || this.handle < 0) return;
    const status: PathStatus = view.nav.readPath(this.handle, this.path);
    if (status === "found" || status === "partial") {
      this.pathValid = this.path.count > 0;
      this.index = this.path.count > 1 ? 1 : 0;
      this.status = "moving";
      view.nav.releasePath(this.handle);
      this.handle = -1;
      if (!this.pathValid) this.status = this.directOk ? "moving" : "failed";
    } else if (status === "unreachable" || status === "released") {
      this.status = "failed";
      this.handle = -1;
    }
  }

  /** Advances along the path and writes the look-ahead point. Returns the flags of the current waypoint. */
  private followPath(view: BotWorldView): number {
    const self = view.self.feet;
    const p = this.path.points;
    const count = this.path.count;
    // Advance past waypoints inside the look-ahead on the same floor.
    while (this.index < count - 1) {
      const i3 = this.index * 3;
      const d = dx2(self.x, self.z, p[i3]!, p[i3 + 2]!);
      if (d < LOOKAHEAD && Math.abs(self.y - p[i3 + 1]!) < FLOOR_GAP) this.index++;
      else break;
    }
    const i3 = this.index * 3;
    this.moveTarget.x = p[i3]!;
    this.moveTarget.y = p[i3 + 1]!;
    this.moveTarget.z = p[i3 + 2]!;
    if (this.index === count - 1 && (this.goal.x !== p[i3] || this.goal.z !== p[i3 + 2])) {
      // A found path may end at the nearest walkable node; the final approach aims at the goal itself.
      const endGap = dx2(p[i3]!, p[i3 + 2]!, this.goal.x, this.goal.z);
      if (endGap < 1 && dx2(self.x, self.z, p[i3]!, p[i3 + 2]!) < LOOKAHEAD) copyVec(this.moveTarget, this.goal);
    }

    // Off the path by more than 2 m: replan.
    if (this.index > 0) {
      const a3 = (this.index - 1) * 3;
      const off = pointSegmentDistance(self.x, self.z, p[a3]!, p[a3 + 2]!, p[i3]!, p[i3 + 2]!);
      if (off > OFF_PATH) this.request(view, null, false);
    }
    if (this.index === count - 1) {
      const d = dx2(self.x, self.z, p[i3]!, p[i3 + 2]!);
      if (d <= this.arriveRadius) {
        const gap = dx2(self.x, self.z, this.goal.x, this.goal.z);
        this.status = gap <= Math.max(this.arriveRadius, 2.5) ? "arrived" : "failed";
      }
    }
    const next = this.index + 1 < count ? this.path.flags[this.index + 1]! : 0;
    return this.path.flags[this.index]! | next;
  }

  private startSidestep(view: BotWorldView, rng: BotRandom): void {
    const self = view.self.feet;
    const n = view.nav.sampleRing(self, 0.8, 1.6, (rng.next() * 0xffffffff) >>> 0, this.ring, 8);
    for (let i = 0; i < n; i++) {
      this.scratch.x = this.ring[i * 3]!;
      this.scratch.y = this.ring[i * 3 + 1]!;
      this.scratch.z = this.ring[i * 3 + 2]!;
      if (view.nav.lineWalkable(self, this.scratch)) {
        copyVec(this.sidestep, this.scratch);
        this.sidestepTicks = SIDESTEP_TICKS;
        return;
      }
    }
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
