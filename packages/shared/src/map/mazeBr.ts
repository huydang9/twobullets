import { createRng } from "../equipment/math";
import { round3 } from "./layout/geometry";
import type { ScatterRule } from "./layout/scatter";
import type { ValidationOptions } from "./layout/validate";
import type { FlattenRegion, MapBuilding, MapData, MapSpawn, PointOfInterest, PropPlacement, TerrainSpec, Vec2Tuple } from "./types";

/**
 * Maze: a battle-royale map that is one big concrete maze. Unlike the `?map=maze` arena (a LevelData level, see
 * level/maze.ts) this is real MapData, so bots, loot, spawns and the shrinking zone all work on it.
 *
 * Layout conventions (meters, +X east, +Z north, yaw 0 = facing +Z, π/2 = facing +X; walls run along their own local X):
 * - 18 × 18 cells on an 8 m lattice => a 144 × 144 m playable square centred on the origin, x, z ∈ [-72, 72].
 * - `playableHalfExtent` is exactly that 72 m, so the out-of-bounds mountains start at the outer wall: there is no
 *   walkable band around the maze for players to run laps in, and landing targets always land inside it.
 * - Cell (i, j) has its centre at (-68 + 8i, -68 + 8j); lattice line k lies at -72 + 8k, k = 0…18. Lines 0 and 18 are
 *   the perimeter and are never carved, so the maze is a closed box.
 * - Every standing lattice edge is two `wall_concrete` props end to end (4 m each, centres ±2 m from the edge
 *   midpoint), ~2.2 m visible after the catalog's 0.4 m sink. About 15% of the interior edges are glazed instead: same
 *   box, see-through, not walk-through, and every one of them switching between stopping bullets and letting them
 *   through every ten seconds on a clock of its own, with a tell you can read (`wall_glass`, map/glassPhase.ts — this
 *   replaced the old pair of look-alike panes, one of which stopped bullets forever). Ten more edges
 *   are `wall_mirror`: opaque, and since 2026-09-18 shoot-through like the glass, so rounds cross it and leave a hole.
 *   The client reflects players in the nearest few of them, so you can catch an enemy coming round a corner — and
 *   anyone can shoot straight back through the wall they saw you in. Mirrors only ever replace concrete edges.
 *   About 8% more are `wall_grass`: a hedge you cannot see through that has no collider at all, so you and your bullets
 *   walk through it and it hides you while you stand in it. Grass only ever replaces concrete edges, and only where
 *   walking through would save a short detour — see `pickGrass`.
 * - The centre 3 × 3 cells (x, z ∈ [-8, 16]) are cleared into a plaza with a watchtower at its middle, the one place
 *   you can see over the maze. Every edge touching a plaza cell is removed, so the plaza has twelve corridor mouths.
 *
 * Generation is pure and deterministic (a seeded RNG from equipment/math, no Math.random), so the Node server rebuilds
 * the identical map. The carve/braid below is deliberately a copy of level/maze.ts's ~40 lines rather than an import:
 * a level and a map are different layers and must not depend on each other; the duplication is the cheaper price.
 *
 * No roads: a maze is corridors, so there is no road network to author (and therefore no roadside loot). Ground loot
 * comes from the POI pads instead — the flatten regions below double as the loot generator's pad grids.
 */

const HALF_PI = Math.PI / 2;

/** Cells per side. */
export const MAZE_BR_CELLS = 18;
/** Lattice pitch: distance between neighbouring cell centres, m. Corridors are `pitch` minus the 0.3 m wall. */
export const MAZE_BR_PITCH = 8;
/** Half the playable square, m. */
export const MAZE_BR_HALF = (MAZE_BR_CELLS * MAZE_BR_PITCH) / 2;

const SEED = 0x6d61_7a65;
/** Fraction of dead ends opened into loops: a perfect maze plays badly, every fight has one way out. */
const BRAID = 0.25;
/** Share of the standing interior edges made of glass. */
const GLASS_FRACTION = 0.15;
/** Glass edges keep this far apart (m) so they spread over the maze instead of clustering into glass rooms. */
const GLASS_MIN_SPACING = 9;
/**
 * Mirror panels. Each live one costs the client a render pass (world/props/MirrorWalls.ts), so these are counted, not
 * scattered: a handful of deliberate ones at T-junctions, where walking up the corridor shows you both branches.
 */
const MIRROR_COUNT = 10;
/** Mirrors keep this far apart, m: a fifth of the map's width, so they never share a corridor. */
const MIRROR_MIN_SPACING = 20;
/** Of `MIRROR_COUNT`, this many are taken first from the plaza approaches — the corridors everyone funnels through. */
const PLAZA_MIRRORS = 4;
/**
 * Share of the standing interior edges made of grass. Rarer than the glazed panels (15%) because a grass edge changes
 * the maze's shape, not just its sightlines: every one is a door nobody can see. Commoner than the mirrors (10 edges)
 * because a deception you meet once a match is a curiosity, not a mechanic. 8% is about twenty doors in 269 edges —
 * roughly one per fifteen cells, so you walk past several a match and can never assume the wall in front of you is one.
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
/** "Plaza approach": edge midpoint this far from the tower, m (the plaza itself reaches 12 m). */
const PLAZA_RING: readonly [number, number] = [14, 26];
/** Plaza: cells 8…10 on both axes, x, z ∈ [-8, 16]. */
const PLAZA_FROM = 8;
const PLAZA_TO = 10;
/** Watchtower at the plaza centre (an 18-cell grid puts a lattice vertex, not a cell, on the origin). */
const TOWER: Vec2Tuple = [4, 4];

/** Direction indices: 0 = +X, 1 = -X, 2 = +Z, 3 = -Z. */
const DIR_DX = [1, -1, 0, 0] as const;
const DIR_DZ = [0, 0, 1, -1] as const;

/** Centre of cell `index` along one axis, m. */
export function mazeBrCellCenter(index: number): number {
  return -MAZE_BR_HALF + (index + 0.5) * MAZE_BR_PITCH;
}

/** Position of lattice line `k` along one axis, m. */
export function mazeBrLineCoord(k: number): number {
  return -MAZE_BR_HALF + k * MAZE_BR_PITCH;
}

/**
 * Wall lattice plus the glass and mirror masks. `v[k * cells + j]` is the segment on vertical line k (constant X) in
 * row j, which blocks movement along X; `h[k * cells + i]` is its mirror on horizontal line k (constant Z) in column i.
 * The glass and mirror arrays use the same indexing: 1 where the standing wall is that panel rather than concrete. A
 * wall is never both.
 */
export interface MazeBrGrid {
  readonly cells: number;
  readonly pitch: number;
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

/** Clears every edge that touches a plaza cell, leaving a 24 × 24 m square open on twelve corridor mouths. */
function clearPlaza(lat: MazeBrGrid): void {
  for (let j = PLAZA_FROM; j <= PLAZA_TO; j++) {
    for (let i = PLAZA_FROM; i <= PLAZA_TO; i++) {
      for (let dir = 0; dir < 4; dir++) openWall(lat, i, j, dir);
    }
  }
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
      if (lat.v[vi(k, index)] === 1) out.push({ axis: 0, k, index, x: mazeBrLineCoord(k), z: mazeBrCellCenter(index) });
      if (lat.h[vi(k, index)] === 1) out.push({ axis: 1, k, index, x: mazeBrCellCenter(index), z: mazeBrLineCoord(k) });
    }
  }
  return out;
}

/**
 * Picks the glass edges: a seeded shuffle, then greedily taken while they stay `GLASS_MIN_SPACING` apart, up to
 * `GLASS_FRACTION` of the interior edges. The spacing is what keeps them spread — a plain per-edge coin flip clumps
 * them into glass corners and glass rooms.
 */
function pickGlass(lat: MazeBrGrid, rng: () => number): void {
  const candidates = standingInteriorEdges(lat);
  shuffle(candidates, rng);
  const quota = Math.round(candidates.length * GLASS_FRACTION);
  const taken: WallEdge[] = [];
  const minSq = GLASS_MIN_SPACING * GLASS_MIN_SPACING;
  for (const edge of candidates) {
    if (taken.length >= quota) break;
    if (taken.some((other) => (other.x - edge.x) * (other.x - edge.x) + (other.z - edge.z) * (other.z - edge.z) < minSq)) continue;
    taken.push(edge);
    (edge.axis === 0 ? lat.glassV : lat.glassH)[vi(edge.k, edge.index)] = 1;
  }
}

/** Cells either side of an interior edge: (k-1, index) and (k, index) along the edge's axis. */
function edgeCells(edge: WallEdge): readonly [number, number, number, number] {
  return edge.axis === 0 ? [edge.k - 1, edge.index, edge.k, edge.index] : [edge.index, edge.k - 1, edge.index, edge.k];
}

/**
 * Picks the mirror edges. Candidates are concrete edges that close off a T-junction cell — a cell with exactly three
 * open sides, so the mirror is the back wall of the T and everyone walking up the stem looks straight into it and sees
 * both branches. Then a seeded shuffle, `PLAZA_MIRRORS` taken from the plaza approaches first and the rest from the
 * whole maze, each kept `MIRROR_MIN_SPACING` from the ones already taken so they never share a corridor.
 */
function pickMirrors(lat: MazeBrGrid, rng: () => number): void {
  const isGlass = (e: WallEdge) => (e.axis === 0 ? lat.glassV : lat.glassH)[vi(e.k, e.index)] === 1;
  const facesJunction = (e: WallEdge) => {
    const [ax, az, bx, bz] = edgeCells(e);
    return openSides(lat, ax, az) === 3 || openSides(lat, bx, bz) === 3;
  };
  const candidates = standingInteriorEdges(lat).filter((e) => !isGlass(e) && facesJunction(e));
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
function pickGrass(lat: MazeBrGrid, rng: () => number): void {
  const interior = standingInteriorEdges(lat);
  const quota = Math.round(interior.length * GRASS_FRACTION);
  const isPanel = (e: WallEdge) => {
    const at = vi(e.k, e.index);
    return (e.axis === 0 ? lat.glassV[at]! + lat.mirrorV[at]! : lat.glassH[at]! + lat.mirrorH[at]!) > 0;
  };
  const candidates = interior.filter((e) => !isPanel(e));
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

function buildGrid(seed: number): MazeBrGrid {
  const size = (MAZE_BR_CELLS + 1) * MAZE_BR_CELLS;
  const grid: MazeBrGrid = {
    cells: MAZE_BR_CELLS,
    pitch: MAZE_BR_PITCH,
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
  clearPlaza(grid);
  pickGlass(grid, rng);
  pickMirrors(grid, rng);
  pickGrass(grid, rng);
  return grid;
}

/** The generated maze. Same seed => identical walls, on the client and on the server. */
export const MAZE_BR_GRID: MazeBrGrid = buildGrid(SEED);

/** True when a player can walk from cell (i, j) through side `dir` (0 = +X, 1 = -X, 2 = +Z, 3 = -Z). */
export function mazeBrIsOpen(i: number, j: number, dir: number): boolean {
  return !isWalled(MAZE_BR_GRID, i, j, dir);
}

// ---------------------------------------------------------------------------------------------------------------
// Walls: two 4 m props per standing edge, laid end to end along the edge.
// ---------------------------------------------------------------------------------------------------------------

const CONCRETE = "wall_concrete";
/** See-through, walk-into glass; whether bullets cross it depends on the pane's own clock (map/glassPhase.ts). */
const GLASS = "wall_glass";
/** Mirrored panel: concrete's box on the shoot-through layer, reflecting on the client. Opaque to sight, not to bullets. */
const MIRROR = "wall_mirror";
/** Hedge: as tall and as opaque as the concrete, with no collider at all. */
const GRASS = "wall_grass";
/** The two pieces of an 8 m edge sit this far either side of its midpoint, so they meet in the middle. */
const PIECE_OFFSET = MAZE_BR_PITCH / 4;

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
        const prop = edgeProp(grid.glassV, grid.mirrorV, grid.grassV, vi(k, index));
        const x = mazeBrLineCoord(k);
        const z = mazeBrCellCenter(index);
        piece(prop, x, z - PIECE_OFFSET, -HALF_PI);
        piece(prop, x, z + PIECE_OFFSET, -HALF_PI);
      }
      // Horizontal line (constant Z): the wall runs along X, so local X is world X.
      if (grid.h[vi(k, index)] === 1) {
        const prop = edgeProp(grid.glassH, grid.mirrorH, grid.grassH, vi(k, index));
        const x = mazeBrCellCenter(index);
        const z = mazeBrLineCoord(k);
        piece(prop, x - PIECE_OFFSET, z, 0);
        piece(prop, x + PIECE_OFFSET, z, 0);
      }
    }
  }
  return out;
}

export const MAZE_BR_WALLS: readonly PropPlacement[] = wallProps(MAZE_BR_GRID);

// ---------------------------------------------------------------------------------------------------------------
// Terrain: flat. Only a few centimeters of detail noise so the ground isn't a dead-flat plane; every landform
// amplitude is zero. The out-of-bounds mountains start at the outer wall (foothillInset 0).
// ---------------------------------------------------------------------------------------------------------------

export const MAZE_BR_TERRAIN: TerrainSpec = {
  version: 1,
  seed: 0x7b0b_0002,
  size: 256,
  resolution: 257,
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
// Points of interest: the tower plaza in the middle and one per quadrant. They are what loot generation and the team
// spawn plan read, and their pads below are the grids the outdoor loot generator walks.
// ---------------------------------------------------------------------------------------------------------------

const QUADRANT = 44;

export const MAZE_BR_POIS: readonly PointOfInterest[] = [
  { id: "plaza", name: "Tower Plaza", kind: "military", center: [0, 0], radius: 18, lootTier: 2 },
  { id: "north_east", name: "North-East Quarter", kind: "village", center: [QUADRANT, QUADRANT], radius: 18, lootTier: 1 },
  { id: "north_west", name: "North-West Quarter", kind: "village", center: [-QUADRANT, QUADRANT], radius: 18, lootTier: 1 },
  { id: "south_east", name: "South-East Quarter", kind: "village", center: [QUADRANT, -QUADRANT], radius: 18, lootTier: 1 },
  { id: "south_west", name: "South-West Quarter", kind: "village", center: [-QUADRANT, -QUADRANT], radius: 18, lootTier: 1 },
];

/**
 * POI spacing for a 144 m square: the defaults (80 m between any two POI centres) are written for the 500 m maps and
 * nothing fits inside a maze at that spacing. Pass this to `validateMapLayout`, the way the real-world maps pass theirs.
 */
export const MAZE_BR_VALIDATION: ValidationOptions = { poiSpacing: 60, minorPoiSpacing: 50, minorPoiRadius: 40 };

// ---------------------------------------------------------------------------------------------------------------
// Flatten: the tower plaza pad (the tower needs level ground) and one pad per quadrant POI. The terrain is already
// flat, so these only level out the few centimeters of detail noise — and, more importantly, they are the pads the
// loot generator grids over. A maze has no roads, so there are no road flattens.
// ---------------------------------------------------------------------------------------------------------------

const PADS: readonly FlattenRegion[] = [
  // The plaza itself, paved: 3 × 3 cells with the tower in the middle.
  { shape: "rect", center: TOWER, halfExtents: [12, 12], falloff: 4, height: "auto", surface: "road", surfaceFalloff: 1 },
  // A wider level ring round the plaza, so the loot grid reaches the corridor mouths too.
  { shape: "circle", center: TOWER, radius: 19, falloff: 8, height: "auto" },
  ...MAZE_BR_POIS.filter((poi) => poi.id !== "plaza").map((poi): FlattenRegion => ({ shape: "circle", center: poi.center, radius: 28, falloff: 10, height: "auto" })),
];

// ---------------------------------------------------------------------------------------------------------------
// Buildings: the watchtower, the only way to see over the maze.
// ---------------------------------------------------------------------------------------------------------------

const BUILDINGS: readonly MapBuilding[] = [
  { id: "plaza_tower", prefab: "watchtower", position: [TOWER[0], 0, TOWER[1]], yaw: 0, snapToTerrain: true, poi: "plaza" },
];

// ---------------------------------------------------------------------------------------------------------------
// Spawns: four per POI, on open corridor cell centres (4 m from any wall face). Four per group keeps a 20-team solo
// match off the 25 m fallback stacking, which in a maze would drop a team inside a wall.
// ---------------------------------------------------------------------------------------------------------------

const SPAWN_SPOTS: readonly Vec2Tuple[] = [
  // Plaza: one corridor out from each side of it.
  [4, -20],
  [4, 28],
  [-20, 4],
  [28, 4],
  // Quadrants: two on the inner approaches, one deep in the corner, one on the diagonal.
  ...([[1, 1], [-1, 1], [1, -1], [-1, -1]] as const).flatMap(([sx, sz]): Vec2Tuple[] => [
    [sx * 28, sz * 44],
    [sx * 44, sz * 28],
    [sx * 52, sz * 52],
    [sx * 36, sz * 36],
  ]),
];

/** Faces the nearest POI centre, so a team starts looking at what it landed for. */
function spawnYaw(at: Vec2Tuple): number {
  let best = MAZE_BR_POIS[0]!;
  let bestSq = Infinity;
  for (const poi of MAZE_BR_POIS) {
    const d = (poi.center[0] - at[0]) ** 2 + (poi.center[1] - at[1]) ** 2;
    if (d < bestSq) [best, bestSq] = [poi, d];
  }
  return round3(Math.atan2(best.center[0] - at[0], best.center[1] - at[1]));
}

export const MAZE_BR_SPAWNS: readonly MapSpawn[] = SPAWN_SPOTS.map((at) => ({ position: at, yaw: spawnYaw(at) }));

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
  props: MAZE_BR_WALLS,
  scatters: SCATTERS,
  spawns: MAZE_BR_SPAWNS,
};
