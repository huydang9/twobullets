import { describe, expect, it } from "vitest";
import { BOT_PROFILES } from "../profiles/profiles";
import type { BotDifficulty } from "../types";
import { BotRandom, RAD_TO_DEG, wrapAngle } from "../brain/util";
import { AimModel, createAimSolution, solveAim } from "./aim";
import { FireControl } from "./fire";

const DT = 1 / 60;
const EYE = { x: 0, y: 1.65, z: 0 };

/** Median angular error (deg) to a target strafing at 3 m/s across the view at `distance`, sampled after acquisition. */
function strafeError(difficulty: BotDifficulty, distance: number, seed: number): number {
  const profile = BOT_PROFILES[difficulty];
  const aim = new AimModel();
  aim.reset(0, 0);
  const rng = new BotRandom(seed, 3, 2);
  const solution = createAimSolution();
  const errors: number[] = [];
  const feet = { x: 0, y: 0, z: distance };
  const velocity = { x: 3, y: 0, z: 0 };
  for (let tick = 0; tick < 600; tick++) {
    // Strafe back and forth every 1.5 s.
    velocity.x = Math.floor(tick / 90) % 2 === 0 ? 3 : -3;
    feet.x += velocity.x * DT;
    solveAim(EYE, feet, velocity, 1.25, "rifle", profile.aim, profile.aim.fireToleranceScale, solution);
    aim.track(1, solution, tick, DT, profile.aim, rng, 1);
    if (tick > 120) {
      // Error against where the bullet needs to go (the solved point), not the body.
      const yawErr = wrapAngle(aim.yaw - solution.yaw) * RAD_TO_DEG;
      const pitchErr = (aim.pitch - solution.pitch) * RAD_TO_DEG;
      errors.push(Math.sqrt(yawErr * yawErr + pitchErr * pitchErr));
    }
  }
  errors.sort((a, b) => a - b);
  return errors[Math.floor(errors.length / 2)]!;
}

describe("bot aim model", () => {
  it("median tracking error is ordered easy > normal > hard", () => {
    for (const distance of [30, 80]) {
      const median = (d: BotDifficulty) => {
        const samples = [1, 2, 3, 4, 5].map((seed) => strafeError(d, distance, seed)).sort((a, b) => a - b);
        return samples[2]!;
      };
      const easy = median("easy");
      const normal = median("normal");
      const hard = median("hard");
      expect(easy).toBeGreaterThan(normal);
      expect(normal).toBeGreaterThan(hard);
    }
  });

  it("recoil compensation reduces vertical drift", () => {
    const drift = (difficulty: BotDifficulty) => {
      const profile = BOT_PROFILES[difficulty];
      const aim = new AimModel();
      aim.reset(0, 0);
      const solution = createAimSolution();
      let maxRise = 0;
      for (let tick = 0; tick < 120; tick++) {
        solveAim(EYE, { x: 0, y: 0, z: 30 }, { x: 0, y: 0, z: 0 }, 1.65, null, { ...profile.aim, trackingNoiseDeg: 0, acquireErrorDeg: 0 }, 2, solution);
        aim.look(solution.yaw, solution.pitch, tick, DT, profile.aim, 1);
        // A 0.3° kick every 5 ticks for one second (a rifle spray).
        if (tick < 60 && tick % 5 === 0) aim.kick(0.3 * (Math.PI / 180), 0, tick, DT, profile.aim);
        maxRise = Math.max(maxRise, (solution.pitch - aim.pitch) * RAD_TO_DEG);
      }
      return maxRise;
    };
    const easy = drift("easy");
    const hard = drift("hard");
    expect(hard).toBeLessThan(easy * 0.7);
    expect(easy).toBeGreaterThan(0.5);
  });

  it("the turn rate is limited", () => {
    const profile = BOT_PROFILES.easy;
    const aim = new AimModel();
    aim.reset(0, 0);
    aim.look(Math.PI, 0, 0, DT, profile.aim, 1);
    expect(Math.abs(aim.yaw)).toBeLessThanOrEqual((profile.aim.maxTurnRateDeg * DT * Math.PI) / 180 + 1e-9);
  });

  it("lead and drop move the aim point for moving and far targets", () => {
    const profile = BOT_PROFILES.hard.aim;
    const still = solveAim(EYE, { x: 0, y: 0, z: 200 }, { x: 0, y: 0, z: 0 }, 1.4, "sniper", profile, 2, createAimSolution());
    const moving = solveAim(EYE, { x: 0, y: 0, z: 200 }, { x: 5, y: 0, z: 0 }, 1.4, "sniper", profile, 2, createAimSolution());
    expect(moving.point.x).toBeGreaterThan(1);
    expect(still.point.y).toBeGreaterThan(1.4 + 0.5);
  });

  it("the fire gate stays closed when blocked and taps semi weapons", () => {
    const profile = BOT_PROFILES.normal;
    const rng = new BotRandom(1, 1, 5);
    const fire = new FireControl();
    for (let tick = 0; tick < 120; tick++) {
      expect(fire.decide(tick, DT, "auto", 30, 0.1, 1, true, true, profile.aim, profile.fire, rng)).toBe(false);
    }
    const semi = new FireControl();
    const presses: boolean[] = [];
    for (let tick = 0; tick < 60; tick++) presses.push(semi.decide(tick, DT, "semi", 10, 0.1, 1, true, false, profile.aim, profile.fire, rng));
    // Never held on two consecutive ticks, first press after the first-shot delay.
    for (let i = 1; i < presses.length; i++) expect(presses[i] && presses[i - 1]).toBe(false);
    expect(presses.indexOf(true)).toBeGreaterThanOrEqual(Math.round(profile.aim.firstShotDelaySeconds / DT));
  });
});
