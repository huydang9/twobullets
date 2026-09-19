import { buildNavGrid } from "@twobullets/shared/bots/nav/buildNavGrid";
import { createNavQuery } from "@twobullets/shared/bots/nav/navQuery";
import { buildDestructibleWalls, WallKind, type DestructibleWalls } from "@twobullets/shared/equipment/destructible";
import { spawnThrowable } from "@twobullets/shared/equipment/throwables";
import { buildMapLayout, type MapLayout } from "@twobullets/shared/map/layout/mapLayout";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { MAZE_BR } from "@twobullets/shared/map/mazeBr";
import { buildTerrain, type Terrain } from "@twobullets/shared/map/terrain/terrain";
import type { MapData } from "@twobullets/shared/map/types";
import { planTeamSpawns } from "@twobullets/shared/match/spawns";
import { zoneCenterBiasForPois, zoneSpecForHalfExtent } from "@twobullets/shared/match/zone";
import { createMapSimWorld, type HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { MatchLevel } from "../src/level/serverLevel";
import { wallsCrossedBy } from "../src/match/ServerWalls";
import { createHarness, type Harness } from "./harness";

// Server-authoritative destructible walls (protocol v10) end to end: a frag in a match on the maze takes a mirror pane
// out, the server's own world loses its collider, and every connected client — including one that joins afterwards —
// ends up holding exactly the same walls, through the same `WallMirror` the browser runs.

let havok: HavokModule;
let maze: { terrain: Terrain; layout: MapLayout };

beforeAll(async () => {
  havok = await loadHavok();
  const terrain = buildTerrain(MAZE_BR.terrain, MAZE_BR.flatten);
  maze = { terrain, layout: buildMapLayout(MAZE_BR, terrain) };
}, 120_000);

/**
 * A match level on any `MapData`, built analytically (no terrain bake, no map registry): this exercises `ServerMatch`
 * against the real map collision and layout without depending on which maps happen to be registered.
 */
function mapLevel(map: MapData, built: { terrain: Terrain; layout: MapLayout }): MatchLevel {
  const { terrain, layout } = built;
  return {
    mapId: map.id,
    name: map.name,
    killY: map.bounds.killY,
    zone: zoneSpecForHalfExtent(map.terrain.playableHalfExtent, undefined, { centerBias: zoneCenterBiasForPois(map.pois) }),
    heightAt: (x, z) => terrain.sampleHeight(x, z),
    isValidZoneCenter: null,
    planTeamSpawns: (seed, teamCount, teamSize) => planTeamSpawns(seed, teamCount, teamSize, map.pois, map.spawns, (x, z) => terrain.sampleHeight(x, z)),
    createWorld: (h: HavokModule) => Promise.resolve(createMapSimWorld(h, { terrain, layout })),
    loadMs: 0,
    source: "generated",
    // A grid of this match's own, never a shared one: `ServerWalls` patches what it is given.
    createNav: () => ({ nav: createNavQuery(buildNavGrid({ map, terrain, layout })), buildMs: 0, kind: "grid" }),
  };
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

async function mazeMatch(clients = 2): Promise<Harness> {
  const h = await createHarness(havok, { level: mapLevel(MAZE_BR, maze), maxPlayers: 10, teamMode: "duo" });
  harness = h;
  await h.match.ready;
  for (let i = 0; i < clients; i++) {
    const client = h.connect({ team: i, seed: 90 + i });
    client.mirrorWalls(maze.layout);
    client.script = (_tick, e) => {
      e.forward = 0;
      e.right = 0;
      e.buttons = 0;
    };
  }
  h.run(400);
  return h;
}

/** The first standing pane, and a point a frag can go off at to take it. */
function firstPane(walls: DestructibleWalls): number {
  for (let i = 0; i < walls.count; i++) if (walls.kind[i] === WallKind.pane && walls.destroyed[i] !== 1) return i;
  throw new Error("the maze has no mirror panes");
}

/** Drops a live frag at `index`'s pane and runs the match until it has gone off and everything has been streamed. */
function fragAt(h: Harness, index: number, ms = 600): void {
  const walls = h.match.walls!.walls;
  spawnThrowable(h.match.throwables!.world.throwables, {
    id: 4242,
    owner: 0,
    kind: "frag",
    position: { x: walls.x[index]!, y: walls.y[index]! + 1, z: walls.z[index]! },
    velocity: { x: 0, y: 0, z: 0 },
    fuse: 0.1,
  });
  h.run(ms);
}

function destroyedOf(walls: DestructibleWalls): number[] {
  const out: number[] = [];
  for (let i = 0; i < walls.count; i++) if (walls.destroyed[i] === 1) out.push(i);
  return out;
}

describe("networked destructible walls", () => {
  it("the maze gets a wall registry", async () => {
    const h = await mazeMatch(1);
    expect(h.match.walls).not.toBeNull();
    expect(h.match.walls!.walls.count).toBeGreaterThan(0);
  }, 120_000);

  it("the arena has no layout, so no registry at all", async () => {
    const h = await createHarness(havok, {});
    harness = h;
    await h.match.ready;
    expect(h.match.walls).toBeNull();
  }, 60_000);

  it("Map v1 has a layout but nothing destructible, so the system stays off", async () => {
    const terrain = buildTerrain(MAP_V1.terrain, MAP_V1.flatten);
    const h = await createHarness(havok, { level: mapLevel(MAP_V1, { terrain, layout: buildMapLayout(MAP_V1, terrain) }) });
    harness = h;
    await h.match.ready;
    expect(h.match.walls).toBeNull();
  }, 120_000);

  it("one client's frag destroys a pane and every client ends up with the same walls", async () => {
    const h = await mazeMatch(2);
    const server = h.match.walls!.walls;
    const index = firstPane(server);
    expect(h.clients.every((c) => destroyedOf(c.walls!.walls).length === 0)).toBe(true);

    fragAt(h, index);

    const gone = destroyedOf(server);
    expect(gone).toContain(index);
    for (const client of h.clients) {
      expect(client.wallMalformed).toBe(0);
      expect(destroyedOf(client.walls!.walls)).toEqual(gone);
    }
    // The server's own world lost the collider, which is what opens the corridor for movement and bullets.
    expect(h.match.walls!.stats.collidersRemoved).toBe(gone.length);
  }, 120_000);

  it("a client that joins afterwards is sent the state, not the history", async () => {
    const h = await mazeMatch(1);
    const server = h.match.walls!.walls;
    fragAt(h, firstPane(server));
    const gone = destroyedOf(server);
    expect(gone.length).toBeGreaterThan(0);

    const late = h.connect({ team: 3, seed: 7 });
    late.mirrorWalls(maze.layout);
    late.script = (_tick, e) => {
      e.forward = 0;
      e.right = 0;
      e.buttons = 0;
    };
    h.run(400);

    expect(late.wallMalformed).toBe(0);
    expect(destroyedOf(late.walls!.walls)).toEqual(gone);
    // It never saw the change log; the state alone rebuilt it.
    expect(late.walls!.stats.clears).toBe(1);
  }, 120_000);

  it("a round through a mirror holes it for everybody, and only the transition travels", async () => {
    const h = await mazeMatch(2);
    const walls = h.match.walls!.walls;
    const index = firstPane(walls);
    // Straight through the pane's middle, across it.
    const nx = Math.sin(walls.yaw[index]!);
    const nz = Math.cos(walls.yaw[index]!);
    const y = walls.y[index]! + walls.height[index]! / 2;
    const from = { x: walls.x[index]! - nx * 2, y, z: walls.z[index]! - nz * 2 };
    const to = { x: walls.x[index]! + nx * 2, y, z: walls.z[index]! + nz * 2 };

    // The real path: whatever `ServerProjectiles` was given for this match is what a bullet's segment goes through.
    const onSegment = h.match.combat!.projectiles.onSegment!;
    onSegment(0, "rifle", from, to, 1, true);
    h.run(200);

    expect(walls.holes[index]).toBe(1);
    for (const client of h.clients) expect(client.walls!.walls.holes[index]).toBe(1);

    // Two more rounds through the same pane: the server counts them, the wire stays quiet, and every client still
    // agrees on the one thing that matters — this pane is holed.
    const before = h.clients.map((c) => c.wallMessages);
    onSegment(0, "rifle", from, to, 1, true);
    onSegment(0, "rifle", from, to, 1, true);
    h.run(200);
    expect(walls.holes[index]).toBe(3);
    expect(h.clients.map((c) => c.wallMessages)).toEqual(before);
    for (const client of h.clients) expect(client.walls!.walls.holes[index]).toBe(1);
  }, 120_000);

  it("a smoke cloud closes a holed pane, and the clients watch it close", async () => {
    const h = await mazeMatch(2);
    const walls = h.match.walls!.walls;
    const index = firstPane(walls);
    const nx = Math.sin(walls.yaw[index]!);
    const nz = Math.cos(walls.yaw[index]!);
    const y = walls.y[index]! + walls.height[index]! / 2;
    h.match.combat!.projectiles.onSegment!(
      0,
      "rifle",
      { x: walls.x[index]! - nx * 2, y, z: walls.z[index]! - nz * 2 },
      { x: walls.x[index]! + nx * 2, y, z: walls.z[index]! + nz * 2 },
      1,
      true,
    );
    h.run(100);
    expect(h.clients.every((c) => c.walls!.walls.holes[index]! > 0)).toBe(true);

    spawnThrowable(h.match.throwables!.world.throwables, {
      id: 8484,
      owner: 0,
      kind: "smoke",
      position: { x: walls.x[index]!, y: walls.y[index]! + 1, z: walls.z[index]! },
      velocity: { x: 0, y: 0, z: 0 },
      fuse: 0.1,
    });
    // Enough for the cloud to build and sit on the pane for its five seconds.
    h.run(9000, 5);

    expect(walls.holes[index]).toBe(0);
    expect(walls.destroyed[index]).toBe(0);
    for (const client of h.clients) {
      expect(client.wallMalformed).toBe(0);
      expect(client.walls!.walls.holes[index]).toBe(0);
      expect(client.walls!.stats.repaired).toBe(1);
      // The glass grew back over the seconds rather than popping shut.
      expect(client.wallMessages).toBeGreaterThan(4);
    }
  }, 180_000);

  it("a molotov burns a hedge away for everybody", async () => {
    const h = await mazeMatch(2);
    const walls = h.match.walls!.walls;
    let hedge = -1;
    for (let i = 0; i < walls.count; i++) if (walls.kind[i] === WallKind.hedge) hedge = i;
    expect(hedge).toBeGreaterThanOrEqual(0);

    spawnThrowable(h.match.throwables!.world.throwables, {
      id: 9090,
      owner: 0,
      kind: "molotov",
      position: { x: walls.x[hedge]!, y: walls.y[hedge]! + 0.5, z: walls.z[hedge]! },
      velocity: { x: 0, y: 0, z: 0 },
      fuse: 0.1,
    });
    h.run(6000, 5);

    expect(walls.destroyed[hedge]).toBe(1);
    for (const client of h.clients) expect(client.walls!.walls.destroyed[hedge]).toBe(1);
    // A hedge never had a collider, so nothing was taken out of the world for it.
    expect(h.match.walls!.stats.collidersRemoved).toBe(0);
  }, 180_000);

  it("a bullet that stopped short of the glass never punches it", async () => {
    const h = await mazeMatch(1);
    const walls = h.match.walls!.walls;
    const index = firstPane(walls);
    const nx = Math.sin(walls.yaw[index]!);
    const nz = Math.cos(walls.yaw[index]!);
    const y = walls.y[index]! + walls.height[index]! / 2;
    const from = { x: walls.x[index]! - nx * 2, y, z: walls.z[index]! - nz * 2 };
    const to = { x: walls.x[index]! + nx * 2, y, z: walls.z[index]! + nz * 2 };
    // Hit something a quarter of the way along: the segment ends before the pane.
    h.match.combat!.projectiles.onSegment!(0, "rifle", from, to, 0.25, true);
    h.run(100);
    expect(walls.holes[index]).toBe(0);
  }, 120_000);
});

// The geometry behind the apertures: a mirror is shoot-through on the collider layer, so no world hit reports the
// crossing and the segment has to be tested against the pane's own box.
describe("wallsCrossedBy", () => {
  /** One 4 m mirror pane (box 4 × 2.6 × 0.3) standing at the origin, running along world X. */
  const panes = (yaw: number): DestructibleWalls =>
    buildDestructibleWalls({ props: [{ prop: "wall_mirror", data: new Float32Array([0, 0, 0, yaw, 1, 0, 0]) }] });

  it("finds the pane a round goes through", () => {
    const walls = panes(0);
    const out: number[] = [];
    expect(wallsCrossedBy(walls, 0, 1.3, -3, 0, 1.3, 3, out)).toBe(1);
    expect(out).toEqual([0]);
  });

  it("misses past the end, over the top, under the sill and short of the glass", () => {
    const walls = panes(0);
    const out: number[] = [];
    // 3 m along the wall: the pane is only 2 m either way.
    expect(wallsCrossedBy(walls, 3, 1.3, -3, 3, 1.3, 3, out)).toBe(0);
    // Above 2.6 m and below the base.
    expect(wallsCrossedBy(walls, 0, 3.2, -3, 0, 3.2, 3, out)).toBe(0);
    expect(wallsCrossedBy(walls, 0, -0.5, -3, 0, -0.5, 3, out)).toBe(0);
    // Stops 1 m short of the pane.
    expect(wallsCrossedBy(walls, 0, 1.3, -3, 0, 1.3, -1, out)).toBe(0);
    // Parallel to the pane and a metre off it.
    expect(wallsCrossedBy(walls, -3, 1.3, 1, 3, 1.3, 1, out)).toBe(0);
  });

  it("follows the pane's yaw", () => {
    const walls = panes(Math.PI / 2);
    const out: number[] = [];
    // Now the wall runs along Z, so a round crossing it travels along X.
    expect(wallsCrossedBy(walls, -3, 1.3, 0, 3, 1.3, 0, out)).toBe(1);
    // The same shot that crossed it at yaw 0 now runs a metre beside it and misses.
    expect(wallsCrossedBy(walls, 1, 1.3, -3, 1, 1.3, 3, out)).toBe(0);
  });

  it("never counts a pane that is already gone", () => {
    const walls = panes(0);
    walls.destroyed[0] = 1;
    const out: number[] = [];
    expect(wallsCrossedBy(walls, 0, 1.3, -3, 0, 1.3, 3, out)).toBe(0);
  });
});
