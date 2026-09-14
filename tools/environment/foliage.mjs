// Game-ready vegetation from Poly Haven's film-resolution plants (0.1-4 M triangles), baked headless on the CPU:
//
//   trunk     the solid trunk material, simplified per level with meshoptimizer;
//   cards     everything else (twigs, leaves, small branches) is clustered with k-means, and each cluster becomes a
//             quad on its best-fit plane whose texture is an orthographic render of that cluster's own geometry;
//   impostor  the far level: three vertical quads crossing at the trunk, each showing a baked side view of the tree.
//
// All card and impostor renders of a model share one RGBA atlas, so every level beyond the trunk is a single material.
import sharp from "sharp";
import { bounds, keepTriangles, simplifyPart, triangleCount } from "./geometry.mjs";

/** Triangles whose centroid is below `height`. */
function clipAbove(part, height) {
  const { positions: p, indices: idx } = part;
  const keep = new Uint8Array(idx.length / 3);
  for (let t = 0; t < keep.length; t++) keep[t] = (p[idx[t * 3] * 3 + 1] + p[idx[t * 3 + 1] * 3 + 1] + p[idx[t * 3 + 2] * 3 + 1]) / 3 < height ? 1 : 0;
  return keepTriangles(part, keep);
}

const SUPERSAMPLE = 2;
const ALPHA_CUTOFF = 0.5;
/** Share of atlas area per level kind; tiles are packed with one texel density per kind. */
const ATLAS_SHARE = { cards0: 0.62, cards1: 0.18, impostor: 0.2 };

const srgbToLinear = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});
const linearToSrgb8 = (c) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

/**
 * @param doc glTF Transform document (card materials must already carry alpha in their base color)
 * @param modelId used for the atlas material name
 * @param items [{ prop, parts }] with parts placed in prop space; prop.foliage = { trunk: string[], lods: [...] }
 * @param atlasSize atlas edge in pixels
 * @returns Map(propId → { levels: Part[][], trunk: Part[] })
 */
export async function buildFoliage(doc, modelId, items, atlasSize) {
  const samplers = new Map();
  const tiles = [];
  const plans = [];

  for (const { prop, parts } of items) {
    const trunk = parts.filter((p) => prop.foliage.trunk.includes(p.material?.getName()));
    const cardParts = parts.filter((p) => !trunk.includes(p));
    for (const part of parts) if (!samplers.has(part.material)) samplers.set(part.material, await createSampler(part.material));
    const soup = triangleSoup(cardParts);
    const canopy = canopyShape(cardParts);
    let fullSoup = null;
    const plan = { prop, trunk, cardParts, soup, canopy, levels: [] };
    for (const [index, lod] of prop.foliage.lods.entries()) {
      if (lod.sourceCards) {
        // Already game-ready cards (a hand-made crown): keep them with their own sprite texture, which reuses sprites
        // far more densely than a unique atlas can. Only their normals and occlusion follow the baked cards.
        plan.levels.push({ lod, source: true });
      } else if (lod.impostor) {
        const views = impostorViews(parts, canopy);
        plan.levels.push({ lod, views });
        tiles.push(...views.map((view) => ({ kind: "impostor", width: view.width, height: view.height, owner: view, render: () => renderSoup(view, (fullSoup ??= triangleSoup(parts)), samplers, canopy, true) })));
      } else {
        const clusters = clusterCards(soup, lod.cards, index * 7919 + 1, lod.cross ?? index > 0);
        plan.levels.push({ lod, clusters });
        const kind = index === 0 ? "cards0" : "cards1";
        tiles.push(...clusters.map((c) => ({ kind, width: c.width, height: c.height, owner: c, render: () => renderSoup(c, soup, samplers, canopy, false) })));
      }
    }
    plans.push(plan);
    console.log(`  ${prop.id}: ${triangleCount(cardParts)} card-source tris, ${triangleCount(trunk)} trunk tris`);
  }

  const atlas = await bakeAtlas(tiles, atlasSize);
  const material = doc
    .createMaterial(`${modelId}_cards`)
    .setBaseColorTexture(doc.createTexture(`${modelId}_cards`).setImage(atlas).setMimeType("image/png").setURI(`${modelId}_cards.png`))
    .setAlphaMode("MASK")
    .setAlphaCutoff(0.4)
    .setDoubleSided(true)
    .setMetallicFactor(0)
    .setRoughnessFactor(0.9);

  const result = new Map();
  for (const plan of plans) {
    const levels = plan.levels.map(({ lod, clusters, views, source }) => {
      if (views) {
        // Big trunks are cover: `trunk` keeps a real, simplified trunk (below `trunkBelow`) under the impostor quads.
        if (!lod.trunk) return [impostorPart(views, material)];
        const solid = plan.trunk
          .map((p) => (lod.trunkBelow === undefined ? p : clipAbove(p, lod.trunkBelow)))
          .filter((p) => p.indices.length > 0)
          .map((p) => simplifyPart(p, Math.min(1, lod.trunk / Math.max(1, triangleCount([p]))), 0.05, ["Prune", "Permissive"]));
        return [...solid, impostorPart(views, material)];
      }
      const trunk = plan.trunk.map((p) => simplifyPart(p, Math.min(1, lod.trunk / Math.max(1, triangleCount([p]))), 0.02 + lod.distance / 2000));
      if (source) return [...trunk, ...plan.cardParts.map((p) => sourceCardsPart(p, plan.canopy))];
      return [...trunk, cardsPart(clusters, plan.canopy, material)];
    });
    result.set(plan.prop.id, { levels, trunk: plan.trunk });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Sources

/** Nearest-texel sampler for a material's base color, honoring texCoord and KHR_texture_transform. */
async function createSampler(material) {
  const info = material.getBaseColorTextureInfo();
  const texture = material.getBaseColorTexture();
  if (!texture) return { texCoord: 0, sample: (_u, _v, out) => out.set([0.2, 0.18, 0.12, 1]) };
  const { data, info: meta } = await sharp(texture.getImage()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const transform = info?.getExtension("KHR_texture_transform");
  const [ox, oy] = transform?.getOffset() ?? [0, 0];
  const [sx, sy] = transform?.getScale() ?? [1, 1];
  const rotation = transform?.getRotation() ?? 0;
  const [cos, sin] = [Math.cos(rotation), Math.sin(rotation)];
  const { width: W, height: H } = meta;
  const opaque = material.getAlphaMode() === "OPAQUE";
  const factor = material.getBaseColorFactor();
  return {
    texCoord: info?.getTexCoord() ?? 0,
    sample(u, v, out) {
      const tu = cos * sx * u + sin * sy * v + ox;
      const tv = -sin * sx * u + cos * sy * v + oy;
      const x = Math.min(W - 1, Math.floor((tu - Math.floor(tu)) * W));
      const y = Math.min(H - 1, Math.floor((tv - Math.floor(tv)) * H));
      const i = (y * W + x) * 4;
      out[0] = srgbToLinear[data[i]] * factor[0];
      out[1] = srgbToLinear[data[i + 1]] * factor[1];
      out[2] = srgbToLinear[data[i + 2]] * factor[2];
      out[3] = opaque ? 1 : data[i + 3] / 255;
    },
  };
}

/** Flat per-triangle arrays over several parts. */
function triangleSoup(parts) {
  const count = triangleCount(parts);
  const soup = { parts, part: new Uint8Array(count), local: new Uint32Array(count), centroid: new Float32Array(count * 3), area: new Float32Array(count) };
  let t = 0;
  parts.forEach((part, pi) => {
    const { positions: p, indices: idx } = part;
    for (let k = 0; k < idx.length; k += 3, t++) {
      const [a, b, c] = [idx[k] * 3, idx[k + 1] * 3, idx[k + 2] * 3];
      soup.part[t] = pi;
      soup.local[t] = k / 3;
      for (let d = 0; d < 3; d++) soup.centroid[t * 3 + d] = (p[a + d] + p[b + d] + p[c + d]) / 3;
      const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      soup.area[t] = 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
    }
  });
  return soup;
}

/** Canopy extent used for card normals and baked ambient occlusion. */
function canopyShape(parts) {
  const { min, max } = bounds(parts);
  let radius = 0;
  for (const { positions: p } of parts) for (let i = 0; i < p.length; i += 3) radius = Math.max(radius, Math.hypot(p[i], p[i + 2]));
  return { min, max, radius, center: [0, (min[1] + max[1]) / 2, 0], halfHeight: (max[1] - min[1]) / 2 };
}

/** Darker toward the trunk and the canopy bottom: a cheap stand-in for self-shadowing. */
function canopyOcclusion(canopy, x, y, z) {
  const radial = Math.min(1, Math.hypot(x, z) / Math.max(0.01, canopy.radius));
  const height = Math.min(1, Math.max(0, (y - canopy.min[1]) / Math.max(0.01, canopy.max[1] - canopy.min[1])));
  return (0.55 + 0.45 * Math.pow(radial, 0.6)) * (0.8 + 0.2 * height);
}

// ---------------------------------------------------------------------------------------------
// Clusters and cards

/** `cross`: each cluster becomes two upright cards (facing out from the trunk and across), which never go edge-on. */
function clusterCards(soup, k, seed, cross) {
  const n = soup.area.length;
  k = Math.min(k, n);
  let state = seed >>> 0 || 1;
  const random = () => ((state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);

  // Lloyd iterations on an area-weighted sample, then one full assignment pass.
  const sampleSize = Math.min(n, 40000);
  const sample = Uint32Array.from({ length: sampleSize }, () => Math.floor(random() * n));
  const centers = new Float32Array(k * 3);
  for (let c = 0; c < k; c++) {
    const t = sample[Math.floor((c + 0.5) * (sampleSize / k))];
    centers.set(soup.centroid.subarray(t * 3, t * 3 + 3), c * 3);
  }
  const nearest = (t) => {
    let best = 0;
    let bestD = Infinity;
    const [x, y, z] = [soup.centroid[t * 3], soup.centroid[t * 3 + 1], soup.centroid[t * 3 + 2]];
    for (let c = 0; c < k; c++) {
      const dx = x - centers[c * 3];
      const dy = (y - centers[c * 3 + 1]) * 1.3; // flatter clusters follow the horizontal branch layers
      const dz = z - centers[c * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) [bestD, best] = [d, c];
    }
    return best;
  };
  for (let iteration = 0; iteration < 10; iteration++) {
    const sums = new Float64Array(k * 4);
    for (const t of sample) {
      const c = nearest(t);
      const w = soup.area[t] + 1e-6;
      for (let d = 0; d < 3; d++) sums[c * 4 + d] += soup.centroid[t * 3 + d] * w;
      sums[c * 4 + 3] += w;
    }
    for (let c = 0; c < k; c++) {
      if (sums[c * 4 + 3] > 0) for (let d = 0; d < 3; d++) centers[c * 3 + d] = sums[c * 4 + d] / sums[c * 4 + 3];
      else {
        const t = sample[Math.floor(random() * sampleSize)];
        centers.set(soup.centroid.subarray(t * 3, t * 3 + 3), c * 3);
      }
    }
  }
  const assignment = new Uint32Array(n);
  const counts = new Uint32Array(k + 1);
  for (let t = 0; t < n; t++) counts[(assignment[t] = nearest(t)) + 1]++;
  for (let c = 0; c < k; c++) counts[c + 1] += counts[c];
  const order = new Uint32Array(n);
  const cursor = counts.slice();
  for (let t = 0; t < n; t++) order[cursor[assignment[t]]++] = t;

  const clusters = [];
  for (let c = 0; c < k; c++) {
    const tris = order.subarray(counts[c], counts[c + 1]);
    if (tris.length === 0) continue;
    if (!cross) {
      clusters.push(fitCard(soup, tris));
      continue;
    }
    const center = [centers[c * 3], 0, centers[c * 3 + 2]];
    const outward = Math.hypot(center[0], center[2]) > 1e-3 ? normalize(center) : [0, 0, 1];
    clusters.push(fitCard(soup, tris, outward), fitCard(soup, tris, [-outward[2], 0, outward[0]]));
  }
  return clusters;
}

/** Best-fit plane of a cluster (smallest principal axis, unless forced) and its 1st-99th percentile extent on it. */
function fitCard(soup, tris, forcedNormal) {
  let w = 0;
  const mean = [0, 0, 0];
  for (const t of tris) {
    const a = soup.area[t] + 1e-6;
    w += a;
    for (let d = 0; d < 3; d++) mean[d] += soup.centroid[t * 3 + d] * a;
  }
  for (let d = 0; d < 3; d++) mean[d] /= w;
  const cov = new Float64Array(9);
  for (const t of tris) {
    const a = soup.area[t] + 1e-6;
    const q = [soup.centroid[t * 3] - mean[0], soup.centroid[t * 3 + 1] - mean[1], soup.centroid[t * 3 + 2] - mean[2]];
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) cov[r * 3 + s] += (q[r] * q[s] * a) / w;
  }
  let normal = forcedNormal ?? symmetricEigen(cov).vectors[2];
  // Mostly-horizontal cards face up; upright ones face away from the trunk.
  const outward = [mean[0], 0, mean[2]];
  if (Math.abs(normal[1]) > 0.6 ? normal[1] < 0 : dot(normal, outward) < 0) normal = normal.map((v) => -v);
  const up = Math.abs(normal[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(up, normal));
  const v = cross(normal, u);

  const us = [];
  const vs = [];
  const zs = [];
  for (const t of tris) {
    const { positions: p, indices } = soup.parts[soup.part[t]];
    const base = soup.local[t] * 3;
    for (let k = 0; k < 3; k++) {
      const i = indices[base + k] * 3;
      const q = [p[i] - mean[0], p[i + 1] - mean[1], p[i + 2] - mean[2]];
      us.push(dot(q, u));
      vs.push(dot(q, v));
      zs.push(dot(q, normal));
    }
  }
  const range = (values, lo, hi) => {
    const sorted = Float32Array.from(values).sort();
    return [sorted[Math.floor(lo * (sorted.length - 1))], sorted[Math.ceil(hi * (sorted.length - 1))]];
  };
  const [u0, u1] = range(us, 0.01, 0.99);
  const [v0, v1] = range(vs, 0.01, 0.99);
  const [z0, z1] = range(zs, 0, 1);
  const pad = 0.03 * Math.max(u1 - u0, v1 - v0);
  return {
    tris,
    origin: mean,
    u,
    v,
    normal,
    rect: [u0 - pad, v0 - pad, u1 + pad, v1 + pad],
    depth: [z0, z1],
    width: u1 - u0 + 2 * pad,
    height: v1 - v0 + 2 * pad,
  };
}

/** Source cards with the baked cards' bent normals and canopy occlusion colors. */
function sourceCardsPart(part, canopy) {
  const { positions: p } = part;
  const normals = new Float32Array(part.normals.length);
  const colors = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const radial = normalize([p[i] - canopy.center[0], (p[i + 1] - canopy.center[1]) * 0.6, p[i + 2] - canopy.center[2]]);
    const n = [part.normals[i], part.normals[i + 1], part.normals[i + 2]];
    normals.set(normalize([0, 1, 2].map((d) => radial[d] * 0.75 + n[d] * 0.25 + (d === 1 ? 0.25 : 0))), i);
    colors.fill(canopyOcclusion(canopy, p[i], p[i + 1], p[i + 2]), i, i + 3);
  }
  return { ...part, normals, colors };
}

function cardsPart(clusters, canopy, material) {
  const count = clusters.length;
  const positions = new Float32Array(count * 12);
  const normals = new Float32Array(count * 12);
  const uv0 = new Float32Array(count * 8);
  const colors = new Float32Array(count * 12);
  const indices = new Uint32Array(count * 6);
  clusters.forEach((c, i) => {
    const [u0, v0, u1, v1] = c.rect;
    const corners = [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ];
    corners.forEach(([cu, cv], k) => {
      const p = [0, 1, 2].map((d) => c.origin[d] + c.u[d] * cu + c.v[d] * cv);
      positions.set(p, (i * 4 + k) * 3);
      // Normals bend toward the canopy's outward direction so the crown shades as a volume, not as flat cards.
      const radial = normalize([p[0] - canopy.center[0], (p[1] - canopy.center[1]) * 0.6, p[2] - canopy.center[2]]);
      normals.set(normalize([0, 1, 2].map((d) => radial[d] * 0.75 + c.normal[d] * 0.25 + (d === 1 ? 0.25 : 0))), (i * 4 + k) * 3);
      const ao = canopyOcclusion(canopy, p[0], p[1], p[2]);
      colors.set([ao, ao, ao], (i * 4 + k) * 3);
      const [x0, y0, x1, y1] = c.atlasRect;
      // Tile row 0 is the top of the card (largest v).
      uv0.set([x0 + (x1 - x0) * ((cu - u0) / (u1 - u0)), y0 + (y1 - y0) * (1 - (cv - v0) / (v1 - v0))], (i * 4 + k) * 2);
    });
    indices.set([0, 1, 2, 0, 2, 3].map((o) => i * 4 + o), i * 6);
  });
  return { material, positions, normals, uv0, uv1: null, colors, indices };
}

// ---------------------------------------------------------------------------------------------
// Impostor

function impostorViews(parts, canopy) {
  const { min, max } = bounds(parts);
  let radius = 0;
  for (const { positions: p } of parts) for (let i = 0; i < p.length; i += 3) radius = Math.max(radius, Math.hypot(p[i], p[i + 2]));
  return [0, 60, 120].map((deg) => {
    const a = (deg * Math.PI) / 180;
    const normal = [Math.sin(a), 0, Math.cos(a)];
    const u = [Math.cos(a), 0, -Math.sin(a)];
    return {
      origin: [0, 0, 0],
      u,
      v: [0, 1, 0],
      normal,
      rect: [-radius, min[1], radius, max[1]],
      depth: [-radius, radius],
      width: 2 * radius,
      height: max[1] - min[1],
      canopy,
    };
  });
}

function impostorPart(views, material) {
  const cards = cardsPart(views, views[0].canopy, material);
  // Impostor quads light as a sky-facing volume; skip the crown AO gradient that per-card colors carry.
  for (let i = 0; i < cards.normals.length; i += 3) cards.normals.set(normalize([cards.normals[i] * 0.4, 1, cards.normals[i + 2] * 0.4]), i);
  cards.colors.fill(1);
  return cards;
}

// ---------------------------------------------------------------------------------------------
// Baking

function renderSoup(card, soup, samplers, canopy, occludeByCanopy) {
  const tris = card.tris;
  const count = tris ? tris.length : soup.area.length;
  const index = tris ? (i) => tris[i] : (i) => i;
  return renderTris(card, count, (i) => soup.parts[soup.part[index(i)]], (i) => soup.local[index(i)], samplers, canopy, occludeByCanopy);
}

/**
 * Orthographic render of triangles onto a card plane (looking along -normal) into a supersampled RGBA tile.
 * Keeps the texel nearest to the viewer; shades by depth inside the card and by canopy occlusion.
 */
function renderTris(card, count, partOf, localOf, samplers, canopy, occludeByCanopy) {
  const { pixelWidth: W, pixelHeight: H } = card.tile;
  const SW = W * SUPERSAMPLE;
  const SH = H * SUPERSAMPLE;
  const color = new Float32Array(SW * SH * 3);
  const alpha = new Uint8Array(SW * SH);
  const depth = new Float32Array(SW * SH).fill(-Infinity);
  const [u0, v0, u1, v1] = card.rect;
  const sxScale = SW / (u1 - u0);
  const syScale = SH / (v1 - v0);
  const [z0, z1] = card.depth;
  const texel = new Float32Array(4);
  const sx = new Float32Array(3);
  const sy = new Float32Array(3);
  const sz = new Float32Array(3);
  const tu = new Float32Array(3);
  const tv = new Float32Array(3);
  const world = new Float32Array(9);

  for (let i = 0; i < count; i++) {
    const part = partOf(i);
    const sampler = samplers.get(part.material);
    const uv = sampler.texCoord === 1 ? part.uv1 : part.uv0;
    const base = localOf(i) * 3;
    for (let k = 0; k < 3; k++) {
      const vi = part.indices[base + k];
      const p = part.positions;
      const q = [p[vi * 3] - card.origin[0], p[vi * 3 + 1] - card.origin[1], p[vi * 3 + 2] - card.origin[2]];
      world.set([p[vi * 3], p[vi * 3 + 1], p[vi * 3 + 2]], k * 3);
      sx[k] = (dot(q, card.u) - u0) * sxScale;
      sy[k] = (v1 - dot(q, card.v)) * syScale;
      sz[k] = dot(q, card.normal);
      tu[k] = uv ? uv[vi * 2] : 0;
      tv[k] = uv ? uv[vi * 2 + 1] : 0;
    }
    const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
    const minX = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2])));
    const maxX = Math.min(SW - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
    const minY = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2])));
    const maxY = Math.min(SH - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
    if (minX > maxX || minY > maxY) continue;
    const tiny = Math.abs(area) < 1;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        let b0;
        let b1;
        let b2;
        if (tiny) {
          // Sub-pixel triangles (needles) still cover the pixel under their centroid.
          const cx = (sx[0] + sx[1] + sx[2]) / 3;
          const cy = (sy[0] + sy[1] + sy[2]) / 3;
          if (Math.floor(cx) !== x || Math.floor(cy) !== y) continue;
          b0 = b1 = b2 = 1 / 3;
        } else {
          const px = x + 0.5;
          const py = y + 0.5;
          b0 = ((sx[1] - px) * (sy[2] - py) - (sx[2] - px) * (sy[1] - py)) / area;
          b1 = ((sx[2] - px) * (sy[0] - py) - (sx[0] - px) * (sy[2] - py)) / area;
          b2 = 1 - b0 - b1;
          if (b0 < 0 || b1 < 0 || b2 < 0) continue;
        }
        const z = b0 * sz[0] + b1 * sz[1] + b2 * sz[2];
        const o = y * SW + x;
        if (z <= depth[o]) continue;
        sampler.sample(b0 * tu[0] + b1 * tu[1] + b2 * tu[2], b0 * tv[0] + b1 * tv[1] + b2 * tv[2], texel);
        if (texel[3] < ALPHA_CUTOFF) continue;
        const front = (z - z0) / Math.max(1e-3, z1 - z0);
        let shade = 0.7 + 0.3 * Math.min(1, Math.max(0, front));
        if (occludeByCanopy) {
          const wx = b0 * world[0] + b1 * world[3] + b2 * world[6];
          const wy = b0 * world[1] + b1 * world[4] + b2 * world[7];
          const wz = b0 * world[2] + b1 * world[5] + b2 * world[8];
          shade *= canopyOcclusion(canopy, wx, wy, wz);
        }
        depth[o] = z;
        alpha[o] = 1;
        color[o * 3] = texel[0] * shade;
        color[o * 3 + 1] = texel[1] * shade;
        color[o * 3 + 2] = texel[2] * shade;
      }
    }
  }
  return { color, alpha };
}

/** Packs tiles (shelves, per-kind density found by bisection), renders them and returns the atlas PNG. */
async function bakeAtlas(tiles, size) {
  const kinds = Object.keys(ATLAS_SHARE);
  const densities = {};
  // Shares of the kinds present, renormalized (a model whose LOD0 keeps its source cards has no cards0 tiles).
  const present = kinds.filter((kind) => tiles.some((t) => t.kind === kind));
  const shareSum = present.reduce((a, kind) => a + ATLAS_SHARE[kind], 0);
  for (const kind of kinds) {
    const area = tiles.filter((t) => t.kind === kind).reduce((a, t) => a + t.width * t.height, 0);
    densities[kind] = area > 0 ? Math.sqrt(((ATLAS_SHARE[kind] / shareSum) * size * size * 0.8) / area) : 0;
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const t of tiles) {
      const d = densities[t.kind];
      t.pixelWidth = Math.max(4, Math.min(size / 2, Math.round(t.width * d)));
      t.pixelHeight = Math.max(4, Math.min(size / 2, Math.round(t.height * d)));
    }
    if (pack(tiles, size)) break;
    for (const kind of kinds) densities[kind] *= 0.95;
    if (attempt === 29) throw new Error("atlas packing failed");
  }
  console.log(`  atlas ${size}px: ${tiles.length} tiles, texels/m ${kinds.map((k) => `${k} ${densities[k].toFixed(0)}`).join(", ")}`);

  const rgba = new Uint8Array(size * size * 4);
  const filled = new Uint8Array(size * size);
  let done = 0;
  for (const tile of tiles) {
    tile.owner.tile = tile;
    const { color, alpha } = tile.render();
    const S = SUPERSAMPLE;
    for (let y = 0; y < tile.pixelHeight; y++) {
      for (let x = 0; x < tile.pixelWidth; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let covered = 0;
        for (let dy = 0; dy < S; dy++) {
          for (let dx = 0; dx < S; dx++) {
            const o = (y * S + dy) * tile.pixelWidth * S + (x * S + dx);
            if (!alpha[o]) continue;
            r += color[o * 3];
            g += color[o * 3 + 1];
            b += color[o * 3 + 2];
            covered++;
          }
        }
        const o = (tile.y + y) * size + tile.x + x;
        if (covered === 0) continue;
        rgba.set([linearToSrgb8(r / covered), linearToSrgb8(g / covered), linearToSrgb8(b / covered), Math.round((255 * covered) / (S * S))], o * 4);
        filled[o] = 1;
      }
    }
    tile.owner.atlasRect = [tile.x / size, tile.y / size, (tile.x + tile.pixelWidth) / size, (tile.y + tile.pixelHeight) / size];
    if (++done % 100 === 0) console.log(`  baked ${done}/${tiles.length} tiles`);
  }
  dilate(rgba, filled, size);
  return new Uint8Array(await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
}

/** Shelf packing with a 2 px gutter; sets tile.x/y. */
function pack(tiles, size) {
  const order = [...tiles].sort((a, b) => b.pixelHeight - a.pixelHeight);
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const t of order) {
    if (x + t.pixelWidth + 2 > size) {
      x = 0;
      y += shelf + 2;
      shelf = 0;
    }
    if (y + t.pixelHeight + 2 > size) return false;
    t.x = x + 1;
    t.y = y + 1;
    x += t.pixelWidth + 2;
    shelf = Math.max(shelf, t.pixelHeight);
  }
  return true;
}

/** Bleeds edge colors into transparent texels so mip levels don't darken cutout borders. */
function dilate(rgba, filled, size) {
  for (let pass = 0; pass < 8; pass++) {
    const next = filled.slice();
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = y * size + x;
        if (filled[o]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size || !filled[ny * size + nx]) continue;
          const q = (ny * size + nx) * 4;
          r += rgba[q];
          g += rgba[q + 1];
          b += rgba[q + 2];
          n++;
        }
        if (n === 0) continue;
        rgba.set([r / n, g / n, b / n, 0], o * 4);
        next[o] = 1;
      }
    }
    filled.set(next);
  }
}

// ---------------------------------------------------------------------------------------------
// Math

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Jacobi eigen decomposition of a symmetric 3×3 matrix; eigenvectors sorted by descending eigenvalue. */
function symmetricEigen(m) {
  const a = [
    [m[0], m[1], m[2]],
    [m[3], m[4], m[5]],
    [m[6], m[7], m[8]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-12) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p];
        const akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k];
        const aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p];
        const vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const pairs = [0, 1, 2].map((i) => ({ value: a[i][i], vector: [v[0][i], v[1][i], v[2][i]] })).sort((x, y) => y.value - x.value);
  return { values: pairs.map((p) => p.value), vectors: pairs.map((p) => p.vector) };
}

/** Debug: side views of each level (as the runtime would texture them) composed into one PNG. */
export async function writePreview(levels, file, heightPx = 600) {
  const samplers = new Map();
  const images = [];
  for (const parts of levels) {
    for (const part of parts) if (!samplers.has(part.material)) samplers.set(part.material, await createSampler(part.material));
    const canopy = canopyShape(parts);
    const [view] = impostorViews(parts, canopy).slice(1);
    const scale = heightPx / view.height;
    view.tile = { pixelWidth: Math.max(8, Math.round(view.width * scale)), pixelHeight: heightPx };
    const { color, alpha } = renderSoup(view, triangleSoup(parts), samplers, canopy, false);
    const W = view.tile.pixelWidth * SUPERSAMPLE;
    const rgb = Buffer.alloc((color.length / 3) * 3);
    for (let i = 0; i < alpha.length; i++) {
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = alpha[i] ? linearToSrgb8(Math.min(1, color[i * 3 + c] * 1.6)) : [150, 170, 190][c];
    }
    images.push({ input: await sharp(rgb, { raw: { width: W, height: heightPx * SUPERSAMPLE, channels: 3 } }).resize(Math.round(W / SUPERSAMPLE), heightPx).png().toBuffer(), width: Math.round(W / SUPERSAMPLE) });
  }
  let x = 0;
  const composites = images.map(({ input, width }) => ({ input, left: (x += width + 10) - width - 10, top: 0 }));
  await sharp({ create: { width: x, height: heightPx, channels: 3, background: "#96aabe" } }).composite(composites).png().toFile(file);
}
