import { TERRAIN_SURFACES, type FlattenRegion, type TerrainSurface } from "../types";
import type { Heightfield } from "./heightfield";
import { segmentDistanceSq, sinCos, smoothstep } from "./math";

/**
 * Surface paint from flatten regions: 4 channels per sample (TERRAIN_SURFACES order), 0..255, composited "over" in
 * region order so later regions win. The channels of a sample never sum above 255.
 */
export class SurfacePaint {
  readonly resolution: number;
  readonly channels: Uint8Array;
  constructor(resolution: number, channels?: Uint8Array) {
    const count = resolution * resolution * 4;
    if (channels && channels.length !== count) throw new Error(`SurfacePaint expects ${count} bytes, got ${channels.length}`);
    this.resolution = resolution;
    this.channels = channels ?? new Uint8Array(count);
  }

  /** Composites `weight` (0..1) of `surface` over sample i. */
  paint(i: number, surface: number, weight: number): void {
    const c = this.channels;
    const base = i * 4;
    const keep = 1 - weight;
    for (let k = 0; k < 4; k++) {
      const painted = k === surface ? weight * 255 : 0;
      c[base + k] = Math.round(c[base + k]! * keep + painted);
    }
  }
}

/** Polylines are resampled at this step before heights are resolved, m. */
const ROAD_SAMPLE_STEP = 4;

/**
 * Flattens terrain under each region in order: circles and rects for POI pads, polylines for roads. Heights blend
 * from the target inside the shape to natural ground over `falloff` with a smoothstep. Optional paint is recorded in
 * `paint` for the surface mask. Mutates `field.heights`.
 */
export function flattenHeightfield(field: Heightfield, regions: readonly FlattenRegion[], paint?: SurfacePaint): void {
  for (const region of regions) {
    if (region.falloff < 0) throw new Error("flatten falloff must be ≥ 0");
    if (region.shape === "polyline") flattenPolyline(field, region, paint);
    else flattenArea(field, region, paint);
  }
}

type AreaRegion = Extract<FlattenRegion, { shape: "circle" | "rect" }>;
type PolylineRegion = Extract<FlattenRegion, { shape: "polyline" }>;

interface Blend {
  readonly mode: "set" | "cut" | "fill";
  readonly falloff: number;
  readonly surface: number;
  readonly surfaceFalloff: number;
}

function blendOf(region: FlattenRegion): Blend {
  return {
    mode: region.mode ?? "set",
    falloff: region.falloff,
    surface: region.surface ? surfaceIndex(region.surface) : -1,
    surfaceFalloff: region.surfaceFalloff ?? Math.min(region.falloff, 1.5),
  };
}

export function surfaceIndex(surface: TerrainSurface): number {
  return TERRAIN_SURFACES.indexOf(surface);
}

/** Applies one sample: `outside` is the distance outside the shape (0 inside). */
function applySample(field: Heightfield, i: number, outside: number, target: number, blend: Blend, paint: SurfacePaint | undefined): void {
  const w = blend.falloff > 0 ? 1 - smoothstep(0, blend.falloff, outside) : outside > 0 ? 0 : 1;
  if (w > 0) {
    const h = field.heights[i]!;
    if (blend.mode === "set" || (blend.mode === "cut" && target < h) || (blend.mode === "fill" && target > h)) {
      field.heights[i] = h + (target - h) * w;
    }
  }
  if (paint && blend.surface >= 0) {
    const ws = blend.surfaceFalloff > 0 ? 1 - smoothstep(0, blend.surfaceFalloff, outside) : outside > 0 ? 0 : 1;
    if (ws > 0) paint.paint(i, blend.surface, ws);
  }
}

function flattenArea(field: Heightfield, region: AreaRegion, paint: SurfacePaint | undefined): void {
  const [cx, cz] = region.center;
  let outside: (x: number, z: number) => number;
  let extent: number;
  if (region.shape === "circle") {
    outside = (x, z) => {
      const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz)) - region.radius;
      return d > 0 ? d : 0;
    };
    extent = region.radius;
  } else {
    const [hx, hz] = region.halfExtents;
    const { sin, cos } = sinCos(region.yaw ?? 0);
    outside = (x, z) => {
      const dx = x - cx;
      const dz = z - cz;
      const ox = Math.abs(dx * cos - dz * sin) - hx;
      const oz = Math.abs(dx * sin + dz * cos) - hz;
      const px = ox > 0 ? ox : 0;
      const pz = oz > 0 ? oz : 0;
      return Math.sqrt(px * px + pz * pz);
    };
    extent = Math.sqrt(hx * hx + hz * hz);
  }

  const reach = extent + Math.max(region.falloff, region.surfaceFalloff ?? 0, 1.5);
  const [ix0, iz0, ix1, iz1] = indexBounds(field, cx - reach, cz - reach, cx + reach, cz + reach);
  const target = resolveAreaHeight(field, region, outside, ix0, iz0, ix1, iz1) + (region.heightOffset ?? 0);
  const blend = blendOf(region);
  const n = field.resolution;
  for (let iz = iz0; iz <= iz1; iz++) {
    const z = field.worldZ(iz);
    for (let ix = ix0; ix <= ix1; ix++) applySample(field, iz * n + ix, outside(field.worldX(ix), z), target, blend, paint);
  }
}

function resolveAreaHeight(field: Heightfield, region: AreaRegion, outside: (x: number, z: number) => number, ix0: number, iz0: number, ix1: number, iz1: number): number {
  if (region.height !== "auto") return region.height;
  let sum = 0;
  let count = 0;
  for (let iz = iz0; iz <= iz1; iz++) {
    const z = field.worldZ(iz);
    for (let ix = ix0; ix <= ix1; ix++) {
      if (outside(field.worldX(ix), z) > 0) continue;
      sum += field.heights[iz * field.resolution + ix]!;
      count++;
    }
  }
  return count > 0 ? sum / count : field.sampleHeight(region.center[0], region.center[1]);
}

interface PathPoint {
  readonly x: number;
  readonly z: number;
  y: number;
  readonly pinned: boolean;
}

/**
 * Roads: the path is resampled every few meters. Unpinned heights come from the terrain and are smoothed along the
 * path, so the road rides the hills at a gentler grade; points given as [x, z, y] pin the height.
 */
function flattenPolyline(field: Heightfield, region: PolylineRegion, paint: SurfacePaint | undefined): void {
  const path = resolvePath(field, region);
  const half = region.width / 2;
  const reach = half + Math.max(region.falloff, region.surfaceFalloff ?? 0, 1.5);
  const n = field.resolution;

  // Nearest-segment distance and target per sample, over the region's bounding box.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of path) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  const [bx0, bz0, bx1, bz1] = indexBounds(field, minX - reach, minZ - reach, maxX + reach, maxZ + reach);
  if (bx0 > bx1 || bz0 > bz1) return;
  const width = bx1 - bx0 + 1;
  const count = width * (bz1 - bz0 + 1);
  const bestDistSq = new Float64Array(count).fill(Infinity);
  const bestTarget = new Float64Array(count);
  const along = { t: 0 };

  for (let s = 0; s + 1 < path.length; s++) {
    const a = path[s]!;
    const b = path[s + 1]!;
    const [ix0, iz0, ix1, iz1] = indexBounds(field, Math.min(a.x, b.x) - reach, Math.min(a.z, b.z) - reach, Math.max(a.x, b.x) + reach, Math.max(a.z, b.z) + reach);
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = field.worldZ(iz);
      for (let ix = ix0; ix <= ix1; ix++) {
        const d = segmentDistanceSq(field.worldX(ix), z, a.x, a.z, b.x, b.z, along);
        const k = (iz - bz0) * width + (ix - bx0);
        if (d < bestDistSq[k]!) {
          bestDistSq[k] = d;
          bestTarget[k] = a.y + (b.y - a.y) * along.t;
        }
      }
    }
  }

  const blend = blendOf(region);
  const offset = region.heightOffset ?? 0;
  const reachSq = reach * reach;
  for (let iz = bz0; iz <= bz1; iz++) {
    for (let ix = bx0; ix <= bx1; ix++) {
      const k = (iz - bz0) * width + (ix - bx0);
      const dSq = bestDistSq[k]!;
      if (dSq > reachSq) continue;
      const d = Math.sqrt(dSq) - half;
      applySample(field, iz * n + ix, d > 0 ? d : 0, bestTarget[k]! + offset, blend, paint);
    }
  }
}

function resolvePath(field: Heightfield, region: PolylineRegion): PathPoint[] {
  const points = region.points;
  const constant = region.height === "auto" ? null : region.height;
  const linear = region.profile === "linear";
  // Original points: y from the data, the region's constant height, or the terrain under the point.
  const anchors = points.map((p) => ({ x: p[0], z: p[1], y: p[2] ?? constant ?? field.sampleHeight(p[0], p[1]), pinned: p[2] !== undefined || constant !== null || linear }));

  const out: PathPoint[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    out.push(a);
    const b = anchors[i + 1];
    if (!b) break;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const steps = Math.floor(Math.sqrt(dx * dx + dz * dz) / ROAD_SAMPLE_STEP);
    const interpolate = linear || (a.pinned && b.pinned);
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      out.push(interpolate ? { x, z, y: a.y + (b.y - a.y) * t, pinned: true } : { x, z, y: field.sampleHeight(x, z), pinned: false });
    }
  }

  // Smooth unpinned heights along the path: 12 passes of a 1-2-1 kernel at a 4 m step is roughly a 40 m window.
  for (let pass = 0; pass < 12; pass++) {
    let previous = out[0]?.y ?? 0;
    for (let i = 1; i + 1 < out.length; i++) {
      const current = out[i]!;
      const smoothed = previous * 0.25 + current.y * 0.5 + out[i + 1]!.y * 0.25;
      previous = current.y;
      if (!current.pinned) current.y = smoothed;
    }
  }
  return out;
}

/** Inclusive sample index bounds of a world rectangle, clamped to the grid. */
function indexBounds(field: Heightfield, x0: number, z0: number, x1: number, z1: number): [number, number, number, number] {
  const n = field.resolution;
  const toIndex = (v: number, min: number) => (v - min) / field.spacing;
  // Only the inner side is clamped, so a rectangle entirely off the grid yields start > end (an empty loop).
  return [
    Math.max(0, Math.ceil(toIndex(x0, field.minX))),
    Math.max(0, Math.ceil(toIndex(z0, field.minZ))),
    Math.min(n - 1, Math.floor(toIndex(x1, field.minX))),
    Math.min(n - 1, Math.floor(toIndex(z1, field.minZ))),
  ];
}
