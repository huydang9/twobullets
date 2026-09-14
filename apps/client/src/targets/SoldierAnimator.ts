import { AnimationGroupMask, AnimationGroupMaskMode, type AnimationGroup } from "@babylonjs/core";
import type { CharacterClipName, CharacterInstance } from "../assets";
import { ACTIONS, JUMP_DOWN_START, JUMP_UP_START, type ActionName } from "./soldierRig";

/** Movement input for the animator, written by the owner every frame (local player sim or network snapshot). */
export interface SoldierMotion {
  /** Horizontal velocity in the soldier's own frame, m/s: +X right, +Z forward. */
  velocityX: number;
  velocityZ: number;
  grounded: boolean;
  crouched: boolean;
  sprinting: boolean;
  /** Holds the shouldered-rifle stance on the upper body while moving. */
  aiming: boolean;
}

export function createSoldierMotion(): SoldierMotion {
  return { velocityX: 0, velocityZ: 0, grounded: true, crouched: false, sprinting: false, aiming: false };
}

export type DeathDirection = "front" | "back";
export type AirState = "ground" | "rising" | "falling" | "landing";

/** Weight smoothing rates, 1/s (exponential; ~3/rate seconds to settle). */
const BASE_RATE = 9;
const OVERLAY_RATE = 25;
const AIR_RATE = 12;
const DEATH_RATE = 9;
const REVIVE_RATE = 7;
const EPSILON = 1e-3;

/** Airborne this long before the jump pose starts, so stepping off small ledges doesn't trigger it. */
const AIR_DELAY = 0.1;
/** Full jump_down influence after touching down, before blending back into locomotion. */
const LANDING_HOLD = 0.15;
const LANDING_HOLD_MOVING = 0.05;

/** Locomotion playback-rate limits relative to the clip's authored speed. */
const MIN_PLAYBACK = 0.5;
const MAX_PLAYBACK = 1.8;
/** Below this speed the previous movement direction is kept, so the blend doesn't spin when stopping. */
const DIRECTION_MIN_SPEED = 0.15;

const LOCOMOTION = {
  walk: { fwd: "walk_fwd", back: "walk_back", left: "walk_left", right: "walk_right" },
  run: { fwd: "run_fwd", back: "run_back", left: "run_left", right: "run_right" },
} as const;

interface Channel {
  readonly name: CharacterClipName;
  readonly group: AnimationGroup;
  /** Upper-body layer factor per targeted animation (same order as `group.animatables`). */
  readonly upper: Float32Array;
  readonly fps: number;
  readonly duration: number;
  /** Authored root speed, m/s (0 for in-place clips). */
  readonly rootSpeed: number;
  /** Phase-locked locomotion cycle. */
  readonly cyclic: boolean;
  /** Played on demand and held on its last frame instead of looping. */
  readonly oneShot: boolean;
  base: number;
  overlay: number;
  full: number;
  baseTarget: number;
  overlayTarget: number;
  fullTarget: number;
  /** Frame a one-shot freezes on. */
  endFrame: number;
  frozen: boolean;
  /** Started but not yet weighted in; keeps a one-shot alive through its first frames. */
  pending: boolean;
  weighted: boolean;
}

/**
 * Weight-based animation blender for one character instance. Every clip is an AnimationGroup whose per-bone
 * animatable weights are recomputed each frame from three layers:
 *
 * - base: locomotion blend space (idle / 4-way walk and run / sprint / crouch), weights summing to 1;
 * - overlay: upper-body clips (aim, fire, reload, hit), scaled per bone by `upperBodyWeights`;
 * - full: full-body clips (jump, death) over everything.
 *
 * Per bone the weights always sum to 1, so Babylon's weighted blend never mixes in a stale rest pose.
 * Groups only run while they carry weight. Locomotion cycles share one frequency and join in phase; one-shots
 * are started on demand, frozen on their last frame, and stopped once faded out.
 */
export class SoldierAnimator {
  private readonly channels: Channel[] = [];
  private readonly byName = new Map<CharacterClipName, Channel>();
  private readonly idle: Channel;
  private readonly crouchIdle: Channel;
  private readonly crouchWalk: Channel;
  private readonly sprint: Channel;
  private readonly jumpUp: Channel;
  private readonly jumpLoop: Channel;
  private readonly jumpDown: Channel;

  private action: ActionName | null = null;
  private actionTime = 0;
  private actionSpeed = 1;
  private air: AirState = "ground";
  private airTime = 0;
  private death: Channel | null = null;

  /** Last significant movement direction, as normalized 4-way weights. */
  private dirFwd = 1;
  private dirBack = 0;
  private dirLeft = 0;
  private dirRight = 0;

  constructor(
    character: CharacterInstance,
    readonly motion: SoldierMotion,
    upperWeights: ReadonlyMap<string, number>,
    upperMask: AnimationGroupMask,
  ) {
    for (const [name, group] of character.animations) {
      const clip = character.asset.clips[name];
      const oneShot = !clip.loop;
      const targets = group.targetedAnimations;
      const upper = new Float32Array(targets.length);
      targets.forEach((t, i) => (upper[i] = upperWeights.get((t.target as { name: string }).name) ?? 0));
      const channel: Channel = {
        name,
        group,
        upper,
        fps: targets[0]?.animation.framePerSecond ?? 60,
        duration: clip.duration,
        rootSpeed: clip.rootMotion ? Math.hypot(clip.rootMotion[0], clip.rootMotion[2]) : 0,
        cyclic: clip.loop && clip.rootMotion !== undefined,
        oneShot,
        base: 0,
        overlay: 0,
        full: 0,
        baseTarget: 0,
        overlayTarget: 0,
        fullTarget: 0,
        endFrame: group.to,
        frozen: false,
        pending: false,
        weighted: true,
      };
      if (group.isStarted) group.stop(true);
      // -1 would bypass weighted blending entirely.
      group.weight = 0;
      if (name === "fire" || name === "reload" || name === "hit") group.mask = upperMask;
      this.channels.push(channel);
      this.byName.set(name, channel);
    }
    this.idle = this.channel("rifle_idle");
    this.crouchIdle = this.channel("crouch_idle");
    this.crouchWalk = this.channel("crouch_walk_fwd");
    this.sprint = this.channel("sprint_fwd");
    this.jumpUp = this.channel("jump_up");
    this.jumpLoop = this.channel("jump_loop");
    this.jumpDown = this.channel("jump_down");

    this.idle.base = 1;
    this.apply(0);
  }

  get dead(): boolean {
    return this.death !== null;
  }

  get currentAction(): ActionName | null {
    return this.action;
  }

  get airState(): AirState {
    return this.air;
  }

  fire(): void {
    if (!this.dead) this.startAction("fire", ACTIONS.fire.speed);
  }

  /** @param seconds Reload length to match (the simulation's reload time); defaults to the clip's own. */
  reload(seconds?: number): void {
    if (this.dead) return;
    const spec = ACTIONS.reload;
    const length = (spec.end ?? this.channel(spec.clip).duration) - spec.start;
    this.startAction("reload", seconds && seconds > 0 ? length / seconds : spec.speed);
  }

  /** Upper-body flinch. Doesn't interrupt a reload. */
  hit(): void {
    if (this.dead || this.action === "reload") return;
    this.startAction("hit", ACTIONS.hit.speed);
  }

  die(direction: DeathDirection): void {
    if (this.dead) return;
    this.action = null;
    this.air = "ground";
    this.death = this.channel(direction === "front" ? "death_front" : "death_back");
    this.play(this.death, 0, 1, this.death.duration);
  }

  /** Blends from wherever the body lies back into locomotion. */
  revive(): void {
    this.death = null;
    this.airTime = 0;
  }

  update(dt: number): void {
    this.updateAir(dt);
    this.updateAction(dt);
    this.updateTargets();
    this.smooth(dt);
    this.apply(dt);
  }

  private channel(name: CharacterClipName): Channel {
    const channel = this.byName.get(name);
    if (!channel) throw new Error(`Soldier animation "${name}" missing`);
    return channel;
  }

  private startAction(action: ActionName, speed: number): void {
    const spec = ACTIONS[action];
    const channel = this.channel(spec.clip);
    this.action = action;
    this.actionTime = 0;
    this.actionSpeed = speed;
    this.play(channel, spec.start, speed, spec.end ?? channel.duration);
  }

  /** Starts (or rewinds) a one-shot at clip time `from`, to freeze at clip time `to`. */
  private play(channel: Channel, from: number, speed: number, to: number): void {
    const group = channel.group;
    if (!group.isStarted) group.start(true, speed, group.from, group.to);
    group.speedRatio = speed;
    group.goToFrame(group.from + from * channel.fps);
    channel.endFrame = Math.min(group.from + to * channel.fps, group.to - 0.01);
    channel.frozen = false;
    channel.pending = true;
  }

  private updateAir(dt: number): void {
    const { grounded } = this.motion;
    this.airTime += dt;
    if (this.dead) {
      this.air = "ground";
      return;
    }
    switch (this.air) {
      case "ground":
        if (grounded) this.airTime = 0;
        else if (this.airTime >= AIR_DELAY) this.setAir("rising");
        break;
      case "rising":
        if (grounded) this.setAir("landing");
        else if (this.airTime >= this.jumpUp.duration - JUMP_UP_START) this.setAir("falling");
        break;
      case "falling":
        if (grounded) this.setAir("landing");
        break;
      case "landing": {
        const moving = Math.hypot(this.motion.velocityX, this.motion.velocityZ) > 1;
        if (!grounded) this.setAir("rising");
        else if (this.airTime >= (moving ? LANDING_HOLD_MOVING : LANDING_HOLD)) this.setAir("ground");
        break;
      }
    }
  }

  private setAir(state: AirState): void {
    this.air = state;
    this.airTime = 0;
    if (state === "rising") this.play(this.jumpUp, JUMP_UP_START, 1, this.jumpUp.duration);
    else if (state === "landing") this.play(this.jumpDown, JUMP_DOWN_START, 1, this.jumpDown.duration);
  }

  private updateAction(dt: number): void {
    if (this.action === null) return;
    if (this.dead) {
      this.action = null;
      return;
    }
    this.actionTime += dt;
    if (this.actionTime >= this.actionLength(this.action)) this.action = null;
  }

  /** Real seconds an action plays for at its current speed. */
  private actionLength(action: ActionName): number {
    const spec = ACTIONS[action];
    return ((spec.end ?? this.channel(spec.clip).duration) - spec.start) / this.actionSpeed;
  }

  private updateTargets(): void {
    for (const c of this.channels) {
      c.baseTarget = 0;
      c.overlayTarget = 0;
      c.fullTarget = 0;
    }

    // Full body: death over jumps.
    if (this.death) this.death.fullTarget = 1;
    else if (this.air === "rising") this.jumpUp.fullTarget = 1;
    else if (this.air === "falling") this.jumpLoop.fullTarget = 1;
    else if (this.air === "landing") this.jumpDown.fullTarget = 1;

    // Upper body: one action, or the aim stance.
    let actionWeight = 0;
    if (this.action !== null) {
      const spec = ACTIONS[this.action];
      const t = this.actionTime;
      actionWeight = spec.weight * Math.min(1, t / spec.fadeIn, Math.max(0, (this.actionLength(this.action) - t) / spec.fadeOut));
      this.channel(spec.clip).overlayTarget = actionWeight;
    }
    if (this.motion.aiming) this.idle.overlayTarget = 1 - actionWeight;

    this.updateLocomotionTargets();
  }

  private updateLocomotionTargets(): void {
    const { velocityX: vx, velocityZ: vz, crouched, sprinting } = this.motion;
    const speed = Math.hypot(vx, vz);
    if (speed > DIRECTION_MIN_SPEED) {
      const sum = Math.abs(vx) + Math.abs(vz);
      this.dirFwd = Math.max(vz, 0) / sum;
      this.dirBack = Math.max(-vz, 0) / sum;
      this.dirRight = Math.max(vx, 0) / sum;
      this.dirLeft = Math.max(-vx, 0) / sum;
    }

    if (crouched) {
      // Only a forward crouch walk exists; it stands in for every direction.
      const t = Math.min(speed / this.crouchWalk.rootSpeed, 1);
      this.crouchIdle.baseTarget = 1 - t;
      this.crouchWalk.baseTarget = t;
      return;
    }

    // 1D blend over authored speeds: idle 0, walk, run, then sprint (forward only, when sprinting).
    const walkSpeed = this.channel("walk_fwd").rootSpeed;
    const runSpeed = this.channel("run_fwd").rootSpeed;
    let idle = 0;
    let walk = 0;
    let run = 0;
    let sprint = 0;
    if (speed <= walkSpeed) {
      walk = speed / walkSpeed;
      idle = 1 - walk;
    } else if (speed <= runSpeed || !sprinting) {
      run = Math.min((speed - walkSpeed) / (runSpeed - walkSpeed), 1);
      walk = 1 - run;
    } else {
      sprint = Math.min((speed - runSpeed) / (this.sprint.rootSpeed - runSpeed), 1);
      run = 1 - sprint;
    }

    this.idle.baseTarget = idle;
    this.addDirectional(LOCOMOTION.walk, walk);
    this.addDirectional(LOCOMOTION.run, run);
    // Sprint only has a forward clip; its sideways and backward share falls back to running.
    this.sprint.baseTarget += sprint * this.dirFwd;
    this.channel("run_back").baseTarget += sprint * this.dirBack;
    this.channel("run_left").baseTarget += sprint * this.dirLeft;
    this.channel("run_right").baseTarget += sprint * this.dirRight;
  }

  private addDirectional(clips: (typeof LOCOMOTION)["walk" | "run"], weight: number): void {
    if (weight <= 0) return;
    this.channel(clips.fwd).baseTarget += weight * this.dirFwd;
    this.channel(clips.back).baseTarget += weight * this.dirBack;
    this.channel(clips.left).baseTarget += weight * this.dirLeft;
    this.channel(clips.right).baseTarget += weight * this.dirRight;
  }

  private smooth(dt: number): void {
    const kBase = 1 - Math.exp(-BASE_RATE * dt);
    const kOverlay = 1 - Math.exp(-OVERLAY_RATE * dt);
    const kAir = 1 - Math.exp(-AIR_RATE * dt);
    const kDeath = 1 - Math.exp(-(this.dead ? DEATH_RATE : REVIVE_RATE) * dt);
    for (const c of this.channels) {
      c.base = approach(c.base, c.baseTarget, kBase);
      c.overlay = approach(c.overlay, c.overlayTarget, kOverlay);
      const deathClip = c.name === "death_front" || c.name === "death_back";
      c.full = approach(c.full, c.fullTarget, deathClip || this.dead ? kDeath : kAir);
    }
  }

  private apply(dt: number): void {
    let baseSum = 0;
    let overlaySum = 0;
    let fullSum = 0;
    let cycleWeight = 0;
    let cycleSpeed = 0;
    let cycleRate = 0;
    for (const c of this.channels) {
      baseSum += c.base;
      overlaySum += c.overlay;
      fullSum += c.full;
      if (c.cyclic && c.base > 0) {
        cycleWeight += c.base;
        cycleSpeed += c.base * c.rootSpeed;
        cycleRate += c.base / c.duration;
      }
    }
    if (baseSum < EPSILON) {
      this.idle.base = baseSum = 1;
    }
    const baseScale = 1 / baseSum;
    const overlayScale = overlaySum > 1 ? 1 / overlaySum : 1;
    const overlay = Math.min(overlaySum, 1);
    const full = Math.min(fullSum, 1);
    const fullScale = fullSum > 1 ? 1 / fullSum : 1;

    // One shared cycle frequency, scaled so feet match the ground speed; each clip's rate follows from its length.
    let frequency = 1;
    let reference: Channel | null = null;
    if (cycleWeight > EPSILON) {
      const speed = Math.hypot(this.motion.velocityX, this.motion.velocityZ);
      const authored = cycleSpeed / cycleWeight;
      const playback = Math.min(MAX_PLAYBACK, Math.max(MIN_PLAYBACK, authored > 0 ? speed / authored : 1));
      frequency = (playback * cycleRate) / cycleWeight;
      for (const c of this.channels) {
        if (!c.cyclic || !c.group.isStarted) continue;
        c.group.speedRatio = frequency * c.duration;
        if (c.weighted && (!reference || c.base > reference.base)) reference = c;
      }
    }

    for (const c of this.channels) {
      const base = c.base * baseScale;
      const a = (1 - full) * base + c.full * fullScale;
      const b = (1 - full) * (c.overlay * overlayScale - base * overlay);
      const group = c.group;

      if (a + Math.max(b, 0) < EPSILON) {
        if (c.weighted) {
          for (const animatable of group.animatables) animatable.weight = 0;
          c.weighted = false;
        }
        if (group.isStarted && !c.pending && c.base + c.overlay + c.full === 0) {
          group.stop(true);
          c.frozen = false;
        }
        continue;
      }

      if (!group.isStarted) {
        if (c.oneShot) continue;
        this.startLoop(c, frequency, reference, dt);
      } else if (c.oneShot && !c.frozen) {
        this.freezeAtEnd(c, dt);
      }
      const animatables = group.animatables;
      const upper = c.upper;
      for (let i = 0; i < animatables.length; i++) animatables[i]!.weight = a + b * upper[i]!;
      c.weighted = true;
      c.pending = false;
    }
  }

  /**
   * Loops only run while weighted (Babylon skips weight-0 animatables without advancing them, so idle groups would
   * drift). A locomotion cycle joins at the phase of the dominant running one, keeping footfalls in step.
   */
  private startLoop(c: Channel, frequency: number, reference: Channel | null, dt: number): void {
    const group = c.group;
    group.start(true, c.cyclic ? frequency * c.duration : 1, group.from, group.to);
    if (c.cyclic && reference) {
      const ref = reference.group;
      // The reference advances once more before the new group's first evaluation.
      const phase = ((ref.getCurrentFrame() - ref.from) / (ref.to - ref.from) + frequency * dt) % 1;
      group.goToFrame(group.from + phase * (group.to - group.from));
    }
  }

  /** Holds a one-shot on its end frame; weights may still be fading, so it must keep contributing. */
  private freezeAtEnd(c: Channel, dt: number): void {
    const group = c.group;
    const step = 2 * dt * c.fps * group.speedRatio;
    if (group.getCurrentFrame() + step < c.endFrame) return;
    group.goToFrame(c.endFrame);
    group.speedRatio = 0;
    c.frozen = true;
  }
}

function approach(value: number, target: number, k: number): number {
  const next = value + (target - value) * k;
  return target === 0 && next < EPSILON ? 0 : next;
}

/** Include-mask of every skeleton node with a non-zero upper-body weight. */
export function createUpperBodyMask(weights: ReadonlyMap<string, number>): AnimationGroupMask {
  const names = [...weights].filter(([, w]) => w > 0).map(([name]) => name);
  return new AnimationGroupMask(names, AnimationGroupMaskMode.Include);
}
