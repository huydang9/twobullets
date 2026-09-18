import { clamp, createRng } from "../equipment/math";
import type { LevelBlock, LevelData, SpawnPoint, SurfaceKind, TargetSpawn } from "./types";

// Layout conventions (same as arena.ts): +X = east, +Z = north, Y up, meters. Floor top is y = 0 and the level is
// centred on the origin. The maze lives on a square lattice: `cells` corridor cells per side with a cell pitch of
// `corridor + wallThickness`, so the playable square is `cells * pitch` m across (21 × 7 = 147 m by default) and
// spans x, z ∈ [-73.5, 73.5]. Interior walls sit centred on the lattice lines; the perimeter wall is centred on the
// outermost lines, so every corridor — edge ones included — is exactly `corridor` wide.
//
// Generation is pure and deterministic: a mulberry32 stream seeded from `seed` drives the carve, the braid and the
// target placement, so the Node server rebuilds the identical level from the same options.
//
// Block budget matters. `packages/sim/src/level/buildLevel.ts` makes one mesh AND one Havok body per block with no
// instancing or merging downstream, so a raw ~400-segment lattice would mean ~400 draw calls and rigid bodies. Every
// straight run of collinear wall segments is therefore merged into a single long box before it is emitted.

/** Direction indices used throughout: 0 = +X, 1 = -X, 2 = +Z, 3 = -Z. */
const DIR_DX = [1, -1, 0, 0] as const;
const DIR_DZ = [0, 0, 1, -1] as const;
/** Facing around Y for each direction (0 = +Z, π/2 = +X), matching SpawnPoint.yaw. */
const DIR_YAW = [Math.PI / 2, -Math.PI / 2, 0, Math.PI] as const;

const PERIMETER_HEIGHT = 8;
const FLOOR_THICKNESS = 1;
const KILL_Y = -20;
const TARGET_COUNT = 10;
/** Total side-to-side travel of a strafing dummy; stays clear of a 6 m corridor's walls. */
const STRAFE_DISTANCE = 4;
const STRAFE_SPEED = 3;

export interface MazeOptions {
  /** Seed for the layout. Same seed => byte-identical LevelData. Default 1. */
  readonly seed?: number;
  /** Cells per side of the maze grid. Default 21. */
  readonly cells?: number;
  /** Corridor width, m. Default 6. */
  readonly corridor?: number;
  /** Wall thickness, m. Default 1. */
  readonly wallThickness?: number;
  /** Interior wall height, m. Default 4. */
  readonly wallHeight?: number;
  /** Fraction of dead ends opened up into loops, 0..1. Default 0.25. */
  readonly braid?: number;
}

/** Resolved geometry of a maze, for tools, minimaps and tests. */
export interface MazeMetrics {
  readonly seed: number;
  readonly cells: number;
  readonly corridor: number;
  readonly wallThickness: number;
  readonly wallHeight: number;
  readonly braid: number;
  /** Distance between neighbouring cell centres, m. */
  readonly pitch: number;
  /** Side of the playable square, m. */
  readonly size: number;
}

/** Resolves defaults and clamps to a buildable range. Fewer than 5 cells has nowhere to put 8 spread-out spawns. */
export function mazeMetrics(options: MazeOptions = {}): MazeMetrics {
  const cells = Math.max(5, Math.floor(options.cells ?? 21));
  const corridor = Math.max(1, options.corridor ?? 6);
  const wallThickness = Math.max(0.1, options.wallThickness ?? 1);
  const pitch = corridor + wallThickness;
  return {
    seed: Math.floor(options.seed ?? 1),
    cells,
    corridor,
    wallThickness,
    wallHeight: Math.max(1, options.wallHeight ?? 4),
    braid: clamp(options.braid ?? 0.25, 0, 1),
    pitch,
    size: cells * pitch,
  };
}

/**
 * Wall lattice. There are `cells + 1` lines per axis and `cells` segments along each line.
 * `v[k * cells + j]` is the segment on vertical line k (constant X) in row j, blocking movement along X;
 * `h[k * cells + i]` is the mirror on horizontal line k (constant Z) in column i. Lines 0 and `cells` are the
 * perimeter and are never carved.
 */
interface Lattice {
  readonly v: Uint8Array;
  readonly h: Uint8Array;
}

/** Axis-aligned box from min/max ranges per axis (same helper shape as arena.ts). */
function span(name: string, surface: SurfaceKind, x: readonly [number, number], y: readonly [number, number], z: readonly [number, number]): LevelBlock {
  return {
    kind: "box",
    name,
    surface,
    position: [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2, (z[0] + z[1]) / 2],
    size: [x[1] - x[0], y[1] - y[0], z[1] - z[0]],
  };
}

/** Randomised depth-first carve (recursive backtracker), iterative so a 200 × 200 grid can't blow the JS stack. */
function carve(m: MazeMetrics, lat: Lattice, rng: () => number): void {
  const { cells } = m;
  const total = cells * cells;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const options = new Int32Array(4);

  let top = 0;
  stack[0] = (rng() * total) | 0;
  visited[stack[0]] = 1;

  while (top >= 0) {
    const cur = stack[top]!;
    const i = cur % cells;
    const j = (cur / cells) | 0;

    let n = 0;
    if (i + 1 < cells && visited[cur + 1] === 0) options[n++] = 0;
    if (i > 0 && visited[cur - 1] === 0) options[n++] = 1;
    if (j + 1 < cells && visited[cur + cells] === 0) options[n++] = 2;
    if (j > 0 && visited[cur - cells] === 0) options[n++] = 3;
    if (n === 0) {
      top--;
      continue;
    }

    const dir = options[(rng() * n) | 0]!;
    openWall(m, lat, i, j, dir);
    const next = cur + DIR_DX[dir]! + DIR_DZ[dir]! * cells;
    visited[next] = 1;
    stack[++top] = next;
  }
}

/** Removes the wall on side `dir` of cell (i, j). */
function openWall(m: MazeMetrics, lat: Lattice, i: number, j: number, dir: number): void {
  const { cells } = m;
  if (dir === 0) lat.v[(i + 1) * cells + j] = 0;
  else if (dir === 1) lat.v[i * cells + j] = 0;
  else if (dir === 2) lat.h[(j + 1) * cells + i] = 0;
  else lat.h[j * cells + i] = 0;
}

/** True when the wall on side `dir` of cell (i, j) is still standing. */
function isWalled(m: MazeMetrics, lat: Lattice, i: number, j: number, dir: number): boolean {
  const { cells } = m;
  if (dir === 0) return lat.v[(i + 1) * cells + j] === 1;
  if (dir === 1) return lat.v[i * cells + j] === 1;
  if (dir === 2) return lat.h[(j + 1) * cells + i] === 1;
  return lat.h[j * cells + i] === 1;
}

function openSides(m: MazeMetrics, lat: Lattice, i: number, j: number): number {
  let n = 0;
  for (let dir = 0; dir < 4; dir++) if (!isWalled(m, lat, i, j, dir)) n++;
  return n;
}

function deadEnds(m: MazeMetrics, lat: Lattice): number[] {
  const out: number[] = [];
  for (let j = 0; j < m.cells; j++) {
    for (let i = 0; i < m.cells; i++) if (openSides(m, lat, i, j) === 1) out.push(j * m.cells + i);
  }
  return out;
}

/** Deterministic Fisher-Yates. */
function shuffle(list: number[], rng: () => number): void {
  for (let k = list.length - 1; k > 0; k--) {
    const swap = (rng() * (k + 1)) | 0;
    const tmp = list[k]!;
    list[k] = list[swap]!;
    list[swap] = tmp;
  }
}

/**
 * Opens `m.braid` of the dead ends into loops. A perfect maze plays badly for a shooter: every fight is a rat run
 * with one way out. Loops give flanking routes and let a player break contact.
 */
function braidDeadEnds(m: MazeMetrics, lat: Lattice, rng: () => number): void {
  const ends = deadEnds(m, lat);
  shuffle(ends, rng);
  const quota = Math.floor(ends.length * m.braid);
  const options = new Int32Array(4);

  for (let k = 0; k < quota; k++) {
    const cell = ends[k]!;
    const i = cell % m.cells;
    const j = (cell / m.cells) | 0;
    // An earlier braid may have already opened this one from the other side.
    if (openSides(m, lat, i, j) !== 1) continue;

    let n = 0;
    for (let dir = 0; dir < 4; dir++) {
      const ni = i + DIR_DX[dir]!;
      const nj = j + DIR_DZ[dir]!;
      if (ni < 0 || nj < 0 || ni >= m.cells || nj >= m.cells) continue; // never breach the perimeter
      if (isWalled(m, lat, i, j, dir)) options[n++] = dir;
    }
    if (n > 0) openWall(m, lat, i, j, options[(rng() * n) | 0]!);
  }
}

/** Centre of cell (i, j) along one axis. */
function cellCoord(m: MazeMetrics, index: number): number {
  return -m.size / 2 + (index + 0.5) * m.pitch;
}

/** Position of lattice line k along one axis. */
function lineCoord(m: MazeMetrics, k: number): number {
  return -m.size / 2 + k * m.pitch;
}

/**
 * Emits the interior walls, merging every straight run of collinear segments into one box. This is mandatory, not an
 * optimisation: one block = one mesh + one rigid body downstream.
 */
function emitWalls(m: MazeMetrics, lat: Lattice, out: LevelBlock[]): void {
  const { cells, wallThickness: t, wallHeight } = m;
  const half = t / 2;

  // Vertical lines (constant X): runs merge along Z.
  for (let k = 1; k < cells; k++) {
    const x = lineCoord(m, k);
    let run = 0;
    for (let j = 0; j <= cells; j++) {
      if (j < cells && lat.v[k * cells + j] === 1) {
        run++;
        continue;
      }
      if (run > 0) {
        out.push(span(`maze_wallX${k}_${j - run}`, "wall", [x - half, x + half], [0, wallHeight], [lineCoord(m, j - run), lineCoord(m, j)]));
        run = 0;
      }
    }
  }

  // Horizontal lines (constant Z): runs merge along X.
  for (let k = 1; k < cells; k++) {
    const z = lineCoord(m, k);
    let run = 0;
    for (let i = 0; i <= cells; i++) {
      if (i < cells && lat.h[k * cells + i] === 1) {
        run++;
        continue;
      }
      if (run > 0) {
        out.push(span(`maze_wallZ${k}_${i - run}`, "wall", [lineCoord(m, i - run), lineCoord(m, i)], [0, wallHeight], [z - half, z + half]));
        run = 0;
      }
    }
  }
}

/** Floor slab plus the four perimeter walls; north and south span the full width so the corners are sealed. */
function emitShell(m: MazeMetrics, out: LevelBlock[]): void {
  const inner = m.size / 2 - m.wallThickness / 2;
  const outer = m.size / 2 + m.wallThickness / 2;
  out.push(
    span("maze_ground", "ground", [-outer, outer], [-FLOOR_THICKNESS, 0], [-outer, outer]),
    span("maze_perimeterNorth", "wall", [-outer, outer], [0, PERIMETER_HEIGHT], [inner, outer]),
    span("maze_perimeterSouth", "wall", [-outer, outer], [0, PERIMETER_HEIGHT], [-outer, -inner]),
    span("maze_perimeterEast", "wall", [inner, outer], [0, PERIMETER_HEIGHT], [-inner, inner]),
    span("maze_perimeterWest", "wall", [-outer, -inner], [0, PERIMETER_HEIGHT], [-inner, inner]),
  );
}

/** Direction to face from cell (i, j): the open side that leads most directly toward the middle of the maze. */
function facingDir(m: MazeMetrics, lat: Lattice, i: number, j: number): number {
  const x = cellCoord(m, i);
  const z = cellCoord(m, j);
  let best = -1;
  let bestScore = -Infinity;
  for (let dir = 0; dir < 4; dir++) {
    if (isWalled(m, lat, i, j, dir)) continue;
    const score = DIR_DX[dir]! * -x + DIR_DZ[dir]! * -z;
    if (score > bestScore) {
      bestScore = score;
      best = dir;
    }
  }
  return best;
}

/** Nudges tried around a spawn site, nearest first, when the site itself has no corridor leading inward. */
const SPAWN_NUDGE: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];

/**
 * Eight spawns at the corners and edge midpoints, one cell in from the perimeter. Every grid cell is carved open, so
 * a cell centre is always `corridor / 2` clear of the nearest wall. The yaw looks down an open corridor, never into a
 * wall; where the exact site only opens outward the spawn shifts a cell so the player starts facing into the maze.
 */
function buildSpawns(m: MazeMetrics, lat: Lattice): SpawnPoint[] {
  const lo = 1;
  const hi = m.cells - 2;
  const mid = (m.cells - 1) >> 1;
  const sites: readonly (readonly [number, number])[] = [
    [lo, lo], [hi, hi], [hi, lo], [lo, hi],
    [mid, lo], [mid, hi], [lo, mid], [hi, mid],
  ];
  const used = new Uint8Array(m.cells * m.cells);
  return sites.map(([si, sj]): SpawnPoint => {
    let i = si;
    let j = sj;
    let dir = facingDir(m, lat, i, j);
    for (const [di, dj] of SPAWN_NUDGE) {
      const ni = clamp(si + di, 0, m.cells - 1);
      const nj = clamp(sj + dj, 0, m.cells - 1);
      if (used[nj * m.cells + ni] === 1) continue;
      const nd = facingDir(m, lat, ni, nj);
      // A positive score means the open side heads toward the middle of the maze.
      if (nd >= 0 && DIR_DX[nd]! * -cellCoord(m, ni) + DIR_DZ[nd]! * -cellCoord(m, nj) > 0) {
        i = ni;
        j = nj;
        dir = nd;
        break;
      }
    }
    used[j * m.cells + i] = 1;
    return { position: [cellCoord(m, i), 0, cellCoord(m, j)], yaw: dir < 0 ? 0 : DIR_YAW[dir]! };
  });
}

/**
 * Practice dummies, dead ends first (a dummy round a blind corner is the interesting shot), then ordinary cells.
 * Candidates are accepted greedily while they stay clear of the spawns and of each other; the separation relaxes if
 * a small maze can't satisfy it.
 */
function buildTargets(m: MazeMetrics, lat: Lattice, spawns: readonly SpawnPoint[], rng: () => number): TargetSpawn[] {
  const ends = deadEnds(m, lat);
  shuffle(ends, rng);
  const rest: number[] = [];
  const isEnd = new Uint8Array(m.cells * m.cells);
  for (const cell of ends) isEnd[cell] = 1;
  for (let cell = 0; cell < m.cells * m.cells; cell++) if (isEnd[cell] === 0) rest.push(cell);
  shuffle(rest, rng);
  const candidates = [...ends, ...rest];

  const chosen: number[] = [];
  for (let pass = 0; pass < 4 && chosen.length < TARGET_COUNT; pass++) {
    const minSep = [3, 2, 1, 0][pass]! * m.pitch;
    const minSpawnSep = [2, 2, 1, 0][pass]! * m.pitch;
    for (const cell of candidates) {
      if (chosen.length >= TARGET_COUNT) break;
      if (chosen.includes(cell)) continue;
      const x = cellCoord(m, cell % m.cells);
      const z = cellCoord(m, (cell / m.cells) | 0);
      if (spawns.some((s) => near(s.position[0], s.position[2], x, z, minSpawnSep))) continue;
      if (chosen.some((c) => near(cellCoord(m, c % m.cells), cellCoord(m, (c / m.cells) | 0), x, z, minSep))) continue;
      chosen.push(cell);
    }
  }

  return chosen.map((cell, index): TargetSpawn => {
    const i = cell % m.cells;
    const j = (cell / m.cells) | 0;
    const position = [cellCoord(m, i), 0, cellCoord(m, j)] as const;
    // A dead-end dummy faces its only opening, i.e. whoever walks in; the rest face the middle of the maze.
    const dir = isEnd[cell] === 1 ? firstOpen(m, lat, i, j) : facingDir(m, lat, i, j);
    const yaw = dir < 0 ? Math.atan2(-position[0], -position[2]) : DIR_YAW[dir]!;
    // Two strafers, on cells with room on both sides of the facing axis.
    return index === 2 || index === 6
      ? { position, yaw, motion: "strafe", strafeDistance: STRAFE_DISTANCE, strafeSpeed: STRAFE_SPEED }
      : { position, yaw, motion: "static" };
  });
}

function firstOpen(m: MazeMetrics, lat: Lattice, i: number, j: number): number {
  for (let dir = 0; dir < 4; dir++) if (!isWalled(m, lat, i, j, dir)) return dir;
  return -1;
}

/** Math.sqrt over Math.hypot per the repo's numeric rules; compared squared, so neither is needed. */
function near(ax: number, az: number, bx: number, bz: number, minDistance: number): boolean {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz < minDistance * minDistance;
}

/** Builds a maze level. Pure and deterministic. */
export function createMazeLevel(options: MazeOptions = {}): LevelData {
  const m = mazeMetrics(options);
  const rng = createRng(m.seed);
  const lat: Lattice = {
    v: new Uint8Array((m.cells + 1) * m.cells).fill(1),
    h: new Uint8Array((m.cells + 1) * m.cells).fill(1),
  };

  carve(m, lat, rng);
  braidDeadEnds(m, lat, rng);

  const blocks: LevelBlock[] = [];
  emitShell(m, blocks);
  emitWalls(m, lat, blocks);
  const spawnPoints = buildSpawns(m, lat);

  return {
    name: `Maze ${m.cells}×${m.cells}`,
    killY: KILL_Y,
    blocks,
    spawnPoints,
    targets: buildTargets(m, lat, spawnPoints, rng),
  };
}

/** The default maze: seed 1, 21 cells, ~147 × 147 m playable. */
export const MAZE_LEVEL: LevelData = createMazeLevel();
