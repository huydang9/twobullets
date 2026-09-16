import type { TerrainSpec } from "../types";

/**
 * Map v1 terrain: 640 m square (500 m playable + 70 m mountain border), 513² samples at 1.25 m spacing.
 *
 * The playable square halved from 1 km to 500 m on 2026-09-16 (the browser build was too heavy). POI content is still
 * authored at 1:1, so the landforms moved and shrank rather than scaling with the square.
 *
 * Landforms (playable area, +X east, +Z north):
 * - radar ridge north of town, crest ~20 m above the surrounding hills;
 * - a lookout hill west of town;
 * - a terraced quarry pit in the south-west.
 */
export const TERRAIN_V1: TerrainSpec = {
  version: 1,
  seed: 0x7b0b_0001,
  size: 640,
  resolution: 513,
  playableHalfExtent: 250,
  relief: {
    baseHeight: 30,
    macroAmplitude: 8,
    macroWavelength: 420,
    hillAmplitude: 5,
    hillWavelength: 130,
    detailAmplitude: 0.6,
    detailWavelength: 24,
    warp: 40,
  },
  border: {
    foothillInset: 20,
    rampDistance: 55,
    height: 110,
    ridgeWavelength: 200,
  },
  features: [
    { kind: "ridge", path: [[-118, 138], [-60, 185], [-2, 232]], width: 130, height: 20 },
    { kind: "hill", center: [60, -60], radius: 55, height: 9 },
    { kind: "basin", center: [-130, -110], radius: 85, floorRadius: 40, depth: 22, terraces: 3 },
  ],
};
