import { hash32 } from "@twobullets/shared/equipment/math";
import { NavFlag, type NavGrid, type NavPath, type NavQuery, type PathOptions, type PathStatus } from "@twobullets/shared/bots/types";
import type { Terrain } from "@twobullets/shared/map/terrain/terrain";
import type { Vec3 } from "@twobullets/shared/movement/types";

// Straight-line NavQuery over the terrain for headless match tests until the real grid nav (shared/bots/nav) is wired:
// every playable point is walkable, paths are the direct segment at terrain height.

const GRID: NavGrid = {
  info: { version: 0, cellSize: 0.5, buildingCellSize: 0.25, coarseCellSize: 4, originX: -500, originZ: -500, width: 2000, depth: 2000, terrainNodes: 4_000_000, buildingNodes: 0, components: 1, byteLength: 0, checksum: "straight" },
};

export class StraightNav implements NavQuery {
  readonly grid = GRID;
  private readonly terrain: Terrain;
  private readonly requests: { fx: number; fz: number; tx: number; tz: number; status: PathStatus }[] = [];

  constructor(terrain: Terrain) {
    this.terrain = terrain;
  }

  nearest(p: Vec3, _maxDistance: number, out: { x: number; y: number; z: number }): number {
    out.x = p.x;
    out.z = p.z;
    out.y = this.terrain.sampleHeight(p.x, p.z);
    return this.terrain.isPlayable(p.x, p.z) ? 0 : -1;
  }

  flagsAt(): number {
    return NavFlag.walkable;
  }

  reachable(): boolean {
    return true;
  }

  lineWalkable(from: Vec3, to: Vec3): boolean {
    return this.terrain.isPlayable(from.x, from.z) && this.terrain.isPlayable(to.x, to.z);
  }

  requestPath(from: Vec3, to: Vec3, _options: PathOptions | null): number {
    this.requests.push({ fx: from.x, fz: from.z, tx: to.x, tz: to.z, status: "found" });
    return this.requests.length - 1;
  }

  readPath(handle: number, out: NavPath): PathStatus {
    const r = this.requests[handle];
    if (!r) return "released";
    if (r.status !== "found") return r.status;
    const pts = out.points as Float32Array;
    pts[0] = r.fx;
    pts[1] = this.terrain.sampleHeight(r.fx, r.fz);
    pts[2] = r.fz;
    pts[3] = r.tx;
    pts[4] = this.terrain.sampleHeight(r.tx, r.tz);
    pts[5] = r.tz;
    out.flags[0] = NavFlag.walkable;
    out.flags[1] = NavFlag.walkable;
    out.count = 2;
    out.length = Math.sqrt((r.tx - r.fx) ** 2 + (r.tz - r.fz) ** 2);
    return "found";
  }

  releasePath(handle: number): void {
    const r = this.requests[handle];
    if (r) r.status = "released";
  }

  update(): number {
    return 0;
  }

  sampleRing(center: Vec3, minRadius: number, maxRadius: number, seed: number, out: Float32Array, max: number): number {
    let n = 0;
    for (let i = 0; i < max * 4 && n < max; i++) {
      const h = hash32(seed, i);
      const angle = ((h & 0xffff) / 0x10000) * Math.PI * 2;
      const r = minRadius + ((h >>> 16) / 0x10000) * (maxRadius - minRadius);
      const x = center.x + Math.sin(angle) * r;
      const z = center.z + Math.cos(angle) * r;
      if (!this.terrain.isPlayable(x, z)) continue;
      out[n * 3] = x;
      out[n * 3 + 1] = this.terrain.sampleHeight(x, z);
      out[n * 3 + 2] = z;
      n++;
    }
    return n;
  }
}
