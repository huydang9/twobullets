import { CreateBoxVertexData, CreateCapsuleVertexData, Matrix, Vector3, VertexData } from "@babylonjs/core";

/** A 2D point in a weapon's side view: [z (forward), y (up)] in meters. */
export type ProfilePoint = readonly [number, number];
/** A lathe ring: [radius, z] in meters, ordered rear → front around the outside (and back inside for hollow parts). */
export type LatheRing = readonly [number, number];

/**
 * Babylon's front-face winding, measured once from a builder mesh: +1 when cross(b - a, c - a) points along the
 * vertex normal, -1 otherwise. Generated triangles are oriented to match so back-face culling keeps the right side.
 */
const WINDING = (() => {
  const box = CreateBoxVertexData({ size: 1 });
  const p = box.positions ?? [];
  const n = box.normals ?? [];
  const [a = 0, b = 0, c = 0] = box.indices ?? [];
  const vertex = (i: number) => new Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  const cross = Vector3.Cross(vertex(b).subtract(vertex(a)), vertex(c).subtract(vertex(a)));
  return Vector3.Dot(cross, new Vector3(n[a * 3], n[a * 3 + 1], n[a * 3 + 2])) >= 0 ? 1 : -1;
})();

class MeshBuffer {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly indices: number[] = [];

  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): number {
    const length = Math.hypot(nx, ny, nz) || 1;
    this.positions.push(x, y, z);
    this.normals.push(nx / length, ny / length, nz / length);
    return this.positions.length / 3 - 1;
  }

  /** Adds a triangle wound to face along its vertex normals. */
  triangle(a: number, b: number, c: number): void {
    const p = this.positions;
    const n = this.normals;
    const e1x = p[b * 3]! - p[a * 3]!;
    const e1y = p[b * 3 + 1]! - p[a * 3 + 1]!;
    const e1z = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const e2x = p[c * 3]! - p[a * 3]!;
    const e2y = p[c * 3 + 1]! - p[a * 3 + 1]!;
    const e2z = p[c * 3 + 2]! - p[a * 3 + 2]!;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const nx = n[a * 3]! + n[b * 3]! + n[c * 3]!;
    const ny = n[a * 3 + 1]! + n[b * 3 + 1]! + n[c * 3 + 1]!;
    const nz = n[a * 3 + 2]! + n[b * 3 + 2]! + n[c * 3 + 2]!;
    if ((cx * nx + cy * ny + cz * nz) * WINDING >= 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  toVertexData(): VertexData {
    const data = new VertexData();
    data.positions = this.positions;
    data.normals = this.normals;
    data.indices = this.indices;
    return data;
  }
}

/** Box with rounded edges and corners (smooth normals). `size` is the full extent, like CreateBox. */
export function roundedBox(size: readonly [number, number, number], radius: number, segments = 3): VertexData {
  const half = [size[0] / 2, size[1] / 2, size[2] / 2] as const;
  const r = Math.max(1e-4, Math.min(radius, half[0], half[1], half[2]));
  const inner = [half[0] - r, half[1] - r, half[2] - r] as const;
  // Grid coordinates per axis: dense near both edges so the rounding gets `segments` steps, flat in the middle.
  const axisCoords = (axis: 0 | 1 | 2): number[] => {
    const coords: number[] = [];
    for (let k = segments; k >= 0; k--) coords.push(-inner[axis] - r * Math.tan((Math.PI / 4) * (k / segments)));
    for (let k = 0; k <= segments; k++) coords.push(inner[axis] + r * Math.tan((Math.PI / 4) * (k / segments)));
    return coords;
  };
  const buffer = new MeshBuffer();
  const p = [0, 0, 0];
  for (let axis = 0 as 0 | 1 | 2; axis < 3; axis = (axis + 1) as 0 | 1 | 2) {
    const u = ((axis + 1) % 3) as 0 | 1 | 2;
    const v = ((axis + 2) % 3) as 0 | 1 | 2;
    const us = axisCoords(u);
    const vs = axisCoords(v);
    for (const sign of [-1, 1]) {
      const grid: number[] = [];
      for (const cu of us) {
        for (const cv of vs) {
          p[axis] = sign * half[axis];
          p[u] = cu;
          p[v] = cv;
          const ix = Math.max(-inner[0], Math.min(inner[0], p[0]!));
          const iy = Math.max(-inner[1], Math.min(inner[1], p[1]!));
          const iz = Math.max(-inner[2], Math.min(inner[2], p[2]!));
          let nx = p[0]! - ix;
          let ny = p[1]! - iy;
          let nz = p[2]! - iz;
          const length = Math.hypot(nx, ny, nz) || 1;
          nx /= length;
          ny /= length;
          nz /= length;
          grid.push(buffer.vertex(ix + nx * r, iy + ny * r, iz + nz * r, nx, ny, nz));
        }
      }
      const rows = us.length;
      const cols = vs.length;
      for (let i = 0; i < rows - 1; i++) {
        for (let j = 0; j < cols - 1; j++) {
          buffer.quad(grid[i * cols + j]!, grid[(i + 1) * cols + j]!, grid[(i + 1) * cols + j + 1]!, grid[i * cols + j + 1]!);
        }
      }
    }
  }
  return buffer.toVertexData();
}

/**
 * Side-view silhouette extruded across X (width), with a chamfer of `bevel` on both faces. Handles concave outlines
 * (grips, stocks, curved magazines). Points are [z, y], in either winding order.
 */
export function extrudeProfile(points: readonly ProfilePoint[], width: number, bevel = 0): VertexData {
  const count = points.length;
  let area = 0;
  for (let i = 0; i < count; i++) {
    const [z0, y0] = points[i]!;
    const [z1, y1] = points[(i + 1) % count]!;
    area += z0 * y1 - z1 * y0;
  }
  const ccw = area > 0 ? 1 : -1;
  // Outward edge normals in (z, y).
  const normals: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const [z0, y0] = points[i]!;
    const [z1, y1] = points[(i + 1) % count]!;
    const dz = z1 - z0;
    const dy = y1 - y0;
    const length = Math.hypot(dz, dy) || 1;
    normals.push([(dy / length) * ccw, (-dz / length) * ccw]);
  }
  const b = Math.min(bevel, width / 2 - 1e-4);
  const inset: [number, number][] = points.map(([z, y], i) => {
    if (b <= 0) return [z, y];
    const [pz, py] = normals[(i + count - 1) % count]!;
    const [nz, ny] = normals[i]!;
    let mz = pz + nz;
    let my = py + ny;
    const length = Math.hypot(mz, my) || 1;
    mz /= length;
    my /= length;
    const scale = b / Math.max(0.35, mz * nz + my * ny);
    return [z - mz * scale, y - my * scale];
  });

  const buffer = new MeshBuffer();
  const halfWall = width / 2 - b;
  const halfCap = width / 2;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const [nz, ny] = normals[i]!;
    const [z0, y0] = points[i]!;
    const [z1, y1] = points[j]!;
    buffer.quad(
      buffer.vertex(-halfWall, y0, z0, 0, ny, nz),
      buffer.vertex(halfWall, y0, z0, 0, ny, nz),
      buffer.vertex(halfWall, y1, z1, 0, ny, nz),
      buffer.vertex(-halfWall, y1, z1, 0, ny, nz),
    );
    if (b > 0) {
      const [iz0, iy0] = inset[i]!;
      const [iz1, iy1] = inset[j]!;
      for (const side of [-1, 1]) {
        buffer.quad(
          buffer.vertex(side * halfWall, y0, z0, side, ny, nz),
          buffer.vertex(side * halfCap, iy0, iz0, side, ny, nz),
          buffer.vertex(side * halfCap, iy1, iz1, side, ny, nz),
          buffer.vertex(side * halfWall, y1, z1, side, ny, nz),
        );
      }
    }
  }
  const triangles = earClip(inset);
  for (const side of [-1, 1]) {
    const base = inset.map(([z, y]) => buffer.vertex(side * halfCap, y, z, side, 0, 0));
    for (let t = 0; t < triangles.length; t += 3) buffer.triangle(base[triangles[t]!]!, base[triangles[t + 1]!]!, base[triangles[t + 2]!]!);
  }
  return buffer.toVertexData();
}

/**
 * Surface of revolution around +Z. Each profile segment becomes its own band (crisp along the profile, smooth
 * around it). Open ends are left open; close them by starting/ending the profile at radius 0.
 */
export function lathe(rings: readonly LatheRing[], segments = 16): VertexData {
  const buffer = new MeshBuffer();
  for (let i = 0; i < rings.length - 1; i++) {
    const [r0, z0] = rings[i]!;
    const [r1, z1] = rings[i + 1]!;
    const dr = r1 - r0;
    const dz = z1 - z0;
    const length = Math.hypot(dr, dz);
    if (length < 1e-6) continue;
    // Outward normal of the profile segment in (radius, z).
    const nr = dz / length;
    const nzAxis = -dr / length;
    let previous: [number, number] | null = null;
    for (let s = 0; s <= segments; s++) {
      const angle = (s / segments) * Math.PI * 2;
      const cx = Math.cos(angle);
      const cy = Math.sin(angle);
      const a = buffer.vertex(cx * r0, cy * r0, z0, cx * nr, cy * nr, nzAxis);
      const c = buffer.vertex(cx * r1, cy * r1, z1, cx * nr, cy * nr, nzAxis);
      if (previous) buffer.quad(previous[0], a, c, previous[1]);
      previous = [a, c];
    }
  }
  return buffer.toVertexData();
}

/** Rounded capsule of total length `length` (including caps) along +Z. */
export function capsule(length: number, radius: number, tessellation = 10): VertexData {
  const data = CreateCapsuleVertexData({ height: Math.max(length, radius * 2 + 1e-4), radius, tessellation, subdivisions: 1, capSubdivisions: 4 });
  // Built along +Y and rotated here: the builder's `orientation` option rotates positions but not normals.
  return data.transform(Matrix.RotationX(Math.PI / 2));
}

/** Ear-clipping triangulation of a simple polygon; returns index triples. */
function earClip(points: readonly (readonly [number, number])[]): number[] {
  const indices = points.map((_, i) => i);
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[(i + 1) % points.length]!;
    area += x0 * y1 - x1 * y0;
  }
  if (area < 0) indices.reverse();
  const result: number[] = [];
  let guard = 0;
  while (indices.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < indices.length; i++) {
      const ia = indices[(i + indices.length - 1) % indices.length]!;
      const ib = indices[i]!;
      const ic = indices[(i + 1) % indices.length]!;
      const [ax, ay] = points[ia]!;
      const [bx, by] = points[ib]!;
      const [cx, cy] = points[ic]!;
      if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) <= 1e-12) continue;
      let contains = false;
      for (const other of indices) {
        if (other === ia || other === ib || other === ic) continue;
        const [px, py] = points[other]!;
        if (insideTriangle(px, py, ax, ay, bx, by, cx, cy)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      result.push(ia, ib, ic);
      indices.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (indices.length === 3) result.push(indices[0]!, indices[1]!, indices[2]!);
  return result;
}

function insideTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}
