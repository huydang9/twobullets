import { describe, expect, it } from "vitest";
import { buildNavGrid } from "../bots/nav/buildNavGrid";
import { mapNavProbes, resolveProbes } from "../bots/nav/mapProbes";
import { createNavQuery } from "../bots/nav/navQuery";
import { generateLoot } from "../equipment/loot";
import { getBuildingPrefab, type BuildingPrefabId } from "./buildings/prefabs";
import { buildMapLayout } from "./layout/mapLayout";
import { MAP_PROP_IDS, getMapProp } from "./layout/props";
import { validateMapLayout, type MapIssueKind } from "./layout/validate";
import { GLASS_PHASE, glassBlocksAt, glassPhaseBucket } from "./glassPhase";
import type { PropPlacement } from "./types";
import {
  MAZE_BR,
  MAZE_BR_ALCOVES,
  MAZE_BR_CELLS,
  MAZE_BR_COLUMN_WIDTHS,
  MAZE_BR_COVER,
  MAZE_BR_GRID,
  MAZE_BR_HALF,
  MAZE_BR_NOOKS,
  MAZE_BR_ROW_HEIGHTS,
  MAZE_BR_VALIDATION,
  MAZE_BR_WALLS,
  MAZE_BR_WALL_PIECE,
  MAZE_BR_WALL_PIECE_SHORT,
  MAZE_BR_WIDTHS,
  mazeBrCellAt,
  mazeBrEdgePieces,
  mazeBrWallProp,
  mazeBrCellCenterX,
  mazeBrCellCenterZ,
  mazeBrColumnWidth,
  mazeBrIsOpen,
  mazeBrLineX,
  mazeBrLineZ,
  mazeBrRowHeight,
} from "./mazeBr";
import { checksumBytes } from "./terrain/heightfield";
import { buildTerrain } from "./terrain/terrain";

/**
 * Prop budget: 1,860 interior lattice edges plus the perimeter, most of them carved away, and 1, 2 or 3 pieces per
 * standing edge depending on how wide the lane it crosses is. The 30 × 30 lattice has nearly twice the edges the
 * 22 × 22 one had, but each lane is narrower so each edge is fewer pieces: the count went from 1,007 to about 1,310.
 * Map v1 carries 1,355 instances, so this stays under 1,400 including the cover props.
 */
const PROP_BUDGET = 1_400;

const DIR_DX = [1, -1, 0, 0];
const DIR_DZ = [0, 0, 1, -1];

/** Plaza block: cells 13…15 on both axes, three 8 m lanes a side. */
const PLAZA_COLUMNS = [13, 15] as const;
const PLAZA_ROWS = [13, 15] as const;
/** The plaza square in metres: three 8 m lanes centred on the origin. */
const PLAZA_REACH = 12;
const inPlaza = (i: number, j: number): boolean =>
  i >= PLAZA_COLUMNS[0] && i <= PLAZA_COLUMNS[1] && j >= PLAZA_ROWS[0] && j <= PLAZA_ROWS[1];

/** Pieces on an edge: `axis` 0 = a constant-X line crossing row `index`, 1 = a constant-Z line crossing column `index`. */
function edgePieces(axis: 0 | 1, index: number): number {
  return mazeBrEdgePieces(axis === 0 ? mazeBrRowHeight(index) : mazeBrColumnWidth(index)).count;
}

/** Length of one piece on that edge, m. */
function edgePieceLength(axis: 0 | 1, index: number): number {
  return mazeBrEdgePieces(axis === 0 ? mazeBrRowHeight(index) : mazeBrColumnWidth(index)).length;
}

/** Every wall kind, in both lengths. */
const WALL_KINDS = ["wall_concrete", "wall_glass", "wall_mirror", "wall_grass"];
const WALL_PROPS = WALL_KINDS.flatMap((kind) => [kind, `${kind}_2`]);
/** True when a piece is of this kind, whichever length it is. */
const isKind = (prop: string, kind: string): boolean => prop === kind || prop === `${kind}_2`;

/** Total pieces the walls with `mask` set would emit, summed over the whole lattice. */
function piecesOf(maskV: Uint8Array, maskH: Uint8Array): number {
  let total = 0;
  for (let k = 0; k <= MAZE_BR_CELLS; k++) {
    for (let index = 0; index < MAZE_BR_CELLS; index++) {
      const at = k * MAZE_BR_CELLS + index;
      if (maskV[at] === 1) total += edgePieces(0, index);
      if (maskH[at] === 1) total += edgePieces(1, index);
    }
  }
  return total;
}

/**
 * Walking distance in cells from `start` to every cell over the lattice (v, h); -1 where unreachable. The maze module
 * has its own copy of this; the test deliberately keeps a second one so a bug in the picker's flood fill can't hide.
 */
function distances(v: Uint8Array, h: Uint8Array, start: number): Int32Array {
  const n = MAZE_BR_CELLS;
  const dist = new Int32Array(n * n).fill(-1);
  const queue = [start];
  dist[start] = 0;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    const i = cur % n;
    const j = (cur / n) | 0;
    for (let dir = 0; dir < 4; dir++) {
      const ni = i + DIR_DX[dir]!;
      const nj = j + DIR_DZ[dir]!;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const walled = dir === 0 ? v[(i + 1) * n + j] : dir === 1 ? v[i * n + j] : dir === 2 ? h[(j + 1) * n + i] : h[j * n + i];
      if (walled === 1) continue;
      const next = nj * n + ni;
      if (dist[next] !== -1) continue;
      dist[next] = dist[cur]! + 1;
      queue.push(next);
    }
  }
  return dist;
}

/** Longest walk between any two cells, in cells. */
function diameter(v: Uint8Array, h: Uint8Array): number {
  let max = 0;
  for (let start = 0; start < MAZE_BR_CELLS * MAZE_BR_CELLS; start++) {
    for (const d of distances(v, h, start)) if (d > max) max = d;
  }
  return max;
}

/** Every grass edge: its mask index, the two cells it separates and its midpoint. */
function grassEdges(): { axis: 0 | 1; at: number; a: number; b: number; x: number; z: number }[] {
  const n = MAZE_BR_CELLS;
  const out: { axis: 0 | 1; at: number; a: number; b: number; x: number; z: number }[] = [];
  for (let k = 0; k <= n; k++) {
    for (let index = 0; index < n; index++) {
      const at = k * n + index;
      if (MAZE_BR_GRID.grassV[at] === 1) out.push({ axis: 0, at, a: index * n + (k - 1), b: index * n + k, x: mazeBrLineX(k), z: mazeBrCellCenterZ(index) });
      if (MAZE_BR_GRID.grassH[at] === 1) out.push({ axis: 1, at, a: (k - 1) * n + index, b: k * n + index, x: mazeBrCellCenterX(index), z: mazeBrLineZ(k) });
    }
  }
  return out;
}

/**
 * Distance from a point to the nearest wall piece's collider footprint (the box is 4 or 2 m × 0.3 m around its
 * center). `wall_grass` has no collider at all, so it is not a wall to anything that has to walk or stand: skipped.
 */
function wallClearance(x: number, z: number, walls: readonly PropPlacement[] = MAZE_BR_WALLS): number {
  let best = Infinity;
  for (const wall of walls) {
    const collision = getMapProp(wall.prop).collision;
    if (collision.kind !== "box") continue;
    const { size } = collision;
    const dx = x - wall.position[0];
    const dz = z - wall.position[2];
    // Into the piece's local frame: local X runs along the wall (yaw turns +X toward (cos, -sin)).
    const lx = dx * Math.cos(wall.yaw) - dz * Math.sin(wall.yaw);
    const lz = dx * Math.sin(wall.yaw) + dz * Math.cos(wall.yaw);
    const ox = Math.max(0, Math.abs(lx) - size[0] / 2);
    const oz = Math.max(0, Math.abs(lz) - size[2] / 2);
    best = Math.min(best, Math.sqrt(ox * ox + oz * oz));
  }
  return best;
}

/**
 * Longest straight run a standing player can see down, m, measured on a 0.25 m occupancy grid of everything that blocks
 * sight: concrete, mirrors and hedges. Glazed panes are see-through and the cover props are all under 1.5 m, so neither
 * shortens a sightline for someone on their feet. Axis-aligned only, which is what the corridors and avenues are.
 */
const SIGHT_STEP = 0.25;
const SIGHT_SIZE = Math.round((MAZE_BR_HALF * 2) / SIGHT_STEP) + 1;

/**
 * Unobstructed looks: from every open point on the sight grid, in a pseudo-random cardinal direction, the distance to
 * the first sight blocker. Deterministic (a fixed LCG), so the thresholds mean the same thing on every run.
 */
function sightlineSamples(): { readonly median: number; readonly underFour: number; readonly underEight: number } {
  const occupied = sightOccupancy();
  const size = SIGHT_SIZE;
  let seed = 0x5eed_1234;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const looks: number[] = [];
  for (let gz = 1; gz < size - 1; gz++) {
    for (let gx = 1; gx < size - 1; gx++) {
      if (occupied[gz * size + gx] === 1) continue;
      const dir = (rnd() * 4) | 0;
      const dx = DIR_DX[dir]!;
      const dz = DIR_DZ[dir]!;
      let [d, x, z] = [0, gx, gz];
      for (;;) {
        x += dx;
        z += dz;
        if (x < 0 || z < 0 || x >= size || z >= size || occupied[z * size + x] === 1) break;
        d += SIGHT_STEP;
      }
      looks.push(d);
    }
  }
  looks.sort((a, b) => a - b);
  return {
    median: looks[Math.floor(looks.length / 2)]!,
    underFour: looks.filter((d) => d < 4).length / looks.length,
    underEight: looks.filter((d) => d < 8).length / looks.length,
  };
}

function longestSightline(): number {
  const occupied = sightOccupancy();
  const size = SIGHT_SIZE;
  let best = 0;
  for (let a = 0; a < size; a++) {
    let row = 0;
    let column = 0;
    for (let b = 0; b < size; b++) {
      row = occupied[a * size + b] === 1 ? 0 : row + 1;
      column = occupied[b * size + a] === 1 ? 0 : column + 1;
      best = Math.max(best, row, column);
    }
  }
  return best * SIGHT_STEP;
}

function buildSightOccupancy(): Uint8Array {
  const step = SIGHT_STEP;
  const size = SIGHT_SIZE;
  const occupied = new Uint8Array(size * size);
  const mark = (x: number, z: number): void => {
    const gx = Math.round((x + MAZE_BR_HALF) / step);
    const gz = Math.round((z + MAZE_BR_HALF) / step);
    if (gx >= 0 && gz >= 0 && gx < size && gz < size) occupied[gz * size + gx] = 1;
  };
  for (const wall of MAZE_BR_WALLS) {
    if (isKind(wall.prop, "wall_glass")) continue;
    const [x, , z] = wall.position;
    const length = wall.prop.endsWith("_2") ? MAZE_BR_WALL_PIECE_SHORT : MAZE_BR_WALL_PIECE;
    const alongX = Math.abs(Math.cos(wall.yaw)) > 0.5;
    for (let t = -length / 2; t <= length / 2 + 1e-6; t += step / 2) {
      for (let n = -0.15; n <= 0.15 + 1e-6; n += step / 2) {
        if (alongX) mark(x + t, z + n);
        else mark(x + n, z + t);
      }
    }
  }
  return occupied;
}

let sightCache: Uint8Array | null = null;
function sightOccupancy(): Uint8Array {
  return (sightCache ??= buildSightOccupancy());
}

/** Every piece's place and kind, hashed: the map's identity. Bump it when the geometry is meant to change. */
const MAZE_CHECKSUM = "e73bbcf4";

describe("Maze map", () => {
  const terrain = buildTerrain(MAZE_BR.terrain, MAZE_BR.flatten);
  const layout = buildMapLayout(MAZE_BR, terrain);
  const issues = validateMapLayout(MAZE_BR, terrain, layout, MAZE_BR_VALIDATION);

  // The terrain renderer splits the heightfield into chunks of TERRAIN_RENDER_DEFAULTS.chunkCells (128) a side and
  // throws "chunk size 128 must divide N cells" at load if it doesn't fit. Nothing in the map layer knows about the
  // renderer, so growing the map once shipped a size of 320 that only failed in the browser. Assert it here instead.
  it("has a terrain grid the renderer can chunk", () => {
    const CHUNK_CELLS = 128;
    expect(MAZE_BR.terrain.resolution).toBe(MAZE_BR.terrain.size + 1);
    expect((MAZE_BR.terrain.resolution - 1) % CHUNK_CELLS).toBe(0);
    // ...and it must still cover the playable square plus the full border ramp on every side.
    const border = (MAZE_BR.terrain.size - 2 * MAZE_BR.terrain.playableHalfExtent) / 2;
    expect(border).toBeGreaterThanOrEqual(MAZE_BR.terrain.border.rampDistance);
  });
  const of = (kind: MapIssueKind) => issues.filter((i) => i.kind === kind).map((i) => i.message);

  it("generates the same maze every build", () => {
    // Every piece's place and kind: concrete 0, mirror 2, grass 4, and a glazed pane as 10 + its phase group, so the
    // pane's mode schedule is pinned here too — it is derived from where the pane stands, and a change to that
    // derivation moves this the way a change to the seed, carve, braid, glass pick, mirror pick or grass pick does.
    const kind = (wall: PropPlacement) =>
      isKind(wall.prop, "wall_glass")
        ? 10 + glassPhaseBucket(wall.position[0], wall.position[2], wall.yaw)
        : wall.prop === "wall_mirror"
          ? 2
          : wall.prop === "wall_grass"
            ? 4
            : 0;
    const data = new Float32Array(MAZE_BR_WALLS.length * 4);
    MAZE_BR_WALLS.forEach((wall, k) => {
      data[k * 4] = wall.position[0];
      data[k * 4 + 1] = wall.position[2];
      data[k * 4 + 2] = wall.yaw;
      data[k * 4 + 3] = kind(wall);
    });
    expect(checksumBytes(data)).toBe(MAZE_CHECKSUM);
    expect(MAZE_BR.id).toBe("mazebr");
    expect(MAZE_BR.terrain.playableHalfExtent).toBe(92);
  });

  it("makes the squeeze the common lane and keeps the boulevard for the avenues", () => {
    const { squeeze, corridor, boulevard } = MAZE_BR_WIDTHS;
    const tiers = [squeeze, corridor, boulevard];
    // 4 m is the floor, decided from both ends (2026-09-19): 8 m read as a grid of streets, and a 2 m lattice was
    // built, played and rejected — "ĐÚNG LÀ ĐƯỜNG NHỎ KHÔNG HAY LẮM, KHÔI PHỤC LẠI NHÉ". This pins the settled answer.
    expect(squeeze).toBe(4);
    expect(MAZE_BR_COLUMN_WIDTHS).toHaveLength(MAZE_BR_CELLS);
    expect(MAZE_BR_ROW_HEIGHTS).toHaveLength(MAZE_BR_CELLS);
    const count = (widths: readonly number[], w: number) => widths.filter((v) => v === w).length;
    for (const widths of [MAZE_BR_COLUMN_WIDTHS, MAZE_BR_ROW_HEIGHTS]) {
      // Only the three tiers, every one a whole number of 4 m wall pieces, and 184 m in total on both axes.
      for (const w of widths) expect(tiers).toContain(w);
      for (const w of widths) expect(w % MAZE_BR_WALL_PIECE).toBe(0);
      expect(widths.reduce((a, b) => a + b, 0)).toBe(MAZE_BR_HALF * 2);
      // The shape of the map, and the owner's note on the version before this one — "đường đi quá rộng, nên không mang
      // lại cảm giác mê cung", the lanes were too wide to read as a maze. The first non-uniform lattice ran 5 squeezes,
      // 8 corridors and 9 boulevards per axis; this asserts that ordering is the other way round for good. Narrow is
      // the majority of every axis, the corridor is the exception, and the boulevard is rare — three per axis, which is
      // exactly what the two avenue columns and the avenue row need, plus one spare wide lane that is not an avenue.
      expect(count(widths, squeeze) / widths.length, "squeeze share").toBeGreaterThan(0.5);
      expect(count(widths, squeeze)).toBeGreaterThan(count(widths, corridor));
      expect(count(widths, corridor)).toBeGreaterThan(count(widths, boulevard));
      expect(count(widths, boulevard), "boulevards").toBeGreaterThanOrEqual(3);
      expect(count(widths, boulevard) / widths.length, "boulevard share").toBeLessThanOrEqual(0.15);
      // Still a rhythm and not a single tier: every tier is on the map, several times.
      for (const w of tiers) expect(count(widths, w), `width ${w}`).toBeGreaterThanOrEqual(3);
    }
    // The two axes are different arrangements of the same multiset, so the maze is not symmetric about its diagonal.
    for (const w of tiers) expect(count(MAZE_BR_COLUMN_WIDTHS, w)).toBe(count(MAZE_BR_ROW_HEIGHTS, w));
    expect(MAZE_BR_COLUMN_WIDTHS).not.toEqual(MAZE_BR_ROW_HEIGHTS);

    // Lines and centres stay in step with the widths, and the lattice is centred on the origin.
    expect(mazeBrLineX(0)).toBe(-MAZE_BR_HALF);
    expect(mazeBrLineZ(0)).toBe(-MAZE_BR_HALF);
    expect(mazeBrLineX(MAZE_BR_CELLS)).toBe(MAZE_BR_HALF);
    expect(mazeBrLineZ(MAZE_BR_CELLS)).toBe(MAZE_BR_HALF);
    for (let k = 0; k < MAZE_BR_CELLS; k++) {
      expect(mazeBrLineX(k + 1) - mazeBrLineX(k)).toBe(mazeBrColumnWidth(k));
      expect(mazeBrLineZ(k + 1) - mazeBrLineZ(k)).toBe(mazeBrRowHeight(k));
      expect(mazeBrCellCenterX(k)).toBe(mazeBrLineX(k) + mazeBrColumnWidth(k) / 2);
      expect(mazeBrCellCenterZ(k)).toBe(mazeBrLineZ(k) + mazeBrRowHeight(k) / 2);
      expect(mazeBrCellAt(mazeBrCellCenterX(k), mazeBrCellCenterZ(k))).toEqual([k, k]);
    }
    // The plaza sits on the origin, 24 × 24 m.
    expect(mazeBrLineX(PLAZA_COLUMNS[0])).toBe(-PLAZA_REACH);
    expect(mazeBrLineZ(PLAZA_ROWS[0])).toBe(-PLAZA_REACH);
    expect(mazeBrLineX(PLAZA_COLUMNS[1] + 1)).toBe(PLAZA_REACH);
    expect(mazeBrLineZ(PLAZA_ROWS[1] + 1)).toBe(PLAZA_REACH);
  });

  /**
   * How far you can see, measured rather than asserted by eye: from every open point on a 0.25 m grid, in a random
   * cardinal direction, the distance to the first thing that blocks sight. This is the instrument the lane-width
   * argument was finally settled with, so it stays even though the answer is settled — it is how we would notice the
   * map drifting either way again.
   *
   * Measured on both lattices (2026-09-19): this one, 4 / 8 / 12 m over 184 m, runs a **median of 9.5 m**, 24 % of
   * looks under 4 m and 44 % under 8 m. The 2 m lattice ran 7.0 m / 33 % / 53 % and the owner rejected it as too
   * tight, so the bounds below are a band around this map rather than a push in either direction.
   */
  it("keeps a player's sightlines in the band both ends of the argument settled on", () => {
    const { median, underFour, underEight } = sightlineSamples();
    // Not a grid of streets: this is the "đường đi quá rộng" direction, and the ceiling is what holds it.
    expect(median, "median unobstructed look").toBeLessThanOrEqual(11);
    expect(underEight, "share of looks under 8 m").toBeGreaterThan(0.38);
    // …and not the 2 m maze the owner sent back either: "ĐÚNG LÀ ĐƯỜNG NHỎ KHÔNG HAY LẮM".
    expect(median, "median unobstructed look").toBeGreaterThanOrEqual(8);
    expect(underFour, "share of looks under 4 m").toBeLessThan(0.3);
  });

  /**
   * And the same thing from the walker's side: from a cell, in a direction you can walk, how far before the corridor
   * turns, branches or ends. This map means a decision every 8.6 m, about 2 s at a run; the rejected 2 m lattice ran
   * 5.1 m, about 1.2 s, which is the pace the owner found too busy.
   */
  it("puts a corner or a junction a couple of seconds apart", () => {
    const runs: number[] = [];
    for (let j = 0; j < MAZE_BR_CELLS; j++) {
      for (let i = 0; i < MAZE_BR_CELLS; i++) {
        for (let dir = 0; dir < 4; dir++) {
          if (!mazeBrIsOpen(i, j, dir)) continue;
          let [ci, cj, span] = [i, j, 0];
          for (;;) {
            const ni = ci + DIR_DX[dir]!;
            const nj = cj + DIR_DZ[dir]!;
            if (ni < 0 || nj < 0 || ni >= MAZE_BR_CELLS || nj >= MAZE_BR_CELLS || !mazeBrIsOpen(ci, cj, dir)) break;
            span += dir < 2 ? mazeBrColumnWidth(ni) : mazeBrRowHeight(nj);
            [ci, cj] = [ni, nj];
            const open = [0, 1, 2, 3].filter((d) => mazeBrIsOpen(ci, cj, d));
            if (open.length !== 2 || !open.includes(dir)) break;
          }
          runs.push(span);
        }
      }
    }
    const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
    expect(mean, "metres to the next decision").toBeLessThanOrEqual(10);
    expect(mean, "metres to the next decision").toBeGreaterThanOrEqual(7);
    runs.sort((a, b) => a - b);
    expect(runs[Math.floor(runs.length / 2)]!, "median metres to the next decision").toBeLessThanOrEqual(8);
  });

  // Strict connectivity: the maze with every wall solid, hedges included. `wall_grass` only ever replaces a concrete
  // edge and never touches `v`/`h`, so this is unchanged by the hedges and must stay that way — a maze that only works
  // if you find the grass is not a maze. The looser graph, where hedges are walked through, is two tests below.
  it("leaves every cell reachable, the plaza included", () => {
    const total = MAZE_BR_CELLS * MAZE_BR_CELLS;
    const seen = new Uint8Array(total);
    const stack = [0];
    seen[0] = 1;
    let reached = 1;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const i = cur % MAZE_BR_CELLS;
      const j = (cur / MAZE_BR_CELLS) | 0;
      for (let dir = 0; dir < 4; dir++) {
        const ni = i + DIR_DX[dir]!;
        const nj = j + DIR_DZ[dir]!;
        if (ni < 0 || nj < 0 || ni >= MAZE_BR_CELLS || nj >= MAZE_BR_CELLS) continue;
        if (!mazeBrIsOpen(i, j, dir)) continue;
        const next = nj * MAZE_BR_CELLS + ni;
        if (seen[next] === 1) continue;
        seen[next] = 1;
        reached++;
        stack.push(next);
      }
    }
    expect(reached).toBe(total);
    // The plaza is 3 × 3 cells with every touching edge removed: twelve ways in.
    for (let j = PLAZA_ROWS[0]; j <= PLAZA_ROWS[1]; j++) {
      for (let i = PLAZA_COLUMNS[0]; i <= PLAZA_COLUMNS[1]; i++) expect(seen[j * MAZE_BR_CELLS + i], `plaza cell ${i},${j}`).toBe(1);
    }
  });

  it("runs avenues end to end, so a rifle has something to shoot down", () => {
    // The point of the first rework: the uniform map's longest straight run was 42 m, which is a pistol fight. Three
    // 12 m lanes cross the whole map uncarved, and the narrowing that followed did not touch them: the contrast between
    // a 3.7 m squeeze and a 184 m hall is the map.
    const sightline = longestSightline();
    expect(sightline).toBeGreaterThanOrEqual(150);
    expect(sightline).toBeLessThanOrEqual(MAZE_BR_HALF * 2);

    // And they really are lanes, not a lucky alignment: three of them, each a full row or column of open cells whose
    // own width is the boulevard tier.
    let avenues = 0;
    for (let i = 0; i < MAZE_BR_CELLS; i++) {
      let open = true;
      for (let j = 0; j + 1 < MAZE_BR_CELLS && open; j++) open = mazeBrIsOpen(i, j, 2);
      if (open) {
        avenues++;
        expect(mazeBrColumnWidth(i), `avenue column ${i}`).toBe(MAZE_BR_WIDTHS.boulevard);
      }
    }
    for (let j = 0; j < MAZE_BR_CELLS; j++) {
      let open = true;
      for (let i = 0; i + 1 < MAZE_BR_CELLS && open; i++) open = mazeBrIsOpen(i, j, 0);
      if (open) {
        avenues++;
        expect(mazeBrRowHeight(j), `avenue row ${j}`).toBe(MAZE_BR_WIDTHS.boulevard);
      }
    }
    expect(avenues).toBeGreaterThanOrEqual(2);
    expect(avenues).toBeLessThanOrEqual(4);
  });

  it("opens rooms that are not the plaza", () => {
    // A 2 × 2 block with its four inside edges gone: four cells that all see each other and none of them the plaza.
    let rooms = 0;
    for (let j = 0; j + 1 < MAZE_BR_CELLS; j++) {
      for (let i = 0; i + 1 < MAZE_BR_CELLS; i++) {
        const open =
          mazeBrIsOpen(i, j, 0) && mazeBrIsOpen(i, j + 1, 0) && mazeBrIsOpen(i, j, 2) && mazeBrIsOpen(i + 1, j, 2);
        if (!open) continue;
        const touchesPlaza = i + 1 >= PLAZA_COLUMNS[0] && i <= PLAZA_COLUMNS[1] && j + 1 >= PLAZA_ROWS[0] && j <= PLAZA_ROWS[1];
        if (!touchesPlaza) rooms++;
      }
    }
    expect(rooms).toBeGreaterThanOrEqual(7);
  });

  it("emits the right number of wall pieces per standing edge, within budget", () => {
    expect(MAZE_BR_WALLS.filter((w) => WALL_PROPS.includes(w.prop))).toHaveLength(MAZE_BR_WALLS.length);
    // One piece on a squeeze, two on a corridor, three on a boulevard — an edge is never scaled or trimmed.
    expect(MAZE_BR_WALLS).toHaveLength(piecesOf(MAZE_BR_GRID.v, MAZE_BR_GRID.h));
    expect(MAZE_BR.props.length).toBeLessThan(PROP_BUDGET);
    expect(MAZE_BR.props).toHaveLength(MAZE_BR_WALLS.length + MAZE_BR_COVER.length);
    // The perimeter alone is 184 m of wall on each of four sides, at 4 m a piece.
    expect(MAZE_BR_WALLS.length).toBeGreaterThan((4 * MAZE_BR_HALF * 2) / MAZE_BR_WALL_PIECE);
    for (const wall of MAZE_BR_WALLS) {
      expect(Math.abs(wall.position[0])).toBeLessThanOrEqual(MAZE_BR_HALF);
      expect(Math.abs(wall.position[2])).toBeLessThanOrEqual(MAZE_BR_HALF);
      expect(wall.snapToTerrain).toBe(true);
    }
    // Every lane on this map is 4 m or wider, so every piece is a long one and the short props go unused here.
    expect(MAZE_BR_WALLS.some((w) => w.prop.endsWith("_2"))).toBe(false);
  });

  /**
   * The short pieces the 2 m lattice was built from. That lattice was played and reverted — 4 m is the floor now — but
   * the props and the machinery that picks them stay, so a narrower lane is one constant away instead of a rework.
   * This is what stops them rotting while nothing places them: they must stay the long piece in every respect but
   * length, and `mazeBrEdgePieces` must still reach for them.
   */
  it("keeps the 2 m wall pieces wired, even though this map does not use one", () => {
    expect(mazeBrEdgePieces(MAZE_BR_WALL_PIECE_SHORT)).toEqual({ length: MAZE_BR_WALL_PIECE_SHORT, count: 1 });
    expect(mazeBrEdgePieces(MAZE_BR_WIDTHS.squeeze)).toEqual({ length: MAZE_BR_WALL_PIECE, count: 1 });
    expect(mazeBrEdgePieces(MAZE_BR_WIDTHS.boulevard)).toEqual({ length: MAZE_BR_WALL_PIECE, count: 3 });
    for (const kind of WALL_KINDS) {
      const short = getMapProp(mazeBrWallProp(kind, MAZE_BR_WALL_PIECE_SHORT));
      const long = getMapProp(mazeBrWallProp(kind, MAZE_BR_WALL_PIECE));
      expect(short.id, kind).toBe(`${kind}_2`);
      expect(long.id, kind).toBe(kind);
      // Same wall, half the span: same height, same depth, same sink, same surface, same layer.
      expect(short.category, kind).toBe(long.category);
      expect(short.surface, kind).toBe(long.surface);
      expect(short.sink, kind).toBe(long.sink);
      expect(short.collision.kind, kind).toBe(long.collision.kind);
      if (short.collision.kind === "box" && long.collision.kind === "box") {
        expect(short.collision.size[0], kind).toBe(MAZE_BR_WALL_PIECE_SHORT);
        expect(long.collision.size[0], kind).toBe(MAZE_BR_WALL_PIECE);
        expect(short.collision.size.slice(1), kind).toEqual(long.collision.size.slice(1));
        expect(short.collision.bulletproof, kind).toBe(long.collision.bulletproof);
      }
      // The hedge has no collider, so its footprint is its extent: half the span, half the footprint.
      if (short.collision.kind === "none") expect(short.footprint * 2, kind).toBe(long.footprint);
    }
  });

  it("stands cover in the avenues and the rooms, under eye height and clear of the spawns", () => {
    expect(MAZE_BR_COVER.length).toBeGreaterThanOrEqual(20);
    for (const prop of MAZE_BR_COVER) {
      const def = getMapProp(prop.prop);
      // Category "prop" keeps them out of the road-surface validator, and nothing reaches a standing player's eyes:
      // this is cover to crouch behind, never a wall that shortens the avenue's sightline.
      expect(def.category, prop.prop).toBe("prop");
      const height = def.collision.kind === "box" ? def.collision.size[1] : def.collision.kind === "cylinder" ? def.collision.height : 0;
      expect(height, prop.prop).toBeGreaterThan(0);
      expect(height, prop.prop).toBeLessThan(1.5);
      expect(Math.abs(prop.position[0])).toBeLessThan(MAZE_BR_HALF);
      expect(Math.abs(prop.position[2])).toBeLessThan(MAZE_BR_HALF);
      for (const spawn of MAZE_BR.spawns) {
        const d = Math.hypot(spawn.position[0] - prop.position[0], spawn.position[1] - prop.position[2]);
        expect(d, `${prop.prop} at (${prop.position[0]}, ${prop.position[2]})`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("makes about 15% of the interior walls transparent, spread out", () => {
    let interior = 0;
    let glass = 0;
    for (let k = 1; k < MAZE_BR_CELLS; k++) {
      for (let index = 0; index < MAZE_BR_CELLS; index++) {
        const at = k * MAZE_BR_CELLS + index;
        if (MAZE_BR_GRID.v[at] === 1) interior++;
        if (MAZE_BR_GRID.h[at] === 1) interior++;
        glass += MAZE_BR_GRID.glassV[at]! + MAZE_BR_GRID.glassH[at]!;
      }
    }
    // Merging the two look-alike panes into one that switches modes kept the transparent share where it was: what used
    // to be a 60/40 split of these edges between shoot-through and bulletproof is now every one of them, over time.
    expect(glass / interior).toBeGreaterThan(0.1);
    expect(glass / interior).toBeLessThan(0.2);
    const panes = MAZE_BR_WALLS.filter((w) => isKind(w.prop, "wall_glass"));
    expect(panes).toHaveLength(piecesOf(MAZE_BR_GRID.glassV, MAZE_BR_GRID.glassH));
    // One glazed pane prop, and its resting mode (what the pure layout and the nav grid see) is shoot-through.
    expect(getMapProp("wall_glass").collision).toMatchObject({ kind: "box", bulletproof: false });
    expect(MAP_PROP_IDS.filter((id) => id.startsWith("wall_glass"))).toEqual(["wall_glass", "wall_glass_2"]);

    // No two pieces share a spot: the panes are spread, not stacked.
    const centers = panes.map((w) => [w.position[0], w.position[2]] as const);
    const unique = [...new Set(centers.map(([x, z]) => `${x},${z}`))];
    expect(unique.length).toBe(centers.length);

    // Panes in every quadrant, so no corner of the maze is the one you can always shoot through.
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const here = panes.some((w) => Math.sign(w.position[0]) === sx && Math.sign(w.position[2]) === sz);
      expect(here, `pane in quadrant ${sx},${sz}`).toBe(true);
    }
  });

  it("gives every pane a phase group, all its pieces the same one, and never flips them all together", () => {
    const panes = MAZE_BR_WALLS.filter((w) => isKind(w.prop, "wall_glass"));
    // The pieces of one wall must agree: half a pane stopping bullets would read as a bug. A wall can be three pieces
    // over a 12 m boulevard now, which is why the group comes from the wall's lattice line rather than the piece's
    // cell — see glassPhaseBucket. This walks the mask and checks every piece of every glazed edge.
    let edges = 0;
    for (let k = 0; k <= MAZE_BR_CELLS; k++) {
      for (let index = 0; index < MAZE_BR_CELLS; index++) {
        const at = k * MAZE_BR_CELLS + index;
        for (const axis of [0, 1] as const) {
          if ((axis === 0 ? MAZE_BR_GRID.glassV : MAZE_BR_GRID.glassH)[at] !== 1) continue;
          edges++;
          const groups = new Set<number>();
          const from = axis === 0 ? mazeBrLineZ(index) : mazeBrLineX(index);
          const length = edgePieceLength(axis, index);
          for (let p = 0; p < edgePieces(axis, index); p++) {
            const along = from + (p + 0.5) * length;
            // Yaw names the line the piece stands on: -π/2 for a wall running along Z, 0 for one running along X.
            groups.add(axis === 0 ? glassPhaseBucket(mazeBrLineX(k), along, -Math.PI / 2) : glassPhaseBucket(along, mazeBrLineZ(k), 0));
          }
          expect(groups.size, `pane ${axis === 0 ? "V" : "H"} ${k},${index}`).toBe(1);
        }
      }
    }
    expect(edges).toBeGreaterThan(0);

    const buckets = panes.map((w) => glassPhaseBucket(w.position[0], w.position[2], w.yaw));
    // Every group is used, so no group's schedule is dead weight and no group carries the whole map.
    expect(new Set(buckets).size).toBe(GLASS_PHASE.buckets);
    for (let bucket = 0; bucket < GLASS_PHASE.buckets; bucket++) {
      const share = buckets.filter((b) => b === bucket).length / buckets.length;
      expect(share, `phase group ${bucket} share`).toBeGreaterThan(0.1);
      expect(share, `phase group ${bucket} share`).toBeLessThan(0.45);
    }

    // The owner's rule: never a moment when the whole map is passable or the whole map is armoured, and never a flip
    // that takes every pane with it. Walked over two full cycles at 0.25 s steps.
    for (let t = 0; t < GLASS_PHASE.holdSeconds * 4; t += 0.25) {
      const blocking = buckets.filter((b) => glassBlocksAt(b, t)).length;
      expect(blocking, `t = ${t}`).toBeGreaterThan(0);
      expect(blocking, `t = ${t}`).toBeLessThan(buckets.length);
    }
  });

  it("places a handful of mirror walls at junctions, four of them on the plaza approaches", () => {
    const pieces = MAZE_BR_WALLS.filter((w) => isKind(w.prop, "wall_mirror"));
    // Each live one costs the client a render pass: this stays a small, counted number of *edges* (the piece count
    // follows the lanes they cross, so it is no longer twice the edges).
    expect(pieces).toHaveLength(piecesOf(MAZE_BR_GRID.mirrorV, MAZE_BR_GRID.mirrorH));
    // Same box as concrete, so a mirror fills a corridor exactly like the wall it replaced — but shoot-through since
    // 2026-09-18, which makes it mechanically a `wall_glass` you cannot see through. Bullets cross it and leave a hole.
    expect(getMapProp("wall_mirror").collision).toEqual(getMapProp("wall_glass").collision);
    expect(getMapProp("wall_mirror").collision).toMatchObject({ kind: "box", bulletproof: false });
    if (getMapProp("wall_concrete").collision.kind !== "box") throw new Error("the concrete wall is a box");
    expect(getMapProp("wall_mirror").collision).toEqual({ ...getMapProp("wall_concrete").collision, bulletproof: false });
    expect(getMapProp("wall_mirror").sink).toBe(getMapProp("wall_concrete").sink);

    // Never on a glass edge, and never two mirrors on the same edge.
    let mirrorEdges = 0;
    for (let k = 0; k <= MAZE_BR_CELLS; k++) {
      for (let index = 0; index < MAZE_BR_CELLS; index++) {
        const at = k * MAZE_BR_CELLS + index;
        expect(MAZE_BR_GRID.mirrorV[at]! + MAZE_BR_GRID.glassV[at]!).toBeLessThanOrEqual(1);
        expect(MAZE_BR_GRID.mirrorH[at]! + MAZE_BR_GRID.glassH[at]!).toBeLessThanOrEqual(1);
        mirrorEdges += MAZE_BR_GRID.mirrorV[at]! + MAZE_BR_GRID.mirrorH[at]!;
        // Only standing interior edges can be mirrors: never the perimeter, never a carved-away edge.
        if (MAZE_BR_GRID.mirrorV[at] === 1) expect(MAZE_BR_GRID.v[at], `V ${k},${index}`).toBe(1);
        if (MAZE_BR_GRID.mirrorH[at] === 1) expect(MAZE_BR_GRID.h[at], `H ${k},${index}`).toBe(1);
        if (k === 0 || k === MAZE_BR_CELLS) expect(MAZE_BR_GRID.mirrorV[at]! + MAZE_BR_GRID.mirrorH[at]!).toBe(0);
      }
    }
    expect(mirrorEdges).toBeGreaterThanOrEqual(8);
    expect(mirrorEdges).toBeLessThanOrEqual(12);

    // Spread: edge midpoints at least 24 m apart, and four of them on the ring of corridors feeding the tower plaza.
    const midpoints: [number, number][] = [];
    for (let k = 0; k <= MAZE_BR_CELLS; k++) {
      for (let index = 0; index < MAZE_BR_CELLS; index++) {
        const at = k * MAZE_BR_CELLS + index;
        if (MAZE_BR_GRID.mirrorV[at] === 1) midpoints.push([mazeBrLineX(k), mazeBrCellCenterZ(index)]);
        if (MAZE_BR_GRID.mirrorH[at] === 1) midpoints.push([mazeBrCellCenterX(index), mazeBrLineZ(k)]);
      }
    }
    for (let a = 0; a < midpoints.length; a++) {
      for (let b = a + 1; b < midpoints.length; b++) {
        const d = Math.hypot(midpoints[a]![0] - midpoints[b]![0], midpoints[a]![1] - midpoints[b]![1]);
        expect(d, `mirrors at (${midpoints[a]}) and (${midpoints[b]})`).toBeGreaterThanOrEqual(20);
      }
    }
    // The tower is on the origin and the plaza reaches 12 m: four mirrors sit in the corridors 14…40 m out from it.
    expect(midpoints.filter(([x, z]) => Math.hypot(x, z) <= 40)).toHaveLength(4);

    // Every mirror closes off a T-junction cell (three open sides), so you walk up the stem straight into it.
    for (const [x, z] of midpoints) {
      const around = [mazeBrCellAt(x - 1, z), mazeBrCellAt(x + 1, z), mazeBrCellAt(x, z - 1), mazeBrCellAt(x, z + 1)].filter((c) => c !== null);
      expect(around.some(([i, j]) => [0, 1, 2, 3].filter((dir) => mazeBrIsOpen(i, j, dir)).length === 3), `mirror at (${x}, ${z})`).toBe(true);
    }
  });

  it("hides about 8% of the interior walls as walk-through hedges", () => {
    let interior = 0;
    let grass = 0;
    for (let k = 1; k < MAZE_BR_CELLS; k++) {
      for (let index = 0; index < MAZE_BR_CELLS; index++) {
        const at = k * MAZE_BR_CELLS + index;
        if (MAZE_BR_GRID.v[at] === 1) interior++;
        if (MAZE_BR_GRID.h[at] === 1) interior++;
        grass += MAZE_BR_GRID.grassV[at]! + MAZE_BR_GRID.grassH[at]!;
        // A wall lies in exactly one way: a hedge is never also glazed, mirrored or bulletproof.
        expect(MAZE_BR_GRID.grassV[at]! + MAZE_BR_GRID.glassV[at]! + MAZE_BR_GRID.mirrorV[at]!).toBeLessThanOrEqual(1);
        expect(MAZE_BR_GRID.grassH[at]! + MAZE_BR_GRID.glassH[at]! + MAZE_BR_GRID.mirrorH[at]!).toBeLessThanOrEqual(1);
        // Only ever a standing edge: never a corridor that was already open.
        if (MAZE_BR_GRID.grassV[at] === 1) expect(MAZE_BR_GRID.v[at], `V ${k},${index}`).toBe(1);
        if (MAZE_BR_GRID.grassH[at] === 1) expect(MAZE_BR_GRID.h[at], `H ${k},${index}`).toBe(1);
      }
    }
    // Rarer than the glazed panels (15%), commoner than the ten mirrors: doors nobody can see.
    expect(grass / interior).toBeGreaterThan(0.06);
    expect(grass / interior).toBeLessThan(0.1);
    const pieces = MAZE_BR_WALLS.filter((w) => isKind(w.prop, "wall_grass"));
    expect(pieces).toHaveLength(piecesOf(MAZE_BR_GRID.grassV, MAZE_BR_GRID.grassH));

    // Never the perimeter: a hedge in the outer wall would be a way out of the map, not a way through it.
    for (let index = 0; index < MAZE_BR_CELLS; index++) {
      for (const k of [0, MAZE_BR_CELLS]) {
        const at = k * MAZE_BR_CELLS + index;
        expect(MAZE_BR_GRID.grassV[at]! + MAZE_BR_GRID.grassH[at]!, `perimeter ${k},${index}`).toBe(0);
      }
    }

    // No collider at all — you walk through it and so do your bullets. That absence is the whole prop.
    const def = getMapProp("wall_grass");
    expect(def.collision).toEqual({ kind: "none" });
    // Sunk and tall like the wall it replaces, so it fills the same gap in the lattice.
    expect(def.sink).toBe(getMapProp("wall_concrete").sink);
    // Category "bush" is load-bearing: the nav grid only flags bush footprints as vegetation, and that flag is what
    // conceals a player standing in a hedge from a bot. Footprint 2 m covers a whole 4 m piece.
    expect(def.category).toBe("bush");
    expect(def.footprint).toBeGreaterThanOrEqual(MAZE_BR_WALL_PIECE / 2);

    // Spread out: two hedges within a corridor of each other would open a room, not a door.
    const edges = grassEdges();
    expect(edges).toHaveLength(grass);
    for (let a = 0; a < edges.length; a++) {
      for (let b = a + 1; b < edges.length; b++) {
        const d = Math.hypot(edges[a]!.x - edges[b]!.x, edges[a]!.z - edges[b]!.z);
        expect(d, `hedges at (${edges[a]!.x}, ${edges[a]!.z}) and (${edges[b]!.x}, ${edges[b]!.z})`).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it("never lets a hedge shortcut a long way round", () => {
    // The second, looser graph: the maze as a player who knows about the hedges walks it. Connectivity on it is not
    // worth asserting — it only ever adds edges to a graph the test above already proved connected — so what this
    // checks is shortcut power, which is the way walk-through walls actually break a maze.
    const edges = grassEdges();
    expect(edges.length).toBeGreaterThan(0);
    const looseV = Uint8Array.from(MAZE_BR_GRID.v);
    const looseH = Uint8Array.from(MAZE_BR_GRID.h);
    for (const e of edges) (e.axis === 0 ? looseV : looseH)[e.at] = 0;

    for (const e of edges) {
      const where = `hedge at (${e.x}, ${e.z})`;
      // Worth walking through: on the solid maze the way round is at least three cells.
      expect(distances(MAZE_BR_GRID.v, MAZE_BR_GRID.h, e.a)[e.b]!, where).toBeGreaterThanOrEqual(3);
      // And not a trapdoor: even with every other hedge already open, this one cuts at most ten cells off the walk.
      const v = Uint8Array.from(looseV);
      const h = Uint8Array.from(looseH);
      (e.axis === 0 ? v : h)[e.at] = 1;
      expect(distances(v, h, e.a)[e.b]!, where).toBeLessThanOrEqual(10);
    }

    // And together: the hedges shorten the map, but they do not flatten it.
    const strict = diameter(MAZE_BR_GRID.v, MAZE_BR_GRID.h);
    const loose = diameter(looseV, looseH);
    expect(loose).toBeLessThan(strict);
    expect(loose).toBeGreaterThan(strict * 0.7);
    // A 30 × 30 maze with three avenues, seven rooms and sixteen sealed nooks still has to be walked, not crossed.
    expect(strict).toBeGreaterThanOrEqual(MAZE_BR_CELLS * 2);
  });

  it("keeps the tower plaza and every spawn clear of walls", () => {
    const tower = layout.buildings.find((b) => b.id === "plaza_tower")!;
    expect(tower.prefab).toBe("watchtower");
    // The plaza is the 24 m square x, z ∈ [-12, 12]: no wall piece stands inside it.
    for (const wall of MAZE_BR_WALLS) {
      const [x, , z] = wall.position;
      const inside = Math.abs(x) < PLAZA_REACH && Math.abs(z) < PLAZA_REACH;
      expect(inside, `wall at ${x},${z} is inside the plaza`).toBe(false);
    }
    // The tower footprint (5.6 m) plus room to walk round it.
    expect(wallClearance(tower.position[0], tower.position[2])).toBeGreaterThan(4);

    for (const spawn of MAZE_BR.spawns) {
      const [x, z] = spawn.position;
      expect(mazeBrCellAt(x, z), `spawn ${x},${z}`).not.toBeNull();
      expect(wallClearance(x, z), `spawn ${x},${z} clearance`).toBeGreaterThan(2);
      // Spawns sit in open space, never boxed into a squeeze. The lattice is mostly 2 m lanes now, so the test is what
      // the validator actually measures — 2 m to every wall piece's *placement* — rather than the lane's nominal width:
      // a squeeze whose side walls the carve removed is as open as a corridor, and a corridor cell can be walled in.
      for (const wall of MAZE_BR_WALLS) {
        if (getMapProp(wall.prop).collision.kind === "none") continue;
        const d = Math.hypot(wall.position[0] - x, wall.position[2] - z);
        expect(d, `spawn ${x},${z} vs ${wall.prop} at ${wall.position}`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("puts every POI center in open space, with spawns of its own", () => {
    expect(MAZE_BR.pois).toHaveLength(5);
    expect(MAZE_BR.spawns.length).toBeGreaterThanOrEqual(20);
    for (const poi of MAZE_BR.pois) {
      const [x, z] = poi.center;
      expect(mazeBrCellAt(x, z), poi.id).not.toBeNull();
      expect(wallClearance(x, z), `${poi.id} clearance`).toBeGreaterThan(2);
      const own = MAZE_BR.spawns.filter((spawn) => {
        let best = MAZE_BR.pois[0]!;
        let bestSq = Infinity;
        for (const other of MAZE_BR.pois) {
          const d = (other.center[0] - spawn.position[0]) ** 2 + (other.center[1] - spawn.position[1]) ** 2;
          if (d < bestSq) [best, bestSq] = [other, d];
        }
        return best.id === poi.id;
      });
      expect(own.length, `${poi.id} spawns`).toBeGreaterThanOrEqual(4);
    }
  });

  it("pays for walking into a dead end", () => {
    // Alcoves are dead ends (one open side) inside a POI, each carrying loot pads of its own. Without them a dead end
    // is pure punishment: you walk in, find nothing, and walk back out past whoever followed you.
    expect(MAZE_BR_ALCOVES.length).toBeGreaterThanOrEqual(10);
    for (const [x, z] of MAZE_BR_ALCOVES) {
      const cell = mazeBrCellAt(x, z);
      expect(cell, `alcove ${x},${z}`).not.toBeNull();
      const [i, j] = cell!;
      expect([0, 1, 2, 3].filter((dir) => mazeBrIsOpen(i, j, dir)), `alcove ${x},${z} is a dead end`).toHaveLength(1);
      const inPoi = MAZE_BR.pois.some((p) => Math.hypot(p.center[0] - x, p.center[1] - z) <= p.radius);
      expect(inPoi, `alcove ${x},${z} is inside a POI, so its pad is gridded for loot`).toBe(true);
      // Two alcoves in one corner would pool the reward instead of spreading it.
      const others = MAZE_BR_ALCOVES.filter((o) => o[0] !== x || o[1] !== z);
      for (const o of others) expect(Math.hypot(o[0] - x, o[1] - z), `alcoves ${x},${z} and ${o}`).toBeGreaterThanOrEqual(20);
    }

    // Most of them hold a pile. The generator rolls once per pad, so each alcove carries several pads; this is what
    // that buys, averaged over seeds.
    const seeds = [1, 2, 3, 4];
    let hits = 0;
    for (const seed of seeds) {
      const loot = generateLoot(seed, MAZE_BR.pois, layout.buildings, { flatten: MAZE_BR.flatten, terrain, layout });
      for (const [x, z] of MAZE_BR_ALCOVES) {
        if (loot.piles.some((p) => Math.hypot(p.position[0] - x, p.position[2] - z) <= 4)) hits++;
      }
    }
    expect(hits / (seeds.length * MAZE_BR_ALCOVES.length)).toBeGreaterThan(0.6);
  });

  it("carries enough ground loot for twenty players, and not only guns", () => {
    // The maze has five small buildings, so the pads are nearly the whole supply. The uniform map ran about 45 piles
    // and 111 items over 144 m, which is two piles a player; this is the floor that has to hold now the map is 184 m
    // of mostly 4 m lanes — a single 9 m pad lattice loses about a third of its points to the walls, which is why the
    // quarter pads are doubled up (mazeBr.ts).
    const seeds = [1, 2, 3, 4];
    let piles = 0;
    let items = 0;
    const byItem: Record<string, number> = {};
    for (const seed of seeds) {
      const loot = generateLoot(seed, MAZE_BR.pois, layout.buildings, { flatten: MAZE_BR.flatten, terrain, layout });
      piles += loot.piles.length;
      items += loot.items.length;
      for (const item of loot.items) byItem[item.itemId] = (byItem[item.itemId] ?? 0) + 1;
      // Every pile is inside the maze, not in the mountains and not inside the tower.
      for (const pile of loot.piles) {
        expect(Math.abs(pile.position[0]), `pile at ${pile.position}`).toBeLessThan(MAZE_BR_HALF);
        expect(Math.abs(pile.position[2]), `pile at ${pile.position}`).toBeLessThan(MAZE_BR_HALF);
      }
    }
    expect(piles / seeds.length).toBeGreaterThan(230);
    expect(items / seeds.length).toBeGreaterThan(830);

    // What the pads carry, not only how much of it. An outdoor lattice point used to be a gun cache, so a match held
    // about 200 guns against 30 throwables, 33 heals and 38 pieces of armor and the owner walked the maze finding
    // rifles and ammo. The pads now ask for full building-style piles (PAD_LOOT in mazeBr.ts); these floors are what
    // that bought, and they are what a retune has to keep.
    const per = (id: string) => (byItem[id] ?? 0) / seeds.length;
    for (const [id, floor] of [["bandage", 40], ["first_aid", 32], ["medkit", 15], ["helmet_1", 28], ["vest_1", 28], ["backpack_1", 20], ["energy_drink", 12]] as const) {
      expect(per(id), id).toBeGreaterThanOrEqual(floor);
    }
    // Throwables: all four kinds turn up, the molotov ("bom lửa") included — it was under 5 a match before.
    for (const [id, floor] of [["frag", 20], ["smoke", 20], ["flash", 10], ["molotov", 10]] as const) {
      expect(per(id), id).toBeGreaterThanOrEqual(floor);
    }
    // Weapons: every one of the four, and the K-98 is a real find now the avenues give it a 184 m sightline. POI
    // `kind` is the one lever a map has over the weapon table, and the quarters are `military` for exactly this.
    for (const [id, floor] of [["weapon_rifle", 90], ["weapon_shotgun", 48], ["weapon_sniper", 36], ["weapon_pistol", 24]] as const) {
      expect(per(id), id).toBeGreaterThanOrEqual(floor);
    }
    expect(per("weapon_rifle")).toBeGreaterThan(per("weapon_shotgun"));
    expect(per("weapon_shotgun")).toBeGreaterThan(per("weapon_sniper"));
    expect(per("weapon_sniper")).toBeGreaterThan(per("weapon_pistol"));
  });

  it("lets a bot walk to every spawn, POI, loot pile and the tower platform", () => {
    const grid = buildNavGrid({ map: MAZE_BR, terrain, layout });
    const nav = createNavQuery(grid);
    // Nothing is orphaned. A 2 m lane leaves 1.1 m of walkable floor once the 0.3 m agent radius is taken off both
    // wall faces, which is two of the nav grid's 0.5 m columns — enough, but with nothing to spare, so anything laid
    // across a lane cuts the maze in two. A 4.5 m cover prop dropped in a 2 m room cell did exactly that and stranded
    // a pocket; the island count is the cheapest guard against it coming back.
    expect(grid.stats?.clearedIslands, "nav islands cleared").toBe(0);
    const scratch = { x: 0, y: 0, z: 0 };
    const from = nav.nearest({ x: 0, y: terrain.sampleHeight(0, 0), z: 0 }, 2, scratch);
    expect(grid.componentOf(from)).toBe(grid.layout.mainComponent);
    const results = resolveProbes(nav, mapNavProbes(MAZE_BR, terrain, layout), from);
    expect(results.length).toBeGreaterThan(MAZE_BR.spawns.length + MAZE_BR.pois.length);
    expect(results.some((r) => r.probe.upper)).toBe(true);
    const unreachable = results.filter((r) => !r.reachable).map((r) => r.probe.name);
    // The tower stairs are in there too (`room:plaza_tower:platform` is 9 m up).
    expect(unreachable).toEqual([]);
    // Every platform, the plaza's and the four corner towers', is one of those probes and one of those climbs: a
    // corner tower whose stairs a generated wall had sealed off would be scenery.
    const platforms = results.filter((r) => r.probe.name.endsWith(":platform"));
    expect(platforms.map((r) => r.probe.name).sort()).toEqual([
      "room:north_east_tower:platform",
      "room:north_west_tower:platform",
      "room:plaza_tower:platform",
      "room:south_east_tower:platform",
      "room:south_west_tower:platform",
    ]);
    for (const p of platforms) expect(p.probe.upper, p.probe.name).toBe(true);

    // Ground loot is not in `mapNavProbes` (it is generated per match, not per map), and a 4 m squeeze is the width
    // this map now has to prove a bot capsule fits down: every pile and every alcove has to be walkable to.
    const loot = generateLoot(7, MAZE_BR.pois, layout.buildings, { flatten: MAZE_BR.flatten, terrain, layout });
    expect(loot.piles.length).toBeGreaterThan(220);
    const stranded = loot.piles.filter((pile) => {
      const ref = nav.nearest({ x: pile.position[0], y: pile.position[1], z: pile.position[2] }, 1.5, scratch);
      return ref < 0 || !nav.reachable(from, ref);
    });
    expect(stranded.map((p) => p.position.join(","))).toEqual([]);
    for (const [x, z] of MAZE_BR_ALCOVES) {
      const ref = nav.nearest({ x, y: terrain.sampleHeight(x, z), z }, 1.5, scratch);
      expect(ref, `alcove ${x},${z}`).toBeGreaterThanOrEqual(0);
      expect(nav.reachable(from, ref), `alcove ${x},${z}`).toBe(true);
    }
    // Every cell centre is walkable, 2 m squeezes included: nothing in the maze is a pocket the nav grid cannot enter.
    // This is the proof that a 1.7 m clear lane still takes a 0.35 m capsule with a 0.3 m nav inflation — two free nav
    // columns across the lane, and two through every doorway. The five tower cells are the exception, because a tower
    // stands on each of them.
    for (let j = 0; j < MAZE_BR_CELLS; j++) {
      for (let i = 0; i < MAZE_BR_CELLS; i++) {
        const x = mazeBrCellCenterX(i);
        const z = mazeBrCellCenterZ(j);
        if (layout.buildings.some((b) => Math.hypot(x - b.position[0], z - b.position[2]) < 5)) continue;
        const ref = nav.nearest({ x, y: terrain.sampleHeight(x, z), z }, 1.5, scratch);
        expect(ref, `cell ${i},${j} at (${x}, ${z})`).toBeGreaterThanOrEqual(0);
        expect(nav.reachable(from, ref), `cell ${i},${j} at (${x}, ${z})`).toBe(true);
      }
    }
  }, 60_000);

  it("cuts shooting nooks off the long lanes, sealed on three sides", () => {
    // "ngách bắn súng nhắm": a one-cell recess whose single mouth opens onto a lane long enough to be worth holding.
    expect(MAZE_BR_NOOKS.length).toBeGreaterThanOrEqual(12);
    const seen = new Set<string>();
    let onAvenue = 0;
    for (const [x, z] of MAZE_BR_NOOKS) {
      const cell = mazeBrCellAt(x, z);
      expect(cell, `nook ${x},${z}`).not.toBeNull();
      const [i, j] = cell!;
      // Exactly one way in and out: a nook is a position, not a route.
      const open = [0, 1, 2, 3].filter((dir) => mazeBrIsOpen(i, j, dir));
      expect(open, `nook ${x},${z} has one mouth`).toHaveLength(1);
      // A recess, not a room: no wider than a corridor on either side, so you fill it and it covers you.
      expect(Math.max(mazeBrColumnWidth(i), mazeBrRowHeight(j)), `nook ${x},${z} size`).toBeLessThanOrEqual(MAZE_BR_WIDTHS.corridor);
      // Never the same cell twice, and spread: a lane lined with nooks is a colonnade, not a maze.
      expect(seen.has(`${i},${j}`)).toBe(false);
      seen.add(`${i},${j}`);
      for (const other of MAZE_BR_NOOKS) {
        if (other[0] === x && other[1] === z) continue;
        expect(Math.hypot(other[0] - x, other[1] - z), `nooks ${x},${z} and ${other}`).toBeGreaterThanOrEqual(14);
      }
      // The mouth opens onto a cell that really is on a long straight run: walk it to the first wall both ways and
      // measure. This is the whole point of a nook — it has to overlook something worth overlooking. A mouth facing
      // ±X (dir 0, 1) looks out at a lane running along Z, and the other way round.
      const dir = open[0]!;
      const [li, lj] = [i + DIR_DX[dir]!, j + DIR_DZ[dir]!];
      const laneAxis: 0 | 1 = dir < 2 ? 1 : 0;
      const runLength = (i0: number, j0: number, axis: 0 | 1): number => {
        let span = axis === 0 ? mazeBrColumnWidth(i0) : mazeBrRowHeight(j0);
        for (const step of [1, -1]) {
          let [ci, cj] = [i0, j0];
          for (;;) {
            const d = axis === 0 ? (step > 0 ? 0 : 1) : step > 0 ? 2 : 3;
            if (!mazeBrIsOpen(ci, cj, d)) break;
            ci += axis === 0 ? step : 0;
            cj += axis === 0 ? 0 : step;
            if (ci < 0 || cj < 0 || ci >= MAZE_BR_CELLS || cj >= MAZE_BR_CELLS) break;
            span += axis === 0 ? mazeBrColumnWidth(ci) : mazeBrRowHeight(cj);
          }
        }
        return span;
      };
      const lane = runLength(li, lj, laneAxis);
      expect(lane, `nook ${x},${z} overlooks a ${lane} m lane`).toBeGreaterThanOrEqual(28);
      if (lane >= 150) onAvenue++;
      // A nook is never also an alcove: one pays you for exploring, the other for staying.
      for (const a of MAZE_BR_ALCOVES) expect(a[0] === x && a[1] === z, `nook ${x},${z} is also an alcove`).toBe(false);
      // Nobody shoots you through the back of one: its three sealed sides are plain concrete, never a pane, a mirror
      // or a hedge you can walk through.
      for (const wall of MAZE_BR_WALLS) {
        const d = Math.hypot(wall.position[0] - x, wall.position[2] - z);
        if (d > Math.max(mazeBrColumnWidth(i), mazeBrRowHeight(j)) / 2 + 0.5) continue;
        expect(isKind(wall.prop, "wall_concrete"), `${wall.prop} at ${wall.position} beside nook ${x},${z}`).toBe(true);
      }
    }
    // Several of them cover an avenue, which is the sightline the owner asked for a firing position on.
    expect(onAvenue).toBeGreaterThanOrEqual(3);
  });

  it("stands a small watchtower in each corner, all of them shorter than the plaza's", () => {
    const plaza = layout.buildings.find((b) => b.id === "plaza_tower")!;
    const corners = layout.buildings.filter((b) => b.id !== "plaza_tower");
    expect(corners).toHaveLength(4);
    const platformY = (id: BuildingPrefabId) => getBuildingPrefab(id).rooms.find((r) => r.id === "platform")!.floorY;
    const topY = (id: BuildingPrefabId) => getBuildingPrefab(id).bounds.max[1];
    expect(platformY("watchtower")).toBe(9);

    const quadrants = new Set<string>();
    for (const tower of corners) {
      expect(tower.prefab).toBe("watchtower_small");
      // Clearly secondary: two flights to a 6 m platform against the plaza tower's three to 9 m, a roof 3 m lower, and
      // no bigger on the ground. If a corner tower matched the middle one the middle one would stop being special.
      expect(platformY(tower.prefab)).toBe(6);
      expect(platformY(tower.prefab)).toBeLessThan(platformY(plaza.prefab));
      expect(topY(tower.prefab)).toBeLessThan(topY(plaza.prefab) - 2);
      for (const axis of [0, 1] as const) expect(tower.bounds.halfExtents[axis]).toBeLessThanOrEqual(plaza.bounds.halfExtents[axis]);
      const [x, , z] = tower.position;
      quadrants.add(`${Math.sign(x)},${Math.sign(z)}`);
      // Inside its own quarter POI, and its courtyard really is a 2 × 2 room: no wall within the foundation's reach.
      const poi = MAZE_BR.pois.find((p) => p.id === tower.poi)!;
      expect(poi.id, `${tower.id} poi`).not.toBe("plaza");
      expect(Math.hypot(poi.center[0] - x, poi.center[1] - z), `${tower.id} inside ${poi.id}`).toBeLessThanOrEqual(poi.radius);
      expect(wallClearance(x, z), `${tower.id} clearance`).toBeGreaterThan(3);
      // Nothing lands on it and no barrier is stacked against its one stair.
      for (const spawn of MAZE_BR.spawns) expect(Math.hypot(spawn.position[0] - x, spawn.position[1] - z), `${tower.id} vs spawn`).toBeGreaterThan(8);
      for (const prop of MAZE_BR_COVER) expect(Math.hypot(prop.position[0] - x, prop.position[2] - z), `${tower.id} vs ${prop.prop}`).toBeGreaterThan(5);
    }
    // One per quadrant of the map.
    expect(quadrants.size).toBe(4);
  });

  it("builds and validates", () => {
    expect(layout.buildings).toHaveLength(5);
    expect(of("spawn")).toEqual([]);
    expect(of("poi-spacing")).toEqual([]);
    expect(of("building-not-on-pad")).toEqual([]);
    expect(of("building-entrance")).toEqual([]);
    expect(of("prop-at-entrance")).toEqual([]);
    expect(issues).toEqual([]);
  });
});
