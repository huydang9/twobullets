import { describe, expect, it } from "vitest";
import type { Vec3 } from "../movement/types";
import { ITEMS, type ThrowableKind } from "./items";
import { len3 } from "./math";
import { box, createTestRaycast, GROUND } from "./testWorld";
import {
  createThrowableSet,
  predictThrowArc,
  resolveThrowOrigin,
  snapshotThrowables,
  spawnThrowable,
  stepThrowables,
  THROWABLE_PHYSICS,
  throwId,
  type ThrowableSet,
  type ThrowableSimEvent,
} from "./throwables";

const DT = 1 / 60;

function simulate(set: ThrowableSet, raycast: ReturnType<typeof createTestRaycast>, ticks: number) {
  const events: { tick: number; event: ThrowableSimEvent }[] = [];
  const scratch: ThrowableSimEvent[] = [];
  const path: Vec3[] = [];
  for (let t = 0; t < ticks; t++) {
    scratch.length = 0;
    stepThrowables(set, DT, raycast, scratch);
    events.push(...scratch.map((event) => ({ tick: t, event })));
    if (set.count > 0) path.push({ x: set.position[0]!, y: set.position[1]!, z: set.position[2]! });
  }
  return { events, path };
}

function spawnOne(kind: ThrowableKind, position: Vec3, velocity: Vec3, fuse: number = ITEMS[kind].fuseSeconds, set = createThrowableSet(4)) {
  spawnThrowable(set, { id: 1, owner: 0, kind, position, velocity, fuse });
  return set;
}

describe("throwable flight", () => {
  const wall = box([5, 0, -5], [5.3, 3, 5]);
  const world = createTestRaycast([GROUND, wall]);

  it("is bitwise deterministic", () => {
    const a = spawnOne("frag", { x: 0, y: 1.5, z: 0 }, { x: 14, y: 5, z: 1.3 });
    const b = spawnOne("frag", { x: 0, y: 1.5, z: 0 }, { x: 14, y: 5, z: 1.3 });
    const ra = simulate(a, world, 200);
    const rb = simulate(b, world, 200);
    expect(rb.path).toEqual(ra.path);
    expect(rb.events).toEqual(ra.events);
    expect(Array.from(b.position)).toEqual(Array.from(a.position));
  });

  it("bounces off a wall with restitution and friction, never passing it", () => {
    const set = spawnOne("frag", { x: 0, y: 1.5, z: 0 }, { x: 15, y: 1, z: 0 });
    const { events, path } = simulate(set, world, 120);
    const bounce = events.find((e) => e.event.type === "bounce")!.event;
    if (bounce.type !== "bounce") throw new Error("no bounce");
    expect(bounce.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(bounce.position.x).toBeCloseTo(5 - THROWABLE_PHYSICS.skin, 6);
    expect(path.every((p) => p.x < 5)).toBe(true);
    // Coming back at restitution × the incoming normal speed.
    const after = path[path.findIndex((p) => p.x >= bounce.position.x - 1e-9) + 1] ?? path.at(-1)!;
    expect(after.x).toBeLessThan(bounce.position.x);
    expect(snapshotThrowables(set)[0]!.bounces).toBeGreaterThanOrEqual(2);
  });

  it("doesn't tunnel through thin walls at speed", () => {
    const thin = createTestRaycast([GROUND, box([3, 0, -2], [3.05, 3, 2])]);
    const { path } = simulate(spawnOne("flash", { x: 0, y: 1.5, z: 0 }, { x: 40, y: 0, z: 0 }), thin, 60);
    expect(path.every((p) => p.x < 3)).toBe(true);
  });

  it("rolls to rest on flat ground and detonates when the fuse runs out", () => {
    const set = spawnOne("frag", { x: 0, y: 1.5, z: 0 }, { x: 6, y: 2, z: 0 });
    const { events } = simulate(set, createTestRaycast([GROUND]), 400);
    const types = events.map((e) => e.event.type);
    expect(types).toContain("rest");
    expect(types.indexOf("rest")).toBeLessThan(types.indexOf("detonate"));
    const detonate = events.find((e) => e.event.type === "detonate")!;
    expect(detonate.tick).toBe(ITEMS.frag.fuseSeconds * 60 - 1);
    if (detonate.event.type !== "detonate") throw new Error();
    expect(detonate.event.reason).toBe("fuse");
    expect(detonate.event.position.y).toBeCloseTo(THROWABLE_PHYSICS.skin, 6);
    expect(set.count).toBe(0);
  });

  it("stops on gentle slopes and rolls down steep ones", () => {
    const slope = (degrees: number) => {
      const a = (degrees * Math.PI) / 180;
      return createTestRaycast([{ kind: "plane", normal: { x: -Math.sin(a), y: Math.cos(a), z: 0 }, point: { x: 0, y: 0, z: 0 } }]);
    };
    const gentle = spawnOne("smoke", { x: 0, y: 0.5, z: 0 }, { x: 0, y: -1, z: 0 }, 30);
    const gentleRun = simulate(gentle, slope(15), 600);
    expect(gentleRun.events.some((e) => e.event.type === "rest")).toBe(true);
    expect(Math.abs(gentle.position[0]!)).toBeLessThan(0.5);

    const steep = spawnOne("smoke", { x: 0, y: 0.5, z: 0 }, { x: 0, y: -1, z: 0 }, 30);
    simulate(steep, slope(40), 120);
    expect(steep.position[0]!).toBeLessThan(-2);
  });

  it("shatters a molotov on its first real impact", () => {
    const set = spawnOne("molotov", { x: 0, y: 1.5, z: 0 }, { x: 15, y: 1, z: 0 });
    const { events } = simulate(set, world, 120);
    expect(events.map((e) => e.event.type)).toEqual(["detonate"]);
    const { event } = events[0]!;
    if (event.type !== "detonate") throw new Error();
    expect(event).toMatchObject({ reason: "impact", normal: { x: -1, y: 0, z: 0 } });
  });

  it("detonates a molotov in the air after its max flight time", () => {
    const set = spawnOne("molotov", { x: 0, y: 100, z: 0 }, { x: 0, y: 30, z: 0 });
    const { events } = simulate(set, createTestRaycast([]), 400);
    expect(events).toHaveLength(1);
    expect(events[0]!.tick).toBe(ITEMS.molotov.fuseSeconds * 60 - 1);
  });

  it("keeps independent items in one set and swap-removes detonated ones", () => {
    const set = createThrowableSet(8);
    spawnThrowable(set, { id: throwId(1, 5), owner: 1, kind: "smoke", position: { x: 0, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, fuse: 0.5 });
    spawnThrowable(set, { id: throwId(2, 9), owner: 2, kind: "frag", position: { x: 10, y: 1, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, fuse: 3 });
    const { events } = simulate(set, createTestRaycast([GROUND]), 60);
    expect(events.filter((e) => e.event.type === "detonate").map((e) => e.event.id)).toEqual([throwId(1, 5)]);
    expect(snapshotThrowables(set)).toMatchObject([{ id: throwId(2, 9), owner: 2, kind: "frag", resting: true }]);
  });
});

describe("arc prediction", () => {
  it("ends exactly where the real flight first touches the world", () => {
    const world = createTestRaycast([GROUND, box([12, 0, -5], [13, 4, 5])]);
    const spawn = { kind: "frag" as const, position: { x: 0, y: 1.6, z: 0 }, velocity: { x: 12, y: 6, z: 0.5 }, fuse: 4.5 };
    const out = new Float32Array(3 * 64);
    const arc = predictThrowArc(spawn, world, out);
    expect(arc.reason).toBe("contact");

    const set = spawnOne(spawn.kind, spawn.position, spawn.velocity);
    const firstContact = simulate(set, world, 300).events.find((e) => e.event.type === "bounce")!.event;
    if (firstContact.type !== "bounce") throw new Error();
    expect(arc.end).toEqual(firstContact.position);
    expect(arc.count).toBeGreaterThan(3);
    expect([out[(arc.count - 1) * 3], out[(arc.count - 1) * 3 + 1], out[(arc.count - 1) * 3 + 2]]).toEqual([
      Math.fround(arc.end.x),
      Math.fround(arc.end.y),
      Math.fround(arc.end.z),
    ]);
    expect([out[0], out[1], out[2]]).toEqual([0, Math.fround(1.6), 0]);
  });

  it("follows the full flight when asked and never overruns the buffer", () => {
    const world = createTestRaycast([GROUND]);
    const out = new Float32Array(3 * 8);
    const arc = predictThrowArc({ kind: "frag", position: { x: 0, y: 1.6, z: 0 }, velocity: { x: 10, y: 5, z: 0 }, fuse: 4.5 }, world, out, { stopAtFirstContact: false });
    expect(arc.count).toBe(8);
    expect(["rest", "detonate"]).toContain(arc.reason);
  });
});

describe("throw origin", () => {
  it("pulls the hand back from a wall in front of the eye", () => {
    const world = createTestRaycast([box([0.2, 0, -1], [0.6, 3, 1])]);
    const eye = { x: 0, y: 1.6, z: 0 };
    const hand = resolveThrowOrigin(eye, { x: 0.35, y: 1.55, z: 0.1 }, world);
    expect(hand.x).toBeLessThan(0.2);
    expect(len3(hand.x - eye.x, hand.y - eye.y, hand.z - eye.z)).toBeLessThan(0.2);
    expect(resolveThrowOrigin(eye, { x: -0.3, y: 1.6, z: 0 }, world)).toEqual({ x: -0.3, y: 1.6, z: 0 });
  });
});
