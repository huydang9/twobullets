// Plain-array mesh helpers for props.mjs and foliage.mjs: extraction from glTF Transform documents with baked
// transforms, meshoptimizer simplification, measurement (bounds, collision) and writing parts back as primitives.
import { MeshoptSimplifier } from "meshoptimizer";

/**
 * @typedef {{
 *   material: import("@gltf-transform/core").Material | null,
 *   positions: Float32Array, normals: Float32Array, uv0: Float32Array | null, uv1: Float32Array | null,
 *   colors?: Float32Array | null, indices: Uint32Array,
 * }} Part
 */

export const triangleCount = (parts) => parts.reduce((n, p) => n + p.indices.length / 3, 0);

function readAccessor(accessor, size) {
  const count = accessor.getCount();
  const out = new Float32Array(count * size);
  const element = [];
  for (let i = 0; i < count; i++) {
    accessor.getElement(i, element);
    for (let k = 0; k < size; k++) out[i * size + k] = element[k] ?? 0;
  }
  return out;
}

/** 4×4 column-major helpers (glTF convention). */
export const mat4 = {
  multiply(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
  },
  translation: ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
  scale: (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1],
  /** Intrinsic X, then Y, then Z rotation in degrees. */
  rotation([dx, dy, dz]) {
    const [x, y, z] = [dx, dy, dz].map((d) => (d * Math.PI) / 180);
    const rx = [1, 0, 0, 0, 0, Math.cos(x), Math.sin(x), 0, 0, -Math.sin(x), Math.cos(x), 0, 0, 0, 0, 1];
    const ry = [Math.cos(y), 0, -Math.sin(y), 0, 0, 1, 0, 0, Math.sin(y), 0, Math.cos(y), 0, 0, 0, 0, 1];
    const rz = [Math.cos(z), Math.sin(z), 0, 0, -Math.sin(z), Math.cos(z), 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return mat4.multiply(rz, mat4.multiply(ry, rx));
  },
};

function determinant3(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

/** Applies a 4×4 transform to a part in place (normals by the rotation part; winding flipped for mirroring). */
export function transformPart(part, m) {
  const { positions: p, normals: n } = part;
  for (let i = 0; i < p.length; i += 3) {
    const [x, y, z] = [p[i], p[i + 1], p[i + 2]];
    p[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    p[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    p[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    const [a, b, c] = [n[i], n[i + 1], n[i + 2]];
    const nx = m[0] * a + m[4] * b + m[8] * c;
    const ny = m[1] * a + m[5] * b + m[9] * c;
    const nz = m[2] * a + m[6] * b + m[10] * c;
    const len = Math.hypot(nx, ny, nz) || 1;
    n[i] = nx / len;
    n[i + 1] = ny / len;
    n[i + 2] = nz / len;
  }
  if (determinant3(m) < 0) {
    for (let i = 0; i < part.indices.length; i += 3) [part.indices[i + 1], part.indices[i + 2]] = [part.indices[i + 2], part.indices[i + 1]];
  }
}

/**
 * Reads the given scene nodes into parts with world transforms baked, merged per material. `nodes` undefined means every
 * node with a mesh. A node spec is a name or `{ name, translate?, rotate?, scale?, crop?, clipBelow? }`:
 * - `crop { min, max }` keeps the connected components whose bounds center lies in the box, and `clipBelow` drops
 *   triangles whose centroid is below that height; both in the node's world space (source units);
 * - then `scale` (uniform), `rotate` (degrees XYZ) and `translate` are applied in that order.
 */
export function extractParts(doc, nodes) {
  const all = doc.getRoot().listNodes();
  const specs = nodes
    ? nodes.map((spec) => {
        const name = typeof spec === "string" ? spec : spec.name;
        const node = all.find((n) => n.getName() === name);
        if (!node?.getMesh()) throw new Error(`node ${name} not found or has no mesh`);
        return typeof spec === "string" ? { node } : { ...spec, node };
      })
    : all.filter((n) => n.getMesh()).map((node) => ({ node }));
  const byMaterial = new Map();
  for (const { node, translate, rotate, scale, crop, clipBelow } of specs) {
    const filtered = crop !== undefined || clipBelow !== undefined;
    // Without filters the extra transform folds into the world matrix (the original translate-only path).
    const extra = rotate || scale || translate ? mat4.multiply(mat4.translation(translate ?? [0, 0, 0]), mat4.multiply(mat4.rotation(rotate ?? [0, 0, 0]), mat4.scale(scale ?? 1))) : null;
    const world = extra && !filtered ? mat4.multiply(extra, node.getWorldMatrix()) : node.getWorldMatrix();
    for (const prim of node.getMesh().listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      const count = position.getCount();
      const part = {
        material: prim.getMaterial(),
        positions: readAccessor(position, 3),
        normals: prim.getAttribute("NORMAL") ? readAccessor(prim.getAttribute("NORMAL"), 3) : new Float32Array(count * 3).fill(0),
        uv0: prim.getAttribute("TEXCOORD_0") ? readAccessor(prim.getAttribute("TEXCOORD_0"), 2) : null,
        uv1: prim.getAttribute("TEXCOORD_1") ? readAccessor(prim.getAttribute("TEXCOORD_1"), 2) : null,
        indices: prim.getIndices() ? Uint32Array.from(prim.getIndices().getArray()) : Uint32Array.from({ length: count }, (_, i) => i),
      };
      transformPart(part, world);
      let kept = part;
      if (filtered) {
        kept = filterPart(part, { crop, clipBelow });
        if (kept.indices.length === 0) continue;
        if (extra) transformPart(kept, extra);
      }
      const key = kept.material ?? "none";
      byMaterial.set(key, [...(byMaterial.get(key) ?? []), kept]);
    }
  }
  return [...byMaterial.values()].map(mergeParts);
}

/** `crop` keeps whole components whose bounds center is inside the box; `clipBelow` drops triangles by centroid height. */
function filterPart(part, { crop, clipBelow }) {
  const { positions: p, indices: idx } = part;
  const keep = new Uint8Array(idx.length / 3).fill(1);
  if (crop) {
    for (const tris of components(part, true)) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const t of tris) {
        for (let k = 0; k < 3; k++) {
          const v = idx[t * 3 + k] * 3;
          for (let d = 0; d < 3; d++) {
            min[d] = Math.min(min[d], p[v + d]);
            max[d] = Math.max(max[d], p[v + d]);
          }
        }
      }
      const inside = [0, 1, 2].every((d) => (min[d] + max[d]) / 2 >= crop.min[d] && (min[d] + max[d]) / 2 <= crop.max[d]);
      if (!inside) for (const t of tris) keep[t] = 0;
    }
  }
  if (clipBelow !== undefined) {
    for (let t = 0; t < keep.length; t++) {
      const y = (p[idx[t * 3] * 3 + 1] + p[idx[t * 3 + 1] * 3 + 1] + p[idx[t * 3 + 2] * 3 + 1]) / 3;
      if (y < clipBelow) keep[t] = 0;
    }
  }
  return keepTriangles(part, keep);
}

/** Part with only the triangles flagged in `keep` (one byte per triangle), vertices compacted. */
export function keepTriangles(part, keep) {
  const indices = [];
  for (let t = 0; t < keep.length; t++) if (keep[t]) indices.push(part.indices[t * 3], part.indices[t * 3 + 1], part.indices[t * 3 + 2]);
  return compactPart(part, Uint32Array.from(indices));
}

export function mergeParts(parts) {
  if (parts.length === 1) return parts[0];
  const vertexCount = parts.reduce((n, p) => n + p.positions.length / 3, 0);
  const merged = {
    material: parts[0].material,
    positions: new Float32Array(vertexCount * 3),
    normals: new Float32Array(vertexCount * 3),
    uv0: parts.every((p) => p.uv0) ? new Float32Array(vertexCount * 2) : null,
    uv1: parts.every((p) => p.uv1) ? new Float32Array(vertexCount * 2) : null,
    indices: new Uint32Array(parts.reduce((n, p) => n + p.indices.length, 0)),
  };
  let v = 0;
  let i = 0;
  for (const p of parts) {
    merged.positions.set(p.positions, v * 3);
    merged.normals.set(p.normals, v * 3);
    merged.uv0?.set(p.uv0, v * 2);
    merged.uv1?.set(p.uv1, v * 2);
    for (let k = 0; k < p.indices.length; k++) merged.indices[i + k] = p.indices[k] + v;
    v += p.positions.length / 3;
    i += p.indices.length;
  }
  return merged;
}

export function bounds(parts) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { positions: p } of parts) {
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[i + k]);
        max[k] = Math.max(max[k], p[i + k]);
      }
    }
  }
  return { min, max };
}

/** Keeps only referenced vertices, in first-use order. */
export function compactPart(part, indices) {
  const remap = new Int32Array(part.positions.length / 3).fill(-1);
  let next = 0;
  for (const index of indices) if (remap[index] < 0) remap[index] = next++;
  const pick = (source, size) => {
    if (!source) return null;
    const out = new Float32Array(next * size);
    for (let old = 0; old < remap.length; old++) if (remap[old] >= 0) for (let k = 0; k < size; k++) out[remap[old] * size + k] = source[old * size + k];
    return out;
  };
  return {
    material: part.material,
    positions: pick(part.positions, 3),
    normals: pick(part.normals, 3),
    uv0: pick(part.uv0, 2),
    uv1: pick(part.uv1, 2),
    indices: indices.map((i) => remap[i]),
  };
}

/**
 * meshoptimizer simplification to `ratio` of the triangles, stopping early at `error` (relative to the part's extent).
 * `LockBorder` keeps open edges (cards, foliage) from shrinking; `Prune` drops small disconnected islands at far LODs.
 */
export function simplifyPart(part, ratio, error, flags = []) {
  const target = Math.max(3, Math.floor((part.indices.length / 3) * ratio)) * 3;
  if (target >= part.indices.length) return part;
  if (flags.includes("Permissive") && part.uv0) {
    // Collapses across UV seams are weighed by the UV change, so textures don't smear along the seams.
    const [indices] = MeshoptSimplifier.simplifyWithAttributes(part.indices, part.positions, 3, part.uv0, 2, [0.5, 0.5], null, target, error, flags);
    return compactPart(part, indices);
  }
  const [indices] = MeshoptSimplifier.simplify(part.indices, part.positions, 3, target, error, flags);
  return compactPart(part, indices);
}

export async function simplifierReady() {
  await MeshoptSimplifier.ready;
}

/** Writes parts as one glTF mesh on a new node under the scene. */
export function writeNode(doc, scene, name, parts) {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const mesh = doc.createMesh(name);
  for (const part of parts) {
    const accessor = (array, type) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    const prim = doc
      .createPrimitive()
      .setAttribute("POSITION", accessor(part.positions, "VEC3"))
      .setAttribute("NORMAL", accessor(part.normals, "VEC3"))
      .setIndices(accessor(part.indices, "SCALAR"));
    if (part.uv0) prim.setAttribute("TEXCOORD_0", accessor(part.uv0, "VEC2"));
    if (part.uv1) prim.setAttribute("TEXCOORD_1", accessor(part.uv1, "VEC2"));
    if (part.colors) prim.setAttribute("COLOR_0", accessor(part.colors, "VEC3"));
    if (part.material) prim.setMaterial(part.material);
    mesh.addPrimitive(prim);
  }
  const node = doc.createNode(name).setMesh(mesh);
  scene.addChild(node);
  return node;
}

// ---------------------------------------------------------------------------------------------
// Measurement. glTF is right-handed; Babylon's loader mirrors X, so reported shapes negate x.

const toBabylon = ([x, y, z]) => [round(-x), round(y), round(z)];
const round = (v) => Math.round(v * 1000) / 1000 + 0;

export function babylonBounds(parts) {
  const { min, max } = bounds(parts);
  return { min: toBabylon([max[0], min[1], min[2]]), max: toBabylon([min[0], max[1], max[2]]) };
}

export function footprintRadius(parts) {
  let r = 0;
  for (const { positions: p } of parts) for (let i = 0; i < p.length; i += 3) r = Math.max(r, Math.hypot(p[i], p[i + 2]));
  return round(r);
}

/** Support points of the vertex cloud along evenly spread directions: an inner approximation of the convex hull. */
export function hullPoints(parts, directions = 48, maxPoints = 32) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const picked = new Map();
  for (let d = 0; d < directions && picked.size < maxPoints; d++) {
    const y = 1 - (2 * (d + 0.5)) / directions;
    const r = Math.sqrt(1 - y * y);
    const dir = [Math.cos(golden * d) * r, y, Math.sin(golden * d) * r];
    let best = null;
    let bestDot = -Infinity;
    for (const { positions: p } of parts) {
      for (let i = 0; i < p.length; i += 3) {
        const dot = p[i] * dir[0] + p[i + 1] * dir[1] + p[i + 2] * dir[2];
        if (dot > bestDot) [bestDot, best] = [dot, [p[i], p[i + 1], p[i + 2]]];
      }
    }
    picked.set(best.map((v) => Math.round(v * 100)).join(","), best);
  }
  return [...picked.values()].map(toBabylon);
}

export function collisionOf(kind, parts, { trunk } = {}) {
  const { min, max } = bounds(parts);
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  switch (kind) {
    case "none":
      return { kind: "none" };
    case "box":
      return { kind: "box", center: toBabylon(center), size: [0, 1, 2].map((k) => round(max[k] - min[k])) };
    case "convexHull":
      return { kind: "convexHull", points: hullPoints(parts) };
    case "cylinder": {
      if (trunk) return trunkCylinder(trunk, max[1]);
      let radius = 0;
      for (const { positions: p } of parts) for (let i = 0; i < p.length; i += 3) radius = Math.max(radius, Math.hypot(p[i] - center[0], p[i + 2] - center[2]));
      return { kind: "cylinder", center: toBabylon(center), radius: round(radius), height: round(max[1] - min[1]) };
    }
    default:
      throw new Error(`unknown collision kind ${kind}`);
  }
}

/**
 * Upright cylinder around the trunk base, up to the trunk's top. Trunk materials often include branch stubs, so the axis
 * is the median of the vertices between 0.8 and 1.5 m and the radius a low percentile of their distances to it.
 */
function trunkCylinder(trunkParts, treeHeight) {
  const xs = [];
  const zs = [];
  for (const { positions: p } of trunkParts) {
    for (let i = 0; i < p.length; i += 3) {
      if (p[i + 1] <= 0.8 || p[i + 1] >= 1.5) continue;
      xs.push(p[i]);
      zs.push(p[i + 2]);
    }
  }
  if (xs.length === 0) throw new Error("trunk has no vertices between 0.8 and 1.5 m");
  const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
  const [cx, cz] = [median(xs), median(zs)];
  const radii = xs.map((x, i) => Math.hypot(x - cx, zs[i] - cz)).sort((a, b) => a - b);
  const radius = Math.max(0.06, radii[Math.floor(radii.length * 0.25)] * 1.1);
  const { max } = bounds(trunkParts);
  const height = Math.min(max[1], treeHeight);
  return { kind: "cylinder", center: toBabylon([cx, height / 2, cz]), radius: round(radius), height: round(height) };
}

/**
 * Connected components (shared vertex indices, or shared positions when `byPosition`), each as a list of triangle
 * indices. Leaves, blades and twig cards are separate components.
 */
export function components(part, byPosition = false) {
  const vertexCount = part.positions.length / 3;
  const parent = Int32Array.from({ length: vertexCount }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent[ra] = rb;
  };
  if (byPosition) {
    const seen = new Map();
    const p = part.positions;
    for (let v = 0; v < vertexCount; v++) {
      const key = `${Math.round(p[v * 3] * 1e4)},${Math.round(p[v * 3 + 1] * 1e4)},${Math.round(p[v * 3 + 2] * 1e4)}`;
      const other = seen.get(key);
      if (other === undefined) seen.set(key, v);
      else union(v, other);
    }
  }
  const idx = part.indices;
  for (let t = 0; t < idx.length; t += 3) {
    union(idx[t], idx[t + 1]);
    union(idx[t], idx[t + 2]);
  }
  const groups = new Map();
  for (let t = 0; t < idx.length / 3; t++) {
    const root = find(idx[t * 3]);
    let list = groups.get(root);
    if (!list) groups.set(root, (list = []));
    list.push(t);
  }
  return [...groups.values()];
}

/**
 * Keeps about `ratio` of the components (deterministic spread), optionally scaling survivors about their centroid by
 * 1/sqrt(ratio) so coverage stays similar. For leaves, blades and twig cards, where edge collapse would destroy shapes.
 */
export function thinComponents(part, ratio, { compensate = false } = {}) {
  const groups = components(part, true);
  const keepEvery = 1 / ratio;
  const indices = [];
  const p = new Float32Array(part.positions);
  const scale = compensate ? 1 / Math.sqrt(ratio) : 1;
  groups.forEach((tris, g) => {
    // Golden-ratio sequence keeps a spatially even subset without sorting.
    if (((g * 0.6180339887) % 1) * keepEvery >= 1) return;
    const verts = new Set();
    for (const t of tris) for (let k = 0; k < 3; k++) verts.add(part.indices[t * 3 + k]);
    if (scale !== 1) {
      const c = [0, 0, 0];
      for (const v of verts) for (let k = 0; k < 3; k++) c[k] += part.positions[v * 3 + k] / verts.size;
      for (const v of verts) for (let k = 0; k < 3; k++) p[v * 3 + k] = c[k] + (part.positions[v * 3 + k] - c[k]) * scale;
    }
    for (const t of tris) indices.push(part.indices[t * 3], part.indices[t * 3 + 1], part.indices[t * 3 + 2]);
  });
  return compactPart({ ...part, positions: p }, Uint32Array.from(indices));
}
