import { describe, expect, it } from "vitest";
import { createInventory } from "../../equipment/inventory";
import { weaponStateFromInventory } from "../../equipment/weaponLoadout";
import type { ZoneState } from "../../match/types";
import { BOT_PROFILES } from "../profiles/profiles";
import { chooseHeal, chooseWeaponSlot, lootNeed, type LootNeed } from "./equipment";
import { solvePitch } from "./grenade";
import { createGoalFacts, GOALS, GoalIndex, GoalSelector, scoreGoals, type ActiveGoal, type GoalFacts } from "./utility";
import { createRotatePlan, planRotate, secondsUntilEdge } from "./zone";

const normal = BOT_PROFILES.normal;

function best(facts: Partial<GoalFacts>, profile = normal): ActiveGoal {
  const scores = scoreGoals({ ...createGoalFacts(), ...facts }, profile, new Float64Array(GOALS.length));
  let top = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[top]!) top = i;
  return GOALS[top]!;
}

const need = (): LootNeed => ({ need: 0, replaceSlot: -1 });

describe("goal scoring", () => {
  it("unarmed bot prefers a weapon over ammo and a pistol-only bot wants a primary", () => {
    const unarmed = createInventory();
    const weapon = lootNeed("weapon_rifle", unarmed, "normal", 1, need()).need;
    const ammo = lootNeed("ammo_556", unarmed, "normal", 60, need()).need;
    expect(weapon).toBeGreaterThan(0.9);
    expect(ammo).toBe(0);

    const pistolOnly = createInventory({ weapons: [null, null, { weaponId: "pistol", magazine: 12 }] });
    expect(lootNeed("weapon_rifle", pistolOnly, "normal", 1, need()).need).toBeCloseTo(0.8);
    expect(lootNeed("weapon_pistol", pistolOnly, "normal", 1, need()).need).toBe(0);

    const twoPrimaries = createInventory({ weapons: [{ weaponId: "shotgun", magazine: 7 }, { weaponId: "sniper", magazine: 5 }, null] });
    const replace = lootNeed("weapon_rifle", twoPrimaries, "hard", 1, need());
    expect(replace.need).toBeGreaterThan(0);
    expect(replace.replaceSlot).toBe(0);
  });

  it("ammo need follows the carried weapon's reserve target; stacks that don't fit are worthless", () => {
    const inv = createInventory({ weapons: [{ weaponId: "rifle", magazine: 30 }, null, null], stacks: [{ itemId: "ammo_556", quantity: 75 }] });
    expect(lootNeed("ammo_556", inv, "normal", 30, need()).need).toBeCloseTo(0.5);
    expect(lootNeed("ammo_556", inv, "normal", 0, need()).need).toBe(0);
    expect(lootNeed("ammo_762", inv, "normal", 30, need()).need).toBe(0);
    expect(lootNeed("helmet_1", inv, "normal", 1, need()).need).toBeCloseTo(0.7);
  });

  it("low and safe heals; low with a visible threat flees or covers", () => {
    expect(best({ health: 40, hasHeals: true, safeSeconds: 30 })).toBe("heal");
    const underFire = best({ health: 25, hasHeals: true, safeSeconds: 0, threatVisible: true, threatInRange: true, hasAmmo: true, hasGun: true, threatDistance: 30, damagedRecently: true, coverAllowed: true });
    expect(["flee", "cover"]).toContain(underFire);
    expect(best({ health: 90, threatVisible: true, threatInRange: true, hasAmmo: true, hasGun: true, threatDistance: 30 })).toBe("engage");
  });

  it("a downed teammate with no threat is revived", () => {
    expect(best({ reviveCandidate: true, reviveDownedHealth: 80, teammateAlive: false, lootValue: 0.8 })).toBe("revive");
    // Under fire, low-risk profiles value the revive less.
    const scores = scoreGoals({ ...createGoalFacts(), reviveCandidate: true, reviveDownedHealth: 80, visibleThreats: 2 }, BOT_PROFILES.hard, new Float64Array(GOALS.length));
    expect(scores[GoalIndex.revive]!).toBeLessThan(0.5);
  });

  it("outside the next circle with too little time rotates", () => {
    const zone: ZoneState = {
      phaseIndex: 2,
      stage: "waiting",
      current: { cx: 0, cz: 0, r: 400 },
      next: { cx: 100, cz: 0, r: 150 },
      dps: 2,
      ticksToChange: 10 * 60,
      phase: { index: 2, waitStartTick: 0, shrinkStartTick: 600, shrinkEndTick: 600 + 45 * 60, from: { cx: 0, cz: 0, r: 400 }, to: { cx: 100, cz: 0, r: 150 }, dps: 2 },
    };
    const feet = { x: -350, y: 0, z: 0 };
    expect(secondsUntilEdge(zone, feet, 1 / 60)).toBeLessThan(30);
    const plan = planRotate(zone, feet, 1 / 60, normal.tactics.zoneMarginSeconds, createRotatePlan());
    expect(plan.score).toBeGreaterThan(0.85);
    expect(plan.target.x).toBeGreaterThan(-60);
    expect(best({ rotateScore: plan.score, lootValue: 0.9, teammateAlive: true, teammateDistance: 80 })).toBe("rotate");

    const inside = planRotate(zone, { x: 100, y: 0, z: 10 }, 1 / 60, 20, createRotatePlan());
    expect(inside.score).toBe(0);
    const outsideCurrent = planRotate({ ...zone, current: { cx: 0, cz: 0, r: 100 } }, feet, 1 / 60, 20, createRotatePlan());
    expect(outsideCurrent.outside).toBe(true);
    expect(outsideCurrent.score).toBe(1);
  });

  it("loot is ignored with a visible threat and halves late in the match", () => {
    const scores = scoreGoals({ ...createGoalFacts(), lootValue: 1, zonePhaseIndex: 3 }, normal, new Float64Array(GOALS.length));
    expect(scores[GoalIndex.loot]).toBeCloseTo(0.3);
    const threat = scoreGoals({ ...createGoalFacts(), lootValue: 1, threatVisible: true }, normal, new Float64Array(GOALS.length));
    expect(threat[GoalIndex.loot]).toBe(0);
  });

  it("selection keeps a goal for 1 s with hysteresis unless damage preempts", () => {
    const selector = new GoalSelector();
    selector.reset(0);
    selector.scores[GoalIndex.loot] = 0.5;
    expect(selector.select(60, 1 / 60, false)).toBe(true);
    expect(selector.goal).toBe("loot");
    selector.scores[GoalIndex.regroup] = 0.58;
    expect(selector.select(200, 1 / 60, false)).toBe(false);
    selector.scores[GoalIndex.regroup] = 0.7;
    expect(selector.select(70, 1 / 60, false)).toBe(false);
    selector.scores[GoalIndex.engage] = 0.9;
    expect(selector.select(71, 1 / 60, true)).toBe(true);
    expect(selector.goal).toBe("engage");
  });
});

describe("equipment choices", () => {
  it("picks weapons by range", () => {
    const inv = createInventory({
      weapons: [{ weaponId: "rifle", magazine: 30 }, { weaponId: "shotgun", magazine: 7 }, { weaponId: "pistol", magazine: 12 }],
      stacks: [{ itemId: "ammo_556", quantity: 30 }, { itemId: "ammo_12g", quantity: 10 }, { itemId: "ammo_9mm", quantity: 20 }],
    });
    const weapon = weaponStateFromInventory(inv, { ammoFromInventory: true });
    expect(chooseWeaponSlot(weapon, 5, normal)).toBe(1);
    expect(chooseWeaponSlot(weapon, 50, normal)).toBe(0);
    const sniperInv = createInventory({ weapons: [{ weaponId: "rifle", magazine: 30 }, { weaponId: "sniper", magazine: 5 }, null], stacks: [{ itemId: "ammo_762", quantity: 10 }] });
    const sniper = weaponStateFromInventory(sniperInv, { ammoFromInventory: true });
    expect(chooseWeaponSlot(sniper, 250, normal)).toBe(1);
    // Easy never scopes beyond 150 m: falls back to the longest gun it has.
    expect(chooseWeaponSlot(sniper, 250, BOT_PROFILES.easy)).toBe(1);
  });

  it("heal choice by health", () => {
    const inv = createInventory({ stacks: [{ itemId: "bandage", quantity: 5 }, { itemId: "first_aid", quantity: 1 }, { itemId: "medkit", quantity: 1 }] });
    expect(chooseHeal(inv, 30)).toBe("medkit");
    expect(chooseHeal(inv, 60)).toBe("first_aid");
    expect(chooseHeal(createInventory({ stacks: [{ itemId: "bandage", quantity: 5 }] }), 60)).toBe("bandage");
    expect(chooseHeal(inv, 90)).toBeNull();
  });

  it("grenade pitch solve reaches the range", () => {
    const pitch = solvePitch(25, -1.5, 19, (5 * Math.PI) / 180);
    expect(pitch).not.toBeNull();
    expect(pitch!).toBeLessThan(0.2);
    expect(solvePitch(80, 0, 19, 0)).toBeNull();
  });
});
