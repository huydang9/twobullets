import type { FlattenRegion, TerrainSpec } from "../types";
import { checksumBytes } from "./heightfield";
import { Terrain } from "./terrain";

/**
 * Baked terrain binary: the built heights, surface mask and flatten paint, so clients skip generation (about 1 s in
 * Node, several seconds on a slow main thread). Layout:
 *
 *   "TBTR" | u32 format | u32 header bytes | header JSON | gzip(heights planes ‖ mask planes ‖ paint planes)
 *
 * - Heights: each float32 is XORed with the float32 prediction from its decoded neighbours (left + below − diagonal),
 *   then split into byte planes (sign/exponent bytes first), which gzip packs to about half the raw size.
 * - Mask: dirt, rock and road planes; grass is 255 minus their sum, as the mask stores it.
 * - Paint: four planes, almost all zero.
 *
 * The header's `inputsHash` names the spec and flatten regions the bake was built from (a mismatch means the bake is
 * stale), and `checksum` is `Terrain.checksum()`, verified after decoding.
 */
const MAGIC = 0x52544254; // "TBTR" little-endian
const FORMAT = 1;

export interface TerrainBakeHeader {
  readonly format: number;
  readonly inputsHash: string;
  readonly checksum: string;
  readonly resolution: number;
  readonly size: number;
}

export type TerrainBakeResult =
  | { readonly ok: true; readonly terrain: Terrain; readonly header: TerrainBakeHeader }
  | { readonly ok: false; readonly reason: string };

/** Hash of everything that determines the built terrain. */
export function terrainInputsHash(spec: TerrainSpec, regions: readonly FlattenRegion[]): string {
  return checksumBytes(new TextEncoder().encode(JSON.stringify({ spec, regions })));
}

export async function encodeTerrainBake(terrain: Terrain, regions: readonly FlattenRegion[]): Promise<Uint8Array> {
  const { spec } = terrain;
  const { heights, weights, paint } = terrain.snapshot();
  const count = heights.length;
  const payload = new Uint8Array(count * 4 + count * 3 + count * 4);

  const residuals = new Uint32Array(count);
  const bits = new Uint32Array(heights.buffer, heights.byteOffset, count);
  const n = spec.resolution;
  for (let i = 0; i < count; i++) residuals[i] = bits[i]! ^ floatBits(predict(heights, i, n));
  writePlanes(payload, 0, residuals, count);

  const mask = count * 4;
  for (let i = 0; i < count; i++) {
    payload[mask + i] = weights[i * 4 + 1]!;
    payload[mask + count + i] = weights[i * 4 + 2]!;
    payload[mask + 2 * count + i] = weights[i * 4 + 3]!;
  }
  const paintStart = mask + count * 3;
  for (let k = 0; k < 4; k++) for (let i = 0; i < count; i++) payload[paintStart + k * count + i] = paint[i * 4 + k]!;

  const header: TerrainBakeHeader = { format: FORMAT, inputsHash: terrainInputsHash(spec, regions), checksum: terrain.checksum(), resolution: n, size: spec.size };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const compressed = await transform(payload, new CompressionStream("gzip"));
  const out = new Uint8Array(12 + headerBytes.length + compressed.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, FORMAT, true);
  view.setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  out.set(compressed, 12 + headerBytes.length);
  return out;
}

/** Reads only the header, e.g. to report a stale bake before decompressing. */
export function readTerrainBakeHeader(bytes: Uint8Array): TerrainBakeHeader | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== FORMAT) return null;
  const length = view.getUint32(8, true);
  if (12 + length > bytes.length) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length))) as TerrainBakeHeader;
  } catch {
    return null;
  }
}

/**
 * Decodes a bake for `spec` + `regions`. Fails (without throwing) when the bake is malformed, was built from other
 * inputs, or its decoded arrays don't hash to the recorded checksum.
 */
export async function decodeTerrainBake(bytes: Uint8Array, spec: TerrainSpec, regions: readonly FlattenRegion[]): Promise<TerrainBakeResult> {
  const header = readTerrainBakeHeader(bytes);
  if (!header) return { ok: false, reason: "not a terrain bake (bad magic, format or header)" };
  if (header.resolution !== spec.resolution || header.size !== spec.size) return { ok: false, reason: "grid size differs from the spec" };
  const expected = terrainInputsHash(spec, regions);
  if (header.inputsHash !== expected) return { ok: false, reason: `stale: baked from inputs ${header.inputsHash}, map is ${expected}` };

  const start = 12 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  let payload: Uint8Array;
  try {
    payload = await transform(bytes.subarray(start), new DecompressionStream("gzip"));
  } catch (error) {
    return { ok: false, reason: `corrupt payload (${String(error)})` };
  }
  const n = spec.resolution;
  const count = n * n;
  if (payload.length !== count * 11) return { ok: false, reason: `payload is ${payload.length} bytes, expected ${count * 11}` };

  const heights = new Float32Array(count);
  const bits = new Uint32Array(heights.buffer);
  for (let i = 0; i < count; i++) {
    const residual = ((payload[i]! << 24) | (payload[count + i]! << 16) | (payload[2 * count + i]! << 8) | payload[3 * count + i]!) >>> 0;
    // Row-major order: every neighbour the predictor reads is already decoded.
    bits[i] = (residual ^ floatBits(predict(heights, i, n))) >>> 0;
  }

  const weights = new Uint8Array(count * 4);
  const mask = count * 4;
  for (let i = 0; i < count; i++) {
    const dirt = payload[mask + i]!;
    const rock = payload[mask + count + i]!;
    const road = payload[mask + 2 * count + i]!;
    weights[i * 4] = 255 - dirt - rock - road;
    weights[i * 4 + 1] = dirt;
    weights[i * 4 + 2] = rock;
    weights[i * 4 + 3] = road;
  }
  const paint = new Uint8Array(count * 4);
  const paintStart = mask + count * 3;
  for (let k = 0; k < 4; k++) for (let i = 0; i < count; i++) paint[i * 4 + k] = payload[paintStart + k * count + i]!;

  const terrain = Terrain.fromSnapshot(spec, { heights, weights, paint });
  const checksum = terrain.checksum();
  if (checksum !== header.checksum) return { ok: false, reason: `checksum ${checksum} does not match the recorded ${header.checksum}` };
  return { ok: true, terrain, header };
}

const scratchFloat = new Float32Array(1);
const scratchBits = new Uint32Array(scratchFloat.buffer);

function floatBits(value: number): number {
  scratchFloat[0] = value;
  return scratchBits[0]!;
}

/** Planar prediction from already-decoded neighbours, rounded to float32 so encoder and decoder agree bit for bit. */
function predict(heights: Float32Array, i: number, n: number): number {
  const ix = i % n;
  if (i >= n) return ix > 0 ? Math.fround(heights[i - 1]! + heights[i - n]! - heights[i - n - 1]!) : heights[i - n]!;
  return ix > 0 ? heights[i - 1]! : 0;
}

/** Big-endian byte planes of 32-bit words: all top bytes, then the next, ... */
function writePlanes(out: Uint8Array, offset: number, words: Uint32Array, count: number): void {
  for (let i = 0; i < count; i++) {
    const w = words[i]!;
    out[offset + i] = w >>> 24;
    out[offset + count + i] = (w >>> 16) & 255;
    out[offset + 2 * count + i] = (w >>> 8) & 255;
    out[offset + 3 * count + i] = w & 255;
  }
}

async function transform(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const source = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(source).arrayBuffer());
}
