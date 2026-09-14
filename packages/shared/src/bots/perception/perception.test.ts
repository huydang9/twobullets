import { describe, expect, it } from "vitest";
import { box, createTestRaycast } from "../../equipment/testWorld";
import { createSmokeCloud, SMOKE, stepSmokeCloud } from "../../equipment/smoke";
import { BotMemoryState } from "../memory/memory";
import { BOT_PROFILES } from "../profiles/profiles";
import { BOT_SCHEDULE } from "../types";
import { TestWorld } from "../brain/testWorld";
import { BotRandom } from "../brain/util";
import { PerceptionState } from "./perception";

const normal = BOT_PROFILES.normal.perception;

function setup(world: TestWorld) {
  const perception = new PerceptionState();
  const memory = new BotMemoryState();
  const rng = new BotRandom(1, world.self.slot, 1);
  /** Runs one second of ticks with perception updates every `perceptionTicks`, looking along `yaw`. */
  const run = (ticks: number, yaw = 0) => {
    for (let i = 0; i < ticks; i++) {
      perception.tickAlways(world.view, normal, memory, rng, yaw);
      if (world.tick % BOT_SCHEDULE.perceptionTicks === 0) perception.update(world.view, normal, memory, rng, yaw);
      world.noises.length = 0;
      world.damageTaken.length = 0;
      world.tick++;
    }
  };
  return { perception, memory, run };
}

describe("bot perception", () => {
  it("spots a standing enemy in the open and reacts only after the reaction time", () => {
    const world = new TestWorld();
    world.addActor(5, 3, 0, 30, { velocity: { x: 0, y: 0, z: 0 } });
    const { perception, memory, run } = setup(world);
    run(1);
    const track = perception.track(5)!;
    expect(track.visible).toBe(true);
    expect(track.awareness).toBeLessThan(1);
    expect(perception.threatSlot).toBe(-1);
    run(120);
    expect(track.awareness).toBe(1);
    expect(track.reactTick).toBeGreaterThan(0);
    expect(perception.threatSlot).toBe(5);
    expect(memory.find(5)?.source).toBe("seen");
  });

  it("does not see through walls, behind itself, or while blind", () => {
    const wall = createTestRaycast([box([-5, 0, 10], [5, 4, 11])]);
    const world = new TestWorld({ raycast: wall });
    world.addActor(5, 3, 0, 30);
    world.addActor(7, 4, 0, -30);
    const { perception, memory, run } = setup(world);
    run(300);
    expect(perception.track(5)!.visible).toBe(false);
    expect(perception.track(7)!.visible).toBe(false);
    expect(perception.track(5)!.awareness).toBe(0);
    expect(memory.count).toBe(0);
    expect(perception.threatSlot).toBe(-1);

    const blindWorld = new TestWorld();
    blindWorld.addActor(5, 3, 0, 20);
    blindWorld.self.vitals = { ...blindWorld.self.vitals, blindSeconds: 3 };
    const blind = setup(blindWorld);
    blind.run(120);
    expect(blind.perception.blind).toBe(true);
    expect(blind.perception.track(5)!.visible).toBe(false);
  });

  it("senses an enemy behind it inside the proximity radius", () => {
    const world = new TestWorld();
    world.addActor(5, 3, 0, -3);
    const { perception, run } = setup(world);
    run(60);
    expect(perception.track(5)!.visible).toBe(true);
  });

  it("smoke blocks sight", () => {
    const world = new TestWorld();
    world.addActor(5, 3, 0, 30);
    let cloud = createSmokeCloud(1, { x: 0, y: 0, z: 15 }, 99, () => null);
    for (let i = 0; i < 60 * (SMOKE.growSeconds + 1); i++) cloud = stepSmokeCloud(cloud, 1 / 60);
    world.smokes.push(cloud);
    const { perception, run } = setup(world);
    run(180);
    expect(perception.track(5)!.visible).toBe(false);
  });

  it("hearing adds a noisy memory entry; deafness ignores noises", () => {
    const world = new TestWorld();
    const { perception, memory, run } = setup(world);
    world.noises.push({ kind: "shot", sourceSlot: 6, position: { x: 100, y: 0, z: 100 }, radius: 800, weaponId: "rifle" });
    run(1);
    const entry = memory.find(6)!;
    expect(entry.source).toBe("heard");
    expect(entry.hostile).toBe(true);
    const error = Math.sqrt((entry.position.x - 100) ** 2 + (entry.position.z - 100) ** 2);
    expect(error).toBeGreaterThan(0);
    expect(error).toBeLessThan(0.15 * 141 * 5);
    expect(perception.track(6)!.visible).toBe(false);

    const deafWorld = new TestWorld();
    deafWorld.self.vitals = { ...deafWorld.self.vitals, deafSeconds: 3 };
    const deaf = setup(deafWorld);
    deafWorld.noises.push({ kind: "shot", sourceSlot: 6, position: { x: 10, y: 0, z: 10 }, radius: 800, weaponId: "rifle" });
    deaf.run(1);
    expect(deaf.memory.find(6)).toBeNull();
  });

  it("noises from teammates and beyond hearing range are ignored", () => {
    const world = new TestWorld();
    world.addTeammate(3, 5, 5);
    const { memory, run } = setup(world);
    world.noises.push({ kind: "shot", sourceSlot: 3, position: { x: 5, y: 0, z: 5 }, radius: 800, weaponId: "rifle" });
    world.noises.push({ kind: "footstep", sourceSlot: 8, position: { x: 50, y: 0, z: 0 }, radius: 20, weaponId: null });
    run(1);
    expect(memory.find(3)).toBeNull();
    expect(memory.find(8)).toBeNull();
  });

  it("damage points back at the attacker and remembers the direction", () => {
    const world = new TestWorld();
    const { perception, memory, run } = setup(world);
    // Bullet travelling toward -X: the attacker is on +X.
    world.damageTaken.push({ attackerSlot: 9, direction: { x: -1, y: 0, z: 0 }, amount: 20, kind: "bullet" });
    run(1);
    expect(perception.lastDamageTick).toBe(0);
    expect(perception.lastDamageFrom.x).toBeGreaterThan(0.95);
    const entry = memory.find(9)!;
    expect(entry.source).toBe("damage");
    expect(entry.position.x).toBeGreaterThan(15);
  });

  it("ray-tests at most maxLosCandidates actors per update, nearest first", () => {
    const stats = { calls: 0 };
    const world = new TestWorld({ raycast: createTestRaycast([box([-50, 0, 5], [50, 10, 6])], stats) });
    for (let i = 0; i < 9; i++) world.addActor(3 + i, 5 + i, i * 3 - 12, 20 + i);
    const { run } = setup(world);
    run(1);
    // Every candidate is behind the wall: both rays per candidate, 6 candidates.
    expect(stats.calls).toBe(BOT_SCHEDULE.maxLosCandidates * 2);
  });
});
