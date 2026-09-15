import { afterEach, describe, expect, it } from "vitest";
import type { CharacterClipName } from "../../src/assets";
import { realSoldier, type RealSoldier } from "./soldierRealRig";

// "Dead player now standing": every death path on the real swat.glb and real Babylon animation groups, measured on the
// evaluated skeleton. A corpse's hips lie below LYING; a standing soldier's are ~0.94 m and a knocked one's ~0.43 m.

const LYING = 0.35;
const STANDING = 0.8;
/** Clips a body is allowed to evaluate once dead. */
const DEATH_CLIPS: ReadonlySet<CharacterClipName> = new Set(["death_front", "death_back", "knock_down", "cpr_receive"]);

let soldier: RealSoldier | null = null;
afterEach(() => {
  soldier?.dispose();
  soldier = null;
});

async function spawn(): Promise<RealSoldier> {
  soldier = await realSoldier();
  soldier.step(0.5);
  expect(soldier.hipsHeight()).toBeGreaterThan(STANDING);
  return soldier;
}

async function knocked(settle = 4): Promise<RealSoldier> {
  const s = await spawn();
  s.motion.downed = true;
  s.step(settle);
  return s;
}

/** Clips still weighted on the body. */
function weighted(s: RealSoldier): CharacterClipName[] {
  return [...s.character.animations].filter(([, g]) => g.isStarted && g.animatables.some((a) => a.weight > 0)).map(([name]) => name);
}

/** After the death has had time to play: flat, only death poses evaluated, and still flat a minute later. */
function expectStaysDead(s: RealSoldier, { settle = 4, dt = 1 / 30 } = {}): void {
  s.step(settle, dt);
  expect(s.hipsHeight()).toBeLessThan(LYING);
  for (const name of weighted(s)) expect(DEATH_CLIPS.has(name), `${name} weighted on a corpse`).toBe(true);
  for (let i = 0; i < 6; i++) {
    s.step(10, dt);
    expect(s.hipsHeight(), `after ${settle + 10 * (i + 1)} s`).toBeLessThan(LYING);
  }
  expect(s.animator.dead).toBe(true);
}

describe("dead soldiers lie down on real animation groups", () => {
  it("killed standing (solo: no knock), shot from the front or behind", async () => {
    for (const side of ["front", "back"] as const) {
      const s = await spawn();
      s.motion.velocityZ = 3;
      s.step(0.5);
      s.animator.die(side);
      s.motion.velocityZ = 0;
      expectStaysDead(s);
      s.dispose();
      soldier = null;
    }
  });

  it("killed while knocked and still (crawl hold)", async () => {
    const s = await knocked();
    expect(s.animator.pose).toBe("crawlHold");
    expect(s.hipsHeight()).toBeGreaterThan(LYING);
    s.animator.die("front");
    expectStaysDead(s);
  });

  it("killed while crawling", async () => {
    const s = await knocked();
    s.motion.velocityZ = -1;
    s.step(1);
    expect(s.animator.pose).toBe("crawl");
    s.animator.die("back");
    expectStaysDead(s);
  });

  it("bled out or zoned mid-fall (still in the knock-down)", async () => {
    const s = await knocked(0.6);
    expect(s.animator.pose).toBe("knock");
    s.animator.die("front");
    expectStaysDead(s);
  });

  it("killed while receiving CPR", async () => {
    const s = await knocked();
    s.motion.beingRevived = true;
    s.step(2);
    s.animator.die("front");
    expectStaysDead(s);
  });

  it("killed while getting up", async () => {
    const s = await knocked();
    s.motion.downed = false;
    s.step(0.8);
    expect(s.animator.pose).toBe("getUp");
    s.animator.die("front");
    expectStaysDead(s);
  });

  it("fall death: killed in the air, then landing", async () => {
    const s = await spawn();
    s.motion.grounded = false;
    s.step(0.6);
    s.animator.die("front");
    s.step(0.3);
    s.motion.grounded = true;
    expectStaysDead(s);
  });

  it("long frames (hitches, throttled tabs) don't wrap the death clip back to standing", async () => {
    const s = await spawn();
    s.animator.die("front");
    s.step(3.2);
    // Babylon's own clock jumps far past the clip end while the game clamps its dt.
    s.frame(0.1, 900);
    s.step(2 / 60);
    expect(s.hipsHeight()).toBeLessThan(LYING);
    for (let i = 0; i < 30; i++) {
      s.frame(0.1, 1000);
      expect(s.hipsHeight()).toBeLessThan(LYING);
    }
    expectStaysDead(s, { settle: 1, dt: 1 / 20 });
  });

  it("knocked kill under uneven frames", async () => {
    const s = await knocked();
    s.animator.die("front");
    for (let i = 0; i < 120; i++) s.frame(i % 7 === 0 ? 0.1 : 1 / 60, i % 7 === 0 ? 400 : 1000 / 60);
    expectStaysDead(s, { settle: 1 });
  });

  it("a pooled body dies again after a respawn, standing and knocked", async () => {
    const s = await spawn();
    s.animator.die("back");
    s.step(5);
    s.animator.revive();
    s.step(3);
    expect(s.hipsHeight()).toBeGreaterThan(STANDING);
    s.animator.die("back");
    s.step(5);
    expect(s.hipsHeight()).toBeLessThan(LYING);
    s.animator.revive();
    s.step(3);
    s.motion.downed = true;
    s.step(4);
    s.animator.die("front");
    s.motion.downed = false;
    expectStaysDead(s);
  });

  it("remote life flicker (dead → alive for a frame → dead) settles lying", async () => {
    const s = await knocked();
    s.animator.die("front");
    s.step(3);
    s.animator.revive();
    s.step(1 / 60);
    s.animator.die("front");
    expectStaysDead(s);
  });

  it("a body first seen already dead lies down at once", async () => {
    const s = await spawn();
    s.animator.die("front", true);
    s.step(1 / 60);
    expect(s.hipsHeight()).toBeLessThan(LYING);
    expectStaysDead(s);

    const k = await knocked();
    k.animator.die("front", true);
    k.step(1 / 60);
    expect(k.hipsHeight()).toBeLessThan(LYING);
    k.dispose();
  });

  it("a revive (respawn) still stands the body back up", async () => {
    const s = await knocked();
    s.animator.die("front");
    s.step(4);
    s.motion.downed = false;
    s.animator.revive();
    s.step(3);
    expect(s.hipsHeight()).toBeGreaterThan(STANDING);
    expect(s.animator.pose).toBe("up");
  });

  it("knocked stays up on all fours and sways (holds seek in real Babylon)", async () => {
    const s = await knocked();
    const heights: number[] = [];
    for (let i = 0; i < 40; i++) {
      s.step(0.1);
      heights.push(s.hipsHeight());
    }
    for (const h of heights) expect(h).toBeGreaterThan(LYING);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.002);
  });
});
