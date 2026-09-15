import { Vector3 } from "@babylonjs/core";
import { SoldierAnimator } from "../../src/targets/SoldierAnimator";
import { ANIMATION_LOD, animationLodInterval } from "../../src/targets/soldierRig";
import { realSoldier, type RealSoldier } from "../targets/soldierRealRig";

// Headless soldier animation micro-benchmark: 20 real swat.glb soldiers (NullEngine) in the mixed states of a live match,
// spread from 5 to 150 m around a camera at the origin looking down +Z (two behind it). Times the per-frame animation
// work: every animator's update (state machine, blending and, on the baked path, the pose) plus Babylon's animation
// pass. Variants: Babylon AnimationGroups (the old path), baked clips at full rate, baked clips with the level of detail
// SoldierCharacter applies (distance and a 90° view cone standing in for the frustum).

export interface SoldierAnimationBenchResult {
  readonly soldiers: number;
  readonly frames: number;
  /** Mean CPU per frame over all soldiers, ms. */
  readonly msPerFrame: number;
  /** Animator updates alone (includes the baked pose evaluation), ms per frame. */
  readonly updateMs: number;
  /** Babylon's `scene._animate` (AnimationGroups), ms per frame. */
  readonly babylonMs: number;
  /** Worst frame, ms. */
  readonly maxMs: number;
  /** Babylon animatables active at the end. */
  readonly activeAnimatables: number;
  /** Soldiers whose bones were written, per frame (baked path). */
  readonly posesPerFrame: number;
}

export type BenchMode = "babylonGroups" | "baked" | "bakedLod";

const FORWARD_COS = Math.cos(Math.PI / 4);

/** SoldierCharacter's level of detail with a fixed unzoomed camera looking down +Z. */
function applyLod(s: RealSoldier, position: Vector3, camera: Vector3): void {
  const dx = position.x - camera.x;
  const dy = position.y + ANIMATION_LOD.cullCenterHeight - camera.y;
  const dz = position.z - camera.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const inView = distance < ANIMATION_LOD.cullRadius || dz / distance > FORWARD_COS;
  const interval = animationLodInterval(distance, inView);
  s.animator.poseInterval = s.animator.pose === "crawlHold" ? Math.max(interval, 1 / ANIMATION_LOD.crawlHoldHz) : interval;
}

type Setup = (s: RealSoldier) => void;
interface Actor {
  readonly z: number;
  readonly x: number;
  readonly setup: Setup;
  readonly tick?: (s: RealSoldier, frame: number) => void;
}

const run = (vx: number, vz: number, sprint = false): Setup => (s) => {
  s.motion.velocityX = vx;
  s.motion.velocityZ = vz;
  s.motion.sprinting = sprint;
};

/** Bot-like churn: changes direction and pace every `period` frames (starts and stops locomotion clips). */
const wander =
  (speed: number, period: number, phase = 0) =>
  (s: RealSoldier, frame: number): void => {
    const step = Math.floor((frame + phase) / period);
    const angle = (step * Math.PI) / 2 + (step % 3) * 0.4;
    const pace = step % 4 === 3 ? speed * 0.35 : speed;
    s.motion.velocityX = Math.sin(angle) * pace;
    s.motion.velocityZ = Math.cos(angle) * pace;
    s.motion.sprinting = step % 5 === 1;
  };

/** Shoots bursts, sometimes flinches or reloads. */
const combat =
  (phase: number) =>
  (s: RealSoldier, frame: number): void => {
    const f = (frame + phase) % 180;
    s.motion.aiming = f < 90;
    if (f < 60 && f % 8 === 0) s.animator.fire();
    if (f === 100) s.animator.hit();
    if (f === 130 && (frame + phase) % 360 === 130) s.animator.reload(2.5);
  };

const both =
  (...ticks: ((s: RealSoldier, frame: number) => void)[]) =>
  (s: RealSoldier, frame: number): void => {
    for (const tick of ticks) tick(s, frame);
  };

const ACTORS: readonly Actor[] = [
  { x: 1, z: 8, setup: run(0, 4.5), tick: both(wander(4.5, 50), combat(0)) },
  { x: -3, z: 15, setup: run(-4, 0), tick: wander(4, 70, 20) },
  { x: 4, z: 25, setup: run(0, 6.5, true), tick: both(wander(6, 90, 10), combat(40)) },
  { x: -6, z: 35, setup: (s) => ((s.motion.aiming = true), run(0, -1.6)(s)), tick: wander(1.6, 60, 5) },
  { x: 2, z: 12, setup: (s) => (s.motion.aiming = true), tick: combat(90) },
  { x: -10, z: 60, setup: () => {}, tick: combat(20) },
  { x: 12, z: 80, setup: run(2, 3), tick: both(wander(3.5, 80, 33), combat(130)) },
  {
    x: 5,
    z: 45,
    setup: (s) => ((s.motion.crouched = true), run(0, 1.5)(s)),
    tick: (s, frame) => {
      s.motion.crouched = frame % 300 < 150;
      wander(1.5, 75, 12)(s, frame);
    },
  },
  { x: -20, z: 120, setup: (s) => (s.motion.crouched = true), tick: combat(60) },
  { x: 3, z: 20, setup: (s) => ((s.motion.downed = true), run(0, -1)(s)) },
  { x: -3, z: 30, setup: (s) => (s.motion.downed = true) },
  { x: -1, z: 30, setup: (s) => ((s.motion.downed = true), (s.motion.beingRevived = true)) },
  { x: 0, z: 31, setup: (s) => (s.motion.activity = "cpr") },
  { x: -2, z: 10, setup: (s) => s.animator.die("front") },
  { x: 8, z: 50, setup: (s) => ((s.motion.downed = true), s.step(3), s.animator.die("back")) },
  { x: 30, z: 150, setup: (s) => s.animator.die("back", true) },
  { x: 1, z: -10, setup: run(0, 4.5), tick: both(wander(4.5, 55, 7), combat(150)) },
  { x: -4, z: -40, setup: () => {}, tick: combat(110) },
  {
    x: 6,
    z: 18,
    setup: run(0, 1.5),
    tick: (s, frame) => {
      if (frame % 12 === 0) s.animator.fire();
      if (frame % 240 === 100) s.animator.reload(2.5);
    },
  },
  {
    x: -8,
    z: 22,
    setup: () => {},
    tick: (s, frame) => {
      s.motion.grounded = frame % 90 > 40;
      wander(3, 45, 3)(s, frame);
    },
  },
];

export interface BenchOptions {
  readonly mode: BenchMode;
  readonly frames?: number;
  readonly repeats?: number;
}

export async function runSoldierAnimationBench(options: BenchOptions): Promise<SoldierAnimationBenchResult> {
  const frames = options.frames ?? 600;
  const repeats = options.repeats ?? 3;
  const soldiers: RealSoldier[] = [];
  const positions: Vector3[] = [];
  const camera = new Vector3(0, 1.6, 0);
  const lod = options.mode === "bakedLod";
  const beforeUpdate = (s: RealSoldier, position: Vector3) => {
    if (lod) applyLod(s, position, camera);
  };
  try {
    for (const actor of ACTORS) {
      SoldierAnimator.bakedClips = options.mode !== "babylonGroups";
      const s = await realSoldier();
      SoldierAnimator.bakedClips = true;
      const root = s.character.root.parent as unknown as { position: Vector3 };
      root.position.set(actor.x, 0, actor.z);
      positions.push(root.position);
      soldiers.push(s);
      s.step(0.3);
      actor.setup(s);
    }
    const scene = soldiers[0]!.scene;
    const animate = scene as unknown as { _animate(ms: number): void; _activeAnimatables: unknown[] };
    const dt = 1 / 60;
    // Settle every state (knock-downs, deaths) before measuring.
    for (let f = 0; f < 240; f++) {
      for (let i = 0; i < soldiers.length; i++) {
        ACTORS[i]!.tick?.(soldiers[i]!, f);
        beforeUpdate(soldiers[i]!, positions[i]!);
        soldiers[i]!.animator.update(dt);
      }
      animate._animate(dt * 1000);
    }

    let update = 0;
    let babylon = 0;
    let max = 0;
    let poses = 0;
    let frame = 240;
    for (let r = 0; r < repeats; r++) {
      for (let f = 0; f < frames; f++, frame++) {
        // A slow camera sweep so soldiers cross the view edge.
        camera.x = Math.sin(frame / 400) * 3;
        const t0 = performance.now();
        for (let i = 0; i < soldiers.length; i++) {
          ACTORS[i]!.tick?.(soldiers[i]!, frame);
          beforeUpdate(soldiers[i]!, positions[i]!);
          soldiers[i]!.animator.update(dt);
        }
        const t1 = performance.now();
        for (const s of soldiers) if (s.animator.posed) poses++;
        animate._animate(dt * 1000);
        const t2 = performance.now();
        update += t1 - t0;
        babylon += t2 - t1;
        max = Math.max(max, t2 - t0);
      }
    }
    const n = frames * repeats;
    return {
      soldiers: soldiers.length,
      frames: n,
      msPerFrame: (update + babylon) / n,
      updateMs: update / n,
      babylonMs: babylon / n,
      maxMs: max,
      activeAnimatables: animate._activeAnimatables.length,
      posesPerFrame: poses / n,
    };
  } finally {
    for (const s of soldiers) s.dispose();
  }
}
