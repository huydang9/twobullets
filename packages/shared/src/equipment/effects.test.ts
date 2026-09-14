import { describe, expect, it } from "vitest";
import type { Vec3 } from "../movement/types";
import { createEquipmentWorld, spawnRelease, stepEquipmentWorld, type EquipmentWorldEvent, type WorldEntity } from "./equipmentStep";
import { blastOrigin, computeExplosionHits, EXPLOSION, explosionFalloff, type EntitySample } from "./explosion";
import { burningCellCount, createFirePatch, FIRE, FIRE_CELL_STRIDE, fireDamageTargets, isFireExpired, stepFirePatch, type FirePatch } from "./fire";
import { FLASH, flashExposure } from "./flash";
import { len2 } from "./math";
import { createSmokeCloud, isSmokeExpired, SMOKE, SMOKE_PUFF_STRIDE, smokeBlocksSight, smokeDensity, smokePuffs, smokeRadius, smokeTransmittance, stepSmokeCloud, type SmokeCloud } from "./smoke";
import { box, createTestRaycast, GROUND, type TestShape } from "./testWorld";

const DT = 1 / 60;
const flat = createTestRaycast([GROUND]);
const entity = (id: number, x: number, z: number, posture: EntitySample["posture"] = "stand", y = 0): EntitySample => ({ id, team: id, feet: { x, y, z }, posture });

describe("explosion damage", () => {
  const frag = EXPLOSION.frag;

  it("falls off linearly from the inner to the outer radius", () => {
    expect(explosionFalloff(frag, 0)).toBe(1);
    expect(explosionFalloff(frag, frag.innerRadius)).toBe(1);
    expect(explosionFalloff(frag, (frag.innerRadius + frag.outerRadius) / 2)).toBeCloseTo(0.5, 9);
    expect(explosionFalloff(frag, frag.outerRadius)).toBe(0);
    expect(explosionFalloff(frag, 50)).toBe(0);
  });

  it("damages fully exposed targets by distance and ignores targets out of range", () => {
    const origin = blastOrigin({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const hits = computeExplosionHits(origin, frag, [entity(1, 0.5, 0), entity(2, 5, 0), entity(3, 9.5, 0), entity(4, 30, 0)], flat);
    expect(hits.map((h) => h.targetId)).toEqual([1, 2]);
    expect(hits[0]!.amount).toBeGreaterThan(125);
    expect(hits[0]!.exposure).toBeGreaterThan(0.9);
    expect(hits[1]!.amount).toBeGreaterThan(40);
    expect(hits[1]!.amount).toBeLessThan(hits[0]!.amount);
  });

  it("is blocked by a wall and partially blocked by low cover", () => {
    const wall = box([2, 0, -3], [2.3, 3, 3]);
    const lowWall = box([-2.3, 0, -3], [-2, 1, 3]);
    const raycast = createTestRaycast([GROUND, wall, lowWall]);
    const origin = blastOrigin({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
    const targets = [entity(1, 3.5, 0), entity(2, -3.5, 0), entity(3, 0, 3.5)];
    const hits = new Map(computeExplosionHits(origin, frag, targets, raycast).map((h) => [h.targetId, h]));
    expect(hits.has(1)).toBe(false);
    expect(hits.get(2)!.exposure).toBeGreaterThan(0);
    expect(hits.get(2)!.amount).toBeLessThan(hits.get(3)!.amount * 0.6);
    // Crouching behind the low wall hides the head too.
    const crouched = computeExplosionHits(origin, frag, [entity(2, -3.5, 0, "crouch")], raycast);
    expect(crouched).toEqual([]);
  });

  it("samples lower points for downed targets", () => {
    const origin = { x: 0, y: 1.2, z: 0 };
    const low = box([1, 0, -2], [1.2, 0.8, 2]);
    const raycast = createTestRaycast([GROUND, low]);
    expect(computeExplosionHits(origin, frag, [entity(1, 1.8, 0, "downed")], raycast)).toEqual([]);
    expect(computeExplosionHits(origin, frag, [entity(1, 1.8, 0, "stand")], raycast)).toHaveLength(1);
  });
});

describe("smoke", () => {
  it("grows, holds and fades over its lifetime", () => {
    expect(smokeRadius(0)).toBe(0);
    expect(smokeRadius(SMOKE.growSeconds)).toBeCloseTo(SMOKE.radius, 9);
    expect(smokeRadius(SMOKE.growSeconds / 2)).toBeGreaterThan(SMOKE.radius / 2);
    expect(smokeDensity(0)).toBe(0);
    expect(smokeDensity(20)).toBe(1);
    expect(smokeDensity(SMOKE.lifetime - SMOKE.fadeSeconds / 2)).toBeCloseTo(0.5, 9);
    expect(smokeDensity(SMOKE.lifetime)).toBe(0);

    let cloud = createSmokeCloud(1, { x: 0, y: 0, z: 0 }, 42, flat);
    for (let t = 0; t < (SMOKE.lifetime - 0.1) * 60; t++) cloud = stepSmokeCloud(cloud, DT);
    expect(isSmokeExpired(cloud)).toBe(false);
    for (let t = 0; t < 12; t++) cloud = stepSmokeCloud(cloud, DT);
    expect(isSmokeExpired(cloud)).toBe(true);
  });

  const at = (cloud: SmokeCloud, age: number): SmokeCloud => ({ ...cloud, age });

  it("blocks sight through the cloud once grown, never beside it or after it fades", () => {
    const cloud = createSmokeCloud(1, { x: 0, y: 0, z: 0 }, 7, flat);
    const through = [{ x: -15, y: 1.6, z: 0 }, { x: 15, y: 1.6, z: 0 }] as const;
    const beside = [{ x: -15, y: 1.6, z: 14 }, { x: 15, y: 1.6, z: 14 }] as const;
    expect(smokeBlocksSight([at(cloud, 0.1)], ...through)).toBe(false);
    expect(smokeBlocksSight([at(cloud, 10)], ...through)).toBe(true);
    expect(smokeBlocksSight([at(cloud, 10)], ...beside)).toBe(false);
    expect(smokeTransmittance([at(cloud, SMOKE.lifetime - 0.05)], ...through)).toBeGreaterThan(0.5);
    expect(smokeBlocksSight([], ...through)).toBe(false);
  });

  it("is seeded: the same seed gives the same puffs, another seed differs", () => {
    const a = new Float32Array(SMOKE.puffCount * SMOKE_PUFF_STRIDE);
    const b = new Float32Array(a.length);
    const c = new Float32Array(a.length);
    smokePuffs(at(createSmokeCloud(1, { x: 3, y: 0, z: 3 }, 99, flat), 12), a);
    smokePuffs(at(createSmokeCloud(2, { x: 3, y: 0, z: 3 }, 99, flat), 12), b);
    smokePuffs(at(createSmokeCloud(3, { x: 3, y: 0, z: 3 }, 100, flat), 12), c);
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(Array.from(c)).not.toEqual(Array.from(a));
  });

  it("keeps puff centers on the open side of a nearby wall and drifts slowly", () => {
    const raycast = createTestRaycast([GROUND, box([1.5, 0, -10], [1.8, 4, 10])]);
    const cloud = at(createSmokeCloud(1, { x: 0, y: 0, z: 0 }, 5, raycast), 10);
    const puffs = new Float32Array(SMOKE.puffCount * SMOKE_PUFF_STRIDE);
    const count = smokePuffs(cloud, puffs);
    for (let k = 0; k < count; k++) expect(puffs[k * SMOKE_PUFF_STRIDE]!).toBeLessThan(1.5 + cloud.driftX * cloud.age + 1e-6);
    expect(Math.abs(len2(cloud.driftX, cloud.driftZ))).toBeLessThanOrEqual(SMOKE.driftSpeed[1]);
  });
});

describe("fire", () => {
  function burn(patch: FirePatch, seconds: number, entities: EntitySample[]) {
    const damage: { age: number; ids: number[] }[] = [];
    for (let t = 0; t < Math.round(seconds * 60); t++) {
      const step = stepFirePatch(patch, DT);
      patch = step.patch;
      if (step.damageTick) damage.push({ age: patch.age, ids: fireDamageTargets(patch, entities) });
    }
    return { patch, damage };
  }

  const cells = (patch: FirePatch): Vec3[] =>
    Array.from({ length: patch.cellCount }, (_, k) => ({ x: patch.cells[k * FIRE_CELL_STRIDE]!, y: patch.cells[k * FIRE_CELL_STRIDE + 1]!, z: patch.cells[k * FIRE_CELL_STRIDE + 2]! }));

  it("spreads over flat ground within its budget, burns ~10 s and expires", () => {
    const patch = createFirePatch(1, 0, { x: 0.2, y: 0.04, z: -0.3 }, { x: 0, y: 1, z: 0 }, 11, flat)!;
    expect(patch.cellCount).toBeGreaterThanOrEqual(25);
    expect(patch.cellCount).toBeLessThanOrEqual(FIRE.maxCells);
    for (const c of cells(patch)) expect(len2(c.x - 0.2, c.z + 0.3)).toBeLessThanOrEqual(FIRE.spreadBudget + 1e-6);
    expect(patch.duration).toBeGreaterThan(FIRE.lifetime - 2);
    expect(patch.duration).toBeLessThan(FIRE.lifetime + 2);

    const { patch: done } = burn(patch, patch.duration + 0.1, []);
    expect(isFireExpired(done)).toBe(true);
    expect(burningCellCount(done)).toBe(0);
    expect(burningCellCount(burn(patch, 1, []).patch)).toBe(patch.cellCount);
  });

  it("is stopped by walls and ledges", () => {
    const shapes: TestShape[] = [GROUND, box([1.4, 0, -10], [1.6, 2, 10]), box([-10, 0, -10], [-1.5, 0.9, 10])];
    const patch = createFirePatch(1, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 3, createTestRaycast(shapes))!;
    for (const c of cells(patch)) {
      expect(c.x).toBeLessThan(1.4);
      expect(c.x).toBeGreaterThan(-1.5);
      expect(c.y).toBeCloseTo(0, 6);
    }
  });

  it("runs further downhill than uphill", () => {
    const a = (20 * Math.PI) / 180;
    const slope = createTestRaycast([{ kind: "plane", normal: { x: -Math.sin(a), y: Math.cos(a), z: 0 }, point: { x: 0, y: 0, z: 0 } }]);
    const patch = createFirePatch(1, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 3, slope)!;
    const xs = cells(patch).map((c) => c.x);
    expect(-Math.min(...xs)).toBeGreaterThan(Math.max(...xs));
  });

  it("needs ground under the impact, and pulls wall hits back to the floor", () => {
    expect(createFirePatch(1, 0, { x: 0, y: 50, z: 0 }, { x: 0, y: 1, z: 0 }, 3, flat)).toBeNull();
    const raycast = createTestRaycast([GROUND, box([2, 0, -5], [2.3, 3, 5])]);
    const patch = createFirePatch(1, 0, { x: 1.96, y: 1.2, z: 0 }, { x: -1, y: 0, z: 0 }, 3, raycast)!;
    expect(cells(patch)[0]!.y).toBeCloseTo(0, 6);
    for (const c of cells(patch)) expect(c.x).toBeLessThan(2);
  });

  it("ticks 5 damage every 0.5 s to entities standing in burning cells", () => {
    const patch = createFirePatch(1, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 3, flat)!;
    const { damage } = burn(patch, 2, [entity(1, 0.3, 0.2), entity(2, 8, 0), entity(3, 0, 0, "stand", 3)]);
    expect(damage.map((d) => d.age)).toHaveLength(4);
    expect(damage.every((d) => d.ids.length === 1 && d.ids[0] === 1)).toBe(true);
  });
});

describe("flashbang exposure", () => {
  const eye = { x: 0, y: 1.6, z: 0 };
  const forward = { x: 0, y: 0, z: 1 };

  it("fully blinds when looking at a close flash", () => {
    const e = flashExposure(eye, forward, { x: 0, y: 1.6, z: 5 }, false);
    expect(e.blind).toBe(1);
    expect(e.blindSeconds).toBe(FLASH.maxBlindSeconds);
    expect(e.deafSeconds).toBe(FLASH.maxDeafSeconds);
  });

  it("weakens with view angle; ringing ignores it", () => {
    const flash = (angleDegrees: number) => {
      const a = (angleDegrees * Math.PI) / 180;
      return flashExposure(eye, forward, { x: Math.sin(a) * 5, y: 1.6, z: Math.cos(a) * 5 }, false);
    };
    const angles = [0, 30, 60, 90, 135, 180].map(flash);
    for (let i = 1; i < angles.length; i++) expect(angles[i]!.blind).toBeLessThanOrEqual(angles[i - 1]!.blind);
    expect(angles[0]!.blind).toBeGreaterThan(0.85);
    expect(angles[3]!.blind).toBeGreaterThan(0.2);
    expect(angles[3]!.blind).toBeLessThan(0.7);
    expect(angles[5]!.blind).toBeLessThan(0.1);
    expect(new Set(angles.map((a) => a.deaf)).size).toBe(1);
  });

  it("blinds through nothing but still rings behind a wall, and floors close flashes", () => {
    const blocked = flashExposure(eye, forward, { x: 0, y: 1.6, z: 5 }, true);
    expect(blocked.blind).toBe(0);
    expect(blocked.deaf).toBeCloseTo(FLASH.occludedDeaf, 9);
    expect(flashExposure(eye, forward, { x: 0, y: 1.6, z: -2 }, false).blind).toBeGreaterThanOrEqual(FLASH.closeMinimumView);
    expect(flashExposure(eye, forward, { x: 0, y: 1.6, z: 30 }, false).blind).toBe(0);
  });
});

describe("equipment world", () => {
  const worldEntity = (id: number, x: number, z: number, viewDir: Vec3 = { x: 0, y: 0, z: -1 }): WorldEntity => ({
    ...entity(id, x, z),
    eye: { x, y: 1.65, z },
    viewDir,
  });

  function run(seconds: number, raycast = flat, entities: WorldEntity[], setup: (world: ReturnType<typeof createEquipmentWorld>) => void) {
    const world = createEquipmentWorld(1234);
    setup(world);
    const events: { tick: number; event: EquipmentWorldEvent }[] = [];
    const scratch: EquipmentWorldEvent[] = [];
    for (let t = 0; t < Math.round(seconds * 60); t++) {
      scratch.length = 0;
      stepEquipmentWorld(world, DT, raycast, entities, scratch);
      events.push(...scratch.map((event) => ({ tick: t, event })));
    }
    return { world, events };
  }

  const drop = (kind: "frag" | "smoke" | "flash" | "molotov", x: number, z: number, fuse: number) => (world: ReturnType<typeof createEquipmentWorld>) =>
    spawnRelease(world, { kind, throwCounter: 0, eye: { x, y: 1, z }, hand: { x, y: 1, z }, velocity: { x: 0, y: -3, z: 0 }, fuse, style: "dropped", cooked: false }, 0, 0, flat);

  it("detonates a frag into damage requests for everyone exposed, including its owner", () => {
    const { events } = run(3, flat, [worldEntity(0, 0.5, 0), worldEntity(5, 4, 0), worldEntity(6, 40, 0)], drop("frag", 0, 0, 2));
    const damage = events.flatMap((e) => (e.event.type === "damage" ? [e.event.request] : []));
    expect(damage.map((d) => d.targetId).sort()).toEqual([0, 5]);
    expect(damage.every((d) => d.kind === "explosion" && d.sourceId === 0)).toBe(true);
    expect(events.find((e) => e.event.type === "detonate")!.tick).toBe(119);
  });

  it("spawns and expires a smoke cloud", () => {
    const { events, world } = run(SMOKE.lifetime + 3, flat, [], drop("smoke", 0, 0, 2));
    const types = events.map((e) => e.event.type);
    expect(types.filter((t) => t === "smokeSpawned")).toHaveLength(1);
    expect(types.filter((t) => t === "smokeExpired")).toHaveLength(1);
    const spawned = events.find((e) => e.event.type === "smokeSpawned")!.tick;
    const expired = events.find((e) => e.event.type === "smokeExpired")!.tick;
    expect((expired - spawned) / 60).toBeCloseTo(SMOKE.lifetime, 1);
    expect(world.smokes).toHaveLength(0);
  });

  it("flashes viewers by facing and cover", () => {
    const raycast = createTestRaycast([GROUND, box([-5, 0, -8], [5, 4, -7.7])]);
    const facing = worldEntity(1, 0, 4, { x: 0, y: 0, z: -1 });
    const away = worldEntity(2, 0, -4, { x: 0, y: 0, z: -1 });
    const covered = worldEntity(3, 0, -10, { x: 0, y: 0, z: 1 });
    const { events } = run(3, raycast, [facing, away, covered], drop("flash", 0, 0, 2));
    const flashed = new Map(events.flatMap((e) => (e.event.type === "flashed" ? [[e.event.targetId, e.event.exposure] as const] : [])));
    expect(flashed.get(1)!.blind).toBeGreaterThan(0.8);
    expect(flashed.get(2)!.blind).toBeLessThan(0.2);
    expect(flashed.get(3)!.blind).toBe(0);
    expect(flashed.get(3)!.deaf).toBeGreaterThan(0);
  });

  it("turns a molotov into a fire patch that burns whoever stands in it", () => {
    const { events, world } = run(3, flat, [worldEntity(1, 0.5, 0), worldEntity(2, 9, 0)], drop("molotov", 0, 0, 4));
    expect(events.some((e) => e.event.type === "fireSpawned")).toBe(true);
    const burns = events.flatMap((e) => (e.event.type === "damage" ? [e.event.request] : []));
    expect(burns.length).toBeGreaterThanOrEqual(4);
    expect(burns.every((b) => b.targetId === 1 && b.kind === "fire" && b.amount === FIRE.damagePerTick)).toBe(true);
    expect(world.fires).toHaveLength(1);
  });
});
