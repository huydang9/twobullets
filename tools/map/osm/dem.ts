/**
 * Decodes cached AWS Terrain Tiles (terrarium PNG: height = R·256 + G + B/256 − 32768 m) into elevation samples on the
 * local map grid. Tooling only (sharp); the converter itself is pure.
 */
import { createRequire } from "node:module";
import type { Projection } from "../../../packages/shared/src/map/real/convert/projection.ts";
import type { ElevationSamples } from "../../../packages/shared/src/map/real/convert/types.ts";
import { REPO_ROOT } from "../lib/resolve.ts";

const require = createRequire(`${REPO_ROOT}/package.json`);

interface DecodedTile {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly size: number;
  readonly heights: Float64Array;
}

async function decodeTile(tile: { path: string; x: number; y: number; z: number }): Promise<DecodedTile> {
  const sharp = require("sharp") as (path: string) => { raw(): { toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> } };
  const { data, info } = await sharp(tile.path).raw().toBuffer({ resolveWithObject: true });
  if (info.width !== info.height) throw new Error(`${tile.path}: tile is not square`);
  const heights = new Float64Array(info.width * info.height);
  for (let i = 0; i < heights.length; i++) {
    const o = i * info.channels;
    heights[i] = data[o]! * 256 + data[o + 1]! + data[o + 2]! / 256 - 32768;
  }
  return { x: tile.x, y: tile.y, z: tile.z, size: info.width, heights };
}

/** Samples `spacing`-m elevation over the square of `half` m around the projection center (bilinear between pixel centers). */
export async function sampleElevation(tiles: readonly { path: string; x: number; y: number; z: number }[], projection: Projection, half: number, spacing: number): Promise<ElevationSamples> {
  const decoded = await Promise.all(tiles.map(decodeTile));
  const byKey = new Map(decoded.map((t) => [`${t.x},${t.y}`, t] as const));
  const zoom = decoded[0]!.z;
  const size = decoded[0]!.size;
  const n = 2 ** zoom;
  const pixel = (px: number, py: number): number => {
    const tx = Math.floor(px / size);
    const ty = Math.floor(py / size);
    const tile = byKey.get(`${tx},${ty}`);
    if (!tile) throw new Error(`DEM tile ${zoom}/${tx}/${ty} missing (fetch a larger area)`);
    return tile.heights[(py - ty * size) * size + (px - tx * size)]!;
  };
  const columns = Math.round((2 * half) / spacing) + 1;
  const heights: number[] = [];
  for (let j = 0; j < columns; j++) {
    for (let i = 0; i < columns; i++) {
      const { lat, lon } = projection.unproject(-half + i * spacing, -half + j * spacing);
      const rad = (lat * Math.PI) / 180;
      const gx = ((lon + 180) / 360) * n * size - 0.5;
      const gy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * size - 0.5;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      const top = pixel(x0, y0) * (1 - fx) + pixel(x0 + 1, y0) * fx;
      const bottom = pixel(x0, y0 + 1) * (1 - fx) + pixel(x0 + 1, y0 + 1) * fx;
      heights.push(Math.round((top * (1 - fy) + bottom * fy) * 100) / 100);
    }
  }
  return { spacing, columns, rows: columns, heights };
}
