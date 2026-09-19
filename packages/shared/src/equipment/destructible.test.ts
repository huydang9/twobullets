import { describe, expect, it } from "vitest";
import { INSTANCE_STRIDE } from "../map/layout/scatter";
import type { PropInstanceSet } from "../map/layout/mapLayout";
import {
  buildDestructibleWalls,
  fireBurnsWalls,
  fragDestroysWalls,
  smokeRepairsWalls,
  wallAtPoint,
  wallBurnProgress,
  wallRepairProgress,
  WallChange,
  WallKind,
  WALL_DAMAGE,
} from "./destructible";
import { FIRE_CELL_STRIDE, type FirePatch } from "./fire";
import { createSmokeCloud, SMOKE, stepSmokeCloud, type SmokeCloud } from "./smoke";

const DT = 1 / 60;

function instance(x: number, z: number, yaw = 0, y = 0, scale = 1): number[] {
  const row = new Array<number>(INSTANCE_STRIDE).fill(0);
  row[0] = x;
  row[1] = y;
  row[2] = z;
  row[3] = yaw;
  row[4] = scale;
  return row;
}

/** Two mirrored panes 12 m apart on a wall running along world X, and a hedge beside the first. */
function layout(): { readonly props: readonly PropInstanceSet[] } {
  return {
    props: [
      { prop: "wall_grass", data: new Float32Array(instance(0, 6)) },
      { prop: "wall_mirror", data: new Float32Array([...instance(0, 0), ...instance(12, 0)]) },
    ],
  };
}

function clearCloud(x: number, z: number, age: number): SmokeCloud {
  const cloud = createSmokeCloud(1, { x, y: 0, z }, 7, () => null);
  return stepSmokeCloud(cloud, age);
}

function firePatchOn(x: number, z: number): FirePatch {
  const cells = new Float32Array(FIRE_CELL_STRIDE);
  cells[0] = x;
  cells[1] = 0;
  cells[2] = z;
  cells[3] = 0;
  cells[4] = 60;
  return { id: 1, owner: 0, age: 1, damageTicks: 0, cellCount: 1, cells, duration: 60 };
}

describe("destructible walls", () => {
  it("registers every mirrored pane and grass hedge, in layout order", () => {
    const walls = buildDestructibleWalls(layout());
    expect(walls.count).toBe(3);
    expect([...walls.kind]).toEqual([WallKind.hedge, WallKind.pane, WallKind.pane]);
    // wall_mirror's collider is 4 m × 0.3 m; wall_grass's footprint circle is 2 m.
    expect(walls.halfX[1]).toBeCloseTo(2);
    expect(walls.halfZ[1]).toBeCloseTo(0.15);
    expect(walls.halfX[0]).toBeCloseTo(2);
    expect(walls.indexOf(1, 1)).toBe(2);
  });

  it("a frag takes the pane it went off against and leaves the one down the corridor", () => {
    const walls = buildDestructibleWalls(layout());
    expect(fragDestroysWalls(walls, 0, 1, WALL_DAMAGE.fragRadius - 0.5)).toBe(1);
    expect(walls.destroyed[1]).toBe(1);
    expect(walls.destroyed[2]).toBe(0);
    // A hedge is not a pane: only fire takes one.
    expect(walls.destroyed[0]).toBe(0);
    expect(walls.logged).toBe(1);
    expect(walls.changeAt(0)).toBe(1 * 2 + WallChange.destroyed);
    // And destroying it twice is a no-op, which is what makes a re-sent event safe.
    expect(fragDestroysWalls(walls, 0, 1, 0)).toBe(0);
  });

  it("a frag out of reach takes nothing", () => {
    const walls = buildDestructibleWalls(layout());
    expect(fragDestroysWalls(walls, 0, 1, WALL_DAMAGE.fragRadius + 1)).toBe(0);
    expect(fragDestroysWalls(walls, 6, 1, 0)).toBe(0);
    expect(walls.logged).toBe(0);
  });

  it("finds the pane a round crossed", () => {
    const walls = buildDestructibleWalls(layout());
    expect(wallAtPoint(walls, 1, 1.5, 0.15)).toBe(1);
    expect(wallAtPoint(walls, 1, 4, 0.15)).toBe(-1);
    expect(wallAtPoint(walls, 6, 1.5, 0)).toBe(-1);
    fragDestroysWalls(walls, 0, 1, 0);
    expect(wallAtPoint(walls, 1, 1.5, 0.15)).toBe(-1);
  });

  it("smoke closes a holed pane's apertures, and only while it sits there", () => {
    const walls = buildDestructibleWalls(layout());
    walls.addHole(1);
    walls.addHole(1);
    expect(walls.holes[1]).toBe(2);

    const cloud = clearCloud(0, 0, SMOKE.growSeconds);
    const need = Math.round(WALL_DAMAGE.repairSeconds / DT);
    for (let i = 0; i < need - 1; i++) expect(smokeRepairsWalls(walls, [cloud], DT)).toBe(0);
    expect(wallRepairProgress(walls, 1, DT)).toBeGreaterThan(0.9);
    expect(smokeRepairsWalls(walls, [cloud], DT)).toBe(1);
    expect(walls.holes[1]).toBe(0);
    expect(walls.changeAt(walls.logged - 1)).toBe(1 * 2 + WallChange.repaired);

    // A cloud that drifts off takes the progress with it.
    walls.addHole(1);
    smokeRepairsWalls(walls, [cloud], DT);
    expect(walls.ticks[1]).toBe(1);
    smokeRepairsWalls(walls, [], DT);
    expect(walls.ticks[1]).toBe(0);
  });

  it("smoke never brings a destroyed pane back", () => {
    const walls = buildDestructibleWalls(layout());
    walls.addHole(1);
    fragDestroysWalls(walls, 0, 1, 0);
    const cloud = clearCloud(0, 0, SMOKE.growSeconds);
    for (let i = 0; i < Math.round(WALL_DAMAGE.repairSeconds / DT) + 10; i++) smokeRepairsWalls(walls, [cloud], DT);
    expect(walls.destroyed[1]).toBe(1);
    // One log entry: the destruction. Nothing healed.
    expect(walls.logged).toBe(1);
  });

  it("fire burns a hedge away and leaves the panes standing", () => {
    const walls = buildDestructibleWalls(layout());
    const patch = firePatchOn(0, 6);
    const need = Math.round(WALL_DAMAGE.burnSeconds / DT);
    for (let i = 0; i < need - 1; i++) expect(fireBurnsWalls(walls, [patch], DT)).toBe(0);
    expect(wallBurnProgress(walls, 0, DT)).toBeGreaterThan(0.9);
    expect(fireBurnsWalls(walls, [patch], DT)).toBe(1);
    expect(walls.destroyed[0]).toBe(1);
    expect(walls.destroyed[1]).toBe(0);
    expect(walls.destroyed[2]).toBe(0);
  });

  it("is a pure function of the state: two runs agree exactly", () => {
    const run = (): string => {
      const walls = buildDestructibleWalls(layout());
      walls.addHole(1);
      walls.addHole(2);
      const cloud = clearCloud(12, 0, SMOKE.growSeconds);
      const patch = firePatchOn(0.5, 6.5);
      const log: number[] = [];
      for (let tick = 0; tick < 600; tick++) {
        if (tick === 100) fragDestroysWalls(walls, 0, 1, 1);
        smokeRepairsWalls(walls, [stepSmokeCloud(cloud, tick * DT)], DT);
        fireBurnsWalls(walls, [patch], DT);
        for (let s = log.length; s < walls.logged; s++) log.push(tick, walls.changeAt(s));
      }
      return log.join(",");
    };
    const a = run();
    expect(run()).toBe(a);
    expect(a.length).toBeGreaterThan(0);
  });
});
