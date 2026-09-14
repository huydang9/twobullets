import type { TerrainSpec } from "../types";

/**
 * Map v1 terrain: 1280 m square (1 km playable + 140 m mountain border), 1025² samples at 1.25 m spacing.
 *
 * Landforms (playable area, +X east, +Z north):
 * - radar ridge in the north-west, crest ~40 m above the surrounding hills;
 * - a shallow river valley running north-south east of the center;
 * - a lookout hill between the ridge and the center;
 * - a terraced quarry pit in the south.
 */
export const TERRAIN_V1: TerrainSpec = {
  version: 1,
  seed: 0x7b0b_0001,
  size: 1280,
  resolution: 1025,
  playableHalfExtent: 500,
  relief: {
    baseHeight: 30,
    macroAmplitude: 14,
    macroWavelength: 700,
    hillAmplitude: 7,
    hillWavelength: 180,
    detailAmplitude: 0.6,
    detailWavelength: 24,
    warp: 50,
  },
  border: {
    foothillInset: 40,
    rampDistance: 110,
    height: 120,
    ridgeWavelength: 320,
  },
  features: [
    { kind: "ridge", path: [[-370, 170], [-300, 255], [-215, 300]], width: 170, height: 40 },
    { kind: "valley", path: [[90, 560], [150, 320], [120, 140], [200, -60], [160, -220], [240, -560]], width: 130, depth: 9 },
    { kind: "hill", center: [-190, 110], radius: 95, height: 13 },
    { kind: "basin", center: [-60, -330], radius: 95, floorRadius: 45, depth: 24, terraces: 3 },
  ],
};
