import { describe, expect, it } from "vitest";
import { box, createTestRaycast } from "../../equipment/testWorld";
import { PlayerActionType } from "../../input";
import type { ZoneState } from "../../match/types";
import { createMoveOptions, Motor } from "../motor/motor";
import { PerceptionState } from "../perception/perception";
import { BOT_PROFILES } from "../profiles/profiles";
import { GOALS, GoalIndex, GoalSelector } from "../goals/utility";
import { createBotBrain } from "./brain";
import { FakeNavQuery } from "./fakeNav";
import { TestWorld } from "./testWorld";
import { BotRandom } from "./util";

// Tuning round 2 behaviors: loot found by searching buildings (never by reading far ground loot), paths that never
// stall, and goal selection that doesn't hold a dead goal.

describe("building search", () => {
  it("an unarmed bot walks to a building beyond its loot scan and picks up the weapon it finds inside", () => {
    const building = { id: "house", x: 70, y: 0, z: 0, minX: 66, minZ: -4, maxX: 74, maxZ: 4 };
    const nav = new FakeNavQuery({ placements: [building] });
    // Walls hide the item until the bot is inside (an opening on the west side).
    const walls = createTestRaycast([box([66, 0, -4.2], [74, 3, -4]), box([66, 0, 4], [74, 3, 4.2]), box([74, 0, -4], [74.2, 3, 4]), box([65.8, 0, -4], [66, 3, -1.2]), box([65.8, 0, 1.2], [66, 3, 4])]);
    const world = new TestWorld({ weapons: [null, null, null], stacks: [], nav, raycast: walls });
    world.addLoot(1, "weapon_rifle", 72, 2);
    const brain = createBotBrain({ slot: world.self.slot, team: world.self.team, seed: 5, profile: BOT_PROFILES.normal });
    let pickedUp = false;
    let searched = false;
    world.run(brain, 60 * 40, {
      onTick: () => {
        if (brain.debug().subState === "to-building" || brain.debug().subState === "search-rooms") searched = true;
        if (world.out.input.action?.type === PlayerActionType.pickup && world.out.input.action.arg === 1) pickedUp = true;
      },
    });
    expect(searched).toBe(true);
    expect(pickedUp).toBe(true);
  });

  it("without buildings or items an unarmed bot doesn't hold the loot goal", () => {
    const world = new TestWorld({ weapons: [null, null, null], stacks: [] });
    const brain = createBotBrain({ slot: world.self.slot, team: world.self.team, seed: 5, profile: BOT_PROFILES.normal });
    world.run(brain, 240);
    expect(brain.debug().goal).not.toBe("loot");
  });
});

describe("motor robustness", () => {
  function motorRun(nav: FakeNavQuery, targetX: number, targetZ: number, ticks: number) {
    const world = new TestWorld({ nav });
    const motor = new Motor();
    const rng = new BotRandom(1, 2, 4);
    const options = createMoveOptions();
    const perception = new PerceptionState();
    let longestIdle = 0;
    let idle = 0;
    for (let i = 0; i < ticks; i++) {
      nav.update(1500);
      motor.beginTick();
      motor.moveTo(world.view, targetX, 0, targetZ, options);
      world.out.input.forward = 0;
      world.out.input.right = 0;
      world.out.input.buttons = 0;
      motor.output(world.view, world.out.input, 0, perception, rng, false);
      const moving = world.out.input.forward !== 0 || world.out.input.right !== 0;
      idle = moving ? 0 : idle + 1;
      longestIdle = Math.max(longestIdle, idle);
      // Kinematic step along yaw 0.
      world.self.feet.x += world.out.input.right * 6.5 / 60;
      world.self.feet.z += world.out.input.forward * 6.5 / 60;
      world.self.velocity.x = world.out.input.right * 6.5;
      world.self.velocity.z = world.out.input.forward * 6.5;
      world.tick++;
      if (motor.status === "arrived") break;
    }
    return { world, motor, longestIdle };
  }

  it("keeps moving toward the target when requests are refused (queue full)", () => {
    const nav = new FakeNavQuery({ refuse: (x, z) => Math.abs(x - 40) < 0.5 && Math.abs(z - 30) < 0.5 });
    const { world, longestIdle } = motorRun(nav, 40, 30, 60 * 20);
    expect(longestIdle).toBeLessThan(120);
    expect(Math.sqrt((world.self.feet.x - 40) ** 2 + (world.self.feet.z - 30) ** 2)).toBeLessThan(5);
  });

  it("detours when the target is unreachable instead of standing still", () => {
    const nav = new FakeNavQuery({ unreachable: (x, z) => Math.abs(x - 60) < 1 && Math.abs(z) < 1 });
    const { world, longestIdle } = motorRun(nav, 60, 0, 60 * 10);
    expect(longestIdle).toBeLessThan(120);
    expect(world.self.feet.x).toBeGreaterThan(10);
  });
});

describe("goal selection", () => {
  it("a goal whose score dropped to zero is replaced by anything positive", () => {
    const selector = new GoalSelector();
    selector.reset(0);
    selector.scores[GoalIndex.loot] = 0.6;
    selector.select(100, 1 / 60, false);
    expect(selector.goal).toBe("loot");
    selector.scores.fill(0);
    selector.scores[GoalIndex.idle] = 0.05;
    expect(selector.select(110, 1 / 60, false)).toBe(true);
    expect(selector.goal).toBe(GOALS[GoalIndex.idle]);
  });

  it("an unarmed bot loots before a non-urgent rotation", () => {
    const zone: ZoneState = { phaseIndex: 1, stage: "waiting", current: { cx: 0, cz: 0, r: 700 }, next: { cx: 300, cz: 0, r: 350 }, dps: 1, ticksToChange: 60 * 100, phase: { index: 1, waitStartTick: 0, shrinkStartTick: 6000, shrinkEndTick: 9600, from: { cx: 0, cz: 0, r: 700 }, to: { cx: 300, cz: 0, r: 350 }, dps: 1 } };
    const building = { id: "b", x: -20, y: 0, z: 0, minX: -24, minZ: -4, maxX: -16, maxZ: 4 };
    const world = new TestWorld({ weapons: [null, null, null], stacks: [], zone, nav: new FakeNavQuery({ placements: [building] }), x: -100 });
    const brain = createBotBrain({ slot: world.self.slot, team: world.self.team, seed: 2, profile: BOT_PROFILES.normal });
    world.run(brain, 120);
    expect(brain.debug().goal).toBe("loot");
  });
});
