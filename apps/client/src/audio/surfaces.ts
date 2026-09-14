import type { AcousticSurface } from "./types";

/**
 * Positional surface lookup, e.g. the terrain surface mask (`SurfaceMask.surfaceAt(x, z)`), consulted when a ray hit
 * doesn't identify its own material. Returns null when the position is outside the provider's coverage.
 */
export interface SurfaceProvider {
  surfaceAt(x: number, y: number, z: number): AcousticSurface | null;
}

/** Terrain surface names (packages/shared/src/map TERRAIN_SURFACES) → footstep/impact sound family. */
const TERRAIN: Readonly<Record<string, AcousticSurface>> = {
  grass: "grass",
  dirt: "dirt",
  rock: "concrete",
  road: "gravel",
};

/** Building material slots (packages/shared/src/map/buildings BuildingMaterialId). */
const BUILDING: Readonly<Record<string, AcousticSurface>> = {
  plaster: "concrete",
  plasterInterior: "concrete",
  concrete: "concrete",
  woodFloor: "wood",
  woodPlanks: "wood",
  woodTrim: "wood",
  corrugated: "metal",
  roofMetal: "metal",
  roofAsphalt: "concrete",
  paintedSteel: "metal",
  darkSteel: "metal",
  containerRed: "metal",
  containerBlue: "metal",
};

/** Arena material looks (world/materials.ts, material names `mat_<look>`). */
const LOOK: Readonly<Record<string, AcousticSurface>> = {
  ground: "dirt",
  concreteWall: "concrete",
  concreteFloor: "concrete",
  asphalt: "concrete",
  planks: "wood",
  corrugatedIron: "metal",
  paintedSteel: "metal",
  darkSteel: "metal",
};

const ACOUSTIC: ReadonlySet<string> = new Set<AcousticSurface>(["concrete", "dirt", "grass", "gravel", "wood", "metal"]);

/** Adapts a terrain surface mask (dominant surface at x, z) to a SurfaceProvider. */
export function terrainSurfaceProvider(mask: { surfaceAt(x: number, z: number): string }): SurfaceProvider {
  return { surfaceAt: (x, _y, z) => TERRAIN[mask.surfaceAt(x, z)] ?? null };
}

interface NodeLike {
  readonly name: string;
  readonly metadata?: unknown;
  readonly material?: { readonly name: string } | null;
}

/** What a hit node declares it is made of: `metadata.surface` (an acoustic surface, a terrain surface or a building
 * material id; the hook for terrain and buildings), then the arena material name. */
export function taggedSurface(node: NodeLike | null | undefined): AcousticSurface | null {
  if (!node) return null;
  const tagged = (node.metadata as { surface?: unknown } | null | undefined)?.surface;
  if (typeof tagged === "string") {
    if (ACOUSTIC.has(tagged)) return tagged as AcousticSurface;
    const mapped = TERRAIN[tagged] ?? BUILDING[tagged];
    if (mapped) return mapped;
  }
  const material = node.material?.name;
  return material?.startsWith("mat_") ? (LOOK[material.slice(4)] ?? null) : null;
}

/** Last resort: guesses from the mesh name. */
export function surfaceFromName(node: NodeLike | null | undefined): AcousticSurface | null {
  if (!node) return null;
  const name = node.name.toLowerCase();
  if (/terrain|ground|heightfield/.test(name)) return "dirt";
  if (/catwalk|stack|barrier|container|metal|steel/.test(name)) return "metal";
  if (/crate|plank|wood/.test(name)) return "wood";
  if (/level_|wall|floor|stair|ramp|pillar|platform|concrete/.test(name)) return "concrete";
  return null;
}
