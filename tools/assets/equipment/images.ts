import sharp from "sharp";

export interface ChannelStats {
  readonly mean: number;
  readonly stdev: number;
}

/** Per-channel mean/stdev (0..255). */
export async function imageStats(bytes: Uint8Array): Promise<ChannelStats[]> {
  const stats = await sharp(bytes).stats();
  return stats.channels.map((c) => ({ mean: c.mean, stdev: c.stdev }));
}

/** True when every channel is (nearly) a single value, e.g. a 2K PNG that only holds a flat roughness. */
export function isFlat(stats: readonly ChannelStats[]): boolean {
  return stats.every((c) => c.stdev < 1.5);
}

async function raw(bytes: Uint8Array, channels: 3 | 4 = 3) {
  const image = channels === 4 ? sharp(bytes).ensureAlpha() : sharp(bytes).removeAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height, channels };
}

const png = (data: Uint8Array, width: number, height: number, channels: 1 | 3 | 4) =>
  sharp(data, { raw: { width, height, channels } })
    .png({ compressionLevel: 3 })
    .toBuffer()
    .then((b) => new Uint8Array(b));

/** DirectX → OpenGL normal map (Y flipped). */
export async function flipGreen(bytes: Uint8Array): Promise<Uint8Array> {
  const image = await raw(bytes);
  for (let i = 1; i < image.data.length; i += 3) image.data[i] = 255 - image.data[i]!;
  return png(image.data, image.width, image.height, 3);
}

/**
 * Paints out printed marks lighter than the fabric (a real product's label and small print): pixels whose luma is well
 * above the texture's typical luma, grown so dark lettering inside a light banner is covered too, are replaced by a normalized blur of the unmarked pixels, so
 * the fill takes the local fabric colour. Noise from the original is added back so the patch isn't smooth.
 */
export async function removeLightMarks(bytes: Uint8Array): Promise<Uint8Array> {
  const { data, width, height } = await raw(bytes);
  const n = width * height;
  const luma = new Float32Array(n);
  let sum = 0;
  for (let p = 0; p < n; p++) {
    const l = 0.2126 * data[p * 3]! + 0.7152 * data[p * 3 + 1]! + 0.0722 * data[p * 3 + 2]!;
    luma[p] = l;
    sum += l;
  }
  const mean = sum / n;
  let variance = 0;
  for (let p = 0; p < n; p++) variance += (luma[p]! - mean) ** 2;
  const threshold = mean + Math.max(18, 2.5 * Math.sqrt(variance / n));

  let mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (luma[p]! > threshold) mask[p] = 1;
  // Wide enough to swallow dark lettering printed inside light banners.
  const grow = Math.max(3, Math.round(width / 160));
  for (let pass = 0; pass < grow; pass++) {
    const next = mask.slice();
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const p = y * width + x;
        if (!mask[p] && (mask[p - 1] || mask[p + 1] || mask[p - width] || mask[p + width])) next[p] = 1;
      }
    }
    mask = next;
  }

  // Normalized convolution: blur(color · keep) / blur(keep).
  const keep = new Float32Array(n);
  const channels = [0, 1, 2].map(() => new Float32Array(n));
  for (let p = 0; p < n; p++) {
    if (mask[p]) continue;
    keep[p] = 1;
    for (let c = 0; c < 3; c++) channels[c]![p] = data[p * 3 + c]!;
  }
  const radius = Math.max(4, Math.round(width / 64));
  for (const plane of [keep, ...channels]) gaussianish(plane, width, height, radius);

  for (let p = 0; p < n; p++) {
    if (!mask[p]) continue;
    const w = keep[p]!;
    // Grain borrowed from a pixel a label-width away keeps the fabric texture.
    const q = (p + (width >> 3) * width) % n;
    const grain = mask[q] ? 0 : luma[q]! - mean;
    for (let c = 0; c < 3; c++) {
      const fill = w > 1e-3 ? channels[c]![p]! / w : mean;
      data[p * 3 + c] = Math.max(0, Math.min(255, Math.round(fill + grain * 0.6)));
    }
  }
  return png(data, width, height, 3);
}

/** Three box-blur passes per axis (close to a Gaussian), in place, clamped edges. */
function gaussianish(plane: Float32Array, width: number, height: number, radius: number): void {
  const line = new Float32Array(Math.max(width, height));
  const blurLine = (get: (i: number) => number, set: (i: number, v: number) => void, length: number) => {
    for (let i = 0; i < length; i++) line[i] = get(i);
    const scale = 1 / (2 * radius + 1);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += line[Math.min(length - 1, Math.max(0, i))]!;
    for (let i = 0; i < length; i++) {
      set(i, sum * scale);
      sum += line[Math.min(length - 1, i + radius + 1)]! - line[Math.max(0, i - radius)]!;
    }
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      blurLine((x) => plane[row + x]!, (x, v) => (plane[row + x] = v), width);
    }
    for (let x = 0; x < width; x++) blurLine((y) => plane[y * width + x]!, (y, v) => (plane[y * width + x] = v), height);
  }
}

/** Spec/gloss → metal/rough: a roughness texture (G = 1 − glossiness·factor from alpha), metalness in B left 0. */
export async function roughnessFromGlossiness(bytes: Uint8Array, glossFactor: number): Promise<Uint8Array> {
  const { data, width, height } = await raw(bytes, 4);
  const out = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    out[p * 3] = 255;
    out[p * 3 + 1] = Math.round(255 - data[p * 4 + 3]! * glossFactor);
    out[p * 3 + 2] = 0;
  }
  return png(out, width, height, 3);
}

/** sRGB byte → linear 0..1 (for folding a flat base color texture into the factor). */
export function srgbToLinear(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
