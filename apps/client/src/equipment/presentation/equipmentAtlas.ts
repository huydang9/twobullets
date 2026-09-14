import { Constants, RawTexture, Texture, type Scene } from "@babylonjs/core";

export const EQ_ATLAS_COLUMNS = 4;
export const EQ_ATLAS_ROWS = 4;
const CELL = 128;

/** Cells of the equipment effects atlas (RGBA; batches multiply instance color by the texel RGB). */
export const EqCell = {
  /** Billowing hot blob: white core to orange rim. */
  fireball: 0,
  /** Soft billow, top-lit (brighter toward +V). */
  smoke: 1,
  /** Low-contrast dust puff. */
  dust: 2,
  /** Blast mark with radial streaks. */
  scorch: 3,
  /** Charred ground patch. */
  burn: 4,
  ring: 5,
  dot: 6,
  /** Irregular rock/dirt chunk. */
  chunk: 7,
  /** Glass shard with a bright edge. */
  shard: 8,
  /** Short skid mark along U. */
  scuff: 9,
  /** Flame tongue flipbook along U (base at U = 0): FLAME_FRAMES frames starting here. */
  flame0: 10,
} as const;

export const FLAME_FRAMES = 6;

/** Deterministic procedural atlas, built once from raw pixels (no canvas, so it also works under NullEngine). */
export function createEquipmentAtlas(scene: Scene): RawTexture {
  const size = CELL * EQ_ATLAS_COLUMNS;
  const data = new Uint8Array(size * size * 4);
  const painters: readonly Painter[] = [fireball, smoke, dust, scorch, burn, ring, dot, chunk, shard, scuff];
  for (let cell = 0; cell < EQ_ATLAS_COLUMNS * EQ_ATLAS_ROWS; cell++) {
    const painter = cell < EqCell.flame0 ? painters[cell] : cell < EqCell.flame0 + FLAME_FRAMES ? flame(cell - EqCell.flame0) : null;
    if (!painter) continue;
    const ox = (cell % EQ_ATLAS_COLUMNS) * CELL;
    const oy = Math.floor(cell / EQ_ATLAS_COLUMNS) * CELL;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        const u = (x + 0.5) / CELL;
        const v = (y + 0.5) / CELL;
        painter(u, v, out);
        // Keep a 2 px transparent border so mips don't bleed between cells.
        const edge = Math.min(x, y, CELL - 1 - x, CELL - 1 - y) < 2 ? 0 : 1;
        const o = ((oy + y) * size + ox + x) * 4;
        data[o] = toByte(out[0]!);
        data[o + 1] = toByte(out[1]!);
        data[o + 2] = toByte(out[2]!);
        data[o + 3] = toByte(out[3]! * edge);
      }
    }
  }
  // Row 0 is V = 0, matching the FxBatch cell math (no Y flip).
  const texture = new RawTexture(data, size, size, Constants.TEXTUREFORMAT_RGBA, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  texture.name = "eq_atlas";
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  texture.hasAlpha = true;
  return texture;
}

/** Tileable value noise textures for the smoke volume (R, G: two octave sets; B, A: offset copies). */
export function createNoiseTexture(scene: Scene, size = 64): RawTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const o = (y * size + x) * 4;
      data[o] = toByte(fbm(u * 4, v * 4, 4, 11, 4));
      data[o + 1] = toByte(fbm(u * 8, v * 8, 8, 23, 3));
      data[o + 2] = toByte(fbm(u * 4 + 0.37, v * 4 + 0.71, 4, 37, 4));
      data[o + 3] = toByte(fbm(u * 2, v * 2, 2, 53, 4));
    }
  }
  // No mips: the smoke shader samples inside per-puff branches, where derivatives are undefined.
  const texture = new RawTexture(data, size, size, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.BILINEAR_SAMPLINGMODE);
  texture.name = "eq_noise";
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  return texture;
}

type Painter = (u: number, v: number, out: Float32Array) => void;
const out = new Float32Array(4);

function toByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value * 255)));
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix * 374761393 + iy * 668265263 + seed * 2147483647, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Value noise tiling every `period` units. */
function noise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const wrap = (i: number) => ((i % period) + period) % period;
  const a = hash(wrap(ix), wrap(iy), seed);
  const b = hash(wrap(ix + 1), wrap(iy), seed);
  const c = hash(wrap(ix), wrap(iy + 1), seed);
  const d = hash(wrap(ix + 1), wrap(iy + 1), seed);
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number, period: number, seed: number, octaves: number): number {
  let sum = 0;
  let amplitude = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const scale = 1 << i;
    sum += noise(x * scale, y * scale, period * scale, seed + i * 17) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
  }
  return sum / norm;
}

function radius(u: number, v: number): number {
  const dx = u - 0.5;
  const dy = v - 0.5;
  return Math.sqrt(dx * dx + dy * dy) * 2;
}

function fireball(u: number, v: number, o: Float32Array): void {
  const r = radius(u, v);
  const n = fbm(u * 5, v * 5, 5, 3, 4);
  const shape = smoothstep(1, 0.45, r + (n - 0.5) * 0.55);
  const heat = clamp01(1.25 - r * 1.1 + (n - 0.5) * 0.5);
  o[0] = 1;
  o[1] = 0.35 + 0.6 * heat;
  o[2] = 0.08 + 0.75 * heat * heat;
  o[3] = shape;
}

function smoke(u: number, v: number, o: Float32Array): void {
  const r = radius(u, v);
  const n = fbm(u * 4, v * 4, 4, 7, 5);
  const shape = smoothstep(1, 0.2, r + (n - 0.5) * 0.7) * (0.55 + 0.45 * n);
  const light = 0.62 + 0.38 * smoothstep(0.15, 0.95, v + (n - 0.5) * 0.3);
  o[0] = o[1] = o[2] = light;
  o[3] = shape;
}

function dust(u: number, v: number, o: Float32Array): void {
  const r = radius(u, v);
  const n = fbm(u * 3, v * 3, 3, 13, 4);
  o[0] = o[1] = o[2] = 0.85 + 0.15 * v;
  o[3] = smoothstep(1, 0.1, r + (n - 0.5) * 0.5) * (0.4 + 0.4 * n);
}

function scorch(u: number, v: number, o: Float32Array): void {
  const r = radius(u, v);
  const angle = Math.atan2(v - 0.5, u - 0.5);
  const rays = 0.5 + 0.5 * Math.sin(angle * 11 + Math.sin(angle * 5) * 2);
  const n = fbm(u * 6, v * 6, 6, 29, 4);
  const reach = 0.55 + 0.4 * rays * n;
  const alpha = smoothstep(reach, 0.1, r) * (0.7 + 0.3 * n);
  o[0] = o[1] = o[2] = 0.05 + 0.1 * n;
  o[3] = alpha;
}

function burn(u: number, v: number, o: Float32Array): void {
  const r = radius(u, v);
  const n = fbm(u * 5, v * 5, 5, 41, 5);
  const alpha = smoothstep(0.95, 0.35, r + (n - 0.5) * 0.6);
  const ash = smoothstep(0.62, 0.8, fbm(u * 16, v * 16, 16, 43, 2));
  o[0] = 0.07 + 0.25 * ash;
  o[1] = 0.06 + 0.23 * ash;
  o[2] = 0.05 + 0.2 * ash;
  o[3] = alpha;
}

function ring(u: number, v: number, o: Float32Array): void {
  const r = radius(u, v);
  o[0] = o[1] = o[2] = 1;
  o[3] = smoothstep(0.62, 0.8, r) * smoothstep(1, 0.86, r);
}

function dot(u: number, v: number, o: Float32Array): void {
  const r = radius(u, v);
  o[0] = o[1] = o[2] = 1;
  o[3] = smoothstep(1, 0.45, r);
}

function chunk(u: number, v: number, o: Float32Array): void {
  const angle = Math.atan2(v - 0.5, u - 0.5);
  const r = radius(u, v);
  const edge = 0.62 + 0.18 * Math.sin(angle * 3 + 1) + 0.1 * Math.sin(angle * 7);
  const n = fbm(u * 8, v * 8, 8, 61, 3);
  o[0] = o[1] = o[2] = 0.55 + 0.45 * n * smoothstep(0.2, 0.9, v);
  o[3] = smoothstep(edge + 0.05, edge - 0.05, r);
}

function shard(u: number, v: number, o: Float32Array): void {
  // Triangle (0.15, 0.2) (0.85, 0.35) (0.4, 0.9).
  const e0 = (u - 0.15) * (0.35 - 0.2) - (v - 0.2) * (0.85 - 0.15);
  const e1 = (u - 0.85) * (0.9 - 0.35) - (v - 0.35) * (0.4 - 0.85);
  const e2 = (u - 0.4) * (0.2 - 0.9) - (v - 0.9) * (0.15 - 0.4);
  const inside = Math.min(-e0, -e1, -e2);
  o[0] = o[1] = o[2] = 1;
  o[3] = smoothstep(0, 0.03, inside) * (0.35 + 0.65 * smoothstep(0.05, 0, inside));
}

function scuff(u: number, v: number, o: Float32Array): void {
  const across = Math.abs(v - 0.5) * 2;
  const n = fbm(u * 3, v * 12, 3, 71, 3);
  o[0] = o[1] = o[2] = 0.15;
  o[3] = smoothstep(0.9, 0.2, across + (n - 0.5) * 0.5) * smoothstep(0, 0.25, u) * smoothstep(1, 0.6, u) * 0.8;
}

/** Flame tongue frame: the noise scrolls toward the tip one sixth of a tile per frame, so the loop is seamless. */
function flame(frame: number): Painter {
  const scroll = (frame / FLAME_FRAMES) * 3;
  return (u, v, o) => {
    const across = (v - 0.5) * 2;
    const n = fbm(u * 3 - scroll, v * 3, 3, 83, 4);
    const m = fbm(u * 6 - scroll * 2, v * 6 + 0.5, 6, 89, 3);
    // Wide at the base, licking to a wavering tip.
    const widthAt = (0.85 - 0.8 * u) * (0.75 + 0.5 * n);
    const bend = (n - 0.5) * 0.5 * u;
    const body = smoothstep(widthAt, widthAt * 0.35, Math.abs(across - bend));
    const alpha = body * smoothstep(0, 0.08, u) * smoothstep(1, 0.55 - 0.25 * m, u);
    const heat = clamp01(1.1 - u * 1.2 - Math.abs(across) * 0.8 + (m - 0.5) * 0.4);
    o[0] = 1;
    o[1] = 0.28 + 0.62 * heat;
    o[2] = 0.05 + 0.6 * heat * heat * heat;
    o[3] = alpha;
  };
}
