import { resolveBuilding, type LayoutBuilding, type ResolvedBuilding } from "../../map/layout/buildings";
import type { MapLayout, PropInstanceSet } from "../../map/layout/mapLayout";
import { SurfacePaint } from "../../map/terrain/flatten";
import { Heightfield } from "../../map/terrain/heightfield";
import { TERRAIN_V1 } from "../../map/terrain/presets";
import { Terrain } from "../../map/terrain/terrain";
import type { MapData, TerrainSpec } from "../../map/types";
import type { NavBuildInput, NavPath } from "../types";

// Small synthetic worlds for nav unit tests (not exported from the barrel).

export interface TestProp {
  readonly prop: string;
  readonly x: number;
  readonly z: number;
  readonly yaw?: number;
  readonly scale?: number;
}

export interface TestWorldOptions {
  /** Playable half extent, m (grid is 2 × half / 0.5 cells per side). */
  readonly half?: number;
  readonly height?: (x: number, z: number) => number;
  readonly buildings?: readonly LayoutBuilding[];
  readonly props?: readonly TestProp[];
}

export function testWorld(options: TestWorldOptions = {}): NavBuildInput {
  const half = options.half ?? 30;
  const size = 2 * half + 8;
  const spec: TerrainSpec = { ...TERRAIN_V1, size, resolution: size + 1, playableHalfExtent: half };
  const field = new Heightfield(size, size + 1);
  const height = options.height ?? (() => 0);
  for (let iz = 0; iz <= size; iz++) {
    for (let ix = 0; ix <= size; ix++) field.heights[iz * (size + 1) + ix] = height(field.worldX(ix), field.worldZ(iz));
  }
  const terrain = new Terrain(spec, field, new SurfacePaint(size + 1));
  const resolved = new Map<string, ResolvedBuilding>();
  const buildings = (options.buildings ?? []).map((b) => {
    const r = resolveBuilding(b, terrain, resolved);
    resolved.set(r.id, r);
    return r;
  });
  const byProp = new Map<string, number[]>();
  for (const p of options.props ?? []) {
    let list = byProp.get(p.prop);
    if (!list) byProp.set(p.prop, (list = []));
    list.push(p.x, terrain.sampleHeight(p.x, p.z), p.z, p.yaw ?? 0, p.scale ?? 1, 0, 0);
  }
  const props: PropInstanceSet[] = [...byProp.keys()].sort().map((prop) => ({ prop, data: new Float32Array(byProp.get(prop)!) }));
  const layout: MapLayout = { buildings, props, ruleCounts: {}, checksum: "test" };
  const map: MapData = {
    id: "nav-test",
    name: "nav test",
    terrain: spec,
    flatten: [],
    bounds: { outOfBoundsGraceSeconds: 10, killY: -40, landingAltitude: 100 },
    pois: [],
    buildings: [],
    props: [],
    scatters: [],
    spawns: [],
  };
  return { map, terrain, layout };
}

export function emptyPath(capacity = 256): NavPath {
  return { points: new Float32Array(capacity * 3), flags: new Uint8Array(capacity), count: 0, length: 0 };
}
