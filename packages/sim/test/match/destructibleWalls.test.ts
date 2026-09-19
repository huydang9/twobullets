import { asNavGridData, PASSABLE } from "@twobullets/shared/bots/nav/navGrid";
import { NavFlag, type NavPath } from "@twobullets/shared/bots/types";
import { WallKind } from "@twobullets/shared/equipment/destructible";
import { spawnThrowable } from "@twobullets/shared/equipment/throwables";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { beforeAll, describe, expect, it } from "vitest";
import { CollisionLayer } from "../../src/collisionLayers";
import type { HavokModule } from "../../src/index";
import { loadHavok } from "../../src/node/loadHavok";
import { WorldRaycaster } from "../../src/WorldRaycaster";
import { idleScript } from "./testBrains";
import { createMapMatch, MAZE_BR } from "./mazeBrWorld";

// A frag destroys a mirror pane in a running MatchSim, and the maze gains a corridor: the Havok instance is gone, the
// nav grid opens under it, and a route that had to go round the wall now goes through it. Plus: two independent runs
// of the same blast destroy exactly the same panes.

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
}, 60_000);

type Match = ReturnType<typeof createMapMatch>;

function maze(seed: number): Match {
  return createMapMatch(havok, {
    map: MAZE_BR,
    seed,
    brains: idleScript,
    loadout: "empty",
    destructible: true,
    config: { maxPlayers: 2, teamMode: "solo" },
  });
}

/** Both sides of pane `index`, `distance` out along its normal, at nav height. */
function sides(match: Match, index: number, distance: number): readonly [Vec3, Vec3] {
  const walls = match.sim.walls!;
  const nx = Math.sin(walls.yaw[index]!);
  const nz = Math.cos(walls.yaw[index]!);
  const reach = walls.halfZ[index]! + distance;
  const grid = asNavGridData(match.nav.grid);
  const point = (sign: number): Vec3 => {
    const x = walls.x[index]! + sign * nx * reach;
    const z = walls.z[index]! + sign * nz * reach;
    return { x, y: grid.terrainHeight(x, z), z };
  };
  return [point(1), point(-1)];
}

function walkable(match: Match, p: Vec3): boolean {
  const grid = asNavGridData(match.nav.grid);
  const cell = grid.cellAt(p.x, p.z);
  return cell >= 0 && (grid.terrainFlags[cell]! & PASSABLE) !== 0;
}

/** Runs the nav query to completion and returns the path length, or -1 when there is none. */
function pathLength(match: Match, from: Vec3, to: Vec3): number {
  const handle = match.nav.requestPath(from, to, null);
  const out: NavPath = { points: new Float32Array(256 * 3), flags: new Uint8Array(256), count: 0, length: 0 };
  let status = match.nav.readPath(handle, out);
  for (let i = 0; i < 64 && status === "pending"; i++) {
    match.nav.update(200_000);
    status = match.nav.readPath(handle, out);
  }
  const length = status === "found" ? out.length : -1;
  match.nav.releasePath(handle);
  return length;
}

/** Drops a live frag at the pane and ticks the match until it has gone off and the world has caught up. */
function fragAt(match: Match, position: Vec3, ticks = 30): void {
  const world = match.sim.equipmentWorld!;
  spawnThrowable(world.throwables, { id: 4242, owner: 0, kind: "frag", position, velocity: { x: 0, y: 0, z: 0 }, fuse: 0.1 });
  for (let i = 0; i < ticks; i++) match.sim.tick();
}

/**
 * The first pane with walkable ground on both sides that you cannot walk between: the blast has somewhere to open a
 * route to. Returns -1 if the maze has none (it has dozens).
 */
function pickSeparatingPane(match: Match): number {
  const walls = match.sim.walls!;
  for (let i = 0; i < walls.count; i++) {
    if (walls.kind[i] !== WallKind.pane) continue;
    const [a, b] = sides(match, i, 1.1);
    if (!walkable(match, a) || !walkable(match, b)) continue;
    if (match.nav.lineWalkable(a, b)) continue;
    return i;
  }
  return -1;
}

describe("a frag destroys a mirror pane and opens a route", () => {
  it("takes the collider, the nav block and the detour with it", () => {
    const match = maze(11);
    try {
      const walls = match.sim.walls!;
      expect(walls.count).toBeGreaterThan(0);
      const grid = asNavGridData(match.nav.grid);
      // The build-time guard the patch must not invalidate.
      expect(grid.stats?.clearedIslands).toBe(0);

      const pane = pickSeparatingPane(match);
      expect(pane).toBeGreaterThanOrEqual(0);
      const [a, b] = sides(match, pane, 1.1);

      // Before: a solid wall. Bullets pass a mirror (it is on the blocker layer), so the collider is probed with a
      // movement-style ray that does see blockers.
      const solid = new WorldRaycaster(match.world.scene, { collideWith: CollisionLayer.blocker });
      const chest = (p: Vec3): Vec3 => ({ x: p.x, y: p.y + 1.2, z: p.z });
      expect(solid.cast(chest(a), chest(b))).not.toBeNull();
      const detour = pathLength(match, a, b);
      const straight = Math.hypot(a.x - b.x, a.z - b.z);
      expect(detour).toBeGreaterThan(straight * 2);

      fragAt(match, { x: walls.x[pane]!, y: walls.y[pane]! + 0.6, z: walls.z[pane]! });

      // After: the pane is gone from the state, from Havok and from the nav grid.
      expect(walls.destroyed[pane]).toBe(1);
      expect(solid.cast(chest(a), chest(b))).toBeNull();
      const patch = match.sim.navPatchStats!;
      expect(patch.opened).toBeGreaterThan(0);
      expect(match.nav.lineWalkable(a, b)).toBe(true);

      // And the route through it is the short one now.
      const through = pathLength(match, a, b);
      expect(through).toBeGreaterThan(0);
      expect(through).toBeLessThan(straight * 1.6);
      expect(through).toBeLessThan(detour * 0.75);
      console.info(
        `[destructible] ${walls.count} walls (${[...walls.kind].filter((k) => k === WallKind.pane).length} panes); pane ${pane}: detour ${detour.toFixed(1)} m → ${through.toFixed(1)} m (straight ${straight.toFixed(1)} m), ` +
          `${patch.opened} cells opened, ${patch.kept} kept, ${patch.merges} component merges`,
      );
    } finally {
      match.dispose();
    }
  }, 300_000);

  it("leaves no stranded ground: every opened cell still reaches the rest of the maze", () => {
    const match = maze(11);
    try {
      const walls = match.sim.walls!;
      const pane = pickSeparatingPane(match);
      const [a, b] = sides(match, pane, 1.1);
      const grid = asNavGridData(match.nav.grid);
      const before = new Uint8Array(grid.terrainFlags);
      fragAt(match, { x: walls.x[pane]!, y: walls.y[pane]! + 0.6, z: walls.z[pane]! });

      // Every cell the patch opened belongs to a component, and to the same one as the ground either side of it.
      const anchor = grid.cellAt(a.x, a.z);
      const far = grid.cellAt(b.x, b.z);
      let opened = 0;
      for (let cell = 0; cell < before.length; cell++) {
        if ((before[cell]! & PASSABLE) !== 0 || (grid.terrainFlags[cell]! & PASSABLE) === 0) continue;
        opened++;
        expect(grid.terrainComp[cell]).not.toBe(0);
        expect(match.nav.reachable(cell, anchor)).toBe(true);
        expect(match.nav.reachable(cell, far)).toBe(true);
      }
      expect(opened).toBeGreaterThan(0);
    } finally {
      match.dispose();
    }
  }, 300_000);

  it("destroys the same panes in two independent runs", () => {
    const listOf = (match: Match): string => {
      const walls = match.sim.walls!;
      const pane = pickSeparatingPane(match);
      fragAt(match, { x: walls.x[pane]!, y: walls.y[pane]! + 0.6, z: walls.z[pane]! });
      const gone: number[] = [];
      for (let i = 0; i < walls.count; i++) if (walls.destroyed[i] === 1) gone.push(i);
      return `${pane}:${gone.join(",")}:${match.sim.navPatchStats!.opened}`;
    };
    const first = maze(11);
    let a: string;
    try {
      a = listOf(first);
    } finally {
      first.dispose();
    }
    const second = maze(11);
    let b: string;
    try {
      b = listOf(second);
    } finally {
      second.dispose();
    }
    expect(b).toBe(a);
    expect(a.split(":")[1]!.split(",").length).toBeGreaterThan(0);
  }, 300_000);
});

describe("a molotov burns a hedge away", () => {
  it("takes the concealment with it and leaves walking alone", () => {
    const match = maze(11);
    try {
      const walls = match.sim.walls!;
      const grid = asNavGridData(match.nav.grid);
      let hedge = -1;
      for (let i = 0; i < walls.count && hedge < 0; i++) {
        if (walls.kind[i] !== WallKind.hedge) continue;
        const cell = grid.cellAt(walls.x[i]!, walls.z[i]!);
        if (cell >= 0 && (grid.terrainFlags[cell]! & NavFlag.vegetation) !== 0) hedge = i;
      }
      expect(hedge).toBeGreaterThanOrEqual(0);
      const before = countFlag(grid.terrainFlags, NavFlag.vegetation);
      const walkableBefore = countFlag(grid.terrainFlags, PASSABLE);

      const world = match.sim.equipmentWorld!;
      const at = { x: walls.x[hedge]!, y: grid.terrainHeight(walls.x[hedge]!, walls.z[hedge]!) + 0.4, z: walls.z[hedge]! };
      spawnThrowable(world.throwables, { id: 99, owner: 0, kind: "molotov", position: at, velocity: { x: 0, y: 0, z: 0 }, fuse: 0.1 });
      // The fire has to spread and then sit on the hedge for `WALL_DAMAGE.burnSeconds`.
      for (let i = 0; i < 400; i++) match.sim.tick();

      expect(walls.destroyed[hedge]).toBe(1);
      expect(countFlag(grid.terrainFlags, NavFlag.vegetation)).toBeLessThan(before);
      // A hedge has no collider, so nothing about where you can walk changed.
      expect(countFlag(grid.terrainFlags, PASSABLE)).toBe(walkableBefore);
      const cell = grid.cellAt(walls.x[hedge]!, walls.z[hedge]!);
      expect(grid.terrainFlags[cell]! & NavFlag.vegetation).toBe(0);
    } finally {
      match.dispose();
    }
  }, 300_000);
});

function countFlag(flags: Uint8Array, bit: number): number {
  let n = 0;
  for (let i = 0; i < flags.length; i++) if ((flags[i]! & bit) !== 0) n++;
  return n;
}
