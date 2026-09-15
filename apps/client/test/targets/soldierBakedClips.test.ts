import { Quaternion, Vector3, type TransformNode } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import type { CharacterClipName } from "../../src/assets";
import type { BakedClipGroup } from "../../src/targets/BakedSoldierClips";
import { SoldierAnimator } from "../../src/targets/SoldierAnimator";
import { realSoldier, type RealSoldier } from "./soldierRealRig";

// Baked clips (BakedSoldierClips) on the real swat.glb, against Babylon's own evaluation.
//
// - Without seeks, Babylon's AnimationGroups are the reference: one soldier of each kind runs the same script.
// - With seeks (one-shots, holds, deaths) they are not: `goToFrame` makes Babylon assign a clip's working quaternion
//   object to the bone node itself, and later weighted blends then write through that alias and drop the clip (a death
//   fading in over a run doesn't show until it is alone). There the reference is computed per bone from
//   `Animation.evaluate` of every weighted clip at its frame, blended with Babylon's sequential slerp.

const MAX_ANGLE = 0.05; // rad, ~3°
const MAX_OFFSET = 0.01; // m, hips position in bind space
const DT = 1 / 60;

let soldiers: RealSoldier[] = [];
afterEach(() => {
  for (const s of soldiers) s.dispose();
  soldiers = [];
  SoldierAnimator.bakedClips = true;
});

async function spawn(baked: boolean): Promise<RealSoldier> {
  SoldierAnimator.bakedClips = baked;
  const soldier = await realSoldier();
  SoldierAnimator.bakedClips = true;
  soldiers.push(soldier);
  expect((soldier.animator as unknown as { mixer: unknown }).mixer === null).toBe(!baked);
  return soldier;
}

function animatedBones(s: RealSoldier): Map<string, TransformNode> {
  const nodes = new Map<string, TransformNode>();
  for (const group of s.character.animations.values()) for (const { target } of group.targetedAnimations) nodes.set((target as TransformNode).name, target as TransformNode);
  return nodes;
}

type Script = (s: RealSoldier, t: number) => void;

interface Difference {
  angle: number;
  offset: number;
  at: string;
}

function track(result: Difference, name: string, t: number, q: Quaternion, r: Quaternion, p: Vector3, o: Vector3): void {
  const dot = Math.min(1, Math.abs(q.x * r.x + q.y * r.y + q.z * r.z + q.w * r.w));
  const angle = 2 * Math.acos(dot);
  if (angle > result.angle) {
    result.angle = angle;
    result.at = `${name} at ${t.toFixed(2)} s`;
  }
  result.offset = Math.max(result.offset, p.subtract(o).length());
}

/** Baked soldier against a Babylon-groups soldier running the same script. */
async function againstGroups(script: Script, seconds: number): Promise<Difference> {
  const reference = await spawn(false);
  const baked = await spawn(true);
  const a = animatedBones(reference);
  const b = animatedBones(baked);
  const animate = reference.scene as unknown as { _animate(ms: number): void };
  const result = { angle: 0, offset: 0, at: "" };
  for (let frame = 0; frame * DT < seconds; frame++) {
    const t = frame * DT;
    for (const s of [reference, baked]) {
      script(s, t);
      s.animator.update(DT);
    }
    animate._animate(DT * 1000);
    for (const [name, node] of a) {
      const other = b.get(name)!;
      track(result, name, t, node.rotationQuaternion!, other.rotationQuaternion!, node.position, other.position);
    }
  }
  return result;
}

/** Baked soldier against the per-bone blend of Babylon's own clip evaluation at the baked groups' frames and weights. */
async function againstEvaluate(script: Script, seconds: number): Promise<Difference> {
  const s = await spawn(true);
  const nodes = animatedBones(s);
  const rest = new Map([...nodes].map(([name, node]) => [name, { q: node.rotationQuaternion!.clone(), p: node.position.clone() }]));
  const groups = (s.animator as unknown as { mixer: { groups: ReadonlyMap<CharacterClipName, BakedClipGroup> } }).mixer.groups;
  const result = { angle: 0, offset: 0, at: "" };
  const q = new Quaternion();
  const p = new Vector3();
  for (let frame = 0; frame * DT < seconds; frame++) {
    const t = frame * DT;
    script(s, t);
    s.animator.update(DT);
    const rotations = new Map<string, { q: Quaternion; w: number }[]>();
    const positions = new Map<string, { p: Vector3; w: number }[]>();
    for (const [name, group] of groups) {
      if (!group.isStarted) continue;
      const source = s.character.animations.get(name)!;
      source.targetedAnimations.forEach(({ target, animation }, k) => {
        const w = group.retained[k] ? group.animatables[k]!.weight : 0;
        if (!(w > 0)) return;
        const bone = (target as TransformNode).name;
        const value = animation.evaluate(group.getCurrentFrame());
        if (animation.targetProperty === "rotationQuaternion") (rotations.get(bone) ?? rotations.set(bone, []).get(bone)!).push({ q: value.clone(), w });
        else (positions.get(bone) ?? positions.set(bone, []).get(bone)!).push({ p: value.clone(), w });
      });
    }
    for (const [name, node] of nodes) {
      const r = rotations.get(name);
      const ps = positions.get(name);
      if (r) {
        // Babylon's late-binding quaternion blend: rest fills a total below 1, then sequential slerps.
        const total = r.reduce((sum, e) => sum + e.w, 0);
        const list = total < 1 ? [{ q: rest.get(name)!.q, w: 1 - total }, ...r] : r;
        const sum = Math.max(total, 1);
        q.copyFrom(list[0]!.q);
        let amount = list[0]!.w / sum;
        for (let i = 1; i < list.length; i++) {
          amount += list[i]!.w / sum;
          Quaternion.SlerpToRef(q, list[i]!.q, list[i]!.w / sum / amount, q);
        }
      } else {
        q.copyFrom(node.rotationQuaternion!);
      }
      if (ps) {
        const total = ps.reduce((sum, e) => sum + e.w, 0);
        p.setAll(0);
        for (const e of ps) p.addInPlace(e.p.scale(e.w / Math.max(total, 1)));
        if (total < 1) p.addInPlace(rest.get(name)!.p.scale(1 - total));
      } else {
        p.copyFrom(node.position);
      }
      track(result, name, t, q, node.rotationQuaternion!, p, node.position);
    }
  }
  return result;
}

function wander(s: RealSoldier, t: number): void {
  const step = Math.floor(t / 0.8);
  const angle = (step * Math.PI) / 2 + (step % 3) * 0.4;
  const pace = [1.2, 4.5, 6.5, 0.4][step % 4]!;
  s.motion.velocityX = Math.sin(angle) * pace;
  s.motion.velocityZ = Math.cos(angle) * pace;
  s.motion.sprinting = step % 4 === 2;
  s.motion.crouched = step % 7 === 5;
  s.motion.aiming = step % 2 === 0;
}

describe("baked soldier clips match Babylon", () => {
  it("idle and locomotion without seeks match real AnimationGroups", async () => {
    const idle = await againstGroups(() => {}, 1.5);
    expect(idle.angle, idle.at).toBeLessThan(MAX_ANGLE);
    const walk = await againstGroups((s) => (s.motion.velocityZ = 1.5), 2);
    expect(walk.angle, walk.at).toBeLessThan(MAX_ANGLE);
    expect(walk.offset).toBeLessThan(MAX_OFFSET);
  }, 60_000);

  it("locomotion churn with fire, reload and flinch layers", async () => {
    const result = await againstEvaluate((s, t) => {
      wander(s, t);
      const f = Math.round(t * 60);
      if (f % 20 === 0) s.animator.fire();
      if (f === 200) s.animator.reload(2);
      if (f === 400) s.animator.hit();
    }, 7);
    expect(result.angle, result.at).toBeLessThan(MAX_ANGLE);
    expect(result.offset).toBeLessThan(MAX_OFFSET);
  }, 60_000);

  it("knocked: fall, crawl, hold, CPR, get-up", async () => {
    const result = await againstEvaluate((s, t) => {
      s.motion.downed = t < 9;
      s.motion.velocityZ = t > 3 && t < 4.5 ? -1 : 0;
      s.motion.beingRevived = t > 6 && t < 9;
    }, 11);
    expect(result.angle, result.at).toBeLessThan(MAX_ANGLE);
    expect(result.offset).toBeLessThan(MAX_OFFSET);
  }, 60_000);

  it("death while running, then a respawn", async () => {
    const result = await againstEvaluate((s, t) => {
      s.motion.velocityZ = t < 1 || t > 5 ? 3 : 0;
      if (Math.round(t * 60) === 60) s.animator.die("back");
      if (Math.round(t * 60) === 300) s.animator.revive();
    }, 7);
    expect(result.angle, result.at).toBeLessThan(MAX_ANGLE);
    expect(result.offset).toBeLessThan(MAX_OFFSET);
  }, 60_000);
});
