import { quantizePitch, quantizeYaw } from "../../aim";
import { BotMemoryState } from "../memory/memory";
import { createMoveOptions, Motor } from "../motor/motor";
import { PerceptionState } from "../perception/perception";
import type { BotBrain, BotBrainFactory, BotBrainOptions, BotDebugState, BotProfile, BotTickOutput, BotWorldView } from "../types";
import { AimModel } from "../aim/aim";
import { BotRandom, RNG_STREAM, wrapAngle } from "./util";

// Test brains for the match sim and headless tests: `idleBrain` stands still (zone-kill tests), `wanderBrain` walks
// between seeded nav points (navigation and stuck tests). Neither perceives, loots or fires.

type MutableDebug = { -readonly [K in keyof BotDebugState]: BotDebugState[K] };

function clearOutput(view: BotWorldView, out: BotTickOutput): void {
  const input = out.input;
  input.tick = view.tick;
  input.forward = 0;
  input.right = 0;
  input.buttons = 0;
  input.select = 0;
  input.viewOffset8 = 0;
  input.action = null;
  out.intents.cycleThrowable = false;
  out.intents.holster = false;
  out.intents.replaceSlot = -1;
  out.intents.reviveSlot = -1;
}

class IdleBrain implements BotBrain {
  readonly slot: number;
  readonly profile: BotProfile;
  readonly perception = new PerceptionState();
  readonly memory = new BotMemoryState();
  protected yaw = 0;
  protected pitch = 0;
  protected started = false;
  protected readonly debugState: MutableDebug = { goal: "idle", goalScore: 0.05, subState: "", targetSlot: -1, aimErrorDeg: Number.NaN, path: null, moveTarget: null, lootTargetId: -1 };

  constructor(options: BotBrainOptions) {
    this.slot = options.slot;
    this.profile = options.profile;
  }

  tick(view: BotWorldView, out: BotTickOutput): void {
    clearOutput(view, out);
    if (!this.started) {
      this.yaw = view.self.aimYaw;
      this.pitch = view.self.aimPitch;
      this.started = true;
    }
    this.debugState.goal = view.self.vitals.life === "dead" ? "dead" : "idle";
    out.input.yawQ = quantizeYaw(this.yaw);
    out.input.pitchQ = quantizePitch(this.pitch);
  }

  kickAim(up: number, right: number): void {
    this.yaw = wrapAngle(this.yaw + right);
    this.pitch -= up;
  }

  reset(yaw: number): void {
    this.yaw = yaw;
    this.pitch = 0;
    this.started = true;
  }

  debug(): BotDebugState {
    return this.debugState;
  }
}

const WANDER_MIN = 15;
const WANDER_MAX = 60;

class WanderBrain extends IdleBrain {
  private readonly motor = new Motor();
  private readonly aim = new AimModel();
  private readonly rng: BotRandom;
  private readonly options = createMoveOptions();
  private readonly ring = new Float32Array(3 * 4);
  private readonly target = { x: 0, y: 0, z: 0 };
  private hasTarget = false;
  private targetTick = 0;

  constructor(options: BotBrainOptions) {
    super(options);
    this.rng = new BotRandom(options.seed, options.slot, RNG_STREAM.motor);
    this.options.sprint = false;
    this.options.arriveRadius = 1.5;
  }

  override tick(view: BotWorldView, out: BotTickOutput): void {
    clearOutput(view, out);
    const self = view.self;
    if (!this.started) {
      this.aim.reset(self.aimYaw, self.aimPitch);
      this.started = true;
    }
    this.motor.beginTick();
    const d = this.debugState;
    if (self.vitals.life === "dead" || view.phase !== "combat") {
      d.goal = self.vitals.life === "dead" ? "dead" : "idle";
      this.writeAim(out);
      return;
    }
    // New target on arrival, failure, or after 40 s.
    if (!this.hasTarget || view.tick - this.targetTick > 2400) this.pickTarget(view);
    if (this.hasTarget) {
      const status = this.motor.moveTo(view, this.target.x, this.target.y, this.target.z, this.options);
      if (status === "arrived" || status === "failed" || this.motor.gaveUp) this.hasTarget = false;
      d.subState = status;
    }
    this.aim.look(this.motor.moving ? this.motor.moveYaw : this.aim.yaw, 0, view.tick, view.dt, this.profile.aim, 0.5);
    this.motor.output(view, out.input, this.aim.yaw, this.perception, this.rng, false);
    d.goal = "loot";
    d.path = this.motor.status === "moving" ? this.motor.path : null;
    d.moveTarget = this.motor.moving ? this.motor.moveTarget : null;
    this.writeAim(out);
  }

  override kickAim(up: number, right: number): void {
    this.aim.kick(up, right, 0, 1 / 60, this.profile.aim);
  }

  override reset(yaw: number): void {
    super.reset(yaw);
    this.aim.reset(yaw, 0);
    this.motor.reset();
    this.hasTarget = false;
  }

  private writeAim(out: BotTickOutput): void {
    out.input.yawQ = quantizeYaw(this.aim.yaw);
    out.input.pitchQ = quantizePitch(this.aim.pitch);
  }

  private pickTarget(view: BotWorldView): void {
    const seed = (this.rng.next() * 0xffffffff) >>> 0;
    const n = view.nav.sampleRing(view.self.feet, WANDER_MIN, WANDER_MAX, seed, this.ring, 4);
    this.hasTarget = n > 0;
    this.targetTick = view.tick;
    if (n > 0) {
      this.target.x = this.ring[0]!;
      this.target.y = this.ring[1]!;
      this.target.z = this.ring[2]!;
      this.motor.stop(view);
    }
  }
}

/** Stands still and holds its spawn aim. */
export const idleBrain: BotBrainFactory = (options) => new IdleBrain(options);

/** Walks between seeded nav points 15–60 m apart. */
export const wanderBrain: BotBrainFactory = (options) => new WanderBrain(options);
