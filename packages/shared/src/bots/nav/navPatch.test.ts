import { describe, expect, it } from "vitest";
import { buildDestructibleWalls, WallKind } from "../../equipment/destructible";
import { buildMapLayout } from "../../map/layout/mapLayout";
import { MAZE_BR } from "../../map/mazeBr";
import { sinCos } from "../../map/terrain/math";
import { buildTerrain } from "../../map/terrain/terrain";
import { NavFlag } from "../types";
import { buildNavGrid, NAV_DEFAULTS } from "./buildNavGrid";
import { PASSABLE } from "./navGrid";
import { NavPatcher, navSlopeWalkable } from "./navPatch";

// The patch re-runs the build's own per-cell tests on a handful of cells. These pin the two places that could drift
// apart: the slope formula it duplicates, and the promise that opening cells never strands ground.

function maze() {
  const terrain = buildTerrain(MAZE_BR.terrain, MAZE_BR.flatten);
  const layout = buildMapLayout(MAZE_BR, terrain);
  const grid = buildNavGrid({ map: MAZE_BR, terrain, layout });
  return { layout, grid, walls: buildDestructibleWalls(layout) };
}

describe("nav patch", () => {
  it("duplicates the build's slope test exactly: every walkable cell passes it", () => {
    const { grid } = maze();
    const slope = sinCos((NAV_DEFAULTS.maxSlopeDegrees * Math.PI) / 180);
    const maxSlopeTan = slope.sin / slope.cos;
    let checked = 0;
    for (let iz = 0; iz < grid.depth; iz++) {
      for (let ix = 0; ix < grid.width; ix++) {
        if ((grid.terrainFlags[iz * grid.width + ix]! & PASSABLE) === 0) continue;
        checked++;
        if (!navSlopeWalkable(grid, ix, iz, maxSlopeTan)) throw new Error(`cell ${ix},${iz} is walkable but fails the patch's slope test`);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  }, 120_000);

  it("opens the cells under a destroyed pane and joins them to ground that was already walkable", () => {
    const { layout, grid, walls } = maze();
    const patcher = new NavPatcher(grid, layout, walls);
    const before = new Uint8Array(grid.terrainFlags);

    let opened = 0;
    let panes = 0;
    for (let i = 0; i < walls.count && panes < 12; i++) {
      if (walls.kind[i] !== WallKind.pane) continue;
      panes++;
      walls.destroyed[i] = 1;
      opened += patcher.destroyed(i);
    }
    expect(panes).toBe(12);
    expect(opened).toBeGreaterThan(0);

    // Every cell the patch opened is in a component and 4-touches ground that was walkable before or has just been
    // opened: no island can appear, which is what `clearedIslands === 0` promised at build time.
    for (let cell = 0; cell < before.length; cell++) {
      if ((before[cell]! & PASSABLE) !== 0 || (grid.terrainFlags[cell]! & PASSABLE) === 0) continue;
      expect(grid.terrainComp[cell]).not.toBe(0);
      const ix = cell % grid.width;
      const iz = (cell - ix) / grid.width;
      const neighbours = [ix + 1 < grid.width ? cell + 1 : -1, ix > 0 ? cell - 1 : -1, iz + 1 < grid.depth ? cell + grid.width : -1, iz > 0 ? cell - grid.width : -1];
      expect(neighbours.some((n) => n >= 0 && (grid.terrainFlags[n]! & PASSABLE) !== 0 && grid.terrainComp[n] === grid.terrainComp[cell])).toBe(true);
    }
    expect(patcher.stats.opened).toBe(opened);
  }, 120_000);

  it("a burnt hedge loses its concealment and nothing else", () => {
    const { layout, grid, walls } = maze();
    const patcher = new NavPatcher(grid, layout, walls);
    const walkableBefore = grid.terrainFlags.reduce((n, f) => n + (f & PASSABLE ? 1 : 0), 0);

    let hedge = -1;
    for (let i = 0; i < walls.count && hedge < 0; i++) {
      if (walls.kind[i] !== WallKind.hedge) continue;
      const cell = grid.cellAt(walls.x[i]!, walls.z[i]!);
      if (cell >= 0 && (grid.terrainFlags[cell]! & NavFlag.vegetation) !== 0) hedge = i;
    }
    expect(hedge).toBeGreaterThanOrEqual(0);

    walls.destroyed[hedge] = 1;
    expect(patcher.destroyed(hedge)).toBeGreaterThan(0);
    expect(grid.terrainFlags[grid.cellAt(walls.x[hedge]!, walls.z[hedge]!)]! & NavFlag.vegetation).toBe(0);
    expect(grid.terrainFlags.reduce((n, f) => n + (f & PASSABLE ? 1 : 0), 0)).toBe(walkableBefore);
  }, 120_000);
});
