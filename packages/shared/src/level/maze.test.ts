import { describe, expect, it } from "vitest";
import { MAZE_LEVEL, createMazeLevel, mazeMetrics, type MazeOptions } from "./maze";
import type { LevelBlock, LevelData } from "./types";

/**
 * Every downstream block is one mesh + one Havok body, so the merge in maze.ts is load-bearing.
 * A raw 21 × 21 lattice is ~380 segments; the merged level must stay well under this.
 */
const BLOCK_BUDGET = 230;

const SEEDS = [1, 2, 3, 7, 42, 99, 1234];

function wallBlocks(level: LevelData): LevelBlock[] {
  return level.blocks.filter((b) => b.surface === "wall");
}

/** All maze blocks are axis-aligned boxes, so a footprint test is a plain range check. */
function inFootprint(block: LevelBlock, x: number, z: number, margin = 0): boolean {
  return (
    Math.abs(x - block.position[0]) <= block.size[0] / 2 + margin && Math.abs(z - block.position[2]) <= block.size[2] / 2 + margin
  );
}

function inAnyWall(walls: readonly LevelBlock[], x: number, z: number, margin = 0): boolean {
  return walls.some((b) => inFootprint(b, x, z, margin));
}

/** Rebuilds the cell grid from the emitted geometry: the test reads what the game actually gets. */
function cellGrid(level: LevelData, options: MazeOptions = {}) {
  const m = mazeMetrics(options);
  const walls = wallBlocks(level);
  const centre = (index: number) => -m.size / 2 + (index + 0.5) * m.pitch;
  /** Open when the midpoint between the two cell centres — which lies on the shared lattice line — is not walled. */
  const open = (i: number, j: number, di: number, dj: number) =>
    !inAnyWall(walls, (centre(i) + centre(i + di)) / 2, (centre(j) + centre(j + dj)) / 2);
  return { m, walls, centre, open };
}

function openSideCount(grid: ReturnType<typeof cellGrid>, i: number, j: number): number {
  const { m, open } = grid;
  let n = 0;
  if (i + 1 < m.cells && open(i, j, 1, 0)) n++;
  if (i > 0 && open(i, j, -1, 0)) n++;
  if (j + 1 < m.cells && open(i, j, 0, 1)) n++;
  if (j > 0 && open(i, j, 0, -1)) n++;
  return n;
}

function countDeadEnds(options: MazeOptions): number {
  const grid = cellGrid(createMazeLevel(options), options);
  let n = 0;
  for (let j = 0; j < grid.m.cells; j++) {
    for (let i = 0; i < grid.m.cells; i++) if (openSideCount(grid, i, j) === 1) n++;
  }
  return n;
}

describe("createMazeLevel", () => {
  it("is deterministic per seed and varies between seeds", () => {
    expect(createMazeLevel({ seed: 7 })).toEqual(createMazeLevel({ seed: 7 }));
    expect(createMazeLevel({ seed: 7 })).not.toEqual(createMazeLevel({ seed: 8 }));
    expect(MAZE_LEVEL).toEqual(createMazeLevel({ seed: 1 }));
    expect(MAZE_LEVEL.name).toBe("Maze 21×21");
    expect(MAZE_LEVEL.killY).toBe(-20);
  });

  it("connects every cell — an unreachable pocket would strand a spawn", () => {
    for (const seed of SEEDS) {
      const grid = cellGrid(createMazeLevel({ seed }), { seed });
      const { m, open } = grid;
      const total = m.cells * m.cells;
      const seen = new Uint8Array(total);
      const stack = [0];
      seen[0] = 1;
      let reached = 1;
      while (stack.length > 0) {
        const cur = stack.pop()!;
        const i = cur % m.cells;
        const j = (cur / m.cells) | 0;
        const push = (ni: number, nj: number) => {
          const next = nj * m.cells + ni;
          if (seen[next] === 1) return;
          seen[next] = 1;
          reached++;
          stack.push(next);
        };
        if (i + 1 < m.cells && open(i, j, 1, 0)) push(i + 1, j);
        if (i > 0 && open(i, j, -1, 0)) push(i - 1, j);
        if (j + 1 < m.cells && open(i, j, 0, 1)) push(i, j + 1);
        if (j > 0 && open(i, j, 0, -1)) push(i, j - 1);
      }
      expect(reached, `seed ${seed}`).toBe(total);
    }
  });

  it("puts every spawn and target in open space with room to stand", () => {
    for (const seed of SEEDS) {
      const level = createMazeLevel({ seed });
      const walls = wallBlocks(level);
      const places = [...level.spawnPoints, ...level.targets];
      expect(places.length).toBe(18);
      for (const place of places) {
        const [x, , z] = place.position;
        // Point plus a 0.45 m body radius in eight directions: no part of the capsule may start inside a wall.
        expect(inAnyWall(walls, x, z), `seed ${seed} at ${x},${z}`).toBe(false);
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          expect(inAnyWall(walls, x + Math.cos(a) * 0.45, z + Math.sin(a) * 0.45), `seed ${seed} clearance at ${x},${z}`).toBe(false);
        }
      }
      // A spawn must look down an open corridor, not into a wall.
      for (const spawn of level.spawnPoints) {
        const [x, , z] = spawn.position;
        expect(inAnyWall(walls, x + Math.sin(spawn.yaw) * 3.4, z + Math.cos(spawn.yaw) * 3.4), `seed ${seed} facing`).toBe(false);
      }
      expect(level.targets.filter((t) => t.motion === "strafe").length).toBe(2);
    }
  });

  it("merges collinear walls and stays under the block budget", () => {
    for (const seed of SEEDS) {
      const level = createMazeLevel({ seed });
      expect(level.blocks.length, `seed ${seed}`).toBeLessThan(BLOCK_BUDGET);
    }
    // Merging really happened: far fewer wall blocks than the 2 × 21 × 20 raw lattice would allow.
    expect(wallBlocks(MAZE_LEVEL).length).toBeLessThan(840 / 2);
  });

  it("keeps every block inside a perimeter with no gaps", () => {
    const m = mazeMetrics();
    const outer = m.size / 2 + m.wallThickness / 2;
    expect(m.size).toBeCloseTo(147, 9);
    for (const block of MAZE_LEVEL.blocks) {
      expect(Math.abs(block.position[0]) + block.size[0] / 2, block.name).toBeLessThanOrEqual(outer + 1e-9);
      expect(Math.abs(block.position[2]) + block.size[2] / 2, block.name).toBeLessThanOrEqual(outer + 1e-9);
      expect(block.rotationY ?? 0).toBe(0);
    }
    // Interior walls are 4 m (no peeking over), the perimeter 8 m.
    const interior = MAZE_LEVEL.blocks.filter((b) => b.name?.startsWith("maze_wallX") || b.name?.startsWith("maze_wallZ"));
    expect(interior.every((b) => b.size[1] === 4)).toBe(true);
    expect(MAZE_LEVEL.blocks.filter((b) => b.name?.startsWith("maze_perimeter")).every((b) => b.size[1] === 8)).toBe(true);

    // Walk the perimeter ring: every sample must be solid, so there is no slot to slip through.
    const walls = wallBlocks(MAZE_LEVEL);
    const ring = m.size / 2;
    for (let t = -ring; t <= ring; t += 0.25) {
      expect(inAnyWall(walls, t, ring), `north at x=${t}`).toBe(true);
      expect(inAnyWall(walls, t, -ring), `south at x=${t}`).toBe(true);
      expect(inAnyWall(walls, ring, t), `east at z=${t}`).toBe(true);
      expect(inAnyWall(walls, -ring, t), `west at z=${t}`).toBe(true);
    }
    // The floor covers the playable square.
    const ground = MAZE_LEVEL.blocks.find((b) => b.surface === "ground")!;
    expect(ground.size[0]).toBeGreaterThanOrEqual(m.size);
    expect(ground.size[2]).toBeGreaterThanOrEqual(m.size);
    expect(ground.position[1] + ground.size[1] / 2).toBe(0);
  });

  it("braids dead ends away", () => {
    for (const seed of [1, 7, 42]) {
      const perfect = countDeadEnds({ seed, braid: 0 });
      const braided = countDeadEnds({ seed, braid: 0.25 });
      expect(braided, `seed ${seed}`).toBeLessThan(perfect);
      expect(countDeadEnds({ seed, braid: 1 }), `seed ${seed} full braid`).toBeLessThan(braided);
    }
  });

  it("honours option overrides", () => {
    const small = createMazeLevel({ seed: 3, cells: 9, corridor: 4, wallThickness: 0.5, wallHeight: 3 });
    const m = mazeMetrics({ cells: 9, corridor: 4, wallThickness: 0.5 });
    expect(m.pitch).toBe(4.5);
    expect(m.size).toBe(40.5);
    expect(small.name).toBe("Maze 9×9");
    expect(small.blocks.every((b) => Math.abs(b.position[0]) + b.size[0] / 2 <= m.size / 2 + 0.25 + 1e-9)).toBe(true);
    expect(small.blocks.filter((b) => b.name?.startsWith("maze_wallX") || b.name?.startsWith("maze_wallZ")).every((b) => b.size[1] === 3)).toBe(true);
    // Below 5 cells there is nowhere to spread 8 spawns, so the grid is clamped.
    expect(mazeMetrics({ cells: 2 }).cells).toBe(5);
  });
});
