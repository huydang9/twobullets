#!/usr/bin/env node
// Turns the raw Poly Haven downloads into web-ready environment assets and a generated TS manifest.
//
//   textures/<id>_<map>_<res>.jpg  albedo via sips (4:2:0), normal/ARM/NXA via ffmpeg (4:4:4, no chroma bleed)
//   sky/sky_{px,py,pz,nx,ny,nz}.jpg  LDR skybox faces cut from the 4K HDRI (GL cube convention)
//   sky/<hdri>_ibl_1k.hdr          sun-less, ground-filled panorama for runtime IBL prefiltering
//
// Requires macOS `sips` and `ffmpeg` on PATH. Usage: node tools/environment/process.mjs [--only=textures|sky]
// Props and vegetation are built separately by props.mjs; both regenerate the manifest from build.json.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HDRI, JPEG, OUT_DIR, SRC_DIR, TEXTURES } from "./config.mjs";
import { readBmp, readHdr, writeBmp, writeHdr } from "./imageio.mjs";
import { readBuildRecord, reportSizes, writeBuildRecord, writeManifest } from "./manifest.mjs";

setTimeout(() => {
  console.error("aborted after 600 s");
  process.exit(2);
}, 600_000).unref();

const run = promisify(execFile);
const TEX_OUT = path.join(OUT_DIR, "textures");
const SKY_OUT = path.join(OUT_DIR, "sky");
const DEG = Math.PI / 180;
/** Linear mean of desaturated albedo maps. */
const DESATURATED_MEAN = 0.35;

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const resLabel = (size) => (size >= 1024 ? `${size / 1024}k` : `${size}`);

async function main() {
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  const record = await readBuildRecord();
  const tmp = await mkdtemp(path.join(tmpdir(), "twobullets-env-"));
  try {
    if (!only || only === "textures") {
      // Start clean so renamed or dropped outputs don't linger in the committed folder.
      await rm(TEX_OUT, { recursive: true, force: true });
      await mkdir(TEX_OUT, { recursive: true });
      record.textures = await processTextures(tmp);
    }
    if (!only || only === "sky") {
      await rm(SKY_OUT, { recursive: true, force: true });
      await mkdir(SKY_OUT, { recursive: true });
      record.sky = await processHdri(tmp, record.textures.forrest_ground_01.meanAlbedo);
    }
    await writeBuildRecord(record);
    await writeManifest(record);
    await reportSizes();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Textures

/** Sequential on purpose: each 2K map is a 12 MB bitmap in memory. */
async function processTextures(tmp) {
  const sets = {};
  for (const { id, meters, sizes, macroOnly, desaturate } of TEXTURES) {
    const entry = { meters, files: {} };
    const resized = async (map, size) => {
      const bmp = path.join(tmp, `${id}_${map}_${size}.bmp`);
      await run("sips", ["-Z", String(size), "-s", "format", "bmp", path.join(SRC_DIR, id, `${id}_${map}_2k.jpg`), "--out", bmp]);
      return bmp;
    };
    for (const [map, size] of Object.entries(sizes)) {
      const name = `${id}_${map}_${resLabel(size)}.jpg`;
      const out = path.join(TEX_OUT, name);
      let bmp;
      if (map === "nxa") {
        const normal = readBmp(await readFile(await resized("nor_gl", size)));
        const arm = readBmp(await readFile(await resized("arm", size)));
        const packed = new Uint8Array(normal.rgb.length);
        let roughness = 0;
        for (let i = 0; i < packed.length; i += 3) {
          packed[i] = normal.rgb[i];
          packed[i + 1] = normal.rgb[i + 1];
          packed[i + 2] = arm.rgb[i];
          roughness += arm.rgb[i + 1];
        }
        entry.roughness = roughness / (packed.length / 3) / 255;
        bmp = path.join(tmp, `${id}_nxa.bmp`);
        await writeFile(bmp, writeBmp(normal.width, normal.height, packed));
      } else {
        bmp = await resized(map, size);
        if (map === "diff" && desaturate) {
          // Luminance normalized to a mid-grey mean, so paint tints stay near 1 and don't amplify noise.
          const image = readBmp(await readFile(bmp));
          const lut = Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
          const { rgb } = image;
          const lum = new Float32Array(rgb.length / 3);
          for (let i = 0; i < lum.length; i++) lum[i] = luminance(lut[rgb[i * 3]], lut[rgb[i * 3 + 1]], lut[rgb[i * 3 + 2]]);
          const scale = DESATURATED_MEAN / (lum.reduce((a, b) => a + b, 0) / lum.length);
          for (let i = 0; i < lum.length; i++) rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = Math.round(linearToSrgb(Math.min(1, lum[i] * scale)) * 255);
          await writeFile(bmp, writeBmp(image.width, image.height, rgb));
        }
      }
      if (map === "diff") {
        await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(JPEG.albedoQuality), bmp, "--out", out]);
      } else {
        await run("ffmpeg", ["-v", "error", "-y", "-i", bmp, "-pix_fmt", "yuvj444p", "-q:v", String(JPEG.dataQscale), out]);
      }
      entry.files[map] = `textures/${name}`;
      if (map === "diff") entry.meanAlbedo = channelStats(readBmp(await readFile(bmp)), true).mean;
      console.log(`${name.padEnd(44)} ${kb((await readFile(out)).length)}`);
      await rm(bmp, { force: true });
    }
    if (macroOnly) entry.macro = true;
    sets[id] = entry;
  }
  return sets;
}

/** Per-channel mean; albedo is averaged in linear space so shaders can normalize by it. */
function channelStats({ rgb }, isColor) {
  const sum = [0, 0, 0];
  const lut = Array.from({ length: 256 }, (_, i) => (isColor ? srgbToLinear(i / 255) : i / 255));
  for (let i = 0; i < rgb.length; i += 3) {
    sum[0] += lut[rgb[i]];
    sum[1] += lut[rgb[i + 1]];
    sum[2] += lut[rgb[i + 2]];
  }
  const n = rgb.length / 3;
  return { mean: sum.map((s) => s / n) };
}

// ---------------------------------------------------------------------------------------------
// HDRI
//
// Babylon's HDRCubeTexture maps a world direction d to panorama column (0.5 + atan2(dx, dz) / 2π)·W and
// row acos(dy) / π·H (row 0 = top). Both the IBL panorama and the sky faces use that mapping, so the sky,
// the IBL and the sun light line up by construction.

function directionOf(x, y, W, H) {
  const polar = ((y + 0.5) / H) * Math.PI;
  const azimuth = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
  return [Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth)];
}

function solidAngleOfRow(y, W, H) {
  return ((2 * Math.PI) / W) * (Math.PI / H) * Math.sin(((y + 0.5) / H) * Math.PI);
}

async function processHdri(tmp, groundAlbedo) {
  const srcFile = path.join(SRC_DIR, HDRI.id, `${HDRI.id}_${HDRI.resolution}.hdr`);
  const src = readHdr(await readFile(srcFile));
  const { width: W, height: H } = src;
  const px = (x, y) => (y * W + x) * 3;

  // Brightest pixel = sun. Rotate the panorama about Y (a column shift) to put it at the target azimuth.
  let peak = 0;
  let peakIndex = 0;
  for (let i = 0; i < W * H; i++) {
    const l = luminance(src.data[i * 3], src.data[i * 3 + 1], src.data[i * 3 + 2]);
    if (l > peak) [peak, peakIndex] = [l, i];
  }
  const peakX = peakIndex % W;
  const shift = Math.round((HDRI.sunAzimuthDeg / 360 + 0.5) * W - (peakX + 0.5));
  const rotated = new Float32Array(src.data.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const to = px((((x + shift) % W) + W) % W, y);
      const from = px(x, y);
      rotated[to] = src.data[from];
      rotated[to + 1] = src.data[from + 1];
      rotated[to + 2] = src.data[from + 2];
    }
  }
  const sunDir = directionOf((((peakX + shift) % W) + W) % W, Math.floor(peakIndex / W), W, H);

  // Sun cone: energy above the surrounding ring moves into the directional light.
  const SUN_RADIUS = 2.5 * DEG;
  const RING_OUTER = 3.5 * DEG;
  const ring = [[], [], []];
  const conePixels = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = directionOf(x, y, W, H);
      const angle = Math.acos(Math.min(1, d[0] * sunDir[0] + d[1] * sunDir[1] + d[2] * sunDir[2]));
      if (angle < SUN_RADIUS) conePixels.push([x, y, d]);
      else if (angle < RING_OUTER) for (let c = 0; c < 3; c++) ring[c].push(rotated[px(x, y) + c]);
    }
  }
  const ringColor = ring.map((values) => values.sort((a, b) => a - b)[values.length >> 1]);
  const sunIrradiance = [0, 0, 0];
  const sunCentroid = [0, 0, 0];
  const sunless = rotated.slice();
  for (const [x, y, d] of conePixels) {
    const dOmega = solidAngleOfRow(y, W, H);
    const i = px(x, y);
    let excess = 0;
    for (let c = 0; c < 3; c++) {
      const e = Math.max(0, rotated[i + c] - ringColor[c]) * dOmega;
      sunIrradiance[c] += e;
      excess += e;
      sunless[i + c] = Math.min(rotated[i + c], ringColor[c]);
    }
    for (let k = 0; k < 3; k++) sunCentroid[k] += d[k] * excess;
  }
  const sunDirection = normalize(sunCentroid);

  // Sky-only irradiance on a horizontal plane (upper hemisphere of the sun-less panorama).
  const skyIrradiance = [0, 0, 0];
  for (let y = 0; y < H / 2; y++) {
    const weight = solidAngleOfRow(y, W, H) * Math.cos(((y + 0.5) / H) * Math.PI);
    for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) skyIrradiance[c] += sunless[px(x, y) + c] * weight;
  }
  const sunY = sunDirection[1];
  const horizontal = (luminance(...sunIrradiance) * sunY + luminance(...skyIrradiance)) / Math.PI;
  const k = HDRI.horizontalRadianceTarget / horizontal;

  // Below the horizon the "pure sky" panorama is a hazy fill; replace it with lit ground for correct bounce light.
  const horizonColor = averageBand(rotated, W, H, 85, 90);
  const groundRadiance = groundAlbedo.map((a, c) => (a * (sunIrradiance[c] * sunY + skyIrradiance[c])) / Math.PI);
  const fillGround = (data) => {
    for (let y = Math.floor(H / 2); y < H; y++) {
      const belowDeg = ((y + 0.5) / H) * 180 - 90;
      const t = smoothstep(0, 4, belowDeg);
      for (let x = 0; x < W; x++) {
        const i = px(x, y);
        for (let c = 0; c < 3; c++) data[i + c] = horizonColor[c] + (groundRadiance[c] - horizonColor[c]) * t;
      }
    }
  };
  fillGround(sunless);
  fillGround(rotated);
  for (let i = 0; i < rotated.length; i++) {
    rotated[i] *= k;
    sunless[i] *= k;
  }

  // IBL panorama: 4× box downsample of the sun-less data.
  const iblW = HDRI.iblWidth;
  const iblH = iblW / 2;
  const factor = W / iblW;
  const ibl = new Float32Array(iblW * iblH * 3);
  for (let y = 0; y < iblH; y++) {
    for (let x = 0; x < iblW; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let sy = 0; sy < factor; sy++) for (let sx = 0; sx < factor; sx++) sum += sunless[px(x * factor + sx, y * factor + sy) + c];
        ibl[(y * iblW + x) * 3 + c] = sum / (factor * factor);
      }
    }
  }
  const iblName = `${HDRI.id}_ibl_${resLabel(iblW)}.hdr`;
  await writeFile(path.join(SKY_OUT, iblName), writeHdr({ width: iblW, height: iblH, data: ibl }));

  // Sky faces: HDR / skyScale → sRGB, so the runtime multiplies by skyScale to restore scene-referred values.
  // The scale ignores the sun's aureole, which is allowed to clip to white like an overexposed sun.
  const skyLuminances = [];
  const aureoleCos = Math.cos(12 * DEG);
  for (let y = 0; y < H / 2; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const d = directionOf(x, y, W, H);
      if (d[0] * sunDirection[0] + d[1] * sunDirection[1] + d[2] * sunDirection[2] > aureoleCos) continue;
      const i = px(x, y);
      skyLuminances.push(luminance(sunless[i], sunless[i + 1], sunless[i + 2]));
    }
  }
  skyLuminances.sort((a, b) => a - b);
  const skyScale = Number((skyLuminances[Math.floor(skyLuminances.length * 0.999)] * 1.15).toFixed(3));
  const faceFiles = await writeSkyFaces(tmp, rotated, W, H, skyScale);

  const round = (v) => Number(v.toFixed(4));
  const sunMax = Math.max(...sunIrradiance);
  const sky = {
    iblPanorama: `sky/${iblName}`,
    skyFaces: faceFiles,
    skyScale,
    sunDirection: sunDirection.map(round),
    sunColor: sunIrradiance.map((v) => round(v / sunMax)),
    /** Babylon directional-light intensity: E_sun,normal / π, in the normalized panorama units. */
    sunIntensity: round((sunMax * k) / Math.PI),
    skyAmbient: round((luminance(...skyIrradiance) * k) / Math.PI),
    horizonColor: horizonColor.map((v) => round(v * k)),
    groundRadiance: groundRadiance.map((v) => round(v * k)),
    sunElevationDeg: round(Math.asin(sunY) / DEG),
    normalization: round(k),
  };
  console.log("HDRI calibration", sky);
  return sky;
}

async function writeSkyFaces(tmp, data, W, H, skyScale) {
  const size = HDRI.skyFaceSize;
  // GL cube convention, t = 0 on the first (top) row; Babylon uploads image faces without flipping.
  const faces = {
    px: (sc, tc) => [1, -tc, -sc],
    py: (sc, tc) => [sc, 1, tc],
    pz: (sc, tc) => [sc, -tc, 1],
    nx: (sc, tc) => [-1, -tc, sc],
    ny: (sc, tc) => [sc, -1, -tc],
    nz: (sc, tc) => [-sc, -tc, -1],
  };
  const files = [];
  let seed = 0x9e3779b9;
  const random = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
  const SUPERSAMPLE = 2;
  for (const [name, dirOf] of Object.entries(faces)) {
    const rgb = new Uint8Array(size * size * 3);
    const color = [0, 0, 0];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        color.fill(0);
        for (let sy = 0; sy < SUPERSAMPLE; sy++) {
          for (let sx = 0; sx < SUPERSAMPLE; sx++) {
            const sc = ((x + (sx + 0.5) / SUPERSAMPLE) / size) * 2 - 1;
            const tc = ((y + (sy + 0.5) / SUPERSAMPLE) / size) * 2 - 1;
            samplePanorama(data, W, H, normalize(dirOf(sc, tc)), color);
          }
        }
        const i = (y * size + x) * 3;
        const dither = (random() - 0.5) / 255;
        for (let c = 0; c < 3; c++) {
          const linear = Math.min(1, color[c] / (SUPERSAMPLE * SUPERSAMPLE) / skyScale);
          rgb[i + c] = Math.max(0, Math.min(255, Math.round((linearToSrgb(linear) + dither) * 255)));
        }
      }
    }
    const bmp = path.join(tmp, `sky_${name}.bmp`);
    await writeFile(bmp, writeBmp(size, size, rgb));
    const file = `sky_${name}.jpg`;
    await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(JPEG.skyQuality), bmp, "--out", path.join(SKY_OUT, file)]);
    files.push(`sky/${file}`);
  }
  return files;
}

/** Bilinear panorama lookup using Babylon's equirectangular mapping; accumulates into `out`. */
function samplePanorama(data, W, H, d, out) {
  const u = (0.5 + Math.atan2(d[0], d[2]) / (2 * Math.PI)) * W - 0.5;
  const v = (Math.acos(Math.max(-1, Math.min(1, d[1]))) / Math.PI) * H - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const xa = ((x0 % W) + W) % W;
  const xb = (xa + 1) % W;
  const ya = Math.max(0, Math.min(H - 1, y0));
  const yb = Math.max(0, Math.min(H - 1, y0 + 1));
  for (let c = 0; c < 3; c++) {
    const top = data[(ya * W + xa) * 3 + c] * (1 - fx) + data[(ya * W + xb) * 3 + c] * fx;
    const bottom = data[(yb * W + xa) * 3 + c] * (1 - fx) + data[(yb * W + xb) * 3 + c] * fx;
    out[c] += top * (1 - fy) + bottom * fy;
  }
}

/** Mean color of the band between two polar angles (degrees from zenith). */
function averageBand(data, W, H, fromDeg, toDeg) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.floor((fromDeg / 180) * H); y < Math.floor((toDeg / 180) * H); y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) sum[c] += data[(y * W + x) * 3 + c];
      n++;
    }
  }
  return sum.map((s) => s / n);
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(0).padStart(6)} KB`;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
