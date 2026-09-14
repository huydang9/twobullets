import type { Vec3Tuple } from "../../level/types";
import { PartBvh } from "./raycast";
import type { BoxPart, BuildingMaterialId, BuildingPrefab, FaceDir, WedgePart } from "./types";

/** Render-agnostic mesh buffers for one material slot of a prefab, in prefab-local space. */
export interface PrefabMeshGroup {
  readonly material: BuildingMaterialId;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Planar UVs in meters (same convention as buildLevel). */
  readonly uvs: Float32Array;
  /** Per vertex: [sky visibility 0..1 from the prefab's own geometry, height above the ground floor in m]. */
  readonly shade: Float32Array;
  readonly indices: Uint32Array;
}

export interface PrefabGeometry {
  readonly groups: readonly PrefabMeshGroup[];
  readonly triangles: number;
  readonly vertices: number;
}

export interface GeometryOptions {
  /** Faces are subdivided into cells no larger than this so per-vertex sky visibility has resolution, m. */
  readonly maxCell?: number;
  /** Hemisphere rays per vertex for the sky-visibility bake; 0 skips the bake (visibility = 1). */
  readonly aoRays?: number;
}

type V3 = readonly [number, number, number];

/** A face that lies in an axis-aligned plane: `axis` is the normal axis, the rect spans the other two axes (b < c). */
interface RectFace {
  readonly axis: 0 | 1 | 2;
  readonly sign: 1 | -1;
  readonly plane: number;
  readonly b: readonly [number, number];
  readonly c: readonly [number, number];
}

interface Polygon {
  readonly corners: readonly V3[];
  readonly normal: V3;
  readonly material: BuildingMaterialId;
}

const OTHER_AXES = [
  [1, 2],
  [0, 2],
  [0, 1],
] as const;
const DIR_OF: Record<string, FaceDir> = { "0,1": "+x", "0,-1": "-x", "1,1": "+y", "1,-1": "-y", "2,1": "+z", "2,-1": "-z" };
const PLANE_EPS = 1e-4;
/** Visibility rays start this far off the surface. */
const RAY_OFFSET = 0.01;
const RAY_LENGTH = 100;

/**
 * Builds merged per-material buffers for a prefab:
 *  - rectangular faces hidden behind a touching part (wall bottoms on slabs, wall ends in corners) are removed,
 *    and partly hidden faces keep only their visible cells;
 *  - faces are gridded to `maxCell` and each vertex gets a baked sky-visibility term so interiors can dim the IBL.
 * Deterministic and free of engine dependencies.
 */
export function buildPrefabGeometry(prefab: BuildingPrefab, options: GeometryOptions = {}): PrefabGeometry {
  const maxCell = options.maxCell ?? 1.5;
  const aoRays = options.aoRays ?? 24;
  const bvh = new PartBvh(prefab.parts);
  const covers = coverIndex(prefab);
  const writers = new Map<BuildingMaterialId, GroupWriter>();
  const writer = (material: BuildingMaterialId) => {
    let w = writers.get(material);
    if (!w) writers.set(material, (w = new GroupWriter(material)));
    return w;
  };

  for (const part of prefab.parts) {
    if (part.kind === "box") {
      for (const face of boxFaces(part)) {
        const material = part.faces?.[DIR_OF[`${face.axis},${face.sign}`]!] ?? part.material;
        emitRectFace(writer(material), face, covers, maxCell);
      }
    } else {
      const { rects, polygons } = wedgeFaces(part);
      for (const face of rects) emitRectFace(writer(part.material), face, covers, maxCell);
      for (const polygon of polygons) writer(polygon.material).polygon(polygon);
    }
  }

  const directions = hemisphere(aoRays);
  let triangles = 0;
  let vertices = 0;
  const groups = [...writers.values()]
    .filter((w) => w.indices.length > 0)
    .sort((a, b) => a.material.localeCompare(b.material))
    .map((w) => {
      triangles += w.indices.length / 3;
      vertices += w.positions.length / 3;
      return w.finish(bvh, directions);
    });
  return { groups, triangles, vertices };
}

function boxFaces(part: BoxPart): RectFace[] {
  const faces: RectFace[] = [];
  for (const axis of [0, 1, 2] as const) {
    const [bi, ci] = OTHER_AXES[axis];
    const b: [number, number] = [part.min[bi], part.max[bi]];
    const c: [number, number] = [part.min[ci], part.max[ci]];
    faces.push({ axis, sign: 1, plane: part.max[axis], b, c }, { axis, sign: -1, plane: part.min[axis], b, c });
  }
  return faces;
}

function wedgeFaces(part: WedgePart): { rects: RectFace[]; polygons: Polygon[] } {
  const [x0, y0, z0] = part.min;
  const [x1, y1, z1] = part.max;
  const alongZ = part.rises[1] === "z";
  const positive = part.rises[0] === "+";
  const rects: RectFace[] = [{ axis: 1, sign: -1, plane: y0, b: [x0, x1], c: [z0, z1] }];
  if (alongZ) rects.push({ axis: 2, sign: positive ? 1 : -1, plane: positive ? z1 : z0, b: [x0, x1], c: [y0, y1] });
  else rects.push({ axis: 0, sign: positive ? 1 : -1, plane: positive ? x1 : x0, b: [y0, y1], c: [z0, z1] });

  const slopeMaterial = part.slopeMaterial ?? part.material;
  let slope: V3[];
  let sides: V3[][];
  let sideAxis: 0 | 2;
  if (alongZ) {
    const low = positive ? z0 : z1;
    const high = positive ? z1 : z0;
    slope = [
      [x0, y0, low],
      [x1, y0, low],
      [x1, y1, high],
      [x0, y1, high],
    ];
    sides = [x0, x1].map((x) => [
      [x, y0, low],
      [x, y0, high],
      [x, y1, high],
    ]);
    sideAxis = 0;
  } else {
    const low = positive ? x0 : x1;
    const high = positive ? x1 : x0;
    slope = [
      [low, y0, z0],
      [low, y0, z1],
      [high, y1, z1],
      [high, y1, z0],
    ];
    sides = [z0, z1].map((z) => [
      [low, y0, z],
      [high, y0, z],
      [high, y1, z],
    ]);
    sideAxis = 2;
  }
  const rise = y1 - y0;
  const run = alongZ ? z1 - z0 : x1 - x0;
  const s = positive ? -1 : 1;
  const len = Math.hypot(rise, run);
  const slopeNormal: V3 = alongZ ? [0, run / len, (s * rise) / len] : [(s * rise) / len, run / len, 0];
  const polygons: Polygon[] = [{ corners: slope, normal: slopeNormal, material: slopeMaterial }];
  sides.forEach((corners, i) => {
    const normal: V3 = sideAxis === 0 ? [i === 0 ? -1 : 1, 0, 0] : [0, 0, i === 0 ? -1 : 1];
    polygons.push({ corners, normal, material: part.material });
  });
  return { rects, polygons };
}

type CoverIndex = Map<string, { b: readonly [number, number]; c: readonly [number, number] }[]>;

const planeKey = (axis: number, sign: number, plane: number) => `${axis}${sign > 0 ? "+" : "-"}${Math.round(plane / PLANE_EPS)}`;

/** Every rectangular face, keyed by plane and facing, so a face can find opposite faces touching it. */
function coverIndex(prefab: BuildingPrefab): CoverIndex {
  const index: CoverIndex = new Map();
  const add = (f: RectFace) => {
    const key = planeKey(f.axis, f.sign, f.plane);
    const list = index.get(key);
    if (list) list.push({ b: f.b, c: f.c });
    else index.set(key, [{ b: f.b, c: f.c }]);
  };
  for (const part of prefab.parts) {
    for (const face of part.kind === "box" ? boxFaces(part) : wedgeFaces(part).rects) add(face);
  }
  return index;
}

function emitRectFace(writer: GroupWriter, face: RectFace, covers: CoverIndex, maxCell: number): void {
  const blockers = (covers.get(planeKey(face.axis, -face.sign, face.plane)) ?? []).filter(
    (r) => r.b[1] > face.b[0] + PLANE_EPS && r.b[0] < face.b[1] - PLANE_EPS && r.c[1] > face.c[0] + PLANE_EPS && r.c[0] < face.c[1] - PLANE_EPS,
  );
  const bs = gridLines(face.b, blockers.flatMap((r) => r.b), maxCell);
  const cs = gridLines(face.c, blockers.flatMap((r) => r.c), maxCell);
  const visible = (i: number, j: number) => {
    const bm = (bs[i]! + bs[i + 1]!) / 2;
    const cm = (cs[j]! + cs[j + 1]!) / 2;
    return !blockers.some((r) => bm > r.b[0] && bm < r.b[1] && cm > r.c[0] && cm < r.c[1]);
  };
  const normal: [number, number, number] = [0, 0, 0];
  normal[face.axis] = face.sign;
  const [bi, ci] = OTHER_AXES[face.axis];
  const vertexIds = new Map<number, number>();
  const vertex = (i: number, j: number) => {
    const key = i * 4096 + j;
    let id = vertexIds.get(key);
    if (id === undefined) {
      const p: [number, number, number] = [0, 0, 0];
      p[face.axis] = face.plane;
      p[bi] = bs[i]!;
      p[ci] = cs[j]!;
      id = writer.vertex(p, normal);
      vertexIds.set(key, id);
    }
    return id;
  };
  for (let i = 0; i < bs.length - 1; i++) {
    for (let j = 0; j < cs.length - 1; j++) {
      if (!visible(i, j)) continue;
      writer.quad(vertex(i, j), vertex(i + 1, j), vertex(i + 1, j + 1), vertex(i, j + 1));
    }
  }
}

/** Sorted cut positions across a range: its ends, blocker edges inside it, then even splits down to maxCell. */
function gridLines(range: readonly [number, number], edges: readonly number[], maxCell: number): number[] {
  const cuts = [...new Set([range[0], range[1], ...edges.filter((e) => e > range[0] + PLANE_EPS && e < range[1] - PLANE_EPS)])].sort((a, b) => a - b);
  const lines: number[] = [cuts[0]!];
  for (let k = 1; k < cuts.length; k++) {
    const a = cuts[k - 1]!;
    const b = cuts[k]!;
    const n = Math.max(1, Math.ceil((b - a) / maxCell - 1e-6));
    for (let s = 1; s <= n; s++) lines.push(s === n ? b : a + ((b - a) * s) / n);
  }
  return lines;
}

class GroupWriter {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly indices: number[] = [];

  constructor(readonly material: BuildingMaterialId) {}

  vertex(p: V3, n: V3): number {
    this.positions.push(p[0], p[1], p[2]);
    this.normals.push(n[0], n[1], n[2]);
    return this.positions.length / 3 - 1;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  polygon({ corners, normal }: Polygon): void {
    const ids = corners.map((c) => this.vertex(c, normal));
    for (let k = 1; k < ids.length - 1; k++) this.triangle(ids[0]!, ids[k]!, ids[k + 1]!);
  }

  /** Babylon treats a triangle as front-facing when cross(p0 - p1, p2 - p1) points along its normal. */
  private triangle(i0: number, i1: number, i2: number): void {
    const p = this.positions;
    const n = this.normals;
    const ax = p[i0 * 3]! - p[i1 * 3]!;
    const ay = p[i0 * 3 + 1]! - p[i1 * 3 + 1]!;
    const az = p[i0 * 3 + 2]! - p[i1 * 3 + 2]!;
    const bx = p[i2 * 3]! - p[i1 * 3]!;
    const by = p[i2 * 3 + 1]! - p[i1 * 3 + 1]!;
    const bz = p[i2 * 3 + 2]! - p[i1 * 3 + 2]!;
    const facing = (ay * bz - az * by) * n[i0 * 3]! + (az * bx - ax * bz) * n[i0 * 3 + 1]! + (ax * by - ay * bx) * n[i0 * 3 + 2]!;
    if (facing < 0) this.indices.push(i0, i2, i1);
    else this.indices.push(i0, i1, i2);
  }

  finish(bvh: PartBvh, directions: readonly V3[]): PrefabMeshGroup {
    const count = this.positions.length / 3;
    const uvs = new Float32Array(count * 2);
    const shade = new Float32Array(count * 2);
    for (let v = 0; v < count; v++) {
      const p: V3 = [this.positions[v * 3]!, this.positions[v * 3 + 1]!, this.positions[v * 3 + 2]!];
      const n: V3 = [this.normals[v * 3]!, this.normals[v * 3 + 1]!, this.normals[v * 3 + 2]!];
      const [uAxis, vAxis] = faceUvAxes(n);
      uvs[v * 2] = dot(p, uAxis);
      uvs[v * 2 + 1] = dot(p, vAxis);
      shade[v * 2] = directions.length > 0 ? skyVisibility(bvh, p, n, directions) : 1;
      shade[v * 2 + 1] = p[1];
    }
    return {
      material: this.material,
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs,
      shade,
      indices: new Uint32Array(this.indices),
    };
  }
}

/** Fraction of cosine-weighted hemisphere rays that escape the prefab's own geometry. Terrain is not an occluder. */
function skyVisibility(bvh: PartBvh, p: V3, n: V3, directions: readonly V3[]): number {
  const t = normalize(Math.abs(n[1]) < 0.9 ? cross(n, [0, 1, 0]) : cross(n, [1, 0, 0]));
  const b = cross(n, t);
  const origin: Vec3Tuple = [p[0] + n[0] * RAY_OFFSET, p[1] + n[1] * RAY_OFFSET, p[2] + n[2] * RAY_OFFSET];
  let open = 0;
  for (const [dx, dy, dz] of directions) {
    const dir: Vec3Tuple = [t[0] * dx + b[0] * dy + n[0] * dz, t[1] * dx + b[1] * dy + n[1] * dz, t[2] * dx + b[2] * dy + n[2] * dz];
    if (bvh.raycast(origin, dir, RAY_LENGTH, true) === null) open++;
  }
  return open / directions.length;
}

/** Cosine-weighted hemisphere directions (z up) on a golden-angle spiral: deterministic and evenly spread. */
function hemisphere(count: number): V3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, i) => {
    const r = Math.sqrt((i + 0.5) / count);
    const phi = i * golden;
    return [r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - r * r)] as V3;
  });
}

/** Same planar mapping as buildLevel: v points uphill on vertical and sloped faces. */
function faceUvAxes(normal: V3): [u: V3, v: V3] {
  const u: V3 = Math.abs(normal[1]) > 0.999 ? [1, 0, 0] : normalize(cross(normal, [0, 1, 0]));
  return [u, normalize(cross(u, normal))];
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: V3): V3 {
  const len = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / len, a[1] / len, a[2] / len];
}
