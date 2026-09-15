import type { AnimationGroup, AnimationGroupMask } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { CharacterClip, CharacterClipName, CharacterInstance } from "../../src/assets";
import { SoldierAnimator, createSoldierMotion, type SoldierMotion } from "../../src/targets/SoldierAnimator";
import { DEAD, DOWNED, crawlRestAhead, crawlSwayTime, deadTintFactor, deadTintStep } from "../../src/targets/soldierRig";

// Knocked vs dead presentation ("dead figure should be different from knocked figure"): the animator's pose selection
// and transitions, on fake animation groups that advance like Babylon's (after the animator's update, at speedRatio).

const FPS = 30;
const DT = 1 / 60;

const CLIPS: Record<CharacterClipName, CharacterClip> = {
  rifle_idle: { duration: 3.1, loop: true },
  walk_fwd: { duration: 1, loop: true, rootMotion: [0, 0, 1.843] },
  walk_back: { duration: 1, loop: true, rootMotion: [0, 0, -1.843] },
  walk_left: { duration: 1, loop: true, rootMotion: [-1.843, 0, 0] },
  walk_right: { duration: 1, loop: true, rootMotion: [1.843, 0, 0] },
  crouch_walk_fwd: { duration: 1, loop: true, rootMotion: [0, 0, 1.956] },
  run_fwd: { duration: 0.5, loop: true, rootMotion: [0, 0, 4.607] },
  run_back: { duration: 0.5, loop: true, rootMotion: [0, 0, -4.607] },
  run_left: { duration: 0.5, loop: true, rootMotion: [-4.607, 0, 0] },
  run_right: { duration: 0.5, loop: true, rootMotion: [4.607, 0, 0] },
  sprint_fwd: { duration: 0.5, loop: true, rootMotion: [0, 0, 6.91] },
  crouch_idle: { duration: 2.1, loop: true },
  jump_up: { duration: 0.533, loop: false },
  jump_loop: { duration: 1, loop: true },
  jump_down: { duration: 0.667, loop: false },
  fire: { duration: 0.267, loop: false },
  reload: { duration: 3.3, loop: false },
  hit: { duration: 2.3, loop: false },
  death_front: { duration: 3.433, loop: false },
  death_back: { duration: 2.967, loop: false },
  knock_down: { duration: 2.2, loop: false },
  writhe: { duration: 5.667, loop: true },
  crawl: { duration: 1.8, loop: true },
  get_up: { duration: 2.067, loop: false },
  cpr_give: { duration: 8.633, loop: true },
  cpr_receive: { duration: 5, loop: true },
  heal_kneel: { duration: 4.933, loop: true },
  bandage: { duration: 5, loop: true },
  drink: { duration: 4.167, loop: true },
  throw_stand: { duration: 1.8, loop: false },
  throw_crouch: { duration: 2, loop: false },
  pick_up: { duration: 1.2, loop: false },
};

class FakeGroup {
  readonly from = 0;
  readonly to: number;
  readonly targetedAnimations = [{ target: { name: "mixamorig:Hips" }, animation: { framePerSecond: FPS } }];
  readonly animatables = [{ weight: 0 }];
  weight = 0;
  speedRatio = 1;
  isStarted = false;
  mask: unknown = null;
  private loop = false;
  private frame = 0;

  constructor(
    readonly name: CharacterClipName,
    duration: number,
  ) {
    this.to = duration * FPS;
  }

  start(loop: boolean, speed: number, from: number): void {
    this.isStarted = true;
    this.loop = loop;
    this.speedRatio = speed;
    this.frame = from;
  }

  stop(): void {
    this.isStarted = false;
  }

  goToFrame(frame: number): void {
    this.frame = frame;
  }

  getCurrentFrame(): number {
    return this.frame;
  }

  /** Babylon's per-render advance. */
  advance(dt: number): void {
    if (!this.isStarted) return;
    this.frame += dt * FPS * this.speedRatio;
    if (this.frame > this.to) this.frame = this.loop ? this.frame % this.to : this.to;
  }

  get influence(): number {
    return this.animatables[0]!.weight;
  }
}

interface Rig {
  readonly animator: SoldierAnimator;
  readonly motion: SoldierMotion;
  readonly groups: ReadonlyMap<CharacterClipName, FakeGroup>;
  step(seconds: number): void;
  group(name: CharacterClipName): FakeGroup;
}

function rig(): Rig {
  const groups = new Map<CharacterClipName, FakeGroup>();
  for (const [name, clip] of Object.entries(CLIPS) as [CharacterClipName, CharacterClip][]) groups.set(name, new FakeGroup(name, clip.duration));
  const character = { asset: { clips: CLIPS }, animations: groups as unknown as ReadonlyMap<CharacterClipName, AnimationGroup> } as unknown as CharacterInstance;
  const motion = createSoldierMotion();
  const animator = new SoldierAnimator(character, motion, new Map(), {} as AnimationGroupMask);
  return {
    animator,
    motion,
    groups,
    group: (name) => groups.get(name)!,
    step(seconds) {
      for (let t = 0; t < seconds - 1e-9; t += DT) {
        animator.update(DT);
        for (const group of groups.values()) group.advance(DT);
      }
    },
  };
}

/** Clip time (s) of a group. */
const clipTime = (group: FakeGroup) => group.getCurrentFrame() / FPS;
/** Weighted groups still animating (a corpse must lie completely still). */
const moving = (r: Rig) => [...r.groups.values()].filter((g) => g.isStarted && g.influence > 1e-3 && g.speedRatio !== 0).map((g) => g.name);

/** Crawl clip seconds from `t` to the nearest planted frame, either direction. */
const restDistance = (t: number) => {
  const d = CLIPS.crawl.duration;
  return Math.min(...DOWNED.crawlRestTimes.map((rest) => Math.min(Math.abs(rest - t), d - Math.abs(rest - t))));
};

function knockAndSettle(r: Rig): void {
  r.motion.downed = true;
  r.step(0.05);
  expect(r.animator.pose).toBe("knock");
  r.step(CLIPS.knock_down.duration + 2);
}

describe("soldier pose: knocked stays up on all fours and alive", () => {
  it("knock → crawl hold (planted, swaying, never the flat writhe) → crawl when moving → hold again", () => {
    const r = rig();
    knockAndSettle(r);
    expect(r.animator.pose).toBe("crawlHold");
    expect(r.group("crawl").influence).toBeGreaterThan(0.99);
    expect(r.group("writhe").isStarted).toBe(false);

    // Sways around a planted frame, within the amplitude.
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      r.step(0.1);
      times.push(clipTime(r.group("crawl")));
    }
    for (const t of times) expect(restDistance(t)).toBeLessThanOrEqual(DOWNED.swayAmplitude + 0.02);
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(DOWNED.swayAmplitude);

    r.motion.velocityZ = -0.8;
    r.step(0.3);
    expect(r.animator.pose).toBe("crawl");
    expect(r.group("crawl").speedRatio).toBeGreaterThan(0);

    r.motion.velocityZ = 0;
    r.step(2);
    expect(r.animator.pose).toBe("crawlHold");
    expect(restDistance(clipTime(r.group("crawl")))).toBeLessThanOrEqual(DOWNED.swayAmplitude + 0.02);
  });

  it("revived: get-up, then back to standing locomotion", () => {
    const r = rig();
    knockAndSettle(r);
    r.motion.downed = false;
    r.step(0.05);
    expect(r.animator.pose).toBe("getUp");
    r.step(CLIPS.get_up.duration + 1);
    expect(r.animator.pose).toBe("up");
    expect(r.group("rifle_idle").influence).toBeGreaterThan(0.95);
    expect(r.group("crawl").isStarted).toBe(false);
  });
});

describe("soldier pose: dead lies flat and still", () => {
  it("shot while standing: one-shot death clip, frozen on its last frame", () => {
    const r = rig();
    r.step(0.5);
    r.animator.die("back");
    expect(r.animator.pose).toBe("deathClip");
    r.step(CLIPS.death_back.duration + 1);
    const death = r.group("death_back");
    expect(death.influence).toBeGreaterThan(0.99);
    expect(death.getCurrentFrame()).toBeGreaterThan(death.to - 1);
    expect(moving(r)).toEqual([]);
  });

  it("finished while knocked: collapses from the crawl onto knock_down's prone frame and holds", () => {
    const r = rig();
    knockAndSettle(r);
    r.motion.velocityZ = -0.8;
    r.step(0.5);
    r.animator.die("front");
    expect(r.animator.pose).toBe("deathCollapse");
    // Slower than a death clip's fade: the crawl still shows a moment after the kill.
    r.step(0.1);
    expect(r.group("crawl").influence).toBeGreaterThan(0.3);
    r.step(3);
    const knock = r.group("knock_down");
    expect(knock.influence).toBeGreaterThan(0.99);
    expect(clipTime(knock)).toBeCloseTo(DEAD.proneTime, 3);
    expect(r.group("crawl").isStarted).toBe(false);
    expect(r.group("death_front").isStarted).toBe(false);
    expect(moving(r)).toEqual([]);
  });

  it("bled out mid-fall: the knock-down plays on to the prone frame and stops there", () => {
    const r = rig();
    r.motion.downed = true;
    r.step(0.6);
    r.animator.die("front");
    expect(r.animator.pose).toBe("deathCollapse");
    r.step(0.5);
    expect(r.group("knock_down").speedRatio).toBeGreaterThan(0);
    r.step(2);
    expect(clipTime(r.group("knock_down"))).toBeCloseTo(DEAD.proneTime, 1);
    expect(clipTime(r.group("knock_down"))).toBeLessThanOrEqual(DEAD.proneTime + 1e-6);
    expect(moving(r)).toEqual([]);
  });

  it("killed while receiving CPR: holds the flat CPR pose", () => {
    const r = rig();
    knockAndSettle(r);
    r.motion.beingRevived = true;
    r.step(2);
    expect(r.animator.pose).toBe("cprReceive");
    r.animator.die("front");
    expect(r.animator.pose).toBe("deathHold");
    r.step(2);
    expect(r.group("cpr_receive").influence).toBeGreaterThan(0.99);
    expect(moving(r)).toEqual([]);
  });

  it("dead ignores the downed flag and movement; a revive (respawn) stands back up", () => {
    const r = rig();
    knockAndSettle(r);
    r.animator.die("front");
    r.motion.velocityZ = 2;
    r.step(2);
    expect(r.animator.pose).toBe("deathCollapse");
    expect(r.animator.handsBusy).toBe(false);
    r.motion.downed = false;
    r.motion.velocityZ = 0;
    r.animator.revive();
    r.step(3);
    expect(r.animator.pose).toBe("up");
    expect(r.group("rifle_idle").influence).toBeGreaterThan(0.95);
  });
});

describe("dead-body helpers", () => {
  it("crawl rest and sway wrap around the loop", () => {
    const d = CLIPS.crawl.duration;
    expect(crawlRestAhead(0.45, d)).toBe(0);
    expect(crawlRestAhead(0.5, d)).toBeCloseTo(0.85, 6);
    expect(crawlRestAhead(1.5, d)).toBeCloseTo(0.75, 6);
    expect(crawlSwayTime(0.45, 0, d)).toBeCloseTo(0.45, 6);
    expect(crawlSwayTime(0.02, DOWNED.swayPeriod * 0.75, d)).toBeCloseTo(d + 0.02 - DOWNED.swayAmplitude, 6);
  });

  it("tint starts after the delay and reaches the final factor", () => {
    expect(deadTintStep(0)).toBe(0);
    expect(deadTintStep(DEAD.tintDelay)).toBe(0);
    expect(deadTintStep(DEAD.tintDelay + 0.01)).toBe(1);
    expect(deadTintStep(DEAD.tintDelay + DEAD.tintDuration)).toBe(DEAD.tintSteps);
    expect(deadTintStep(60)).toBe(DEAD.tintSteps);
    expect(deadTintFactor(0)).toBe(1);
    expect(deadTintFactor(DEAD.tintSteps)).toBeCloseTo(DEAD.tintFactor, 6);
  });
});
