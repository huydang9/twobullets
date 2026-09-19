import { createRng } from "../equipment/math";
import { round3 } from "./layout/geometry";
import { getMapProp } from "./layout/props";
import type { ScatterRule } from "./layout/scatter";
import type { ValidationOptions } from "./layout/validate";
import type { FlattenRegion, MapBuilding, MapData, MapSpawn, PadLoot, PointOfInterest, PropPlacement, TerrainSpec, Vec2Tuple } from "./types";

/**
 * Maze: a battle-royale map that is one big concrete maze. Unlike the `?map=maze` arena (a LevelData level, see
 * level/maze.ts) this is real MapData, so bots, loot, spawns and the shrinking zone all work on it.
 *
 * Layout conventions (meters, +X east, +Z north, yaw 0 = facing +Z, π/2 = facing +X; walls run along their own local X):
 * - 30 × 30 cells on a **non-uniform** lattice: every column has its own width and every row its own height, each one
 *   4, 8 or 12 m, summing to 184 m on both axes — a 184 × 184 m playable square, x, z ∈ [-92, 92].
 * - **The squeeze is the map.** Of the 30 lanes on each axis, 17 are 4 m squeezes, 10 are 8 m corridors and 3 are 12 m
 *   boulevards. That is deliberately the inverse of the first non-uniform version (5 / 8 / 9), which the owner played
 *   and rejected: "đường đi quá rộng, nên không mang lại cảm giác mê cung" — the lanes were so wide the map read as a
 *   grid of streets rather than a maze. A maze is made of turns, and a turn only exists where you cannot see past it.
 *   So the common case is the 3.7 m squeeze you cross one at a time, the 7.7 m corridor is the exception, and the
 *   11.7 m boulevard is reserved almost entirely for the avenues below. Narrowing every lane would have shrunk the map,
 *   so the cell count went from 22 to 30 a side instead: 900 cells rather than 484 over almost the same ground, which
 *   is what actually buys the corners, the choices and the blind turns.
 * - **4 m is the floor, and that is settled** (2026-09-19). A 2 m lattice was built and played — 44 × 44 cells over
 *   160 m, thirty 2 m lanes an axis, 1.7 m of clear floor, which halved the distance to the next corner (5.1 m against
 *   8.6 m) and dropped a bot's chance of seeing an enemy from 34 % to 25 %. The owner played it and ruled: "ĐÚNG LÀ
 *   ĐƯỜNG NHỎ KHÔNG HAY LẮM, KHÔI PHỤC LẠI NHÉ" — the narrow paths are not good, put it back. So the answer is now
 *   known from both ends: 3.7 m read as slightly too wide, 1.7 m plays badly, and of the two the wider one wins. The
 *   2 m wall props (`wall_concrete_2` and its three siblings) stay in the catalog and stay wired end to end, so a lane
 *   narrower than 4 m is one constant away if it is ever wanted again; this map does not use them.
 * - `playableHalfExtent` is exactly 92 m, so the out-of-bounds mountains start at the outer wall: there is no walkable
 *   band around the maze for players to run laps in, and landing targets always land inside it.
 * - Column i spans `[mazeBrLineX(i), mazeBrLineX(i + 1)]` and row j spans `[mazeBrLineZ(j), mazeBrLineZ(j + 1)]`; lines
 *   0 and 30 are the perimeter and are never carved, so the maze is a closed box. Every width is a multiple of the 4 m
 *   wall piece, so a standing edge is a whole number of pieces end to end (1, 2 or 3) and nothing is scaled or trimmed —
 *   a scaled wall would be a short wall, since `PropPlacement.scale` is uniform (map/types.ts).
 * - Every standing lattice edge is `wall_concrete` pieces, ~2.2 m visible after the catalog's 0.4 m sink. About 15% of
 *   the interior edges are glazed instead: same box, see-through, not walk-through, and every one of them switching
 *   between stopping bullets and letting them through every ten seconds on a clock of its own, with a tell you can read
 *   (`wall_glass`, map/glassPhase.ts). Ten more edges are `wall_mirror`: opaque, and since 2026-09-18 shoot-through
 *   like the glass, so rounds cross it and leave a hole. The client reflects players in the nearest few of them, so you
 *   can catch an enemy coming round a corner — and anyone can shoot straight back through the wall they saw you in.
 *   Mirrors only ever replace concrete edges. About 8% more are `wall_grass`: a hedge you cannot see through that has
 *   no collider at all, so you and your bullets walk through it and it hides you while you stand in it. Grass only ever
 *   replaces concrete edges, and only where walking through would save a short detour — see `pickGrass`.
 * - **Avenues** (`AVENUE_COLUMNS`, `AVENUE_ROWS`): three boulevards opened end to end across the whole map, so there
 *   are sightlines a rifle can use — 184 m against the old uniform map's 42 m. Crossing one is the map's standing risk,
 *   and the contrast is the point: tight maze fabric punctuated by three long, dangerous halls.
 * - **Nooks** (`carveNooks`, `MAZE_BR_NOOKS`): one-cell recesses cut into the wall beside an avenue or another long
 *   run — three sides sealed, one mouth onto the lane. A nook is a firing position, not a reward: you step out of the
 *   corridor into a slot that covers the whole hall and hold the angle with a scope.
 * - **Rooms** (`ROOMS`): seven 2 × 2 cell blocks with their inside edges removed, so open ground is not only the plaza.
 *   The first four are the corner courtyards a `watchtower_small` stands in; the rest are plain rooms.
 * - The centre 3 × 3 cells (x, z ∈ [-12, 12]) are cleared into a plaza with a watchtower at its middle, the one place
 *   you can see over the maze. Every edge touching a plaza cell is removed, so the plaza has twelve corridor mouths.
 * - **Alcoves** (`MAZE_BR_ALCOVES`): a dozen dead ends carry a loot pad of their own, so walking into one can pay.
 *   An alcove pays you for exploring; a nook pays you for holding a sightline. They are picked apart on purpose.
 *
 * Generation is pure and deterministic (a seeded RNG from equipment/math, no Math.random), so the Node server rebuilds
 * the identical map. The carve/braid below is deliberately a copy of level/maze.ts's ~40 lines rather than an import:
 * a level and a map are different layers and must not depend on each other; the duplication is the cheaper price.
 *
 * No roads: a maze is corridors, so there is no road network to author (and therefore no roadside loot). Ground loot
 * comes from the POI pads instead — the flatten regions below double as the loot generator's pad grids, and because
 * they are almost the whole supply (five buildings) they ask for full building-style piles rather than the roadside
 * gun cache every other map's pads roll (`PAD_LOOT`).
 */

const HALF_PI = Math.PI / 2;

/** The three lane widths, m. Every one is a multiple of the 4 m wall piece. */
export const MAZE_BR_WIDTHS = { squeeze: 4, corridor: 8, boulevard: 12 } as const;
/** The wall prop this map is built from, m: an edge across a lane is `w / 4` of these laid end to end. */
export const MAZE_BR_WALL_PIECE = 4;
/**
 * The short wall prop, m. Nothing on this map is narrow enough to need one — the 2 m lattice was built, played and
 * reverted (see the header) — but the catalog and every consumer still carry both lengths, so a lane narrower than the
 * long piece stays one constant away. `mazeBrEdgePieces` is what would pick it.
 */
export const MAZE_BR_WALL_PIECE_SHORT = 2;

const S = MAZE_BR_WIDTHS.squeeze;
const C = MAZE_BR_WIDTHS.corridor;
const B = MAZE_BR_WIDTHS.boulevard;

/**
 * Column widths, west to east, and row heights, south to north: seventeen squeezes, ten corridors and three boulevards
 * each, 184 m in total. Narrow dominates — see the header — and the three boulevards per axis are there so the avenues
 * have something wide to run down. The two arrays are different arrangements of the same multiset, so the map is not
 * symmetric about its diagonal. Cells 13…15 are `C` on both axes and start at 80 m, which puts the 24 × 24 m plaza on
 * the origin with its middle cell centred exactly on the tower.
 */
export const MAZE_BR_COLUMN_WIDTHS: readonly number[] = [
  S, S, C, B, C, S, S, S, B, S, S, S, C,
  C, C, C,
  S, S, C, S, S, B, S, S, C, S, S, C, S, C,
];
export const MAZE_BR_ROW_HEIGHTS: readonly number[] = [
  S, C, S, S, C, C, S, B, S, C, S, S, C,
  C, C, C,
  S, S, B, S, S, C, S, S, S, B, S, S, C, S,
];

/** Cells per side. */
export const MAZE_BR_CELLS = MAZE_BR_COLUMN_WIDTHS.length;

/** Cumulative lattice lines for a width list, centred on the origin. */
function lattice(widths: readonly number[]): Float64Array {
  const lines = new Float64Array(widths.length + 1);
  let at = 0;
  for (let k = 0; k < widths.length; k++) lines[k + 1] = at += widths[k]!;
  const half = at / 2;
  for (let k = 0; k <= widths.length; k++) lines[k] = lines[k]! - half;
  return lines;
}

const COLUMN_LINES = lattice(MAZE_BR_COLUMN_WIDTHS);
const ROW_LINES = lattice(MAZE_BR_ROW_HEIGHTS);

/** Half the playable square, m. */
export const MAZE_BR_HALF = COLUMN_LINES[MAZE_BR_CELLS]!;

/** X of lattice line `k` (the constant-X lines), m. */
export function mazeBrLineX(k: number): number {
  return COLUMN_LINES[k]!;
}
/** Z of lattice line `k` (the constant-Z lines), m. */
export function mazeBrLineZ(k: number): number {
  return ROW_LINES[k]!;
}
/** Centre of column `i`, m. */
export function mazeBrCellCenterX(i: number): number {
  return (COLUMN_LINES[i]! + COLUMN_LINES[i + 1]!) / 2;
}
/** Centre of row `j`, m. */
export function mazeBrCellCenterZ(j: number): number {
  return (ROW_LINES[j]! + ROW_LINES[j + 1]!) / 2;
}
/** Width of column `i`, m: the clear corridor is this minus the 0.3 m wall. */
export function mazeBrColumnWidth(i: number): number {
  return MAZE_BR_COLUMN_WIDTHS[i]!;
}
/** Height of row `j`, m. */
export function mazeBrRowHeight(j: number): number {
  return MAZE_BR_ROW_HEIGHTS[j]!;
}
/** The cell containing (x, z), or null outside the maze. */
export function mazeBrCellAt(x: number, z: number): [number, number] | null {
  const find = (lines: Float64Array, v: number): number => {
    for (let k = 0; k < MAZE_BR_CELLS; k++) if (v >= lines[k]! && v < lines[k + 1]!) return k;
    return -1;
  };
  const i = find(COLUMN_LINES, x);
  const j = find(ROW_LINES, z);
  return i < 0 || j < 0 ? null : [i, j];
}

const SEED = 0x6d61_7a65;
/** Fraction of dead ends opened into loops: a perfect maze plays badly, every fight has one way out. */
const BRAID = 0.25;
/** Share of the standing interior edges made of glass. */
const GLASS_FRACTION = 0.15;
/**
 * Glazed edges keep this far apart (m) so they spread over the maze instead of clustering into glass rooms. Two cells
 * at the map's commonest width, which is what "not the next wall along" means on this lattice — it was 9 m while the
 * lanes averaged 8.7 m and there were half as many edges to place panes on.
 */
const GLASS_MIN_SPACING = 8;
/**
 * Mirror panels. Each live one costs the client a render pass (world/props/MirrorWalls.ts), so these are counted, not
 * scattered: a handful of deliberate ones at T-junctions, where walking up the corridor shows you both branches.
 */
const MIRROR_COUNT = 10;
/** Mirrors keep this far apart, m: an eighth of the map's width, so they never share a corridor. */
const MIRROR_MIN_SPACING = 24;
/** Of `MIRROR_COUNT`, this many are taken first from the plaza approaches — the corridors everyone funnels through. */
const PLAZA_MIRRORS = 4;
/**
 * Share of the standing interior edges made of grass. Rarer than the glazed panels (15%) because a grass edge changes
 * the maze's shape, not just its sightlines: every one is a door nobody can see. Commoner than the mirrors (10 edges)
 * because a deception you meet once a match is a curiosity, not a mechanic. 8% is about a door per fifteen cells, so
 * you walk past several a match and can never assume the wall in front of you is one.
 */
const GRASS_FRACTION = 0.08;
/** Grass edges keep this far apart, m: wider than the glass spacing, since two near each other open a room, not a door. */
const GRASS_MIN_SPACING = 12;
/**
 * A grass edge is only worth walking through when the way round is longer, and only safe when the way round is not
 * *much* longer: the wall it replaces is then load-bearing for the maze's shape, and opening it collapses a whole
 * quarter of the map into a straight line. Detour is the walking distance in cells between the two cells the edge
 * separates, measured on the solid maze with the grass taken so far already opened (`pickGrass`).
 */
const GRASS_MIN_DETOUR = 3;
const GRASS_MAX_DETOUR = 10;
/**
 * "Plaza approach": edge midpoint this far from the tower, m (the plaza itself reaches 12 m). The outer bound was 36
 * while the nook picker could take a nook overlooking a lane that a later nook had shortened; tightening that
 * (`carveNooks`) moved a few walls and left only three T-junction candidates inside 36 m that are also 24 m apart, so
 * the ring reaches one corridor further out and `PLAZA_MIRRORS` of them fit again.
 */
const PLAZA_RING: readonly [number, number] = [14, 40];
/** Plaza: cells 13…15 on both axes, three 8 m lanes a side, which is x, z ∈ [-12, 12]. */
const PLAZA_COLUMNS: readonly [number, number] = [13, 15];
const PLAZA_ROWS: readonly [number, number] = [13, 15];
const inPlazaCell = (i: number, j: number): boolean =>
  i >= PLAZA_COLUMNS[0] && i <= PLAZA_COLUMNS[1] && j >= PLAZA_ROWS[0] && j <= PLAZA_ROWS[1];
/** Watchtower at the plaza centre, which the widths above put exactly on the origin. */
const TOWER: Vec2Tuple = [0, 0];

/**
 * The avenues: columns and rows opened end to end, so a shot can travel the whole 184 m. All three are boulevards —
 * a long lane that is also narrow is a corridor shoot, not a duel — and none of them runs through the plaza, whose
 * tower would block the very sightline the avenue exists for. Columns 8 and 21 stand at x = -38 and 42 and row 18 at
 * z = 26, which cuts the map into uneven blocks rather than quarters. The third boulevard on each axis (column 3, rows
 * 7 and 25) stays carved, so a wide lane is not automatically a 184 m one.
 */
const AVENUE_COLUMNS: readonly number[] = [8, 21];
const AVENUE_ROWS: readonly number[] = [18];

/** A rectangular block of cells, inclusive on both ends. */
interface CellBlock {
  readonly i0: number;
  readonly i1: number;
  readonly j0: number;
  readonly j1: number;
}

/** A 2 × 2 block whose south-west cell is `[i, j]`. */
const block = ([i, j]: readonly [number, number]): CellBlock => ({ i0: i, i1: i + 1, j0: j, j1: j + 1 });

/**
 * The corner-tower courtyards: the 2 × 2 blocks a `watchtower_small` stands in, one per quadrant. Each is 12 m across,
 * which leaves 3.2 m of walkable floor on every side of a 5.6 m tower foundation, so the stairs can always be reached
 * and the courtyard's own doorways are never the thing you have to squeeze past.
 */
const TOWER_ROOMS: readonly CellBlock[] = ([[1, 25], [27, 25], [1, 3], [27, 3]] as const).map(block);

/** Plain rooms: open ground that is not the plaza, spread over the map and clear of the plaza and the avenues. */
const PLAIN_ROOMS: readonly CellBlock[] = ([[11, 5], [16, 9], [11, 22]] as const).map(block);

const ROOMS: readonly CellBlock[] = [...TOWER_ROOMS, ...PLAIN_ROOMS];

/** Middle of a cell block. */
function blockCenter(b: CellBlock): Vec2Tuple {
  return [(mazeBrLineX(b.i0) + mazeBrLineX(b.i1 + 1)) / 2, (mazeBrLineZ(b.j0) + mazeBrLineZ(b.j1 + 1)) / 2];
}

/**
 * The four corner watchtowers, one per quadrant POI: the middle of each tower courtyard, which the lattice puts at
 * (±82 / 78, ±68 / 70) — about 25 m in from the map's corners and 18…22 m from the POI centre they belong to. They are
 * `watchtower_small` (two flights to a 6 m platform), never the plaza's `watchtower` (three flights to 9 m): from a
 * corner you see over the wall fabric around you, and the tower on the plaza still sees over you.
 */
/** Nothing else — spawns, cover — comes within this of a corner tower's centre, m. */
const TOWER_CLEARANCE = 8;

export const MAZE_BR_CORNER_TOWERS: readonly Vec2Tuple[] = TOWER_ROOMS.map(blockCenter);

/** True when (x, z) is inside the keep-out ring of a corner tower. */
function nearCornerTower(x: number, z: number, reach = TOWER_CLEARANCE): boolean {
  return MAZE_BR_CORNER_TOWERS.some((t) => (t[0] - x) ** 2 + (t[1] - z) ** 2 < reach * reach);
}

/** Direction indices: 0 = +X, 1 = -X, 2 = +Z, 3 = -Z. */
const DIR_DX = [1, -1, 0, 0] as const;
const DIR_DZ = [0, 0, 1, -1] as const;

/**
 * Wall lattice plus the glass and mirror masks. `v[k * cells + j]` is the segment on vertical line k (constant X) in
 * row j, which blocks movement along X; `h[k * cells + i]` is its mirror on horizontal line k (constant Z) in column i.
 * The glass and mirror arrays use the same indexing: 1 where the standing wall is that panel rather than concrete. A
 * wall is never both.
 */
export interface MazeBrGrid {
  readonly cells: number;
  readonly columnWidths: readonly number[];
  readonly rowHeights: readonly number[];
  readonly v: Uint8Array;
  readonly h: Uint8Array;
  readonly glassV: Uint8Array;
  readonly glassH: Uint8Array;
  readonly mirrorV: Uint8Array;
  readonly mirrorH: Uint8Array;
  /** Walk-through hedges. Like the mirrors these only ever replace concrete, so `v`/`h` still describe the solid maze. */
  readonly grassV: Uint8Array;
  readonly grassH: Uint8Array;
}

const vi = (k: number, j: number): number => k * MAZE_BR_CELLS + j;

/** Removes the wall on side `dir` of cell (i, j). */
function openWall(lat: MazeBrGrid, i: number, j: number, dir: number): void {
  if (dir === 0) lat.v[vi(i + 1, j)] = 0;
  else if (dir === 1) lat.v[vi(i, j)] = 0;
  else if (dir === 2) lat.h[vi(j + 1, i)] = 0;
  else lat.h[vi(j, i)] = 0;
}

/** Puts the wall on side `dir` of cell (i, j) back up. Only `carveNooks` builds walls; everything else removes them. */
function closeWall(lat: MazeBrGrid, i: number, j: number, dir: number): void {
  if (dir === 0) lat.v[vi(i + 1, j)] = 1;
  else if (dir === 1) lat.v[vi(i, j)] = 1;
  else if (dir === 2) lat.h[vi(j + 1, i)] = 1;
  else lat.h[vi(j, i)] = 1;
}

/** True when the wall on side `dir` of cell (i, j) is standing in the lattice (v, h). */
function isWalledIn(v: Uint8Array, h: Uint8Array, i: number, j: number, dir: number): boolean {
  if (dir === 0) return v[vi(i + 1, j)] === 1;
  if (dir === 1) return v[vi(i, j)] === 1;
  if (dir === 2) return h[vi(j + 1, i)] === 1;
  return h[vi(j, i)] === 1;
}

/** True when the wall on side `dir` of cell (i, j) is still standing. */
function isWalled(lat: MazeBrGrid, i: number, j: number, dir: number): boolean {
  return isWalledIn(lat.v, lat.h, i, j, dir);
}

function openSides(lat: MazeBrGrid, i: number, j: number): number {
  let n = 0;
  for (let dir = 0; dir < 4; dir++) if (!isWalled(lat, i, j, dir)) n++;
  return n;
}

/** Randomised depth-first carve (recursive backtracker), iterative so the stack can't blow up. */
function carve(lat: MazeBrGrid, rng: () => number): void {
  const cells = MAZE_BR_CELLS;
  const total = cells * cells;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const options = new Int32Array(4);

  let top = 0;
  stack[0] = (rng() * total) | 0;
  visited[stack[0]!] = 1;

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
    openWall(lat, i, j, dir);
    const next = cur + DIR_DX[dir]! + DIR_DZ[dir]! * cells;
    visited[next] = 1;
    stack[++top] = next;
  }
}

/** Deterministic Fisher-Yates. */
function shuffle<T>(list: T[], rng: () => number): void {
  for (let k = list.length - 1; k > 0; k--) {
    const swap = (rng() * (k + 1)) | 0;
    const tmp = list[k]!;
    list[k] = list[swap]!;
    list[swap] = tmp;
  }
}

/** Opens `BRAID` of the dead ends into loops, so a fight has flanking routes and a way to break contact. */
function braidDeadEnds(lat: MazeBrGrid, rng: () => number): void {
  const cells = MAZE_BR_CELLS;
  const ends: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) if (openSides(lat, i, j) === 1) ends.push(j * cells + i);
  }
  shuffle(ends, rng);
  const quota = Math.floor(ends.length * BRAID);
  const options = new Int32Array(4);

  for (let k = 0; k < quota; k++) {
    const cell = ends[k]!;
    const i = cell % cells;
    const j = (cell / cells) | 0;
    // An earlier braid may have already opened this one from the other side.
    if (openSides(lat, i, j) !== 1) continue;

    let n = 0;
    for (let dir = 0; dir < 4; dir++) {
      const ni = i + DIR_DX[dir]!;
      const nj = j + DIR_DZ[dir]!;
      if (ni < 0 || nj < 0 || ni >= cells || nj >= cells) continue; // never breach the perimeter
      if (isWalled(lat, i, j, dir)) options[n++] = dir;
    }
    if (n > 0) openWall(lat, i, j, options[(rng() * n) | 0]!);
  }
}

/**
 * Opens the avenues: every edge crossing the lane, from the south wall to the north one (or west to east). The
 * perimeter is untouched, so an avenue is a closed 184 m hall, not a way out of the map.
 */
function clearAvenues(lat: MazeBrGrid): void {
  for (const i of AVENUE_COLUMNS) for (let k = 1; k < MAZE_BR_CELLS; k++) lat.h[vi(k, i)] = 0;
  for (const j of AVENUE_ROWS) for (let k = 1; k < MAZE_BR_CELLS; k++) lat.v[vi(k, j)] = 0;
}

/** Opens the inside edges of each room block, leaving its outer walls (and the doors the carve left in them) alone. */
function clearRooms(lat: MazeBrGrid): void {
  for (const b of ROOMS) {
    for (let j = b.j0; j <= b.j1; j++) for (let i = b.i0; i < b.i1; i++) lat.v[vi(i + 1, j)] = 0;
    for (let i = b.i0; i <= b.i1; i++) for (let j = b.j0; j < b.j1; j++) lat.h[vi(j + 1, i)] = 0;
  }
}

/** Clears every edge that touches a plaza cell, leaving a 24 × 24 m square open on twelve corridor mouths. */
function clearPlaza(lat: MazeBrGrid): void {
  for (let j = PLAZA_ROWS[0]; j <= PLAZA_ROWS[1]; j++) {
    for (let i = PLAZA_COLUMNS[0]; i <= PLAZA_COLUMNS[1]; i++) {
      for (let dir = 0; dir < 4; dir++) openWall(lat, i, j, dir);
    }
  }
}

/** True when every cell can still be walked to from every other one. */
function allCellsConnected(lat: MazeBrGrid, seen: Uint8Array, stack: Int32Array): boolean {
  const cells = MAZE_BR_CELLS;
  seen.fill(0);
  seen[0] = 1;
  stack[0] = 0;
  let top = 1;
  let reached = 1;
  while (top > 0) {
    const cur = stack[--top]!;
    const i = cur % cells;
    const j = (cur / cells) | 0;
    for (let dir = 0; dir < 4; dir++) {
      const ni = i + DIR_DX[dir]!;
      const nj = j + DIR_DZ[dir]!;
      if (ni < 0 || nj < 0 || ni >= cells || nj >= cells) continue;
      if (isWalled(lat, i, j, dir)) continue;
      const next = nj * cells + ni;
      if (seen[next] === 1) continue;
      seen[next] = 1;
      reached++;
      stack[top++] = next;
    }
  }
  return reached === cells * cells;
}

// ---------------------------------------------------------------------------------------------------------------
// Nooks: "ngách bắn súng nhắm", the owner's name for them — a slot off the corridor you post up in and hold an angle
// down. A long lane with nothing but flat wall either side is a coin toss: whoever steps into it first is seen first.
// A nook makes the lane a position you can *take*, because standing in one puts your body out of the lane while your
// scope still covers it.
//
// The construction is the smallest thing that reads as one: a single cell beside a long run, its mouth opened onto
// that run and its other three sides sealed. That is the opposite of an alcove — an alcove is a dead end the loot
// generator pays you to walk into, a nook is a dead end that pays you to stay. They are kept apart deliberately:
// `findAlcoves` and `pickSpawns` both skip nook cells, and the glass, mirror and grass pickers skip their walls, so a
// nook is always solid on three sides and nobody can shoot you through the back of one.
// ---------------------------------------------------------------------------------------------------------------

/** How many nooks to cut. Enough that every avenue carries several and the long braided corridors get some too. */
const NOOK_COUNT = 16;
/** A straight open run this long, m, is worth covering — about a sixth of the map, or seven squeezes end to end. */
const NOOK_RUN_METRES = 28;
/** Nook mouths keep this far apart, m, so an avenue is lined with a few firing positions, not a colonnade. */
const NOOK_MIN_SPACING = 14;
/** A nook is a recess, not a room: neither of its sides is wider than a corridor. */
const NOOK_MAX_SIDE = MAZE_BR_WIDTHS.corridor;

/** Marks every cell lying on a straight open run at least `NOOK_RUN_METRES` long — the avenues and the long corridors. */
function longRunCells(lat: MazeBrGrid): Uint8Array {
  const cells = MAZE_BR_CELLS;
  const onRun = new Uint8Array(cells * cells);
  for (let j = 0; j < cells; j++) {
    let from = 0;
    let span = 0;
    for (let i = 0; i < cells; i++) {
      span += mazeBrColumnWidth(i);
      if (i + 1 < cells && !isWalled(lat, i, j, 0)) continue;
      if (span >= NOOK_RUN_METRES) for (let k = from; k <= i; k++) onRun[j * cells + k] = 1;
      from = i + 1;
      span = 0;
    }
  }
  for (let i = 0; i < cells; i++) {
    let from = 0;
    let span = 0;
    for (let j = 0; j < cells; j++) {
      span += mazeBrRowHeight(j);
      if (j + 1 < cells && !isWalled(lat, i, j, 2)) continue;
      if (span >= NOOK_RUN_METRES) for (let k = from; k <= j; k++) onRun[k * cells + i] = 1;
      from = j + 1;
      span = 0;
    }
  }
  return onRun;
}

/**
 * Metres of the straight open run through cell (i, j) along `axis` (0 = X, 1 = Z) on the lattice as it stands. The
 * nook picker uses this to confirm, after sealing, that the lane the nook faces is still long enough to be worth
 * holding: `longRunCells` is computed once before any nook is cut, and a nook's own walls can shorten a neighbour's
 * run, so the marks go stale as the nooks go in.
 */
function straightRun(lat: MazeBrGrid, i: number, j: number, axis: 0 | 1): number {
  let span = axis === 0 ? mazeBrColumnWidth(i) : mazeBrRowHeight(j);
  for (const step of [1, -1]) {
    let [ci, cj] = [i, j];
    for (;;) {
      const dir = axis === 0 ? (step > 0 ? 0 : 1) : step > 0 ? 2 : 3;
      if (isWalled(lat, ci, cj, dir)) break;
      ci += axis === 0 ? step : 0;
      cj += axis === 0 ? 0 : step;
      if (ci < 0 || cj < 0 || ci >= MAZE_BR_CELLS || cj >= MAZE_BR_CELLS) break;
      span += axis === 0 ? mazeBrColumnWidth(ci) : mazeBrRowHeight(cj);
    }
  }
  return span;
}

/**
 * Cuts the nooks. Candidates are cells that are *not* themselves on a long run (sealing one of those would cut the
 * corridor the nook exists to cover), are no wider than a corridor on either side, are clear of the plaza and the
 * rooms, and have at least one neighbour that is on a run. The tightest recesses are preferred — a 4 × 4 m slot reads
 * as a firing slit, an 8 × 8 m one reads as a small room — with a seeded shuffle breaking ties, and each one is taken
 * only if the maze is still one connected component afterwards. Sealing three sides is the only place this file adds
 * walls rather than removing them, so that check is not optional.
 */
function carveNooks(lat: MazeBrGrid, rng: () => number): Vec2Tuple[] {
  const cells = MAZE_BR_CELLS;
  const onRun = longRunCells(lat);
  const inPlaza = inPlazaCell;
  const roomCell = new Uint8Array(cells * cells);
  for (const b of ROOMS) {
    for (let j = b.j0; j <= b.j1; j++) for (let i = b.i0; i <= b.i1; i++) roomCell[j * cells + i] = 1;
  }

  interface Candidate {
    readonly i: number;
    readonly j: number;
    readonly dir: number;
    readonly x: number;
    readonly z: number;
    readonly size: number;
  }
  const candidates: Candidate[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const at = j * cells + i;
      if (onRun[at] === 1 || roomCell[at] === 1 || inPlaza(i, j)) continue;
      if (mazeBrColumnWidth(i) > NOOK_MAX_SIDE || mazeBrRowHeight(j) > NOOK_MAX_SIDE) continue;
      // Never next to the plaza: sealing a side there would wall up one of its twelve mouths.
      let touchesPlaza = false;
      for (let dir = 0; dir < 4; dir++) touchesPlaza ||= inPlaza(i + DIR_DX[dir]!, j + DIR_DZ[dir]!);
      if (touchesPlaza) continue;
      for (let dir = 0; dir < 4; dir++) {
        const li = i + DIR_DX[dir]!;
        const lj = j + DIR_DZ[dir]!;
        if (li < 0 || lj < 0 || li >= cells || lj >= cells) continue;
        if (onRun[lj * cells + li] !== 1) continue;
        candidates.push({ i, j, dir, x: mazeBrCellCenterX(i), z: mazeBrCellCenterZ(j), size: mazeBrColumnWidth(i) + mazeBrRowHeight(j) });
      }
    }
  }
  shuffle(candidates, rng);
  // Stable sort, so the shuffle above is what breaks ties between equally tight recesses.
  candidates.sort((a, b) => a.size - b.size);

  const taken: Vec2Tuple[] = [];
  const used = new Uint8Array(cells * cells);
  const seen = new Uint8Array(cells * cells);
  const stack = new Int32Array(cells * cells);
  const before = new Int32Array(4);
  const minSq = NOOK_MIN_SPACING * NOOK_MIN_SPACING;
  for (const c of candidates) {
    if (taken.length >= NOOK_COUNT) break;
    if (used[c.j * cells + c.i] === 1) continue;
    if (taken.some((o) => (o[0] - c.x) ** 2 + (o[1] - c.z) ** 2 < minSq)) continue;
    for (let dir = 0; dir < 4; dir++) before[dir] = isWalled(lat, c.i, c.j, dir) ? 1 : 0;
    openWall(lat, c.i, c.j, c.dir);
    for (let dir = 0; dir < 4; dir++) if (dir !== c.dir) closeWall(lat, c.i, c.j, dir);
    // A mouth facing ±X looks out at a lane running along Z, and the other way round. The lane has to still be long
    // after the sealing, not just when `longRunCells` marked it: a nook overlooking nothing is a hole in a wall.
    const laneAxis: 0 | 1 = c.dir < 2 ? 1 : 0;
    const lane = straightRun(lat, c.i + DIR_DX[c.dir]!, c.j + DIR_DZ[c.dir]!, laneAxis);
    if (lane < NOOK_RUN_METRES || !allCellsConnected(lat, seen, stack)) {
      for (let dir = 0; dir < 4; dir++) (before[dir] === 1 ? closeWall : openWall)(lat, c.i, c.j, dir);
      continue;
    }
    used[c.j * cells + c.i] = 1;
    taken.push([c.x, c.z]);
  }
  return taken;
}

/** One standing lattice edge: `axis` 0 = vertical line (constant X), 1 = horizontal line (constant Z). */
interface WallEdge {
  readonly axis: 0 | 1;
  readonly k: number;
  readonly index: number;
  readonly x: number;
  readonly z: number;
}

function standingInteriorEdges(lat: MazeBrGrid): WallEdge[] {
  const out: WallEdge[] = [];
  for (let k = 1; k < MAZE_BR_CELLS; k++) {
    for (let index = 0; index < MAZE_BR_CELLS; index++) {
      if (lat.v[vi(k, index)] === 1) out.push({ axis: 0, k, index, x: mazeBrLineX(k), z: mazeBrCellCenterZ(index) });
      if (lat.h[vi(k, index)] === 1) out.push({ axis: 1, k, index, x: mazeBrCellCenterX(index), z: mazeBrLineZ(k) });
    }
  }
  return out;
}

/** Cells either side of an interior edge: (k-1, index) and (k, index) along the edge's axis. */
function edgeCells(edge: WallEdge): readonly [number, number, number, number] {
  return edge.axis === 0 ? [edge.k - 1, edge.index, edge.k, edge.index] : [edge.index, edge.k - 1, edge.index, edge.k];
}

/** The nook cells as a mask, so the pickers below can leave a nook's three walls alone. */
function nookMask(nooks: readonly Vec2Tuple[]): Uint8Array {
  const mask = new Uint8Array(MAZE_BR_CELLS * MAZE_BR_CELLS);
  for (const [x, z] of nooks) {
    const cell = mazeBrCellAt(x, z);
    if (cell) mask[cell[1] * MAZE_BR_CELLS + cell[0]] = 1;
  }
  return mask;
}

/** True when the edge is one of a nook's sealed walls. */
function facesNook(mask: Uint8Array, e: WallEdge): boolean {
  const [ax, az, bx, bz] = edgeCells(e);
  return mask[az * MAZE_BR_CELLS + ax] === 1 || mask[bz * MAZE_BR_CELLS + bx] === 1;
}

/**
 * Picks the glass edges: a seeded shuffle, then greedily taken while they stay `GLASS_MIN_SPACING` apart, up to
 * `GLASS_FRACTION` of the interior edges. The spacing is what keeps them spread — a plain per-edge coin flip clumps
 * them into glass corners and glass rooms.
 */
function pickGlass(lat: MazeBrGrid, nooks: Uint8Array, rng: () => number): void {
  const interior = standingInteriorEdges(lat);
  const quota = Math.round(interior.length * GLASS_FRACTION);
  const candidates = interior.filter((e) => !facesNook(nooks, e));
  shuffle(candidates, rng);
  const taken: WallEdge[] = [];
  const minSq = GLASS_MIN_SPACING * GLASS_MIN_SPACING;
  for (const edge of candidates) {
    if (taken.length >= quota) break;
    if (taken.some((other) => (other.x - edge.x) * (other.x - edge.x) + (other.z - edge.z) * (other.z - edge.z) < minSq)) continue;
    taken.push(edge);
    (edge.axis === 0 ? lat.glassV : lat.glassH)[vi(edge.k, edge.index)] = 1;
  }
}

/**
 * Picks the mirror edges. Candidates are concrete edges that close off a T-junction cell — a cell with exactly three
 * open sides, so the mirror is the back wall of the T and everyone walking up the stem looks straight into it and sees
 * both branches. Then a seeded shuffle, `PLAZA_MIRRORS` taken from the plaza approaches first and the rest from the
 * whole maze, each kept `MIRROR_MIN_SPACING` from the ones already taken so they never share a corridor.
 */
function pickMirrors(lat: MazeBrGrid, nooks: Uint8Array, rng: () => number): void {
  const isGlass = (e: WallEdge) => (e.axis === 0 ? lat.glassV : lat.glassH)[vi(e.k, e.index)] === 1;
  const facesJunction = (e: WallEdge) => {
    const [ax, az, bx, bz] = edgeCells(e);
    return openSides(lat, ax, az) === 3 || openSides(lat, bx, bz) === 3;
  };
  const candidates = standingInteriorEdges(lat).filter((e) => !isGlass(e) && !facesNook(nooks, e) && facesJunction(e));
  shuffle(candidates, rng);

  const taken: WallEdge[] = [];
  const minSq = MIRROR_MIN_SPACING * MIRROR_MIN_SPACING;
  const spread = (e: WallEdge) => taken.every((o) => (o.x - e.x) * (o.x - e.x) + (o.z - e.z) * (o.z - e.z) >= minSq);
  const plazaDistance = (e: WallEdge) => Math.sqrt((e.x - TOWER[0]) ** 2 + (e.z - TOWER[1]) ** 2);

  for (const edge of candidates) {
    if (taken.length >= PLAZA_MIRRORS) break;
    const d = plazaDistance(edge);
    if (d < PLAZA_RING[0] || d > PLAZA_RING[1] || !spread(edge)) continue;
    taken.push(edge);
  }
  for (const edge of candidates) {
    if (taken.length >= MIRROR_COUNT) break;
    if (taken.includes(edge) || !spread(edge)) continue;
    taken.push(edge);
  }
  for (const edge of taken) (edge.axis === 0 ? lat.mirrorV : lat.mirrorH)[vi(edge.k, edge.index)] = 1;
}

/** Walking distance in cells from `start` to every cell over the lattice (v, h); -1 where unreachable. */
function cellDistances(v: Uint8Array, h: Uint8Array, start: number, dist: Int32Array, queue: Int32Array): void {
  const cells = MAZE_BR_CELLS;
  dist.fill(-1);
  dist[start] = 0;
  queue[0] = start;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const cur = queue[head++]!;
    const i = cur % cells;
    const j = (cur / cells) | 0;
    const next = dist[cur]! + 1;
    for (let dir = 0; dir < 4; dir++) {
      const ni = i + DIR_DX[dir]!;
      const nj = j + DIR_DZ[dir]!;
      if (ni < 0 || nj < 0 || ni >= cells || nj >= cells) continue;
      if (isWalledIn(v, h, i, j, dir)) continue;
      const at = nj * cells + ni;
      if (dist[at] !== -1) continue;
      dist[at] = next;
      queue[tail++] = at;
    }
  }
}

/**
 * Picks the grass edges: concrete only (never a glazed or mirrored one — a wall can only lie to you in one way), a
 * seeded shuffle, then greedily taken while they stay `GRASS_MIN_SPACING` apart, up to `GRASS_FRACTION` of the interior
 * edges.
 *
 * The extra rule, and the reason this runs a flood fill instead of a coin flip: a grass edge is a hole in the maze, and
 * a hole is only allowed where the way round is between `GRASS_MIN_DETOUR` and `GRASS_MAX_DETOUR` cells. Below the
 * floor it saves nothing and is only scenery; above the ceiling the wall was holding a whole quarter of the maze apart
 * and walking through it would turn a two-minute loop into a straight line. Distances are measured on a lattice with
 * the grass taken *so far* already opened, so two hedges can never compound into a shortcut neither would be allowed on
 * its own — which is the failure a per-edge rule would miss. Nothing here touches `v`/`h`: the solid maze, and every
 * test that flood-fills it, is unchanged.
 */
function pickGrass(lat: MazeBrGrid, nooks: Uint8Array, rng: () => number): void {
  const interior = standingInteriorEdges(lat);
  const quota = Math.round(interior.length * GRASS_FRACTION);
  const isPanel = (e: WallEdge) => {
    const at = vi(e.k, e.index);
    return (e.axis === 0 ? lat.glassV[at]! + lat.mirrorV[at]! : lat.glassH[at]! + lat.mirrorH[at]!) > 0;
  };
  const candidates = interior.filter((e) => !isPanel(e) && !facesNook(nooks, e));
  shuffle(candidates, rng);

  const looseV = Uint8Array.from(lat.v);
  const looseH = Uint8Array.from(lat.h);
  const dist = new Int32Array(MAZE_BR_CELLS * MAZE_BR_CELLS);
  const queue = new Int32Array(dist.length);
  const taken: WallEdge[] = [];
  const minSq = GRASS_MIN_SPACING * GRASS_MIN_SPACING;

  for (const edge of candidates) {
    if (taken.length >= quota) break;
    if (taken.some((o) => (o.x - edge.x) * (o.x - edge.x) + (o.z - edge.z) * (o.z - edge.z) < minSq)) continue;
    const [ax, az, bx, bz] = edgeCells(edge);
    cellDistances(looseV, looseH, az * MAZE_BR_CELLS + ax, dist, queue);
    const detour = dist[bz * MAZE_BR_CELLS + bx]!;
    if (detour < GRASS_MIN_DETOUR || detour > GRASS_MAX_DETOUR) continue;
    taken.push(edge);
    const at = vi(edge.k, edge.index);
    (edge.axis === 0 ? lat.grassV : lat.grassH)[at] = 1;
    (edge.axis === 0 ? looseV : looseH)[at] = 0;
  }
}

function buildMaze(seed: number): { readonly grid: MazeBrGrid; readonly nooks: readonly Vec2Tuple[] } {
  const size = (MAZE_BR_CELLS + 1) * MAZE_BR_CELLS;
  const grid: MazeBrGrid = {
    cells: MAZE_BR_CELLS,
    columnWidths: MAZE_BR_COLUMN_WIDTHS,
    rowHeights: MAZE_BR_ROW_HEIGHTS,
    v: new Uint8Array(size).fill(1),
    h: new Uint8Array(size).fill(1),
    glassV: new Uint8Array(size),
    glassH: new Uint8Array(size),
    mirrorV: new Uint8Array(size),
    mirrorH: new Uint8Array(size),
    grassV: new Uint8Array(size),
    grassH: new Uint8Array(size),
  };
  const rng = createRng(seed);
  carve(grid, rng);
  braidDeadEnds(grid, rng);
  clearAvenues(grid);
  clearRooms(grid);
  clearPlaza(grid);
  const nooks = carveNooks(grid, rng);
  const mask = nookMask(nooks);
  pickGlass(grid, mask, rng);
  pickMirrors(grid, mask, rng);
  pickGrass(grid, mask, rng);
  return { grid, nooks };
}

const MAZE = buildMaze(SEED);

/** The generated maze. Same seed => identical walls, on the client and on the server. */
export const MAZE_BR_GRID: MazeBrGrid = MAZE.grid;
/** Centres of the shooting nooks: one-cell recesses whose single mouth opens onto a long lane. */
export const MAZE_BR_NOOKS: readonly Vec2Tuple[] = MAZE.nooks;

const NOOK_CELLS = nookMask(MAZE_BR_NOOKS);

/** True when a player can walk from cell (i, j) through side `dir` (0 = +X, 1 = -X, 2 = +Z, 3 = -Z). */
export function mazeBrIsOpen(i: number, j: number, dir: number): boolean {
  return !isWalled(MAZE_BR_GRID, i, j, dir);
}

// ---------------------------------------------------------------------------------------------------------------
// Walls: props laid end to end along each standing edge. A 2 m squeeze takes one 2 m piece; every wider lane takes
// 4 m pieces, one on an alley, two on a corridor, three on a boulevard. Two lengths rather than one scaled prop
// because `PropPlacement.scale` is uniform: a half-length wall would also be half as tall and you would see over it.
// ---------------------------------------------------------------------------------------------------------------

/** Pieces an edge across a `width` m lane is made of. */
export function mazeBrEdgePieces(width: number): { readonly length: number; readonly count: number } {
  return width < MAZE_BR_WALL_PIECE
    ? { length: MAZE_BR_WALL_PIECE_SHORT, count: width / MAZE_BR_WALL_PIECE_SHORT }
    : { length: MAZE_BR_WALL_PIECE, count: width / MAZE_BR_WALL_PIECE };
}

/** The catalog id of a wall kind at a piece length: the short pieces are the same props with a `_2` suffix. */
export function mazeBrWallProp(kind: string, length: number): string {
  return length === MAZE_BR_WALL_PIECE_SHORT ? `${kind}_2` : kind;
}

const CONCRETE = "wall_concrete";
/** See-through, walk-into glass; whether bullets cross it depends on the pane's own clock (map/glassPhase.ts). */
const GLASS = "wall_glass";
/** Mirrored panel: concrete's box on the shoot-through layer, reflecting on the client. Opaque to sight, not to bullets. */
const MIRROR = "wall_mirror";
/** Hedge: as tall and as opaque as the concrete, with no collider at all. */
const GRASS = "wall_grass";

/** Which panel stands on an edge, from the three masks. The pickers keep them disjoint; the order here only breaks ties. */
function edgeProp(glass: Uint8Array, mirror: Uint8Array, grass: Uint8Array, at: number): string {
  if (glass[at] === 1) return GLASS;
  if (mirror[at] === 1) return MIRROR;
  return grass[at] === 1 ? GRASS : CONCRETE;
}

function wallProps(grid: MazeBrGrid): PropPlacement[] {
  const out: PropPlacement[] = [];
  const piece = (prop: string, x: number, z: number, yaw: number): void => {
    out.push({ prop, position: [round3(x), 0, round3(z)], yaw, snapToTerrain: true });
  };
  for (let k = 0; k <= MAZE_BR_CELLS; k++) {
    for (let index = 0; index < MAZE_BR_CELLS; index++) {
      // Vertical line (constant X): the wall runs along Z, so its local X points at -Z (yaw = atan2(-dz, dx)).
      if (grid.v[vi(k, index)] === 1) {
        const kind = edgeProp(grid.glassV, grid.mirrorV, grid.grassV, vi(k, index));
        const { length, count } = mazeBrEdgePieces(mazeBrRowHeight(index));
        const prop = mazeBrWallProp(kind, length);
        const x = mazeBrLineX(k);
        const from = mazeBrLineZ(index);
        for (let p = 0; p < count; p++) piece(prop, x, from + (p + 0.5) * length, -HALF_PI);
      }
      // Horizontal line (constant Z): the wall runs along X, so local X is world X.
      if (grid.h[vi(k, index)] === 1) {
        const kind = edgeProp(grid.glassH, grid.mirrorH, grid.grassH, vi(k, index));
        const { length, count } = mazeBrEdgePieces(mazeBrColumnWidth(index));
        const prop = mazeBrWallProp(kind, length);
        const z = mazeBrLineZ(k);
        const from = mazeBrLineX(index);
        for (let p = 0; p < count; p++) piece(prop, from + (p + 0.5) * length, z, 0);
      }
    }
  }
  return out;
}

/**
 * Distance from (x, z) to the nearest wall piece's collider box, m. Hedges have no collider at all, so they are not
 * walls to anything that has to walk or stand and are skipped. Used to pick spawn spots on this lattice, where the
 * lane a point sits in no longer says how clear it is: a squeeze whose side walls are both carved away is as open as
 * a corridor, and a corridor cell can be boxed in on three sides.
 */
function wallClearance(x: number, z: number): number {
  let best = Infinity;
  for (const wall of MAZE_BR_WALLS) {
    const collision = getMapProp(wall.prop).collision;
    if (collision.kind !== "box") continue;
    const dx = x - wall.position[0];
    const dz = z - wall.position[2];
    if (Math.abs(dx) > 8 || Math.abs(dz) > 8) continue;
    // Into the piece's local frame: local X runs along the wall (yaw turns +X toward (cos, -sin)).
    const lx = dx * Math.cos(wall.yaw) - dz * Math.sin(wall.yaw);
    const lz = dx * Math.sin(wall.yaw) + dz * Math.cos(wall.yaw);
    const ox = Math.max(0, Math.abs(lx) - collision.size[0] / 2);
    const oz = Math.max(0, Math.abs(lz) - collision.size[2] / 2);
    const d = Math.sqrt(ox * ox + oz * oz);
    if (d < best) best = d;
  }
  return best;
}

/** Distance from (x, z) to the nearest wall piece's *placement*, m — the metric `validateMapLayout` holds spawns to. */
function wallPieceDistance(x: number, z: number): number {
  let best = Infinity;
  for (const wall of MAZE_BR_WALLS) {
    if (getMapProp(wall.prop).collision.kind === "none") continue;
    const dx = x - wall.position[0];
    const dz = z - wall.position[2];
    if (Math.abs(dx) > 8 || Math.abs(dz) > 8) continue;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < best) best = d;
  }
  return best;
}

export const MAZE_BR_WALLS: readonly PropPlacement[] = wallProps(MAZE_BR_GRID);

// ---------------------------------------------------------------------------------------------------------------
// Terrain: flat. Only a few centimeters of detail noise so the ground isn't a dead-flat plane; every landform
// amplitude is zero. The out-of-bounds mountains start at the outer wall (foothillInset 0), and the grid is 384 m
// wide so the 46 m ramp still fits between the 92 m playable edge and the terrain's own edge.
// ---------------------------------------------------------------------------------------------------------------

export const MAZE_BR_TERRAIN: TerrainSpec = {
  version: 1,
  seed: 0x7b0b_0002,
  // The renderer chunks terrain at 128 cells and requires `chunkCells` to divide `resolution - 1`
  // (TERRAIN_RENDER_DEFAULTS, world/terrain/TerrainRenderer.ts), so size must be a multiple of 128.
  // 384 leaves 100 m outside the 184 m playable square, comfortably clearing the 46 m border ramp; 256 would not.
  size: 384,
  resolution: 385,
  playableHalfExtent: MAZE_BR_HALF,
  relief: {
    baseHeight: 20,
    macroAmplitude: 0,
    macroWavelength: 400,
    hillAmplitude: 0,
    hillWavelength: 120,
    detailAmplitude: 0.05,
    detailWavelength: 18,
    warp: 0,
  },
  border: {
    foothillInset: 0,
    rampDistance: 46,
    height: 80,
    ridgeWavelength: 120,
  },
  features: [],
};

// ---------------------------------------------------------------------------------------------------------------
// Points of interest: the tower plaza in the middle and one per corner. They are what loot generation and the team
// spawn plan read, and their pads below are the grids the outdoor loot generator walks.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Corner POI centres, given as lattice cells rather than round numbers: a POI centre has to sit at least 2 m clear of
 * every wall (`validateMapLayout`) and on a lattice this narrow only a corridor or boulevard cell is wide enough for
 * that. Columns 4 and 24 are 8 m, row 4 is 8 m and row 25 is a boulevard, which puts the four centres at (±60, 66) and
 * (±60, -68): far enough from the plaza to clear the validator's POI spacing, near enough to the quarter centres that
 * each one owns its corner of the map.
 */
/**
 * Why the quarters are `military` and not `village`: `kind` is the only lever a map has over the weapon table, and
 * `military` is the one that multiplies the sniper weight (`LOOT.militarySniperScale`). On the uniform 144 m maze the
 * K-98 was dead weight — the longest sightline was 42 m — so a village's rifle-and-shotgun mix was right. The three
 * avenues opened this map up to a 184 m hall, and a long gun now has somewhere to matter, so every quarter reads as
 * military and the corner watchtowers stock accordingly. At tier 1 that takes the sniper from 16/106 of the table to
 * 24/114, roughly a fifth of the guns you find instead of an eighth, which is the "đa dạng loại vũ khí hơn" the owner
 * asked for without making the map a sniper map.
 */
const QUADRANT_CELLS: readonly (readonly [string, string, number, number])[] = [
  ["north_east", "North-East Quarter", 24, 25],
  ["north_west", "North-West Quarter", 4, 25],
  ["south_east", "South-East Quarter", 24, 4],
  ["south_west", "South-West Quarter", 4, 4],
];
const QUADRANT_RADIUS = 36;
const PLAZA_RADIUS = 30;

export const MAZE_BR_POIS: readonly PointOfInterest[] = [
  { id: "plaza", name: "Tower Plaza", kind: "military", center: [TOWER[0], TOWER[1]], radius: PLAZA_RADIUS, lootTier: 2 },
  ...QUADRANT_CELLS.map(
    ([id, name, i, j]): PointOfInterest => ({
      id,
      name,
      kind: "military",
      center: [mazeBrCellCenterX(i), mazeBrCellCenterZ(j)],
      radius: QUADRANT_RADIUS,
      lootTier: 1,
    }),
  ),
];

/**
 * POI spacing for a 184 m square: the defaults (120 m between any two POI centres) are written for the 500 m maps and
 * nothing fits inside a maze at that spacing. Pass this to `validateMapLayout`, the way the real-world maps pass theirs.
 */
export const MAZE_BR_VALIDATION: ValidationOptions = { poiSpacing: 60, minorPoiSpacing: 50, minorPoiRadius: 40 };

function nearestPoi(x: number, z: number): PointOfInterest {
  let best = MAZE_BR_POIS[0]!;
  let bestSq = Infinity;
  for (const poi of MAZE_BR_POIS) {
    const d = (poi.center[0] - x) ** 2 + (poi.center[1] - z) ** 2;
    if (d < bestSq) [best, bestSq] = [poi, d];
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Alcoves: dead ends that pay. A dead end in the old map was pure punishment — you walked in, found nothing and
// walked back out past whoever had followed you. These are dead ends that lie inside a POI (the loot generator only
// grids a pad whose centre is in one), each given a pad of its own below. Nook cells are dead ends too and are
// skipped here on purpose: a nook is a place to shoot from, not a place to loot.
// ---------------------------------------------------------------------------------------------------------------

/** Alcoves keep this far apart, m, so the reward is spread rather than pooled in one corner. */
const ALCOVE_MIN_SPACING = 20;
const ALCOVE_COUNT = 14;

function findAlcoves(lat: MazeBrGrid): Vec2Tuple[] {
  const ends: Vec2Tuple[] = [];
  for (let j = 0; j < MAZE_BR_CELLS; j++) {
    for (let i = 0; i < MAZE_BR_CELLS; i++) {
      if (openSides(lat, i, j) !== 1) continue;
      if (NOOK_CELLS[j * MAZE_BR_CELLS + i] === 1) continue;
      const at: Vec2Tuple = [mazeBrCellCenterX(i), mazeBrCellCenterZ(j)];
      const poi = nearestPoi(at[0], at[1]);
      if ((poi.center[0] - at[0]) ** 2 + (poi.center[1] - at[1]) ** 2 > poi.radius * poi.radius) continue;
      ends.push(at);
    }
  }
  const rng = createRng(SEED ^ 0xa1c0);
  shuffle(ends, rng);
  const taken: Vec2Tuple[] = [];
  const minSq = ALCOVE_MIN_SPACING * ALCOVE_MIN_SPACING;
  for (const end of ends) {
    if (taken.length >= ALCOVE_COUNT) break;
    if (taken.some((o) => (o[0] - end[0]) ** 2 + (o[1] - end[1]) ** 2 < minSq)) continue;
    taken.push(end);
  }
  return taken;
}

export const MAZE_BR_ALCOVES: readonly Vec2Tuple[] = findAlcoves(MAZE_BR_GRID);

// ---------------------------------------------------------------------------------------------------------------
// Flatten: the tower plaza pad (the tower needs level ground) and the loot pads. The terrain is already flat, so
// these only level out the few centimeters of detail noise — and, more importantly, they are the pads the loot
// generator grids over (`generateOutdoorLoot` walks every pad whose centre lies inside a POI on a 9 m lattice and
// rolls once per point at that POI's tier). A maze has no roads, so there is no roadside loot and these pads carry
// the whole map's ground loot on their own.
// ---------------------------------------------------------------------------------------------------------------

/**
 * One big pad per quarter of the map, each centred inside its corner POI, so the loot lattice reaches the corridors
 * between the POIs instead of only the POI circles: a point inside a POI rolls that POI's loot, the rest roll tier 0.
 * Half extents stop 2 m short of the outer wall so no flatten reaches into the out-of-bounds mountains.
 */
const QUARTER_PAD = 46;
const QUARTER_PAD_HALF = 44;
/**
 * One more interleaved quarter pad, half the 9 m loot lattice further out. The generator only drops a pile where the
 * point is 1 m clear of every prop, and the clear band in a lane is its width minus 2 m — so a 4 m squeeze gives up
 * half its length and a single 9 m grid loses about a third of its points to the walls. The offset copy puts them back.
 */
const QUARTER_PAD_OFFSETS: readonly number[] = [QUARTER_PAD + 4.5];
const quarterPadHalf = (offset: number): number => MAZE_BR_HALF - 2 - offset;
/** Rolls per alcove. One roll at the pad's own tier would leave two alcoves in three empty, which is not a reward. */
const ALCOVE_ROLLS = 4;
/** Alcove pad radius: big enough for the loot lattice to hold the cell centre, small enough to hold only that. */
const ALCOVE_PAD_RADIUS = 6.5;
/**
 * What a loot lattice point on this map rolls (`PadLoot`, map/types.ts). Both halves of it are here because the maze
 * is the one map whose ground loot is not a garnish:
 * - `style: "pile"` — the global default for an outdoor point is a *gun cache*: a gun, its ammo and one more roll at
 *   50%. That is right for Map v1, where 88% of the piles are inside buildings and the roadside caches are the extra.
 *   The maze has five buildings, so 86% of its piles are lattice points, and the cache rule made the whole map guns
 *   and ammo: 200 guns a match against 30 throwables, 33 heals and 38 pieces of armor — ten rifles and one and a half
 *   grenades per player. A `pile` point rolls exactly what a building loot spot rolls, so medicine, armor, boosts and
 *   throwables (the "bom lửa" the owner could never find) come off the maze floor like they come out of a house.
 * - `density` — and then a little more of everything, which is the other half of the ask. Kept deliberately small:
 *   per player this map is already far denser than Map v1, and the complaint is about what a lane turns up as you
 *   walk it, not about the total.
 */
const PAD_LOOT: PadLoot = { style: "pile", density: 1.25 };

const PADS: readonly FlattenRegion[] = [
  // The plaza itself, paved: 3 × 3 cells with the tower in the middle.
  { shape: "rect", center: TOWER, halfExtents: [12, 12], falloff: 4, height: "auto", surface: "road", surfaceFalloff: 1, loot: PAD_LOOT },
  // Two rings round the plaza, the second offset by half the loot lattice, so the map's one tier-2 POI is also its
  // densest: the plaza is worth the exposure.
  { shape: "circle", center: TOWER, radius: 28, falloff: 6, height: "auto", loot: PAD_LOOT },
  { shape: "circle", center: [TOWER[0] + 4.5, TOWER[1] + 4.5], radius: 24, falloff: 6, height: "auto", loot: PAD_LOOT },
  // Alcove pads, before the quarter pads so a dead end wins its pile against the lattice running past its mouth.
  ...MAZE_BR_ALCOVES.flatMap((at) =>
    Array.from({ length: ALCOVE_ROLLS }, (): FlattenRegion => ({ shape: "circle", center: at, radius: ALCOVE_PAD_RADIUS, falloff: 2, height: "auto", loot: PAD_LOOT })),
  ),
  // A level pad under each corner tower, the way the plaza pad levels the ground under the big one.
  ...MAZE_BR_CORNER_TOWERS.map((at): FlattenRegion => ({ shape: "rect", center: at, halfExtents: [4, 4], falloff: 3, height: "auto", loot: PAD_LOOT })),
  // One pad per quarter, tiling the playable square, and a second one offset by half the 9 m loot lattice. The offset
  // copy is what the plaza already does with its two rings, and the maze needs it now: the lattice only drops a pile
  // where the point is 1 m clear of every wall, and on a 30 × 30 lattice of mostly 4 m lanes a single 9 m grid loses
  // about a third of its points to the walls. Two interleaved grids put the ground loot back where it was.
  ...([[1, 1], [-1, 1], [1, -1], [-1, -1]] as const).flatMap(([sx, sz]): FlattenRegion[] => [
    { shape: "rect", center: [sx * QUARTER_PAD, sz * QUARTER_PAD], halfExtents: [QUARTER_PAD_HALF, QUARTER_PAD_HALF], falloff: 2, height: "auto", loot: PAD_LOOT },
    ...QUARTER_PAD_OFFSETS.map((offset): FlattenRegion => ({
      shape: "rect",
      center: [sx * offset, sz * offset],
      halfExtents: [quarterPadHalf(offset), quarterPadHalf(offset)],
      falloff: 2,
      height: "auto",
      loot: PAD_LOOT,
    })),
  ]),
];

// ---------------------------------------------------------------------------------------------------------------
// Buildings: the plaza watchtower, the one place you can see the whole maze from, plus a small tower in each corner
// courtyard. The corner ones are `watchtower_small` — two flights to a 6 m platform against the plaza tower's three
// to 9 m — so a corner gives you the block around you and the middle still gives you the map.
// ---------------------------------------------------------------------------------------------------------------

const BUILDINGS: readonly MapBuilding[] = [
  { id: "plaza_tower", prefab: "watchtower", position: [TOWER[0], 0, TOWER[1]], yaw: 0, snapToTerrain: true, poi: "plaza" },
  ...MAZE_BR_CORNER_TOWERS.map((at): MapBuilding => {
    const poi = nearestPoi(at[0], at[1]);
    return { id: `${poi.id}_tower`, prefab: "watchtower_small", position: [at[0], 0, at[1]], yaw: 0, snapToTerrain: true, poi: poi.id };
  }),
];

// ---------------------------------------------------------------------------------------------------------------
// Spawns: four per POI, on open cell centres. Only cells at least 8 m wide on both axes qualify — the centre of a 4 m
// squeeze is 1.85 m from the wall face, inside the validator's 2 m — never an avenue cell, because a team that lands
// in a 184 m hall is visible to half the map before it can move, and never a nook, which is a sealed dead end. On top
// of the width rule each candidate is measured against the walls that were actually built, twice: against the collider
// boxes (what a player stands clear of) and against the piece placements (the metric `validateMapLayout` uses). The
// width rule alone says nothing about the walls a carve happened to leave standing around a cell.
//
// Seventeen of the thirty lanes on each axis are squeezes, so cells wide enough to land in are scarce and scattered:
// `SPAWN_POI_REACH` is what keeps four of them within reach of each POI. A candidate still has to be nearer its own
// POI than any other, so the reach only widens the ring; it never lets a team land in the next quarter.
// ---------------------------------------------------------------------------------------------------------------

/** Spawns stay this far inside the playable edge (`validateMapLayout` requires 20 m) and this far from each other. */
const SPAWN_EDGE_MARGIN = 20;
const SPAWN_MIN_SPACING = 16;
const SPAWNS_PER_POI = 4;
/** A spawn stays inside its POI's ring: the centre plus this, so a team lands on the place it landed for. */
const SPAWN_POI_REACH = 30;
/** Clearance a spawn keeps from a wall's collider box and from a wall piece's placement, m. Both are floors of 2 m. */
const SPAWN_WALL_CLEARANCE = 2.4;
const SPAWN_PIECE_CLEARANCE = 2.6;

function pickSpawns(): Vec2Tuple[] {
  const avenueColumn = new Set(AVENUE_COLUMNS);
  const avenueRow = new Set(AVENUE_ROWS);
  const candidates = new Map<string, Vec2Tuple[]>();
  for (let j = 0; j < MAZE_BR_CELLS; j++) {
    for (let i = 0; i < MAZE_BR_CELLS; i++) {
      if (avenueColumn.has(i) || avenueRow.has(j)) continue;
      if (NOOK_CELLS[j * MAZE_BR_CELLS + i] === 1) continue;
      // Never inside the plaza: the tower stands in the middle of it and a spawn there fails the 2 m clearance.
      if (inPlazaCell(i, j)) continue;
      if (mazeBrColumnWidth(i) < MAZE_BR_WIDTHS.corridor || mazeBrRowHeight(j) < MAZE_BR_WIDTHS.corridor) continue;
      const at: Vec2Tuple = [mazeBrCellCenterX(i), mazeBrCellCenterZ(j)];
      if (Math.abs(at[0]) > MAZE_BR_HALF - SPAWN_EDGE_MARGIN || Math.abs(at[1]) > MAZE_BR_HALF - SPAWN_EDGE_MARGIN) continue;
      if (wallClearance(at[0], at[1]) < SPAWN_WALL_CLEARANCE) continue;
      if (wallPieceDistance(at[0], at[1]) < SPAWN_PIECE_CLEARANCE) continue;
      // A corner tower fills its courtyard; landing on its foundation is a spawn inside a building.
      if (nearCornerTower(at[0], at[1])) continue;
      const poi = nearestPoi(at[0], at[1]);
      const reach = poi.radius + SPAWN_POI_REACH;
      if ((poi.center[0] - at[0]) ** 2 + (poi.center[1] - at[1]) ** 2 > reach * reach) continue;
      const list = candidates.get(poi.id) ?? [];
      list.push(at);
      candidates.set(poi.id, list);
    }
  }

  const out: Vec2Tuple[] = [];
  const minSq = SPAWN_MIN_SPACING * SPAWN_MIN_SPACING;
  const spreadOf = (at: Vec2Tuple, taken: readonly Vec2Tuple[]): number => {
    let best = Infinity;
    for (const o of out) best = Math.min(best, (o[0] - at[0]) ** 2 + (o[1] - at[1]) ** 2);
    for (const o of taken) best = Math.min(best, (o[0] - at[0]) ** 2 + (o[1] - at[1]) ** 2);
    return best;
  };
  // Scarcest POI first. The pools are very uneven on this lattice — the plaza has a couple of dozen wide cells within
  // reach and a corner POI barely more than the four it needs — and whoever picks first takes the shared spots on the
  // boundary between two POIs. Letting the rich pool go first left the north-west corner one spawn short.
  const order = [...MAZE_BR_POIS].sort((a, b) => (candidates.get(a.id)?.length ?? 0) - (candidates.get(b.id)?.length ?? 0) || (a.id < b.id ? -1 : 1));
  for (const poi of order) {
    const list = candidates.get(poi.id) ?? [];
    const near = (at: Vec2Tuple) => (at[0] - poi.center[0]) ** 2 + (at[1] - poi.center[1]) ** 2;
    list.sort((a, b) => near(a) - near(b) || a[0] - b[0] || a[1] - b[1]);
    // The spot nearest the POI, then farthest-point sampling: four that ring it instead of sharing one corridor.
    const taken: Vec2Tuple[] = [];
    for (const at of list) {
      if (spreadOf(at, taken) < minSq) continue;
      taken.push(at);
      break;
    }
    while (taken.length < SPAWNS_PER_POI) {
      let best: Vec2Tuple | null = null;
      // `SPAWN_MIN_SPACING` is a floor, so a candidate exactly that far from everything taken still counts; the epsilon
      // is what makes "at least 16 m" mean it, and the first such candidate wins the tie.
      let bestScore = minSq - 1e-9;
      for (const at of list) {
        const spread = spreadOf(at, taken);
        if (spread <= bestScore) continue;
        bestScore = spread;
        best = at;
      }
      if (!best) break;
      taken.push(best);
    }
    out.push(...taken);
  }
  return out;
}

const SPAWN_SPOTS: readonly Vec2Tuple[] = pickSpawns();

/** Faces the nearest POI centre, so a team starts looking at what it landed for. */
function spawnYaw(at: Vec2Tuple): number {
  const best = nearestPoi(at[0], at[1]);
  return round3(Math.atan2(best.center[0] - at[0], best.center[1] - at[1]));
}

export const MAZE_BR_SPAWNS: readonly MapSpawn[] = SPAWN_SPOTS.map((at) => ({ position: at, yaw: spawnYaw(at) }));

// ---------------------------------------------------------------------------------------------------------------
// Cover: waist-high props, only where the walls leave space. An avenue with nothing in it is a 184 m death run rather
// than a risk worth taking, and a 2 × 2 room with nothing in it is a lobby. Everything here is under 1.4 m and sits
// off the lane's centre line, so it is cover to a crouching player and never blocks the sightline the avenue is for.
// All of them are catalog category "prop", which is what keeps them out of the road-surface validator.
// ---------------------------------------------------------------------------------------------------------------

const AVENUE_COVER = ["sandbag_barrier", "road_barrier", "car_wreck"] as const;
/**
 * Room cover is compact on purpose. A `sandbag_barrier` is 4.5 m long, which is longer than the squeeze it sits beside:
 * one laid in a small room cell reached straight through the doorway beyond it and sealed the corridor, and the nav
 * grid lost a whole pocket of the maze to it. Nothing here is over 1.4 m, and `place` below refuses any piece whose
 * collider would overlap a wall at all.
 */
const ROOM_COVER = ["crate_military", "cable_spool", "crate_military_long"] as const;
/** Cover keeps this far from the lane's centre line, m: enough to leave the long shot open. */
const COVER_OFFSET = 3.6;
/** Cover keeps this far from a spawn, m, so nobody lands inside a barrier. */
const COVER_SPAWN_CLEARANCE = 4;
/** …and this far from a corner tower's centre, m: the foundation is 2.8 m and its stair needs the floor beside it. */
const COVER_TOWER_CLEARANCE = 6;

function coverProps(): PropPlacement[] {
  const out: PropPlacement[] = [];
  const rng = createRng(SEED ^ 0xc07e);
  const place = (prop: string, x: number, z: number, yaw: number): void => {
    if (SPAWN_SPOTS.some((s) => (s[0] - x) ** 2 + (s[1] - z) ** 2 < COVER_SPAWN_CLEARANCE ** 2)) return;
    // Clear of the corner towers: a barrier against a tower's foundation blocks its one stair.
    if (nearCornerTower(x, z, COVER_TOWER_CLEARANCE)) return;
    // And clear of the walls. Most lanes are 2 m wide, so a piece of cover that overlaps a wall is a piece of cover
    // lying across the corridor behind it: it would wall off part of the maze, which is not cover, it is a bug.
    const collision = getMapProp(prop).collision;
    const reach = collision.kind === "box" ? Math.max(collision.size[0], collision.size[2]) / 2 : collision.kind === "cylinder" ? collision.radius : 0;
    if (wallClearance(x, z) < reach) return;
    out.push({ prop, position: [round3(x), 0, round3(z)], yaw: round3(yaw), snapToTerrain: true });
  };

  // Avenues: a piece every fourth cell, alternating sides of the lane. The lattice is 30 cells now, not 22, so the
  // step went from three cells to four to keep the barriers about as far apart on the ground as they were.
  for (const i of AVENUE_COLUMNS) {
    const x = mazeBrCellCenterX(i);
    for (let j = 1; j < MAZE_BR_CELLS; j += 4) {
      place(AVENUE_COVER[(rng() * AVENUE_COVER.length) | 0]!, x + (j % 2 === 0 ? COVER_OFFSET : -COVER_OFFSET), mazeBrCellCenterZ(j), -HALF_PI);
    }
  }
  for (const j of AVENUE_ROWS) {
    const z = mazeBrCellCenterZ(j);
    for (let i = 1; i < MAZE_BR_CELLS; i += 4) {
      place(AVENUE_COVER[(rng() * AVENUE_COVER.length) | 0]!, mazeBrCellCenterX(i), z + (i % 2 === 0 ? COVER_OFFSET : -COVER_OFFSET), 0);
    }
  }

  // Rooms: two pieces each, on the diagonal of the block's open middle. The tower courtyards drop theirs to the
  // `COVER_TOWER_CLEARANCE` rule above, which is the point — a tower's floor stays walkable all the way round.
  const ROOM_COVER_OFFSET = 2;
  for (const b of ROOMS) {
    const [cx, cz] = blockCenter(b);
    place(ROOM_COVER[(rng() * ROOM_COVER.length) | 0]!, cx - ROOM_COVER_OFFSET, cz - ROOM_COVER_OFFSET, 0);
    place(ROOM_COVER[(rng() * ROOM_COVER.length) | 0]!, cx + ROOM_COVER_OFFSET, cz + ROOM_COVER_OFFSET, HALF_PI);
  }

  // Plaza: four barriers clear of the tower's entrances, so its twelve mouths are not all held from the middle.
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
    place("sandbag_barrier", sx * 8.5, sz * 8.5, sx * sz > 0 ? 0 : HALF_PI);
  }
  return out;
}

export const MAZE_BR_COVER: readonly PropPlacement[] = coverProps();

// ---------------------------------------------------------------------------------------------------------------
// Scatter: grass only, expanded by the client near the viewer. Nothing that blocks a corridor or a sightline — the
// walls are the whole map.
// ---------------------------------------------------------------------------------------------------------------

const EDGE = MAZE_BR_HALF - 1;
const PLAYABLE: Vec2Tuple[] = [
  [-EDGE, -EDGE],
  [EDGE, -EDGE],
  [EDGE, EDGE],
  [-EDGE, EDGE],
];

const SCATTERS: readonly ScatterRule[] = [
  {
    id: "grass",
    props: [
      { prop: "grass_clump_short", weight: 3 },
      { prop: "grass_clump_medium", weight: 2 },
      { prop: "grass_clump_tall", weight: 1 },
    ],
    area: PLAYABLE,
    density: 18,
    mask: { wavelength: 26, threshold: 0.42, softness: 0.2 },
    excludeSurfaces: ["road"],
    scaleRange: [0.7, 1.2],
    detail: true,
  },
];

// ---------------------------------------------------------------------------------------------------------------

export const MAZE_BR: MapData = {
  id: "mazebr",
  name: "Maze",
  terrain: MAZE_BR_TERRAIN,
  flatten: PADS,
  bounds: { outOfBoundsGraceSeconds: 10, killY: -40, landingAltitude: 200 },
  pois: MAZE_BR_POIS,
  buildings: BUILDINGS,
  props: [...MAZE_BR_WALLS, ...MAZE_BR_COVER],
  scatters: SCATTERS,
  spawns: MAZE_BR_SPAWNS,
};
