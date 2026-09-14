import type { Heightfield } from "@twobullets/shared";

/**
 * Chunk geometry for the terrain renderer (no Babylon imports, so the LOD budget can be estimated headless).
 *
 * Each chunk is `cells` × `cells` grid cells with one shared vertex grid; every LOD is an extra index range over the
 * same vertices, stepping 2^lod samples. Cells split along the same diagonal as Havok's heightfield, so LOD 0 matches
 * the collision surface exactly. Skirts hang below the chunk edges to hide cracks between neighbors at different LODs.
 */
export interface ChunkGeometry {
  /** Chunk grid coordinates and the sample index of its min corner. */
  readonly chunkX: number;
  readonly chunkZ: number;
  /** World center of the chunk on XZ; positions are relative to it. */
  readonly centerX: number;
  readonly centerZ: number;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
  readonly vertexCount: number;
  /** Index range per LOD (terrain triangles plus skirts). */
  readonly lods: readonly { readonly start: number; readonly count: number }[];
  /** Max vertical deviation of each LOD from the full-resolution surface, m. LOD 0 is 0. */
  readonly lodErrors: Float32Array;
  readonly minY: number;
  readonly maxY: number;
}

export interface ChunkLayout {
  readonly cells: number;
  readonly chunksPerSide: number;
  readonly lodCount: number;
}

export function chunkLayout(field: Heightfield, cells: number, maxLod: number): ChunkLayout {
  const gridCells = field.resolution - 1;
  if (gridCells % cells !== 0) throw new Error(`Terrain chunk size ${cells} must divide ${gridCells} cells`);
  const lodCount = Math.min(maxLod, Math.log2(cells)) + 1;
  return { cells, chunksPerSide: gridCells / cells, lodCount };
}

export function buildChunkGeometry(field: Heightfield, layout: ChunkLayout, chunkX: number, chunkZ: number): ChunkGeometry {
  const { cells, lodCount } = layout;
  const n = field.resolution;
  const side = cells + 1;
  const ix0 = chunkX * cells;
  const iz0 = chunkZ * cells;
  const half = (cells * field.spacing) / 2;
  const centerX = field.worldX(ix0) + half;
  const centerZ = field.worldZ(iz0) + half;

  const lodErrors = new Float32Array(lodCount);
  for (let lod = 1; lod < lodCount; lod++) lodErrors[lod] = lodError(field, ix0, iz0, cells, 1 << lod);
  const range = field.rangeIn(ix0, iz0, ix0 + cells, iz0 + cells);
  const skirtDepth = Math.max(2, lodErrors[lodCount - 1]! * 1.5 + 0.5);

  // Grid vertices, then one skirt vertex below each edge vertex (south, north, west, east edges).
  const gridVertices = side * side;
  const vertexCount = gridVertices + 4 * side;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const writeVertex = (v: number, ix: number, iz: number, drop: number) => {
    const gx = field.gradX(ix, iz);
    const gz = field.gradZ(ix, iz);
    const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    positions[v * 3] = field.worldX(ix) - centerX;
    positions[v * 3 + 1] = field.heights[iz * n + ix]! - drop;
    positions[v * 3 + 2] = field.worldZ(iz) - centerZ;
    normals[v * 3] = -gx * inv;
    normals[v * 3 + 1] = inv;
    normals[v * 3 + 2] = -gz * inv;
  };
  for (let j = 0; j < side; j++) for (let i = 0; i < side; i++) writeVertex(j * side + i, ix0 + i, iz0 + j, 0);
  const grid = (i: number, j: number) => j * side + i;
  const edges: readonly ((k: number) => [i: number, j: number])[] = [
    (k) => [k, 0],
    (k) => [k, cells],
    (k) => [0, k],
    (k) => [cells, k],
  ];
  edges.forEach((edge, e) => {
    for (let k = 0; k < side; k++) {
      const [i, j] = edge(k);
      writeVertex(gridVertices + e * side + k, ix0 + i, iz0 + j, skirtDepth);
    }
  });

  const indexList: number[] = [];
  const lods: { start: number; count: number }[] = [];
  for (let lod = 0; lod < lodCount; lod++) {
    const step = 1 << lod;
    const start = indexList.length;
    for (let j = 0; j < cells; j += step) {
      for (let i = 0; i < cells; i += step) {
        const a = grid(i, j);
        const b = grid(i + step, j);
        const c = grid(i, j + step);
        const d = grid(i + step, j + step);
        // Split along b-c, like Havok. Babylon front faces: cross(p0 - p1, p2 - p1) points up.
        indexList.push(a, b, c, d, c, b);
      }
    }
    edges.forEach((edge, e) => {
      for (let k = 0; k < cells; k += step) {
        const [i0, j0] = edge(k);
        const [i1, j1] = edge(k + step);
        const t0 = grid(i0, j0);
        const t1 = grid(i1, j1);
        const s0 = gridVertices + e * side + k;
        const s1 = gridVertices + e * side + k + step;
        // Both windings, so the skirt covers a crack seen from either side.
        indexList.push(t0, t1, s0, t1, s1, s0, t0, s0, t1, t1, s0, s1);
      }
    });
    lods.push({ start, count: indexList.length - start });
  }

  const indices = vertexCount <= 65536 ? Uint16Array.from(indexList) : Uint32Array.from(indexList);
  return { chunkX, chunkZ, centerX, centerZ, positions, normals, indices, vertexCount, lods, lodErrors, minY: range.min - skirtDepth, maxY: range.max };
}

/** Max |full-res height − LOD surface| over the chunk's samples, with the LOD using the same diagonal split. */
function lodError(field: Heightfield, ix0: number, iz0: number, cells: number, step: number): number {
  let worst = 0;
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) {
      const ci = Math.min(Math.floor(i / step) * step, cells - step);
      const cj = Math.min(Math.floor(j / step) * step, cells - step);
      const fx = (i - ci) / step;
      const fz = (j - cj) / step;
      const h00 = field.at(ix0 + ci, iz0 + cj);
      const h10 = field.at(ix0 + ci + step, iz0 + cj);
      const h01 = field.at(ix0 + ci, iz0 + cj + step);
      const coarse =
        fx + fz <= 1
          ? h00 + fx * (h10 - h00) + fz * (h01 - h00)
          : field.at(ix0 + ci + step, iz0 + cj + step) * (fx + fz - 1) + h01 * (1 - fx) + h10 * (1 - fz);
      const error = Math.abs(field.at(ix0 + i, iz0 + j) - coarse);
      if (error > worst) worst = error;
    }
  }
  return worst;
}

/** Pixels per meter of vertical error at 1 m distance: viewport height / (2·tan(fovY/2)). */
export function projectionScale(viewportHeight: number, verticalFov: number): number {
  return viewportHeight / (2 * Math.tan(verticalFov / 2));
}

/** Coarsest LOD whose geometric error projects to at most `pixelError` pixels at `distance`. */
export function selectLod(lodErrors: Float32Array, distance: number, scale: number, pixelError: number): number {
  const d = Math.max(distance, 1);
  let lod = lodErrors.length - 1;
  while (lod > 0 && (lodErrors[lod]! * scale) / d > pixelError) lod--;
  return lod;
}

/** Distance from a point to an axis-aligned box. */
export function distanceToBox(px: number, py: number, pz: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
  const dx = px < minX ? minX - px : px > maxX ? px - maxX : 0;
  const dy = py < minY ? minY - py : py > maxY ? py - maxY : 0;
  const dz = pz < minZ ? minZ - pz : pz > maxZ ? pz - maxZ : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
