import { Mesh, VertexBuffer, type Material, type Scene } from "@babylonjs/core";
import type { Terrain } from "@twobullets/shared";

/** Distance of each ring beyond the heightfield edge, m. Ring 0 lies exactly on the edge samples. */
const RING_OFFSETS = [0, 25, 60, 110, 180, 280, 420, 620, 900, 1300, 1900, 2800] as const;
/** Heightfield samples between perimeter vertices (8 → 10 m at 1.25 m spacing). */
const PERIMETER_STEP = 8;

export interface HorizonGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint16Array;
}

/**
 * Render-only mountain skirt around the heightfield: square rings scaled outward to ~2.8 km, with heights from the
 * terrain's relief function (the border ridges keep going) sinking toward the far edge, where fog takes over. The
 * inner ring reuses the heightfield's edge samples, so it meets the terrain chunks; their skirts cover any sliver.
 */
export function buildHorizonGeometry(terrain: Terrain): HorizonGeometry {
  const { field } = terrain;
  const cells = field.resolution - 1;
  if (cells % PERIMETER_STEP !== 0) throw new Error(`Horizon perimeter step ${PERIMETER_STEP} must divide ${cells}`);
  const half = field.size / 2;

  // Edge samples counter-clockwise (seen from above), starting at the min corner.
  const perimeter: [ix: number, iz: number][] = [];
  for (let i = 0; i < cells; i += PERIMETER_STEP) perimeter.push([i, 0]);
  for (let i = 0; i < cells; i += PERIMETER_STEP) perimeter.push([cells, i]);
  for (let i = cells; i > 0; i -= PERIMETER_STEP) perimeter.push([i, cells]);
  for (let i = cells; i > 0; i -= PERIMETER_STEP) perimeter.push([0, i]);

  const around = perimeter.length;
  const rings = RING_OFFSETS.length;
  const positions = new Float32Array(around * rings * 3);
  for (let r = 0; r < rings; r++) {
    const offset = RING_OFFSETS[r]!;
    const scale = 1 + offset / half;
    // Ranges lose height with distance; the far rings sit in near-opaque fog.
    const sink = 1 - 0.55 * smoothstep(300, 2800, offset);
    perimeter.forEach(([ix, iz], k) => {
      const x = field.worldX(ix) * scale;
      const z = field.worldZ(iz) * scale;
      const v = (r * around + k) * 3;
      positions[v] = x;
      positions[v + 1] = r === 0 ? field.heights[iz * field.resolution + ix]! : terrain.relief(x, z) * sink;
      positions[v + 2] = z;
    });
  }

  const at = (r: number, k: number) => (r * around + ((k + around) % around)) * 3;
  const normals = new Float32Array(positions.length);
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < around; k++) {
      const a = at(r, k - 1);
      const b = at(r, k + 1);
      const c = at(Math.max(r - 1, 0), k);
      const d = at(Math.min(r + 1, rings - 1), k);
      const tx = positions[b]! - positions[a]!;
      const ty = positions[b + 1]! - positions[a + 1]!;
      const tz = positions[b + 2]! - positions[a + 2]!;
      const rx = positions[d]! - positions[c]!;
      const ry = positions[d + 1]! - positions[c + 1]!;
      const rz = positions[d + 2]! - positions[c + 2]!;
      let nx = ty * rz - tz * ry;
      let ny = tz * rx - tx * rz;
      let nz = tx * ry - ty * rx;
      const sign = ny < 0 ? -1 : 1;
      const inv = sign / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const v = at(r, k);
      normals[v] = nx;
      normals[v + 1] = ny;
      normals[v + 2] = nz;
    }
  }

  const indices: number[] = [];
  const pushUp = (i0: number, i1: number, i2: number) => {
    // Front-facing in Babylon when cross(p0 - p1, p2 - p1) points up.
    const p = positions;
    const ax = p[i0 * 3]! - p[i1 * 3]!;
    const az = p[i0 * 3 + 2]! - p[i1 * 3 + 2]!;
    const bx = p[i2 * 3]! - p[i1 * 3]!;
    const bz = p[i2 * 3 + 2]! - p[i1 * 3 + 2]!;
    if (az * bx - ax * bz >= 0) indices.push(i0, i1, i2);
    else indices.push(i0, i2, i1);
  };
  for (let r = 0; r + 1 < rings; r++) {
    for (let k = 0; k < around; k++) {
      const a = at(r, k) / 3;
      const b = at(r, k + 1) / 3;
      const c = at(r + 1, k) / 3;
      const d = at(r + 1, k + 1) / 3;
      pushUp(a, b, c);
      pushUp(b, d, c);
    }
  }
  return { positions, normals, indices: Uint16Array.from(indices) };
}

export function createHorizonMesh(scene: Scene, terrain: Terrain, material: Material): Mesh {
  const geometry = buildHorizonGeometry(terrain);
  const mesh = new Mesh("terrain_horizon", scene);
  mesh.setVerticesData(VertexBuffer.PositionKind, geometry.positions, false);
  mesh.setVerticesData(VertexBuffer.NormalKind, geometry.normals, false);
  mesh.setIndices(geometry.indices);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.freezeWorldMatrix();
  mesh.doNotSyncBoundingInfo = true;
  return mesh;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
