import type { ThrowableKind } from "../../equipment/items";
import { throwableDef } from "../../equipment/items";
import { THROW, throwLaunch } from "../../equipment/throw";
import { predictThrowArc, THROWABLE_PHYSICS } from "../../equipment/throwables";
import { Btn } from "../../input";
import type { Vec3 } from "../../movement/types";
import type { BotTickOutput, BotWorldView } from "../types";
import { DEG, copyVec, vec3, wrapAngle, type MutVec3 } from "../brain/util";

// Throw sequence for frags, molotovs and smokes (design.md §5.4): select the kind (G), draw (select = 5), turn to the
// solved yaw/pitch, pull the pin (fire held), optionally cook (R), release. The pitch comes from the analytic no-drag
// solve, corrected with `predictThrowArc` (decision time only, not per tick).

export type GrenadePhase = "idle" | "draw" | "aim" | "hold" | "release";

const DRAW_TIMEOUT_TICKS = 90;
const AIM_TIMEOUT_TICKS = 40;
const AIM_TOLERANCE = 2.5 * DEG;
const PIN_TICKS = 3;
const TEAMMATE_SAFE_RADIUS = 6;
const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

export class GrenadeThrow {
  phase: GrenadePhase = "idle";
  kind: ThrowableKind = "frag";
  readonly target: MutVec3 = vec3();
  yaw = 0;
  pitch = 0;
  private phaseTick = 0;
  private cookTicks = 0;
  private lastCycleTick = -10;
  private lastSelectTick = -10;
  private cycles = 0;
  private readonly arc = new Float32Array(3 * 64);

  get active(): boolean {
    return this.phase !== "idle";
  }

  cancel(): void {
    this.phase = "idle";
  }

  /**
   * Solves the throw from the bot's eye to `target` and starts the sequence. Returns false (no throw) when the target
   * is out of throwing range or a teammate is near the predicted landing point.
   */
  start(view: BotWorldView, kind: ThrowableKind, target: Vec3, cook: boolean): boolean {
    const eye = view.self.eye;
    copyVec(this.target, target);
    const yaw = Math.atan2(target.x - eye.x, target.z - eye.z);
    const range = Math.sqrt((target.x - eye.x) * (target.x - eye.x) + (target.z - eye.z) * (target.z - eye.z));
    let aimRange = range;
    let pitch = 0;
    let landX = target.x;
    let landZ = target.z;
    let flight = 1;
    for (let iteration = 0; iteration < 3; iteration++) {
      const solved = solvePitch(aimRange, target.y - eye.y, THROW.overhand.speed, THROW.overhand.loftDegrees * DEG);
      if (solved === null) return false;
      pitch = solved;
      const launch = throwLaunch({ eye, yaw, pitch, velocity: ZERO }, "overhand");
      const result = predictThrowArc({ kind, position: launch.hand, velocity: launch.velocity, fuse: 30 }, view.raycast, this.arc, { dt: view.dt, sampleEvery: 8, maxSeconds: 5 });
      landX = result.end.x;
      landZ = result.end.z;
      const predicted = Math.sqrt((landX - eye.x) * (landX - eye.x) + (landZ - eye.z) * (landZ - eye.z));
      flight = (result.count * 8 * view.dt) || 1;
      const error = range - predicted;
      if (Math.abs(error) < 1) break;
      aimRange = Math.max(1, aimRange + error);
    }
    const mates = view.teammates;
    for (let i = 0; i < mates.length; i++) {
      const m = mates[i]!;
      if (m.slot === view.self.slot || m.life === "dead") continue;
      const dx = m.feet.x - landX;
      const dz = m.feet.z - landZ;
      if (Math.sqrt(dx * dx + dz * dz) < TEAMMATE_SAFE_RADIUS) return false;
    }
    this.kind = kind;
    this.yaw = yaw;
    this.pitch = pitch;
    const def = throwableDef(kind);
    this.cookTicks = cook && def.cookable ? Math.max(0, Math.round((def.fuseSeconds - flight - 0.5) / view.dt)) : 0;
    this.phase = "draw";
    this.phaseTick = view.tick;
    this.cycles = 0;
    return true;
  }

  /** Writes this tick's throw inputs. The brain aims at (yaw, pitch) while `phase` is aim/hold/release. */
  tick(view: BotWorldView, out: BotTickOutput, aimYaw: number, aimPitch: number): void {
    const tick = view.tick;
    const self = view.self;
    const state = self.throwState;
    const input = out.input;
    switch (this.phase) {
      case "idle":
        return;
      case "draw": {
        if (self.inventory.selectedThrowable !== this.kind) {
          if (this.cycles > 5 || !carries(view, this.kind)) {
            this.abort(out);
            return;
          }
          if (tick - this.lastCycleTick >= 3) {
            out.intents.cycleThrowable = true;
            this.lastCycleTick = tick;
            this.cycles++;
          }
        } else if (state.phase === "ready" && state.kind === this.kind) {
          this.enter("aim", tick);
        } else if (state.phase === "idle" && tick - this.lastSelectTick >= 3) {
          input.select = 5;
          this.lastSelectTick = tick;
        }
        if (tick - this.phaseTick > DRAW_TIMEOUT_TICKS) this.abort(out);
        return;
      }
      case "aim": {
        const err = Math.abs(wrapAngle(aimYaw - this.yaw)) + Math.abs(aimPitch - this.pitch);
        if (state.phase !== "ready") {
          if (state.phase === "idle") this.phase = "idle";
          return;
        }
        if (err < AIM_TOLERANCE || tick - this.phaseTick > AIM_TIMEOUT_TICKS) {
          input.buttons |= Btn.fire;
          this.enter("hold", tick);
        }
        return;
      }
      case "hold": {
        const held = tick - this.phaseTick;
        input.buttons |= Btn.fire;
        if (this.cookTicks > 0 && held === PIN_TICKS && state.phase === "primed") input.buttons |= Btn.reload;
        if (held >= PIN_TICKS + this.cookTicks) this.enter("release", tick);
        return;
      }
      case "release": {
        // Fire released: the throw leaves the hand this tick.
        if (tick - this.phaseTick > 2) this.phase = "idle";
        return;
      }
    }
  }

  private enter(phase: GrenadePhase, tick: number): void {
    this.phase = phase;
    this.phaseTick = tick;
  }

  private abort(out: BotTickOutput): void {
    out.intents.holster = true;
    this.phase = "idle";
  }
}

function carries(view: BotWorldView, kind: ThrowableKind): boolean {
  const stacks = view.self.inventory.stacks;
  for (let i = 0; i < stacks.length; i++) if (stacks[i]!.itemId === kind && stacks[i]!.quantity > 0) return true;
  return false;
}

/**
 * Aim pitch (+ down) that lands a no-drag throw of `speed` at horizontal `range` and height difference `dy`, with the
 * launch direction lofted by `loft` over the aim. Low arc; null when out of reach.
 */
export function solvePitch(range: number, dy: number, speed: number, loft: number): number | null {
  const g = THROWABLE_PHYSICS.gravity;
  const v2 = speed * speed;
  const disc = v2 * v2 - g * (g * range * range + 2 * dy * v2);
  if (disc < 0) return null;
  const elevation = range < 1e-3 ? Math.PI / 4 : Math.atan2(v2 - Math.sqrt(disc), g * range);
  return loft - elevation;
}
