import { describe, expect, it } from "vitest";
import { NavFlag, type NavPath, type NavQuery, type PathOptions, type PathStatus } from "../types";
import { buildNavGrid } from "./buildNavGrid";
import { navMainComponent, isValidZoneCenter } from "./helpers";
import { NavGridData } from "./navGrid";
import { auditBuildingLinks } from "./linkAudit";
import { GridNavQuery, createNavQuery } from "./navQuery";
import { deserializeNavGrid, serializeNavGrid } from "./serialize";
import { emptyPath, testWorld } from "./testWorld";

// Vite's glob import (this package doesn't load vite/client or Node types).
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
  }
}
const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true });

const P = (x: number, y: number, z: number) => ({ x, y, z });

function solve(nav: NavQuery, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, options: PathOptions | null = null, budget = 1e9): { status: PathStatus; path: NavPath; handle: number } {
  const path = emptyPath();
  const handle = nav.requestPath(from, to, options);
  let status = nav.readPath(handle, path);
  for (let i = 0; status === "pending" && i < 1e6; i++) {
    nav.update(budget);
    status = nav.readPath(handle, path);
  }
  return { status, path, handle };
}

function pathFlags(path: NavPath): number {
  let f = 0;
  for (let i = 0; i < path.count; i++) f |= path.flags[i]!;
  return f;
}

function maxY(path: NavPath): number {
  let y = -Infinity;
  for (let i = 0; i < path.count; i++) y = Math.max(y, path.points[i * 3 + 1]!);
  return y;
}

describe("nav grid: terrain layer", () => {
  it("builds a flat open square as one component with straight paths", () => {
    const grid = buildNavGrid(testWorld());
    expect(grid.info.width).toBe(120);
    expect(grid.info.components).toBe(1);
    const nav = createNavQuery(grid);
    const { status, path } = solve(nav, P(-20, 0, -20), P(20, 0, 15));
    expect(status).toBe("found");
    expect(path.count).toBe(2);
    expect(path.length).toBeCloseTo(Math.hypot(40, 35), 0);
    expect(isValidZoneCenter(grid)(0, 0)).toBe(true);
    expect(navMainComponent(grid)).toBe(1);
  });

  it("blocks slopes steeper than 40° and splits components across a cliff", () => {
    // A 60° ramp band across the whole map between x = 0 and 4 m.
    const grid = buildNavGrid(testWorld({ height: (x) => (x < 0 ? 0 : x > 4 ? 4 * Math.sqrt(3) : x * Math.sqrt(3)) }));
    expect(grid.info.components).toBe(2);
    const nav = createNavQuery(grid);
    const out = P(0, 0, 0);
    const west = nav.nearest(P(-10, 0, 0), 2, out);
    const east = nav.nearest(P(10, 6.93, 0), 2, out);
    expect(nav.reachable(west, east)).toBe(false);
    expect(solve(nav, P(-10, 0, 0), P(10, 6.93, 0)).status).toBe("unreachable");
    const partial = solve(nav, P(-10, 0, 0), P(10, 6.93, 0), { partial: true });
    expect(partial.status).toBe("partial");
    const lastX = partial.path.points[(partial.path.count - 1) * 3]!;
    expect(lastX).toBeGreaterThan(-1.5);
    expect(lastX).toBeLessThan(0.5);

    // 30° stays walkable.
    const gentle = buildNavGrid(testWorld({ height: (x) => (x < 0 ? 0 : x > 8 ? 8 * Math.tan(Math.PI / 6) : x * Math.tan(Math.PI / 6)) }));
    expect(gentle.info.components).toBe(1);
  });

  it("inflates prop colliders by the agent radius and steps over low ones", () => {
    const grid = buildNavGrid(testWorld({ props: [{ prop: "tree_fir_a", x: 0.25, z: 0.25 }, { prop: "rock_small", x: 10.25, z: 0.25, scale: 0.5 }, { prop: "wall_concrete", x: -10, z: 0 }] }));
    const at = (x: number, z: number) => grid.flagsOf(grid.cellAt(x, z));
    // Trunk radius 0.2 + 0.3 inflation.
    expect(at(0.25, 0.25) & NavFlag.walkable).toBe(0);
    expect(at(0.75, 0.25) & NavFlag.walkable).toBe(0);
    expect(at(1.25, 0.25) & NavFlag.walkable).toBe(NavFlag.walkable);
    expect(at(1.25, 0.25) & NavFlag.nearObstacle).toBe(NavFlag.nearObstacle);
    expect(at(5.25, 5.25) & NavFlag.nearObstacle).toBe(0);
    // A half-scale small rock is 0.2 m tall: walkable.
    expect(at(10.25, 0.25) & NavFlag.walkable).toBe(NavFlag.walkable);
    // Concrete wall 4 × 0.3 m: blocked across, open past its ends.
    expect(at(-10.25, 0.25) & NavFlag.walkable).toBe(0);
    expect(at(-10.25, 0.75) & NavFlag.walkable).toBe(NavFlag.walkable);
    expect(at(-12.75, 0.25) & NavFlag.walkable).toBe(NavFlag.walkable);
    const nav = createNavQuery(grid);
    expect(nav.lineWalkable(P(-10, 0, -3), P(-10, 0, 3))).toBe(false);
    expect(nav.lineWalkable(P(-14, 0, -3), P(-14, 0, 3))).toBe(true);
    const { status, path } = solve(nav, P(-10, 0, -3), P(-10, 0, 3));
    expect(status).toBe("found");
    expect(path.count).toBeGreaterThan(2);
    expect(path.length).toBeGreaterThan(6.5);
  });

  it("flags vegetation from bushes", () => {
    const grid = buildNavGrid(testWorld({ props: [{ prop: "bush_c", x: 5, z: 5 }] }));
    const f = grid.flagsOf(grid.cellAt(5.1, 5.1));
    expect(f & NavFlag.vegetation).toBe(NavFlag.vegetation);
    expect(f & NavFlag.walkable).toBe(NavFlag.walkable);
  });

  it("clears walkable islands smaller than 8 m²", () => {
    // Four concrete walls boxing in about 2 × 2 m.
    const props = [
      { prop: "wall_concrete", x: 0, z: 1.6 },
      { prop: "wall_concrete", x: 0, z: -1.6 },
      { prop: "wall_concrete", x: 1.6, z: 0, yaw: Math.PI / 2 },
      { prop: "wall_concrete", x: -1.6, z: 0, yaw: Math.PI / 2 },
    ];
    const grid = buildNavGrid(testWorld({ props }));
    expect(grid.flagsOf(grid.cellAt(0.1, 0.1)) & NavFlag.walkable).toBe(0);
    expect(grid.info.components).toBe(1);
    expect(grid.stats!.clearedIslands).toBe(1);
  });
});

describe("nav grid: building layers", () => {
  const house = buildNavGrid(testWorld({ height: () => -0.1, buildings: [{ id: "h", prefab: "house_two_story", position: [0, 0, 0], yaw: 0 }] }));
  const nav = createNavQuery(house);
  const out = P(0, 0, 0);

  it("links doors to the terrain and resolves floors by height", () => {
    expect(house.info.buildingNodes).toBeGreaterThan(1000);
    expect(house.stats!.links).toBeGreaterThan(0);
    expect(house.info.components).toBeGreaterThanOrEqual(1);
    const outside = nav.nearest(P(0, -0.1, 20), 1, out);
    const entrance = nav.nearest(P(0, 0, 6.2), 1.5, out);
    expect(nav.reachable(outside, entrance)).toBe(true);
    const ground = nav.nearest(P(-3.2, 0.2, 0), 1, out);
    expect(out.y).toBeCloseTo(0, 3);
    const upper = nav.nearest(P(-3.2, 3.2, 0), 1, out);
    expect(out.y).toBeCloseTo(3, 3);
    expect(ground).not.toBe(upper);
    expect(nav.flagsAt(ground) & NavFlag.indoor).toBe(NavFlag.indoor);
    expect(nav.reachable(outside, upper)).toBe(true);
  });

  it("climbs the stairs to the upper floor and back down", () => {
    const up = solve(nav, P(0, -0.1, 20), P(-3.2, 3, 0));
    expect(up.status).toBe("found");
    const flags = pathFlags(up.path);
    expect(flags & NavFlag.stairs).toBe(NavFlag.stairs);
    expect(flags & NavFlag.door).toBe(NavFlag.door);
    expect(up.path.points[(up.path.count - 1) * 3 + 1]).toBeCloseTo(3, 3);
    // Every step between consecutive waypoints on stairs stays climbable per meter travelled.
    for (let i = 1; i < up.path.count; i++) {
      const dy = up.path.points[i * 3 + 1]! - up.path.points[(i - 1) * 3 + 1]!;
      const dxz = Math.hypot(up.path.points[i * 3]! - up.path.points[(i - 1) * 3]!, up.path.points[i * 3 + 2]! - up.path.points[(i - 1) * 3 + 2]!);
      expect(Math.abs(dy)).toBeLessThanOrEqual(0.36 + dxz * 1.2);
    }
    const down = solve(nav, P(3.2, 3, 0), P(-20, -0.1, -20));
    expect(down.status).toBe("found");
    expect(pathFlags(down.path) & NavFlag.stairs).toBe(NavFlag.stairs);
  });

  it("keeps walls: no straight line through a partition, straight inside a room", () => {
    expect(nav.lineWalkable(P(-3.2, 0, 0), P(3.2, 0, 2))).toBe(false);
    expect(nav.lineWalkable(P(-3.2, 0, -2), P(-3.2, 0, 2))).toBe(true);
    expect(nav.lineWalkable(P(0, -0.1, 10), P(0, -0.1, 3))).toBe(false);
    // The room straight above or below is not a straight walk (stairs are the way).
    expect(nav.lineWalkable(P(-3.2, 0, -2), P(-3.2, 3, 2))).toBe(false);
    expect(nav.lineWalkable(P(-3.2, 3, -2), P(-3.2, 0, 2))).toBe(false);
    expect(nav.lineWalkable(P(-3.2, 3, -2), P(-3.2, 3, 2))).toBe(true);
    // Up the flight itself is a straight walk on the stairs layer.
    expect(nav.lineWalkable(P(0.88, 0, 1.4), P(0.88, 2.7, -1.35))).toBe(true);
  });

  it("sweeps every building-to-terrain link with the controller capsule clear of walls and frames", () => {
    const buildings = [
      { id: "house", prefab: "house_two_story", position: [-15, 0, -15], yaw: 0 },
      { id: "container", prefab: "container_open_blue", position: [15, 0, -15], yaw: 0.3 },
      { id: "radar", prefab: "radar_station", position: [-15, 0, 15], yaw: -0.7 },
      { id: "ruin", prefab: "house_small_ruined", position: [15, 0, 15], yaw: 0.4 },
      { id: "booth", prefab: "guard_booth", position: [0, 0, 0], yaw: 1.2 },
    ] as const;
    const world = buildNavGrid(testWorld({ height: () => -0.1, buildings }));
    expect(auditBuildingLinks(world)).toEqual([]);
    const q = createNavQuery(world);
    const o = P(0, 0, 0);
    const outside = q.nearest(P(0, -0.1, -25), 1, o);
    for (const b of buildings) {
      const inside = q.nearest(P(b.position[0], 0.15, b.position[2]), 2, o);
      expect(q.reachable(outside, inside), b.id).toBe(true);
    }
    // The old probe stepped over the container's 5 cm skin: its links now all leave through the open end (local +Z).
    const d = world;
    const c = d.placements.find((p) => p.id === "container")!;
    for (let i = 0; i < d.arrays.linkFrom.length; i++) {
      const from = d.arrays.linkFrom[i]!;
      if (from < d.terrainNodes || d.spanPlacement[from - d.terrainNodes] !== d.placements.indexOf(c)) continue;
      const to = d.arrays.linkTo[i]!;
      const dx = d.nodeX(to) - c.x;
      const dz = d.nodeZ(to) - c.z;
      expect(dx * c.sin + dz * c.cos).toBeGreaterThan(3);
    }
  });

  it("flags crouch passages and routes around them when crouching is not allowed", () => {
    const ruin = buildNavGrid(testWorld({ height: () => -0.1, buildings: [{ id: "r", prefab: "house_small_ruined", position: [0, 0, 0], yaw: 0.4 }] }));
    const q = createNavQuery(ruin);
    const o = P(0, 0, 0);
    // Crouch passage center (prefab-local 0.385, 0, 1.8), rotated by yaw 0.4.
    const s = Math.sin(0.4);
    const c = Math.cos(0.4);
    const local = (lx: number, lz: number) => P(lx * c + lz * s, 0, -lx * s + lz * c);
    const beam = q.nearest(local(0.385, 1.8), 0.5, o);
    expect(beam).toBeGreaterThanOrEqual(0);
    expect(q.flagsAt(beam) & NavFlag.crouchOnly).toBe(NavFlag.crouchOnly);
    const living = local(-2.5, 2.4);
    const bedroom = local(2.5, 1.5);
    const crouched = solve(q, living, bedroom, { allowCrouchOnly: true });
    expect(crouched.status).toBe("found");
    expect(pathFlags(crouched.path) & NavFlag.crouchOnly).toBe(NavFlag.crouchOnly);
    const standing = solve(q, living, bedroom, { allowCrouchOnly: false });
    if (standing.status === "found") {
      expect(pathFlags(standing.path) & NavFlag.crouchOnly).toBe(0);
      expect(standing.path.length).toBeGreaterThan(crouched.path.length);
    } else {
      expect(standing.status).toBe("unreachable");
    }
  });

  it("reaches the watchtower platform through three flights", () => {
    const tower = buildNavGrid(testWorld({ height: () => -0.1, buildings: [{ id: "t", prefab: "watchtower", position: [0, 0, 0], yaw: 0 }] }));
    const q = createNavQuery(tower);
    const { status, path } = solve(q, P(-10, -0.1, -10), P(0, 9, -1.5));
    expect(status).toBe("found");
    expect(maxY(path)).toBeCloseTo(9, 3);
    expect(pathFlags(path) & NavFlag.stairs).toBe(NavFlag.stairs);
  });

  it("drops spans covered by a stacked placement", () => {
    const stack = buildNavGrid(
      testWorld({
        height: () => -0.05,
        buildings: [
          { id: "a", prefab: "container_closed", position: [0, 0, 0], yaw: 0 },
          { id: "b", prefab: "container_closed", position: [0, 0, 0], yaw: 0, stackOn: "a" },
        ],
      }),
    );
    const q = createNavQuery(stack);
    const o = P(0, 0, 0);
    q.nearest(P(0, 2.6, 0), 1, o);
    expect(o.y).not.toBeCloseTo(2.59, 1);
    expect(q.nearest(P(0, 5.2, 0), 0.5, o)).toBeGreaterThanOrEqual(0);
    expect(o.y).toBeCloseTo(5.18, 2);
  });
});

describe("nav query: search", () => {
  // Scattered walls and trees on a 60 × 60 m square (seeded positions, no RNG at runtime).
  const props = Array.from({ length: 60 }, (_, i) => {
    const a = (i * 2654435761) >>> 0;
    return { prop: i % 3 === 0 ? "wall_concrete" : "tree_broadleaf_b", x: ((a % 5000) / 5000) * 52 - 26, z: (((a >>> 13) % 5000) / 5000) * 52 - 26, yaw: (i * 0.7) % Math.PI };
  });
  const world = testWorld({ props, height: (x, z) => Math.sin(x * 0.1) * 1.5 + Math.cos(z * 0.13) });
  const grid = buildNavGrid(world);

  it("A* matches Dijkstra's cost on a small grid", () => {
    const astar = new GridNavQuery(grid);
    const dijkstra = new GridNavQuery(grid);
    dijkstra.heuristicWeight = 0;
    const pairs = [
      [P(-25, 0, -25), P(25, 0, 25)],
      [P(-20, 0, 18), P(22, 0, -19)],
      [P(0, 0, -27), P(3, 0, 27)],
      [P(-27, 0, 3), P(27, 0, -5)],
    ] as const;
    for (const [a, b] of pairs) {
      const ra = solve(astar, a, b);
      const rd = solve(dijkstra, a, b);
      expect(ra.status).toBe(rd.status);
      if (ra.status !== "found") continue;
      expect(Math.abs(astar.lastCost - dijkstra.lastCost) / dijkstra.lastCost).toBeLessThan(0.002);
      expect(astar.expansions).toBeLessThan(dijkstra.expansions);
    }
  });

  it("time-sliced search returns the same path as a one-shot search", () => {
    const a = solve(createNavQuery(grid), P(-25, 0, -25), P(25, 0, 25), null, 1e9);
    const b = solve(createNavQuery(grid), P(-25, 0, -25), P(25, 0, 25), null, 7);
    expect(b.status).toBe("found");
    expect(b.path.count).toBe(a.path.count);
    expect(Array.from(b.path.points.subarray(0, b.path.count * 3))).toEqual(Array.from(a.path.points.subarray(0, a.path.count * 3)));
  });

  it("smoothed paths stay on walkable lines", () => {
    const nav = createNavQuery(grid);
    const { status, path } = solve(nav, P(-25, 0, -25), P(25, 0, 25));
    expect(status).toBe("found");
    for (let i = 1; i < path.count; i++) {
      const a = P(path.points[(i - 1) * 3]!, path.points[(i - 1) * 3 + 1]!, path.points[(i - 1) * 3 + 2]!);
      const b = P(path.points[i * 3]!, path.points[i * 3 + 1]!, path.points[i * 3 + 2]!);
      expect(nav.lineWalkable(a, b), `segment ${i}`).toBe(true);
    }
  });

  it("applies avoid circles, zone penalties and handle lifecycle", () => {
    const nav = createNavQuery(grid);
    const plain = solve(nav, P(-25, 0, 0), P(25, 0, 0));
    const avoid = solve(nav, P(-25, 0, 0), P(25, 0, 0), { avoid: [{ x: 0, z: 0, radius: 10, cost: 20 }] });
    expect(avoid.status).toBe("found");
    let minR = Infinity;
    for (let i = 0; i < avoid.path.count; i++) minR = Math.min(minR, Math.hypot(avoid.path.points[i * 3]!, avoid.path.points[i * 3 + 2]!));
    expect(minR).toBeGreaterThan(5);
    expect(avoid.path.length).toBeGreaterThan(plain.path.length);
    expect(solve(nav, P(-25, 0, 0), P(25, 0, 0), { maxLength: 10 }).status).toBe("unreachable");
    nav.releasePath(plain.handle);
    expect(nav.readPath(plain.handle, emptyPath())).toBe("released");
    expect(nav.readPath(-1, emptyPath())).toBe("unreachable");
    // Many requests at once all resolve.
    const handles = Array.from({ length: 20 }, (_, i) => nav.requestPath(P(-20 + i, 0, -20), P(20, 0, 20 - i), null));
    while (nav.update(1500) > 0);
    for (const h of handles) expect(["found", "partial"]).toContain(nav.readPath(h, emptyPath()));
  });

  it("samples ring points deterministically inside the ring and on the same component", () => {
    const nav = createNavQuery(grid);
    const a = new Float32Array(36);
    const b = new Float32Array(36);
    const center = P(0, 0, 0);
    const n = nav.sampleRing(center, 4, 8, 1234, a, 12);
    expect(n).toBeGreaterThan(6);
    expect(nav.sampleRing(center, 4, 8, 1234, b, 12)).toBe(n);
    expect(Array.from(b)).toEqual(Array.from(a));
    const o = P(0, 0, 0);
    const c = nav.nearest(center, 3, o);
    for (let i = 0; i < n; i++) {
      const r = Math.hypot(a[i * 3]!, a[i * 3 + 2]!);
      expect(r).toBeGreaterThan(3.2);
      expect(r).toBeLessThan(8.8);
      expect(nav.reachable(c, nav.nearest(P(a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!), 0.1, o))).toBe(true);
    }
  });

  it("refines far goals through the coarse corridor beyond one search window", () => {
    // 200 × 200 m with a long wall line at z = 0 open only near x = +90.
    const wall = Array.from({ length: 45 }, (_, i) => ({ prop: "wall_concrete", x: -98 + i * 4, z: 0 }));
    const far = buildNavGrid(testWorld({ half: 100, props: wall }));
    const nav = createNavQuery(far);
    const { status, path } = solve(nav, P(-90, 0, -60), P(-90, 0, 60), null, 1500);
    expect(status).toBe("found");
    let maxX = -Infinity;
    for (let i = 0; i < path.count; i++) maxX = Math.max(maxX, path.points[i * 3]!);
    expect(maxX).toBeGreaterThan(80);
    expect(path.length).toBeGreaterThan(300);
  });
});

describe("nav grid: determinism and serialization", () => {
  it("builds the same checksum twice and round-trips through bytes", () => {
    const world = () => testWorld({ height: (x, z) => Math.sin(x * 0.2) + z * 0.05, buildings: [{ id: "b", prefab: "barn", position: [5, 2, 0], yaw: 0.3 }], props: [{ prop: "tree_fir_a", x: -10, z: 4 }] });
    const a = buildNavGrid(world());
    const b = buildNavGrid(world());
    expect(b.info.checksum).toBe(a.info.checksum);
    const restored = deserializeNavGrid(serializeNavGrid(a));
    expect(restored).toBeInstanceOf(NavGridData);
    expect(restored.info).toEqual(a.info);
    const pa = solve(createNavQuery(a), P(-20, 0, -20), P(5, 5, 6));
    const pb = solve(createNavQuery(restored), P(-20, 0, -20), P(5, 5, 6));
    expect(pb.status).toBe(pa.status);
    expect(Array.from(pb.path.points.subarray(0, pb.path.count * 3))).toEqual(Array.from(pa.path.points.subarray(0, pa.path.count * 3)));
  });

  it("keeps the nav sources pure and engine-independent (same rules as terrain/determinism.test.ts)", () => {
    const files = Object.keys(sources).filter((file) => !file.endsWith(".test.ts"));
    expect(files).toContain("./navQuery.ts");
    const banned = [/Math\.random/, /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b/, /\*\*/, /from\s+["']@babylonjs/, /from\s+["']node:/];
    for (const file of files) {
      const code = sources[file]!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const pattern of banned) expect(code, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  });
});
