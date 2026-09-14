#!/usr/bin/env node
// Throwable VFX textures: CC0 flipbooks and sprites from assets-src/ → premultiplied-alpha KTX2 (UASTC + zstd) in
// apps/client/public/assets/vfx/, plus the generated client manifest and credits.json.
//
// Usage: node tools/vfx/build.mjs [--only=explosion,smokeCloud] [--preview]
//   --preview  also decodes every KTX2 with the hosted Babylon transcoder (as the browser would) and writes PNG
//              contact sheets to assets-src/vfx/preview/ for a visual check.
//
// Conventions (see docs/fx-throwables.md):
// - Sheets are POT canvases. Cells are whole pixels starting at the top-left, so cell edges land on texel edges;
//   leftover space on the right/bottom is transparent. The manifest gives the cell size in UV.
// - RGB is premultiplied by alpha in byte space and stored with a linear transfer function, so the runtime samples the
//   exact display-space values (the FX shaders write after tone mapping) and mips filter without dark fringes.
// - Frame 0 is the top-left cell, frames run left to right then top to bottom; V = 0 is the top row of the image.
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import sharp from "sharp";

setTimeout(() => {
  console.error("aborted after 600 s");
  process.exit(2);
}, 600_000).unref();

const REPO = new URL("../../", import.meta.url).pathname;
const SRC = join(REPO, "assets-src");
const UNITY = join(SRC, "vfx/unity-labs");
const KENNEY = join(SRC, "vfx/kenney-particle-pack/PNG (Transparent)");
const BURNED = join(SRC, "environment/burned_ground_01");
const OUT = join(REPO, "apps/client/public/assets/vfx");
const MANIFEST_TS = join(REPO, "apps/client/src/equipment/presentation/vfxManifest.ts");
const PREVIEW = join(SRC, "vfx/preview");

const { values: args } = parseArgs({ options: { only: { type: "string" }, preview: { type: "boolean", default: false } } });
const only = args.only ? new Set(args.only.split(",")) : null;

// --- Image helpers (RGBA8 raw buffers, straight alpha until `premultiply`) ------------------------------------------

/** Uncompressed 32-bit TGA → straight RGBA, rows top to bottom. */
async function readTga(path) {
  const b = await readFile(path);
  const idLength = b[0];
  const width = b.readUInt16LE(12);
  const height = b.readUInt16LE(14);
  if (b[1] !== 0 || b[2] !== 2 || b[16] !== 32) throw new Error(`${path}: only uncompressed 32-bit TGA is supported`);
  const topDown = (b[17] & 0x20) !== 0;
  const data = Buffer.alloc(width * height * 4);
  let p = 18 + idLength;
  for (let y = 0; y < height; y++) {
    const row = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x++, p += 4) {
      const o = (row * width + x) * 4;
      data[o] = b[p + 2];
      data[o + 1] = b[p + 1];
      data[o + 2] = b[p];
      data[o + 3] = b[p + 3];
    }
  }
  return { width, height, data };
}

async function readImage(path) {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function toSharp(image) {
  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } });
}

/** Lanczos resize (sharp premultiplies internally, so garbage RGB under zero alpha never bleeds in). */
async function resize(image, width, height) {
  const { data, info } = await toSharp(image).resize(width, height, { kernel: "lanczos3", fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function blank(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) };
}

function blit(target, source, left, top) {
  for (let y = 0; y < source.height; y++) {
    const ty = top + y;
    if (ty < 0 || ty >= target.height) continue;
    for (let x = 0; x < source.width; x++) {
      const tx = left + x;
      if (tx < 0 || tx >= target.width) continue;
      source.data.copy(target.data, (ty * target.width + tx) * 4, (y * source.width + x) * 4, (y * source.width + x) * 4 + 4);
    }
  }
}

function crop(image, left, top, width, height) {
  const out = blank(width, height);
  blit(out, { ...image, width: image.width, height: image.height }, -left, -top);
  return out;
}

function premultiply(image) {
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    d[i] = Math.round(d[i] * a);
    d[i + 1] = Math.round(d[i + 1] * a);
    d[i + 2] = Math.round(d[i + 2] * a);
  }
  return image;
}

async function rotate90(image) {
  const { data, info } = await toSharp(image).rotate(90).raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

async function blurAlpha(image, sigma) {
  const alpha = Buffer.alloc(image.width * image.height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = image.data[i * 4 + 3];
  return sharp(alpha, { raw: { width: image.width, height: image.height, channels: 1 } }).blur(sigma).extractChannel(0).raw().toBuffer();
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Bounding boxes of the largest opaque blobs (4-connected, alpha > threshold), biggest first. */
function blobs(image, threshold, count) {
  const { width, height, data } = image;
  const seen = new Int32Array(width * height);
  const found = [];
  let label = 0;
  const stack = [];
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || data[start * 4 + 3] <= threshold) continue;
    let area = 0;
    let x0 = width, y0 = height, x1 = 0, y1 = 0;
    label++;
    stack.push(start);
    seen[start] = label;
    while (stack.length) {
      const i = stack.pop();
      const x = i % width;
      const y = (i - x) / width;
      area++;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (const n of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
        if (n >= 0 && !seen[n] && data[n * 4 + 3] > threshold) {
          seen[n] = label;
          stack.push(n);
        }
      }
    }
    found.push({ area, x0, y0, x1, y1, label, labels: seen });
  }
  return found.sort((a, b) => b.area - a.area).slice(0, count);
}

/** Crops one blob (its pixels plus a 2 px soft rim, other blobs removed) and fits it, centred, into a cell. */
async function fitBlob(image, blob, cell, margin) {
  const pad = 3;
  const w = blob.x1 - blob.x0 + 1 + pad * 2;
  const h = blob.y1 - blob.y0 + 1 + pad * 2;
  const piece = crop(image, blob.x0 - pad, blob.y0 - pad, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) {
        for (let dx = -2; dx <= 2 && !near; dx++) {
          const sx = blob.x0 - pad + x + dx;
          const sy = blob.y0 - pad + y + dy;
          near = sx >= 0 && sy >= 0 && sx < image.width && sy < image.height && blob.labels[sy * image.width + sx] === blob.label;
        }
      }
      if (!near) piece.data[(y * w + x) * 4 + 3] = 0;
    }
  }
  const scale = (cell - margin * 2) / Math.max(w, h);
  const sized = await resize(piece, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)));
  const out = blank(cell, cell);
  blit(out, sized, Math.floor((cell - sized.width) / 2), Math.floor((cell - sized.height) / 2));
  return out;
}

async function fitCell(image, cell, margin = 0) {
  const sized = await resize(image, cell - margin * 2, cell - margin * 2);
  const out = blank(cell, cell);
  blit(out, sized, margin, margin);
  return out;
}

/** A W×H grid of equal cells resampled to whole pixels, placed top-left on a POT canvas. */
async function sheet(source, columns, rows, cellWidth, cellHeight, canvasWidth, canvasHeight) {
  const sized = await resize(source, columns * cellWidth, rows * cellHeight);
  const canvas = blank(canvasWidth, canvasHeight);
  blit(canvas, sized, 0, 0);
  return canvas;
}

// --- Textures -------------------------------------------------------------------------------------------------------

const BURNED_URL = "https://polyhaven.com/a/burned_ground_01";

/** Every output texture: how to build it and what the runtime needs to know. */
const TEXTURES = [
  {
    id: "explosion",
    file: "explosion.ktx2",
    note: "Fireball turning into dark smoke (Unity Labs Explosion01), 25 frames. Straight TGA resampled to 204 px cells.",
    grid: [5, 5], cell: [204, 204], size: [1024, 1024], frames: 25, fps: 18, loop: false,
    blend: "premultiplied", sources: ["unity-labs:Explosion01/Explosion01_5x5.tga"],
    build: async () => sheet(await readTga(join(UNITY, "Explosion01/Explosion01_5x5.tga")), 5, 5, 204, 204, 1024, 1024),
  },
  {
    id: "explosionDust",
    file: "explosion-dust.ktx2",
    note: "Same explosion without fire (Unity Labs Explosion01-nofire): dust ring and lingering blast dust, greyscale.",
    grid: [5, 5], cell: [102, 102], size: [512, 512], frames: 25, fps: 10, loop: false,
    blend: "premultiplied", sources: ["unity-labs:Explosion01-nofire/Explosion01-nofire_5x5.tga"],
    build: async () => sheet(await readTga(join(UNITY, "Explosion01-nofire/Explosion01-nofire_5x5.tga")), 5, 5, 102, 102, 512, 512),
  },
  {
    id: "smokeCloud",
    file: "smoke-cloud.ktx2",
    note: "Dense rolling puff loop (Unity Labs Cloud01), 64 frames, greyscale. Smoke grenade body.",
    grid: [8, 8], cell: [128, 128], size: [1024, 1024], frames: 64, fps: 6, loop: true,
    blend: "premultiplied", sources: ["unity-labs:Cloud01/Cloud01_8x8.tga"],
    build: async () => sheet(await readTga(join(UNITY, "Cloud01/Cloud01_8x8.tga")), 8, 8, 128, 128, 1024, 1024),
  },
  {
    id: "smokeWispy",
    file: "smoke-wispy.ktx2",
    note: "Thin wispy smoke loop (Unity Labs WispySmoke01), 64 frames, greyscale. Cloud rims, fire plume, flash puff.",
    grid: [8, 8], cell: [64, 64], size: [512, 512], frames: 64, fps: 8, loop: true,
    blend: "premultiplied", sources: ["unity-labs:WispySmoke01/WispySmoke01_8x8.tga"],
    build: async () => sheet(await readTga(join(UNITY, "WispySmoke01/WispySmoke01_8x8.tga")), 8, 8, 64, 64, 512, 512),
  },
  {
    id: "flame",
    file: "flame.ktx2",
    note: "Licking flame loop (Unity Labs Flame03), 64 frames, base at the bottom of each 64×128 cell.",
    grid: [16, 4], cell: [64, 128], size: [1024, 512], frames: 64, fps: 30, loop: true,
    blend: "premultiplied", sources: ["unity-labs:Flame03/Flame03_16x4.tga"],
    build: async () => sheet(await readTga(join(UNITY, "Flame03/Flame03_16x4.tga")), 16, 4, 64, 128, 1024, 512),
  },
  {
    id: "particles",
    file: "particles.ktx2",
    note: "Kenney Particle Pack sprites on a 4×4 atlas of 128 px cells: spark streak, debris, glow, flare, glass.",
    grid: [4, 4], cell: [128, 128], size: [512, 512], frames: 16, fps: 0, loop: false,
    blend: "premultiplied",
    cells: { trace: 0, dirtCluster: 1, chunk0: 2, chunk1: 3, chunk2: 4, chunk3: 5, glow: 6, flare: 7, star: 8, halo: 9, shard0: 10, shard1: 11, shard2: 12, shard3: 13 },
    sources: ["kenney:trace_01.png", "kenney:dirt_01.png", "kenney:dirt_02.png", "kenney:circle_05.png", "kenney:flare_01.png", "kenney:star_04.png", "kenney:light_01.png"],
    build: async () => {
      const C = 128;
      const canvas = blank(512, 512);
      const put = (cellIndex, image) => blit(canvas, image, (cellIndex % 4) * C, Math.floor(cellIndex / 4) * C);
      const kenney = (name) => readImage(join(KENNEY, name));
      // Streak along +U (the runtime stretches it from tail U = 0 to head U = 1).
      put(0, await fitCell(await rotate90(await kenney("trace_01.png")), C));
      const dirt = await kenney("dirt_01.png");
      put(1, await fitCell(dirt, C, 2));
      const chunks = blobs(dirt, 100, 4);
      for (let i = 0; i < chunks.length; i++) put(2 + i, await fitBlob(dirt, chunks[i], C, 10));
      put(6, await fitCell(await kenney("circle_05.png"), C));
      put(7, await fitCell(await kenney("flare_01.png"), C));
      put(8, await fitCell(await kenney("star_04.png"), C));
      put(9, await fitCell(await kenney("light_01.png"), C));
      const glass = await kenney("dirt_02.png");
      const shards = blobs(glass, 100, 4);
      for (let i = 0; i < shards.length; i++) put(10 + i, await fitBlob(glass, shards[i], C, 12));
      return canvas;
    },
  },
  {
    id: "scorch",
    file: "scorch.ktx2",
    note: "Ground decals: burned_ground_01 albedo (Poly Haven) masked by Kenney scorch_01 (frag blast mark) and scorch_03 (molotov burn), sRGB albedo values.",
    grid: [2, 1], cell: [512, 512], size: [1024, 512], frames: 2, fps: 0, loop: false,
    blend: "premultiplied",
    cells: { blast: 0, burn: 1 },
    sources: ["polyhaven:burned_ground_01_diff_2k.jpg", "polyhaven:burned_ground_01_arm_2k.jpg", "kenney:scorch_01.png", "kenney:scorch_03.png"],
    build: async () => {
      const C = 512;
      const ground = await readImage(join(BURNED, "burned_ground_01_diff_2k.jpg"));
      const arm = await readImage(join(BURNED, "burned_ground_01_arm_2k.jpg"));
      const canvas = blank(1024, 512);
      const make = async (maskName, left, top, shape) => {
        const albedo = await resize(crop(ground, left, top, 1024, 1024), C, C);
        const ao = await resize(crop(arm, left, top, 1024, 1024), C, C);
        const big = Math.round(C * shape.maskScale);
        const mask = crop(await resize(await readImage(join(KENNEY, maskName)), big, big), (big - C) >> 1, (big - C) >> 1, C, C);
        const soft = await blurAlpha(mask, shape.blur);
        const cell = blank(C, C);
        for (let y = 0; y < C; y++) {
          for (let x = 0; x < C; x++) {
            const i = y * C + x;
            const dx = (x + 0.5) / C - 0.5;
            const dy = (y + 0.5) / C - 0.5;
            const r = Math.sqrt(dx * dx + dy * dy) * 2;
            const lum = (albedo.data[i * 4] + albedo.data[i * 4 + 1] + albedo.data[i * 4 + 2]) / 765;
            const m = soft[i] / 255;
            // Mask spread out and broken up by the ground's own detail; always zero at the cell rim.
            const alpha = clamp01(m * shape.gain + (lum - 0.25) * shape.detail - shape.cut) * smoothstep(1, shape.edge, r);
            // Charred: straw and soil pulled toward grey ash/soot (more in the core), darker toward the centre, AO baked in.
            const burnt = shape.char * (1 - 0.6 * smoothstep(0.2, 0.95, r));
            const char = (shape.core + (1 - shape.core) * smoothstep(0, 0.7, r)) * (0.55 + 0.45 * (ao.data[i * 4] / 255));
            const grey = lum * 255 * 0.55;
            // Bright straw burns away: compress highlights where the mask is solid.
            const ember = 1 - 0.6 * smoothstep(0.25, 0.8, lum) * clamp01(alpha * 1.4) * shape.char;
            for (let c = 0; c < 3; c++) cell.data[i * 4 + c] = Math.round((albedo.data[i * 4 + c] + (grey - albedo.data[i * 4 + c]) * burnt) * char * ember);
            cell.data[i * 4 + 3] = Math.round(alpha * 255);
          }
        }
        return cell;
      };
      blit(canvas, await make("scorch_01.png", 0, 0, { maskScale: 1.7, blur: 5, gain: 1.8, detail: 0.7, cut: 0.05, edge: 0.7, core: 0.45, char: 0.85 }), 0, 0);
      blit(canvas, await make("scorch_03.png", 1024, 1024, { maskScale: 1.5, blur: 12, gain: 2.4, detail: 0.9, cut: 0.1, edge: 0.55, core: 0.6, char: 0.7 }), 512, 0);
      return canvas;
    },
  },
];

// --- Encode ---------------------------------------------------------------------------------------------------------

// One worker, one texture at a time (the basis encoder holds a large wasm heap); its stdout is discarded.
const encoder = new Worker(new URL("./encode-worker.mjs", import.meta.url), { stdout: true });
encoder.stdout.resume();

function encodeKtx2(image) {
  return new Promise((resolve, reject) => {
    encoder.once("message", (message) => (message.output ? resolve(message.output) : reject(new Error(message.error))));
    const data = new Uint8Array(image.data);
    encoder.postMessage({ data, width: image.width, height: image.height }, [data.buffer]);
  });
}

await mkdir(OUT, { recursive: true });
const built = [];
for (const texture of TEXTURES) {
  const path = join(OUT, texture.file);
  if (only && !only.has(texture.id)) {
    built.push({ texture, bytes: (await stat(path)).size, hash: hash(await readFile(path)), meanLuma: averageLuma(await texture.build()) });
    continue;
  }
  const started = performance.now();
  const straight = await texture.build();
  const meanLuma = averageLuma(straight);
  const image = premultiply(straight);
  if (image.width !== texture.size[0] || image.height !== texture.size[1]) throw new Error(`${texture.id}: built ${image.width}×${image.height}`);
  const data = await encodeKtx2(image);
  await writeFile(path, data);
  built.push({ texture, bytes: data.byteLength, hash: hash(data), meanLuma });
  console.log(`${texture.file.padEnd(20)} ${texture.size.join("×").padEnd(9)} ${(data.byteLength / 1024).toFixed(0).padStart(5)} KB  ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

/** Alpha-weighted mean display luma of the straight colors: the sheet's baked brightness, for normalizing tints. */
function averageLuma(image) {
  let sum = 0;
  let weight = 0;
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    sum += ((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255) * a;
    weight += a;
  }
  return weight > 0 ? sum / weight : 1;
}

function hash(bytes) {
  return createHash("sha1").update(bytes).digest("hex").slice(0, 10);
}

// --- Manifest and credits -------------------------------------------------------------------------------------------

const entries = built
  .map(({ texture: t, bytes, hash: h, meanLuma }) => {
    const fields = [
      `url: "${t.file}"`,
      `hash: "${h}"`,
      `bytes: ${bytes}`,
      `width: ${t.size[0]}`,
      `height: ${t.size[1]}`,
      `columns: ${t.grid[0]}`,
      `rows: ${t.grid[1]}`,
      `frames: ${t.frames}`,
      `cellU: ${(t.cell[0] / t.size[0]).toFixed(6)}`,
      `cellV: ${(t.cell[1] / t.size[1]).toFixed(6)}`,
      `fps: ${t.fps}`,
      `loop: ${t.loop}`,
      `blend: "${t.blend}"`,
      `meanLuma: ${meanLuma.toFixed(4)}`,
    ];
    const cells = t.cells ? `\n    cells: { ${Object.entries(t.cells).map(([k, v]) => `${k}: ${v}`).join(", ")} },` : "";
    return `  /** ${t.note} */\n  ${t.id}: {\n    ${fields.join(",\n    ")},${cells}\n  },`;
  })
  .join("\n");

await writeFile(
  MANIFEST_TS,
  `// Generated by tools/vfx/build.mjs. Do not edit by hand.

/** "premultiplied": RGB is premultiplied by alpha; draw with ONE, ONE_MINUS_SRC_ALPHA (additive when output alpha is 0). */
export type VfxBlend = "premultiplied";

export interface VfxSheet {
  /** Relative to VFX_ASSET_ROOT. */
  readonly url: string;
  readonly hash: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly columns: number;
  readonly rows: number;
  /** Frames (or atlas cells), left to right then top to bottom; V = 0 is the top row. */
  readonly frames: number;
  /** Cell size in UV (cells are whole pixels from the top-left; the rest of the POT canvas is empty). */
  readonly cellU: number;
  readonly cellV: number;
  /** Authored playback rate of the flipbook (0 for atlases). */
  readonly fps: number;
  readonly loop: boolean;
  readonly blend: VfxBlend;
  /** Alpha-weighted mean luma of the straight colors (0..1): divide a target display color by it to get a tint. */
  readonly meanLuma: number;
  readonly cells?: Readonly<Record<string, number>>;
}

export const VFX_ASSET_ROOT = \`\${import.meta.env?.BASE_URL ?? "/"}assets/vfx/\`;

export const VFX_SHEETS = {
${entries}
} as const satisfies Record<string, VfxSheet>;

export type VfxSheetId = keyof typeof VFX_SHEETS;
`,
);

const credits = {
  note: "All shipped VFX textures are CC0 (public domain). Attribution is not required but given here.",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  generated: new Date().toISOString().slice(0, 10),
  pipeline: "tools/vfx/build.mjs (premultiplied alpha, KTX2 UASTC + zstd)",
  sources: [
    {
      id: "unity-labs",
      title: "Free VFX Image Sequences & Flipbooks",
      authors: ["Thomas Iché (Unity Labs Paris)"],
      license: "CC0",
      url: "https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks",
      download: "https://unity3d.com/files/labs/downloads/vfx/assets01/<Name>/<Name>-flipbooks.zip",
      files: ["explosion ← Explosion01_5x5.tga", "explosion-dust ← Explosion01-nofire_5x5.tga", "smoke-cloud ← Cloud01_8x8.tga", "smoke-wispy ← WispySmoke01_8x8.tga", "flame ← Flame03_16x4.tga"],
    },
    {
      id: "kenney-particle-pack",
      title: "Particle Pack 1.1",
      authors: ["Kenney Vleugels (Kenney.nl)"],
      license: "CC0",
      url: "https://kenney.nl/assets/particle-pack",
      download: "https://kenney.nl/media/pages/assets/particle-pack/f8fe0f8cb8-1677578741/kenney_particle-pack.zip",
      files: ["particles ← trace_01, dirt_01, dirt_02, circle_05, flare_01, star_04, light_01", "scorch (masks) ← scorch_01, scorch_03"],
    },
    {
      id: "burned_ground_01",
      title: "Burned Ground 01",
      authors: [{ name: "Rob Tuytel", role: "All" }],
      license: "CC0",
      url: BURNED_URL,
      source: "Poly Haven (https://polyhaven.com)",
      files: [
        "scorch ← https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/burned_ground_01/burned_ground_01_diff_2k.jpg",
        "scorch (AO) ← https://dl.polyhaven.org/file/ph-assets/Textures/jpg/2k/burned_ground_01/burned_ground_01_arm_2k.jpg",
      ],
    },
  ],
  textures: Object.fromEntries(built.map(({ texture, bytes }) => [texture.file, { bytes, sources: texture.sources }])),
};
await writeFile(join(OUT, "credits.json"), JSON.stringify(credits, null, 2) + "\n");
await encoder.terminate();
console.log(`wrote ${built.length} textures, vfxManifest.ts and credits.json (${(built.reduce((s, b) => s + b.bytes, 0) / 1024).toFixed(0)} KB total)`);

// --- Preview: decode with the hosted Babylon transcoder -----------------------------------------------------------

if (args.preview) {
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { runInThisContext } = await import("node:vm");
  const dir = join(REPO, "apps/client/public/assets/decoders");
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) =>
    String(input).startsWith("file:") ? new Response(await readFile(new URL(String(input))), { headers: { "content-type": "application/wasm" } }) : nativeFetch(input, init);
  Object.assign(globalThis, { __dirname: dir, __filename: join(dir, "msc_basis_transcoder.js"), require: createRequire(import.meta.url) });
  runInThisContext(await readFile(join(dir, "babylon.ktx2Decoder.js"), "utf8"));
  runInThisContext(await readFile(join(dir, "msc_basis_transcoder.js"), "utf8"));
  const K = globalThis.KTX2DECODER;
  K.MSCTranscoder.UseFromWorkerThread = false;
  K.MSCTranscoder.JSModule = globalThis.MSC_TRANSCODER;
  K.MSCTranscoder.WasmBinary = (await readFile(join(dir, "msc_basis_transcoder.wasm"))).buffer;
  K.LiteTranscoder_UASTC_BC7.WasmModuleURL = pathToFileURL(join(dir, "uastc_bc7.wasm")).href;
  K.LiteTranscoder_UASTC_RGBA_UNORM.WasmModuleURL = pathToFileURL(join(dir, "uastc_rgba8_unorm_v2.wasm")).href;
  K.ZSTDDecoder.WasmModuleURL = pathToFileURL(join(dir, "zstddec.wasm")).href;
  const decoder = new K.KTX2Decoder();
  await mkdir(PREVIEW, { recursive: true });
  for (const { texture } of built) {
    const bytes = new Uint8Array(await readFile(join(OUT, texture.file)));
    const bc7 = await decoder.decode(bytes, { bptc: true }, {});
    if (bc7.mipmaps.length < 2 || bc7.isInGammaSpace) throw new Error(`${texture.id}: mips ${bc7.mipmaps.length}, gamma ${bc7.isInGammaSpace}`);
    const rgba = await decoder.decode(bytes, {}, {});
    const top = rgba.mipmaps[0];
    // Premultiplied over a mid grey, as the runtime blends it.
    const out = Buffer.alloc(top.width * top.height * 3);
    for (let i = 0; i < top.width * top.height; i++) {
      const a = top.data[i * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.min(255, Math.round(top.data[i * 4 + c] + 90 * (1 - a)));
    }
    await sharp(out, { raw: { width: top.width, height: top.height, channels: 3 } }).png().toFile(join(PREVIEW, `${texture.id}.png`));
    console.log(`preview ${texture.id}: ${bc7.mipmaps.length} mips, transcoder ${rgba.transcodedFormat ?? "rgba"}`);
  }
  globalThis.fetch = nativeFetch;
}
