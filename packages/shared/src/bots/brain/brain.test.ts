import { describe, expect, it } from "vitest";
import { dequantizeYaw } from "../../aim";
import { itemCode } from "../../equipment/items";
import { Btn, PlayerActionType } from "../../input";
import type { ZoneState } from "../../match/types";
import { BOT_PROFILES } from "../profiles/profiles";
import type { BotBrain, BotDifficulty } from "../types";
import { createBotBrain } from "./brain";
import { FakeNavQuery } from "./fakeNav";
import { idleBrain, wanderBrain } from "./testBrains";
import { TestWorld } from "./testWorld";
import { wrapAngle } from "./util";

function brainFor(world: TestWorld, difficulty: BotDifficulty = "normal", seed = 42): BotBrain {
  return createBotBrain({ slot: world.self.slot, team: world.self.team, seed, profile: BOT_PROFILES[difficulty] });
}

describe("bot brain fixtures", () => {
  it("unarmed bot walks to a weapon before ammo and picks it up", () => {
    const world = new TestWorld({ weapons: [null, null, null], stacks: [] });
    world.addLoot(10, "ammo_556", 3, 4, 30);
    world.addLoot(11, "weapon_rifle", 8, 10);
    const brain = brainFor(world);
    let pickup = -1;
    world.run(brain, 600, {
      onTick: () => {
        const action = world.out.input.action;
        if (pickup < 0 && action?.type === PlayerActionType.pickup) pickup = action.arg;
      },
    });
    // Captures the action from the tick before onTick of the next tick, so check the final state too.
    const last = world.out.input.action;
    if (pickup < 0 && last?.type === PlayerActionType.pickup) pickup = last.arg;
    expect(brain.debug().lootTargetId === 11 || pickup === 11).toBe(true);
    expect(pickup).toBe(11);
    const d = Math.sqrt((world.self.feet.x - 8) ** 2 + (world.self.feet.z - 10) ** 2);
    expect(d).toBeLessThan(2.6);
  });

  it("low and safe heals with the right item", () => {
    const world = new TestWorld({ health: 50, stacks: [{ itemId: "ammo_556", quantity: 60 }, { itemId: "first_aid", quantity: 1 }, { itemId: "bandage", quantity: 4 }] });
    const brain = brainFor(world);
    let used = -1;
    let healing = 0;
    world.run(brain, 400, {
      move: true,
      onTick: () => {
        const a = world.out.input.action;
        if (used < 0 && a?.type === PlayerActionType.use) used = a.arg;
        if (brain.debug().goal === "heal") {
          healing++;
          expect(world.out.input.buttons & Btn.sprint).toBe(0);
        }
      },
    });
    // The fixture never starts the use, so the brain retries and then backs off; it must have tried the right item.
    expect(healing).toBeGreaterThan(30);
    expect(used).toBe(itemCode("first_aid"));
  });

  it("low with a visible threat flees or takes cover", () => {
    const world = new TestWorld({ health: 20, stacks: [{ itemId: "ammo_556", quantity: 60 }, { itemId: "bandage", quantity: 4 }] });
    world.addActor(5, 3, 0, 25, { lastShotTick: 0 });
    const brain = brainFor(world, "normal");
    world.run(brain, 200, {
      onTick: (w) => {
        if (w.tick % 30 === 0) w.damageTaken.push({ attackerSlot: 5, direction: { x: 0, y: 0, z: -1 }, amount: 1, kind: "bullet" });
      },
    });
    expect(["flee", "cover"]).toContain(brain.debug().goal);
  });

  it("revives a downed teammate when nothing threatens", () => {
    const world = new TestWorld();
    const mate = world.addTeammate(3, 10, 0, { life: "downed", downedHealth: 60, health: 0 });
    const brain = brainFor(world);
    let held = 0;
    world.run(brain, 600, {
      onTick: () => {
        if ((world.out.input.buttons & Btn.interact) !== 0 && world.out.intents.reviveSlot === mate.slot) held++;
      },
    });
    expect(brain.debug().goal).toBe("revive");
    expect(held).toBeGreaterThan(60);
  });

  it("rotates toward the zone when outside it", () => {
    const zone: ZoneState = { phaseIndex: 1, stage: "waiting", current: { cx: 200, cz: 0, r: 100 }, next: { cx: 200, cz: 0, r: 60 }, dps: 1, ticksToChange: 600, phase: null };
    const world = new TestWorld({ zone });
    const brain = brainFor(world);
    const start = Math.abs(world.self.feet.x - 200);
    world.run(brain, 600);
    expect(brain.debug().goal).toBe("rotate");
    expect(Math.abs(world.self.feet.x - 200)).toBeLessThan(start - 40);
  });

  it("engages a visible enemy: turns to it, aims down sights and fires", () => {
    const world = new TestWorld({ yaw: 0.6 });
    world.addActor(5, 3, 0, 40);
    const brain = brainFor(world, "hard");
    let fired = 0;
    world.run(brain, 240, {
      move: false,
      onTick: () => {
        if ((world.out.input.buttons & Btn.fire) !== 0) fired++;
      },
    });
    expect(brain.debug().goal).toBe("engage");
    expect(brain.perception.threatSlot).toBe(5);
    expect(Math.abs(wrapAngle(dequantizeYaw(world.out.input.yawQ)))).toBeLessThan(0.08);
    expect(fired).toBeGreaterThan(0);
  });

  it("never fires with a teammate on the line", () => {
    const world = new TestWorld();
    world.addActor(5, 3, 0, 40);
    const mate = world.addTeammate(3, 0, 20);
    world.segmentActor = () => mate.slot;
    const brain = brainFor(world, "hard");
    let fired = 0;
    world.run(brain, 400, {
      move: false,
      onTick: () => {
        if ((world.out.input.buttons & Btn.fire) !== 0) fired++;
      },
    });
    expect(brain.debug().goal).toBe("engage");
    expect(fired).toBe(0);
  });

  it("is deterministic for the same seed and view sequence", () => {
    const trace = (seed: number) => {
      const world = new TestWorld({ weapons: [null, null, null], stacks: [] });
      world.addLoot(11, "weapon_rifle", 8, 10);
      world.addActor(5, 3, 30, 60, { velocity: { x: -1, y: 0, z: 0 } });
      const brain = brainFor(world, "normal", seed);
      const out: number[] = [];
      world.run(brain, 400, { onTick: () => out.push(world.out.input.yawQ, world.out.input.forward, world.out.input.right, world.out.input.buttons) });
      return out;
    };
    expect(trace(7)).toEqual(trace(7));
  });

  it("warmup freezes movement and fire", () => {
    const world = new TestWorld();
    world.phase = "warmup";
    world.addActor(5, 3, 0, 20);
    const brain = brainFor(world, "hard");
    world.run(brain, 120, {
      onTick: () => {
        expect(world.out.input.forward).toBe(0);
        expect(world.out.input.buttons).toBe(0);
      },
    });
  });

  it("dead bots write no input", () => {
    const world = new TestWorld();
    world.self.vitals = { ...world.self.vitals, life: "dead", health: 0 };
    const brain = brainFor(world);
    world.run(brain, 10);
    expect(world.out.input.buttons).toBe(0);
    expect(brain.debug().goal).toBe("dead");
  });
});

describe("test brains", () => {
  it("idle brain holds still", () => {
    const world = new TestWorld({ yaw: 1 });
    const brain = idleBrain({ slot: 2, team: 1, seed: 1, profile: BOT_PROFILES.normal });
    world.run(brain, 60);
    expect(world.self.feet.x).toBe(0);
    expect(dequantizeYaw(world.out.input.yawQ)).toBeCloseTo(1, 4);
  });

  it("wander brain walks between nav points", () => {
    const nav = new FakeNavQuery({ pendingUpdates: 3 });
    const world = new TestWorld({ nav });
    const brain = wanderBrain({ slot: 2, team: 1, seed: 1, profile: BOT_PROFILES.normal });
    world.run(brain, 900);
    const moved = Math.sqrt(world.self.feet.x ** 2 + world.self.feet.z ** 2);
    expect(moved).toBeGreaterThan(5);
    expect(nav.requests.length).toBeGreaterThan(1);
  });
});
