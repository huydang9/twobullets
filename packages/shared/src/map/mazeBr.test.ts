import { describe, expect, it } from "vitest";
import { buildNavGrid } from "../bots/nav/buildNavGrid";
import { mapNavProbes, resolveProbes } from "../bots/nav/mapProbes";
import { createNavQuery } from "../bots/nav/navQuery";
import { buildMapLayout } from "./layout/mapLayout";
import { MAP_PROP_IDS, getMapProp } from "./layout/props";
import { validateMapLayout, type MapIssueKind } from "./layout/validate";
import { GLASS_PHASE, glassBlocksAt, glassPhaseBucket } from "./glassPhase";
import type { PropPlacement } from "./types";
import {
  MAZE_BR,
  MAZE_BR_CELLS,
  MAZE_BR_GRID,
  MAZE_BR_HALF,
  MAZE_BR_PITCH,
  MAZE_BR_VALIDATION,
  MAZE_BR_WALLS,
  mazeBrCellCenter,
  mazeBrIsOpen,
  mazeBrLineCoord,
} from "./mazeBr";
import { checksumBytes } from "./terrain/heightfield";
import { buildTerrain } from "./terrain/terrain";

/** Prop budget: 684 lattice edges, most of them carved away; two 4 m pieces per standing edge. */
const PROP_BUDGET = 900;

const DIR_DX = [1, -1, 0, 0];
const DIR_DZ = [0, 0, 1, -1];

/** Cell containing a world point, or null when it is outside the maze. */
function cellAt(x: number, z: number): [number, number] | null {
  const i = Math.floor((x + MAZE_BR_HALF) / MAZE_BR_PITCH);
  const j = Math.floor((z + MAZE_BR_HALF) / MAZE_BR_PITCH);
  if (i < 0 || j < 0 || i >= MAZE_BR_CELLS || j >= MAZE_BR_CELLS) return null;
  return [i, j];
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
      if (MAZE_BR_GRID.grassV[at] === 1) out.push({ axis: 0, at, a: index * n + (k - 1), b: index * n + k, x: mazeBrLineCoord(k), z: mazeBrCellCenter(index) });
      if (MAZE_BR_GRID.grassH[at] === 1) out.push({ axis: 1, at, a: (k - 1) * n + index, b: k * n + index, x: mazeBrCellCenter(index), z: mazeBrLineCoord(k) });
    }
  }
  return out;
}

/**
 * Distance from a point to the nearest wall piece's collider footprint (the box is 4 × 0.3 m around its center).
 * `wall_grass` has no collider at all, so it is not a wall to anything that has to walk or stand: it is skipped here.
 */
function wallClearance(x: number, z: number): number {
  let best = Infinity;
  for (const wall of MAZE_BR_WALLS) {
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

describe("Maze map", () => {
  const terrain = buildTerrain(MAZE_BR.terrain, MAZE_BR.flatten);
  const layout = buildMapLayout(MAZE_BR, terrain);
  const issues = validateMapLayout(MAZE_BR, terrain, layout, MAZE_BR_VALIDATION);
  const of = (kind: MapIssueKind) => issues.filter((i) => i.kind === kind).map((i) => i.message);

  it("generates the same maze every build", () => {
    // Every piece's place and kind: concrete 0, mirror 2, grass 4, and a glazed pane as 10 + its phase group, so the
    // pane's mode schedule is pinned here too — it is derived from where the pane stands, and a change to that
    // derivation moves this the way a change to the seed, carve, braid, glass pick, mirror pick or grass pick does.
    const kind = (wall: PropPlacement) =>
      wall.prop === "wall_glass"
        ? 10 + glassPhaseBucket(wall.position[0], wall.position[2])
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
    expect(checksumBytes(data)).toBe("d6df2ff5");
    expect(MAZE_BR.id).toBe("mazebr");
    expect(MAZE_BR.terrain.playableHalfExtent).toBe(72);
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
    for (let j = 8; j <= 10; j++) {
      for (let i = 8; i <= 10; i++) expect(seen[j * MAZE_BR_CELLS + i], `plaza cell ${i},${j}`).toBe(1);
    }
  });

  it("emits two wall pieces per standing edge, within budget", () => {
    const kinds = ["wall_concrete", "wall_glass", "wall_mirror", "wall_grass"];
    expect(MAZE_BR_WALLS.filter((w) => kinds.includes(w.prop))).toHaveLength(MAZE_BR_WALLS.length);
    expect(MAZE_BR_WALLS.length).toBeLessThan(PROP_BUDGET);
    expect(MAZE_BR_WALLS.length % 2).toBe(0);
    // The perimeter alone is 4 × 18 edges, so the maze can never be emptier than that.
    expect(MAZE_BR_WALLS.length).toBeGreaterThan(4 * MAZE_BR_CELLS * 2);
    for (const wall of MAZE_BR_WALLS) {
      expect(Math.abs(wall.position[0])).toBeLessThanOrEqual(MAZE_BR_HALF);
      expect(Math.abs(wall.position[2])).toBeLessThanOrEqual(MAZE_BR_HALF);
      expect(wall.snapToTerrain).toBe(true);
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
    const panes = MAZE_BR_WALLS.filter((w) => w.prop === "wall_glass");
    expect(panes).toHaveLength(glass * 2);
    // One glazed pane prop, and its resting mode (what the pure layout and the nav grid see) is shoot-through.
    expect(getMapProp("wall_glass").collision).toMatchObject({ kind: "box", bulletproof: false });
    expect(MAP_PROP_IDS.filter((id) => id.startsWith("wall_glass"))).toEqual(["wall_glass"]);

    // No two glazed edges share a cell corner: the pieces are spread, not clustered into glass rooms.
    const centers = panes.map((w) => [w.position[0], w.position[2]] as const);
    const unique = [...new Set(centers.map(([x, z]) => `${x},${z}`))];
    expect(unique.length).toBe(centers.length);

    // Panes in every quadrant, so no corner of the maze is the one you can always shoot through.
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const here = panes.some((w) => Math.sign(w.position[0] - 4) === sx && Math.sign(w.position[2] - 4) === sz);
      expect(here, `pane in quadrant ${sx},${sz}`).toBe(true);
    }
  });

  it("gives every pane a phase group, both its pieces the same one, and never flips them all together", () => {
    const panes = MAZE_BR_WALLS.filter((w) => w.prop === "wall_glass");
    // The two 4 m pieces of an 8 m edge must agree: half a pane stopping bullets would read as a bug. They do because
    // the group comes from the 8 m cell a piece stands in, and both pieces of an edge stand in the same one.
    const byEdge = new Map<string, number[]>();
    // The edge a piece belongs to: it stands 2 m off the edge's midpoint along the wall's own X, and that midpoint is
    // a cell centre on one axis and a lattice line on the other.
    const centre = (v: number) => Math.round((v + 68) / MAZE_BR_PITCH) * MAZE_BR_PITCH - 68;
    for (const piece of panes) {
      const [x, , z] = piece.position;
      const key = Math.abs(Math.cos(piece.yaw)) > 0.5 ? `${centre(x)},${z}` : `${x},${centre(z)}`;
      const group = byEdge.get(key) ?? [];
      group.push(glassPhaseBucket(x, z));
      byEdge.set(key, group);
    }
    expect(byEdge.size).toBe(panes.length / 2);
    for (const [key, groups] of byEdge) {
      expect(groups, `pane at ${key}`).toHaveLength(2);
      expect(new Set(groups).size, `pane at ${key}`).toBe(1);
    }

    const buckets = panes.map((w) => glassPhaseBucket(w.position[0], w.position[2]));
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
    const pieces = MAZE_BR_WALLS.filter((w) => w.prop === "wall_mirror");
    // Each edge is two pieces, and each live one costs the client a render pass: this stays a small, counted number.
    expect(pieces.length % 2).toBe(0);
    const edges = pieces.length / 2;
    expect(edges).toBeGreaterThanOrEqual(8);
    expect(edges).toBeLessThanOrEqual(12);
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
        // Only standing interior edges can be mirrors: never the perimeter (k 0 and 18), never a carved-away edge.
        if (MAZE_BR_GRID.mirrorV[at] === 1) expect(MAZE_BR_GRID.v[at], `V ${k},${index}`).toBe(1);
        if (MAZE_BR_GRID.mirrorH[at] === 1) expect(MAZE_BR_GRID.h[at], `H ${k},${index}`).toBe(1);
        if (k === 0 || k === MAZE_BR_CELLS) expect(MAZE_BR_GRID.mirrorV[at]! + MAZE_BR_GRID.mirrorH[at]!).toBe(0);
      }
    }
    expect(mirrorEdges).toBe(edges);

    // Spread: edge midpoints at least 20 m apart, and four of them on the ring of corridors feeding the tower plaza.
    const midpoints: [number, number][] = [];
    for (let k = 0; k <= MAZE_BR_CELLS; k++) {
      for (let index = 0; index < MAZE_BR_CELLS; index++) {
        const at = k * MAZE_BR_CELLS + index;
        if (MAZE_BR_GRID.mirrorV[at] === 1) midpoints.push([mazeBrLineCoord(k), mazeBrCellCenter(index)]);
        if (MAZE_BR_GRID.mirrorH[at] === 1) midpoints.push([mazeBrCellCenter(index), mazeBrLineCoord(k)]);
      }
    }
    for (let a = 0; a < midpoints.length; a++) {
      for (let b = a + 1; b < midpoints.length; b++) {
        const d = Math.hypot(midpoints[a]![0] - midpoints[b]![0], midpoints[a]![1] - midpoints[b]![1]);
        expect(d, `mirrors at (${midpoints[a]}) and (${midpoints[b]})`).toBeGreaterThanOrEqual(20);
      }
    }
    // The tower is at (4, 4) and the plaza reaches 12 m: four mirrors sit in the corridors 14…26 m out from it.
    expect(midpoints.filter(([x, z]) => Math.hypot(x - 4, z - 4) <= 26)).toHaveLength(4);

    // Every mirror closes off a T-junction cell (three open sides), so you walk up the stem straight into it.
    for (const [x, z] of midpoints) {
      const around = [cellAt(x - 2, z), cellAt(x + 2, z), cellAt(x, z - 2), cellAt(x, z + 2)].filter((c) => c !== null);
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
    // Rarer than the glazed panels (15%), commoner than the ten mirrors: roughly twenty doors nobody can see.
    expect(grass / interior).toBeGreaterThan(0.06);
    expect(grass / interior).toBeLessThan(0.1);
    const pieces = MAZE_BR_WALLS.filter((w) => w.prop === "wall_grass");
    expect(pieces).toHaveLength(grass * 2);

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
    // conceals a player standing in a hedge from a bot. Footprint 2 m covers the whole 8 m edge from its two pieces.
    expect(def.category).toBe("bush");
    expect(def.footprint).toBeGreaterThanOrEqual(MAZE_BR_PITCH / 4);

    // Spread out: two hedges within a corridor of each other would open a room, not a door.
    const edges = grassEdges();
    expect(edges).toHaveLength(grass);
    for (let a = 0; a < edges.length; a++) {
      for (let b = a + 1; b < edges.length; b++) {
        const d = Math.hypot(edges[a]!.x - edges[b]!.x, edges[a]!.z - edges[b]!.z);
        expect(d, `hedges at (${edges[a]!.x}, ${edges[a]!.z}) and (${edges[b]!.x}, ${edges[b]!.z})`).toBeGreaterThanOrEqual(12);
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
  });

  it("keeps the tower plaza and every spawn clear of walls", () => {
    const tower = layout.buildings.find((b) => b.id === "plaza_tower")!;
    expect(tower.prefab).toBe("watchtower");
    // The plaza is the 24 m square x, z ∈ [-8, 16]: no wall piece stands inside it.
    for (const wall of MAZE_BR_WALLS) {
      const [x, , z] = wall.position;
      expect(x > -8 && x < 16 && z > -8 && z < 16, `wall at ${x},${z} is inside the plaza`).toBe(false);
    }
    // The tower footprint (5.6 m) plus room to walk round it.
    expect(wallClearance(tower.position[0], tower.position[2])).toBeGreaterThan(4);

    for (const spawn of MAZE_BR.spawns) {
      const [x, z] = spawn.position;
      expect(cellAt(x, z), `spawn ${x},${z}`).not.toBeNull();
      expect(wallClearance(x, z), `spawn ${x},${z} clearance`).toBeGreaterThan(2);
    }
  });

  it("puts every POI center in open space, with spawns of its own", () => {
    expect(MAZE_BR.pois).toHaveLength(5);
    expect(MAZE_BR.spawns.length).toBeGreaterThanOrEqual(20);
    for (const poi of MAZE_BR.pois) {
      const [x, z] = poi.center;
      expect(cellAt(x, z), poi.id).not.toBeNull();
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
    // Cell centres are exactly 4 m from the lattice lines, so mazeBrCellCenter and the pitch stay in step.
    expect(mazeBrCellCenter(0)).toBe(-MAZE_BR_HALF + MAZE_BR_PITCH / 2);
    expect(mazeBrCellCenter(MAZE_BR_CELLS - 1)).toBe(MAZE_BR_HALF - MAZE_BR_PITCH / 2);
  });

  it("lets a bot walk to every spawn, POI and the tower platform", () => {
    const grid = buildNavGrid({ map: MAZE_BR, terrain, layout });
    const nav = createNavQuery(grid);
    const scratch = { x: 0, y: 0, z: 0 };
    const from = nav.nearest({ x: 0, y: terrain.sampleHeight(0, 0), z: 0 }, 2, scratch);
    expect(grid.componentOf(from)).toBe(grid.layout.mainComponent);
    const results = resolveProbes(nav, mapNavProbes(MAZE_BR, terrain, layout), from);
    expect(results.length).toBeGreaterThan(MAZE_BR.spawns.length + MAZE_BR.pois.length);
    expect(results.some((r) => r.probe.upper)).toBe(true);
    const unreachable = results.filter((r) => !r.reachable).map((r) => r.probe.name);
    // The tower stairs are in there too (`room:plaza_tower:platform` is 9 m up).
    expect(unreachable).toEqual([]);
  }, 30_000);

  it("builds and validates", () => {
    expect(layout.buildings).toHaveLength(1);
    expect(of("spawn")).toEqual([]);
    expect(of("poi-spacing")).toEqual([]);
    expect(of("building-not-on-pad")).toEqual([]);
    expect(of("building-entrance")).toEqual([]);
    expect(of("prop-at-entrance")).toEqual([]);
    expect(issues).toEqual([]);
  });
});
