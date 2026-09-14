// Pure, deterministic terrain: no Babylon imports anywhere under this folder (enforced by determinism.test.ts).
export { Heightfield, checksumBytes, type NormalLike } from "./heightfield";
export { createReliefFunction, generateHeightfield, type ReliefFunction } from "./generate";
export { SurfacePaint, flattenHeightfield, surfaceIndex } from "./flatten";
export { SurfaceMask, computeSurfaceMask } from "./surface";
export { Terrain, buildTerrain, type TerrainBuildOptions, type TerrainSnapshot } from "./terrain";
export { decodeTerrainBake, encodeTerrainBake, readTerrainBakeHeader, terrainInputsHash, type TerrainBakeHeader, type TerrainBakeResult } from "./bake";
export { TERRAIN_V1 } from "./presets";
export { fbm, gradientNoise, hash2, ridged, subSeed } from "./noise";
