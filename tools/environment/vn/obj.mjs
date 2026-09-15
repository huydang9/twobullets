#!/usr/bin/env node
// OBJ + TGA/JPG packs (OpenGameArt Yughues/Nobiax, ambientCG scans) → one GLB per pack in assets-src, which vn/build.mjs then reads as an
// external model (`files`). Each OBJ becomes a root node; OBJ groups map to materials by the pack's `materials` rules.
// Materials are metal-rough (metallic 0, constant roughness): the packs' specular maps are dropped. With `splitOpaque`,
// connected components whose texels are all opaque (a palm trunk sharing the frond atlas; `splitOpaque: "triangles"` tests
// each triangle instead, for trunks welded to their fronds) move to `<material>_trunk`,
// so the foliage baker can keep them as geometry.
// Usage: node tools/environment/vn/obj.mjs [--only=pack,pack]
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Document } from "@gltf-transform/core";
import { createIO } from "../../assets/lib/gltf.ts";
import { SRC_DIR } from "../config.mjs";

setTimeout(() => {
  console.error("aborted after 600 s");
  process.exit(2);
}, 600_000).unref();

const OGA = "vn/oga";

/**
 * `objects`: [node name, OBJ file]. `materials`: [{ name, groups? (RegExp on the OBJ group; default all), diffuse, normal?,
 * alpha: "mask" | "opaque", roughness, splitOpaque? }], first match wins. `scale` converts the pack's units (cm) to m.
 */
export const OBJ_PACKS = [
  {
    id: "palm-treez-v3",
    scale: 0.01,
    objects: [["palm_straight", "palm_straight.obj"], ["palm_bend", "palm_bend.obj"], ["palm_dual", "palm_dual.obj"], ["palm_trio", "palm_trio.obj"]],
    materials: [{ name: "palm", diffuse: "diffuse.tga", normal: "normal.tga", alpha: "mask", roughness: 0.8, splitOpaque: "triangles" }],
  },
  {
    id: "bamboo-v1",
    scale: 0.01,
    objects: [["bamboo", "Bamboo 01.obj"]],
    materials: [{ name: "bamboo", diffuse: "diffuse.tga", normal: "normal.tga", alpha: "mask", roughness: 0.75 }],
  },
  {
    id: "palm-plant",
    scale: 0.01,
    // The LOD0 front and backface card sets plus the stems.
    objects: [["palm_plant", "REDUX/PalmPlant_Single.obj"]],
    materials: [{ name: "palm_plant", diffuse: "REDUX/PalmPlant_Diffuse.tga", normal: "REDUX/PalmPlant_Normal.tga", alpha: "mask", roughness: 0.7 }],
  },
  {
    id: "tropical-plant-02",
    scale: 0.01,
    objects: [["tropical_plant", "tropical_plant.obj"]],
    materials: [{ name: "tropical_plant", diffuse: "diffuse.tga", normal: "normal.tga", alpha: "mask", roughness: 0.65 }],
  },
  ...[1, 2, 3, 4, 5].map((n) => ({
    id: `tropical-shrub-0${n}`,
    dir: "tropical-shrubs",
    scale: 0.01,
    objects: [[`trop_shrub_0${n}`, `0${n}/trop_shrub_0${n}.obj`]],
    materials: [{ name: `trop_shrub_0${n}`, diffuse: `0${n}/diffuse.tga`, normal: `0${n}/normal.tga`, alpha: "mask", roughness: 0.7 }],
  })),
  // ambientCG photoscans (CC0), OBJ + JPG, already in meters.
  {
    id: "mango",
    root: "vn/ambientcg/3DMango001",
    scale: 1,
    objects: [["mango", "3DMango001_LQ-1K-JPG.obj"]],
    materials: [{ name: "mango", diffuse: "3DMango001_LQ-1K-JPG_Color.jpg", normal: "3DMango001_LQ-1K-JPG_NormalGL.jpg", alpha: "opaque", roughness: 0.55 }],
  },
  {
    id: "bread_roll",
    root: "vn/ambientcg/3DBread011",
    scale: 1,
    objects: [["bread_roll", "3DBread011_LQ-1K-JPG.obj"]],
    materials: [{ name: "bread_roll", diffuse: "3DBread011_LQ-1K-JPG_Color.jpg", normal: "3DBread011_LQ-1K-JPG_NormalGL.jpg", alpha: "opaque", roughness: 0.8 }],
  },
  {
    id: "houseplants",
    scale: 0.01,
    objects: [["square_palm", "square_palm.obj"], ["cylinder_bamboo", "cylinder_bamboo.obj"], ["square_shrub", "square_shrub.obj"], ["sphere_palm", "sphere_palm.obj"]],
    materials: [
      { name: "planter_cover", groups: /^Cover/, diffuse: "cover.tga", normal: "cover_normal.tga", alpha: "opaque", roughness: 0.95 },
      { name: "planter", groups: /^(Square|Cylinder|Sphere|Triangle|Cross)$/, diffuse: "pot.tga", alpha: "opaque", roughness: 0.85 },
      { name: "houseplant_palm", groups: /^Palm$/, diffuse: "palm.tga", normal: "palm_normal.tga", alpha: "mask", roughness: 0.7 },
      { name: "houseplant_bamboo", groups: /^Bamboo$/, diffuse: "bamboo.tga", normal: "bamboo_normal.tga", alpha: "mask", roughness: 0.7 },
      { name: "houseplant_shrub", groups: /^Shrub$/, diffuse: "shrub.tga", normal: "shrub_normal.tga", alpha: "mask", roughness: 0.7 },
    ],
  },
];

/** Uncompressed or RLE true-color TGA (24/32 bit) → { width, height, data: RGBA top-down }. */
export function decodeTga(buf) {
  const idLength = buf[0];
  const type = buf[2];
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const bpp = buf[16];
  const topDown = (buf[17] & 0x20) !== 0;
  if (![2, 10].includes(type) || ![24, 32].includes(bpp)) throw new Error(`unsupported TGA type ${type} / ${bpp} bpp`);
  const px = bpp / 8;
  const out = Buffer.alloc(width * height * 4);
  let src = 18 + idLength + (buf[1] ? buf.readUInt16LE(5) * Math.ceil(buf[7] / 8) : 0);
  let i = 0;
  const put = (o) => {
    const row = Math.floor(i / width);
    const y = topDown ? row : height - 1 - row;
    const d = (y * width + (i % width)) * 4;
    out[d] = buf[o + 2];
    out[d + 1] = buf[o + 1];
    out[d + 2] = buf[o];
    out[d + 3] = px === 4 ? buf[o + 3] : 255;
    i++;
  };
  while (i < width * height) {
    if (type === 2) {
      put(src);
      src += px;
    } else {
      const header = buf[src++];
      const count = (header & 0x7f) + 1;
      if (header & 0x80) {
        for (let k = 0; k < count; k++) put(src);
        src += px;
      } else {
        for (let k = 0; k < count; k++, src += px) put(src);
      }
    }
  }
  return { width, height, data: out };
}

/** Triangulated OBJ: per-group flat vertex lists (position, normal, uv), no index sharing across groups. */
function parseObj(text, scale) {
  const v = [];
  const vt = [];
  const vn = [];
  const groups = new Map();
  let current = null;
  const group = (name) => {
    if (!groups.has(name)) groups.set(name, { positions: [], normals: [], uvs: [] });
    return groups.get(name);
  };
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "v") v.push([+p[1] * scale, +p[2] * scale, +p[3] * scale]);
    else if (p[0] === "vt") vt.push([+p[1], +p[2]]);
    else if (p[0] === "vn") vn.push([+p[1], +p[2], +p[3]]);
    else if (p[0] === "g" || p[0] === "o") current = group(p.slice(1).join(" ") || "default");
    else if (p[0] === "f") {
      current ??= group("default");
      const corners = p.slice(1).map((c) => c.split("/").map((s) => (s === "" ? undefined : Number(s))));
      const at = (list, index) => (index === undefined ? undefined : list[index < 0 ? list.length + index : index - 1]);
      for (let k = 1; k + 1 < corners.length; k++) {
        for (const [pi, ti, ni] of [corners[0], corners[k], corners[k + 1]]) {
          current.positions.push(...at(v, pi));
          current.uvs.push(...(at(vt, ti) ?? [0, 0]));
          current.normals.push(...(at(vn, ni) ?? [0, 1, 0]));
        }
      }
    }
  }
  return groups;
}

/** Splits a triangle list into the triangles of fully opaque connected components and the rest. */
function splitOpaque(g, texture, perTriangle) {
  const count = g.positions.length / 9;
  const key = (i) => g.positions.slice(i * 3, i * 3 + 3).map((x) => x.toFixed(4)).join(",");
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const owner = new Map();
  for (let t = 0; t < count && !perTriangle; t++) {
    for (let c = 0; c < 3; c++) {
      const k = key(t * 3 + c);
      if (owner.has(k)) parent[find(t)] = find(owner.get(k));
      else owner.set(k, t);
    }
  }
  const alphaAt = (u, w) => {
    const x = Math.min(texture.width - 1, Math.max(0, Math.floor((((u % 1) + 1) % 1) * texture.width)));
    const y = Math.min(texture.height - 1, Math.max(0, Math.floor((1 - (((w % 1) + 1) % 1)) * texture.height)));
    return texture.data[(y * texture.width + x) * 4 + 3];
  };
  const transparent = new Set();
  for (let t = 0; t < count; t++) {
    const uv = g.uvs.slice(t * 6, t * 6 + 6);
    const samples = [[uv[0], uv[1]], [uv[2], uv[3]], [uv[4], uv[5]], [(uv[0] + uv[2] + uv[4]) / 3, (uv[1] + uv[3] + uv[5]) / 3]];
    if (samples.some(([u, w]) => alphaAt(u, w) < 200)) transparent.add(find(t));
  }
  const pick = (opaque) => {
    const out = { positions: [], normals: [], uvs: [] };
    for (let t = 0; t < count; t++) {
      if (transparent.has(find(t)) === opaque) continue;
      out.positions.push(...g.positions.slice(t * 9, t * 9 + 9));
      out.normals.push(...g.normals.slice(t * 9, t * 9 + 9));
      out.uvs.push(...g.uvs.slice(t * 6, t * 6 + 6));
    }
    return out;
  };
  return { opaque: pick(true), rest: pick(false) };
}

async function convertPack(io, pack) {
  const dir = path.join(SRC_DIR, pack.root ?? path.join(OGA, pack.dir ?? pack.id));
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(pack.id);
  const decoded = new Map();
  const tga = async (file) => {
    if (!decoded.has(file)) {
      const bytes = await readFile(path.join(dir, file));
      if (file.toLowerCase().endsWith(".tga")) decoded.set(file, decodeTga(bytes));
      else {
        const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        decoded.set(file, { width: info.width, height: info.height, data });
      }
    }
    return decoded.get(file);
  };
  const png = async (file) => {
    const { width, height, data } = await tga(file);
    return new Uint8Array(await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer());
  };
  const materials = new Map();
  const materialFor = async (spec, suffix = "") => {
    const name = spec.name + suffix;
    if (!materials.has(name)) {
      const opaque = spec.alpha === "opaque" || suffix === "_trunk";
      const m = doc.createMaterial(name).setMetallicFactor(0).setRoughnessFactor(spec.roughness).setAlphaMode(opaque ? "OPAQUE" : "MASK").setAlphaCutoff(0.5);
      const color = doc.createTexture(`${spec.name}_color`);
      const shared = [...materials.values()].find((other) => other.getBaseColorTexture()?.getName() === `${spec.name}_color`);
      m.setBaseColorTexture(shared?.getBaseColorTexture() ?? color.setImage(await png(spec.diffuse)).setMimeType("image/png"));
      if (shared) color.dispose();
      if (spec.normal) m.setNormalTexture(shared?.getNormalTexture() ?? doc.createTexture(`${spec.name}_normal`).setImage(await png(spec.normal)).setMimeType("image/png"));
      materials.set(name, m);
    }
    return materials.get(name);
  };
  const primitive = (g, material) => {
    const accessor = (array, type) => doc.createAccessor().setType(type).setArray(new Float32Array(array)).setBuffer(buffer);
    return doc
      .createPrimitive()
      .setAttribute("POSITION", accessor(g.positions, "VEC3"))
      .setAttribute("NORMAL", accessor(g.normals, "VEC3"))
      .setAttribute("TEXCOORD_0", accessor(g.uvs.map((x, i) => (i % 2 ? 1 - x : x)), "VEC2"))
      .setMaterial(material);
  };
  for (const [nodeName, file] of pack.objects) {
    const groups = parseObj(await readFile(path.join(dir, file), "utf8"), pack.scale);
    const mesh = doc.createMesh(nodeName);
    for (const [groupName, g] of groups) {
      if (g.positions.length === 0) continue;
      const spec = pack.materials.find((m) => !m.groups || m.groups.test(groupName));
      if (!spec) throw new Error(`${pack.id}/${file}: no material for group ${groupName}`);
      if (spec.splitOpaque) {
        const { opaque, rest } = splitOpaque(g, await tga(spec.diffuse), spec.splitOpaque === "triangles");
        if (opaque.positions.length) mesh.addPrimitive(primitive(opaque, await materialFor(spec, "_trunk")));
        if (rest.positions.length) mesh.addPrimitive(primitive(rest, await materialFor(spec)));
        console.log(`  ${nodeName}: ${opaque.positions.length / 9} trunk / ${rest.positions.length / 9} card tris`);
      } else {
        mesh.addPrimitive(primitive(g, await materialFor(spec)));
      }
    }
    scene.addChild(doc.createNode(nodeName).setMesh(mesh));
  }
  const out = path.join(dir, `${pack.id}.glb`);
  await writeFile(out, await io.writeBinary(doc));
  console.log(`${pack.id} -> ${path.relative(SRC_DIR, out)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const io = await createIO();
  for (const pack of OBJ_PACKS) if (!only || only.includes(pack.id)) await convertPack(io, pack);
}
