import type { Vec3Tuple } from "../../level/types";

/**
 * Gameplay side of the prop catalog: footprint, collision and surface per prop id. Pure data, so a headless server
 * builds the same collision the client does. Looks (meshes, LODs) live on the client (world/props).
 *
 * Prop-local frame, like buildings and the environment prop manifest (apps/client/src/world/propAssets.ts): origin on
 * the ground at the footprint center, Y up, front facing local +Z; fence and wall segments run along local X. Instance
 * scale multiplies every dimension. Ids match the manifest's PropId where an environment asset exists, so the client
 * draws the real model once it lands; collision here is the gameplay approximation both client and server build.
 */
export type PropCategory = "prop" | "rock" | "tree" | "bush" | "grass";

/** Footstep/impact family for audio (`metadata.surface` on the client). */
export type PropSurface = "wood" | "concrete" | "metal" | "dirt" | "grass" | "gravel";

export type PropCollision =
  /** Walk-through: grass, bushes, pebbles. */
  | { readonly kind: "none" }
  /** Upright cylinder from the ground (tree trunks). */
  | { readonly kind: "cylinder"; readonly radius: number; readonly height: number }
  /**
   * Box around (0, size.y / 2 + offsetY, 0). `bulletproof` false puts it on the movement-only layer (fences you can
   * shoot through).
   */
  | { readonly kind: "box"; readonly size: Vec3Tuple; readonly offsetY?: number; readonly bulletproof: boolean };

export interface MapPropDef {
  readonly id: string;
  readonly category: PropCategory;
  /** Radius kept clear of other collidable props and used for placement tests, m at scale 1. */
  readonly footprint: number;
  readonly collision: PropCollision;
  readonly surface: PropSurface;
  /** Tilted to the terrain normal by default (rocks, debris). */
  readonly alignToTerrain?: boolean;
  /** Pushed this far into the ground so slopes don't expose the base, m at scale 1. */
  readonly sink?: number;
  /**
   * Cover that must never be culled by distance. The client's `isCover` also derives it from collision (blocking and
   * taller than 0.5 m); this flag states it explicitly for props added as cover.
   */
  readonly cover?: boolean;
}

const DEFS = [
  // Trees: trunk cylinders stop players and bullets; canopies are visual only. Sizes follow the environment manifest.
  { id: "tree_fir_a", category: "tree", footprint: 2.4, collision: { kind: "cylinder", radius: 0.2, height: 10 }, surface: "wood", sink: 0.3 },
  { id: "tree_fir_b", category: "tree", footprint: 2.2, collision: { kind: "cylinder", radius: 0.18, height: 7 }, surface: "wood", sink: 0.3 },
  { id: "tree_fir_young", category: "tree", footprint: 1.6, collision: { kind: "cylinder", radius: 0.12, height: 4.5 }, surface: "wood", sink: 0.2 },
  { id: "tree_broadleaf_a", category: "tree", footprint: 2.8, collision: { kind: "cylinder", radius: 0.2, height: 5.5 }, surface: "wood", sink: 0.3 },
  { id: "tree_broadleaf_b", category: "tree", footprint: 3, collision: { kind: "cylinder", radius: 0.3, height: 4.5 }, surface: "wood", sink: 0.3 },
  // Bushes and grass: walk-through.
  { id: "bush_a", category: "bush", footprint: 0.8, collision: { kind: "none" }, surface: "grass", sink: 0.1 },
  { id: "bush_b", category: "bush", footprint: 0.6, collision: { kind: "none" }, surface: "grass", sink: 0.1 },
  { id: "bush_c", category: "bush", footprint: 1.2, collision: { kind: "none" }, surface: "grass", sink: 0.15 },
  { id: "fern", category: "bush", footprint: 0.6, collision: { kind: "none" }, surface: "grass" },
  { id: "grass_clump_short", category: "grass", footprint: 0.35, collision: { kind: "none" }, surface: "grass" },
  { id: "grass_clump_medium", category: "grass", footprint: 0.35, collision: { kind: "none" }, surface: "grass" },
  { id: "grass_clump_tall", category: "grass", footprint: 0.3, collision: { kind: "none" }, surface: "grass" },
  // Rocks: boxes inside the measured bounds (the assets' hulls are client-only for now), so players don't snag on air.
  { id: "rock_small", category: "rock", footprint: 0.7, collision: { kind: "box", size: [1, 0.4, 0.8], bulletproof: true }, surface: "concrete", alignToTerrain: true, sink: 0.1 },
  { id: "rock_moss_b", category: "rock", footprint: 0.9, collision: { kind: "box", size: [1.35, 0.6, 1.2], bulletproof: true }, surface: "concrete", alignToTerrain: true, sink: 0.12 },
  { id: "rock_boulder_a", category: "rock", footprint: 1.8, collision: { kind: "box", size: [2.2, 1.05, 2.7], bulletproof: true }, surface: "concrete", alignToTerrain: true, sink: 0.2 },
  { id: "rock_moss_a", category: "rock", footprint: 1.1, collision: { kind: "box", size: [1.65, 1.1, 1.3], bulletproof: true }, surface: "concrete", alignToTerrain: true, sink: 0.2 },
  { id: "rock_boulder_b", category: "rock", footprint: 1.3, collision: { kind: "box", size: [1.8, 1.5, 1.65], bulletproof: true }, surface: "concrete", alignToTerrain: true, sink: 0.25 },
  { id: "rock_pile", category: "rock", footprint: 3.2, collision: { kind: "box", size: [5.2, 1.6, 4.2], bulletproof: true }, surface: "gravel", sink: 0.3 },
  // Set dressing from the environment manifest.
  { id: "road_barrier", category: "prop", footprint: 0.8, collision: { kind: "box", size: [1.57, 1.11, 0.44], bulletproof: true }, surface: "concrete" },
  { id: "fence_chainlink", category: "prop", footprint: 0.3, collision: { kind: "box", size: [2.03, 2.52, 0.15], bulletproof: false }, surface: "metal", sink: 0.05 },
  { id: "car_covered", category: "prop", footprint: 2.3, collision: { kind: "box", size: [1.79, 1.41, 4.38], bulletproof: true }, surface: "metal" },
  { id: "log_fallen", category: "prop", footprint: 2, collision: { kind: "box", size: [4.05, 1, 1.06], bulletproof: true }, surface: "wood", sink: 0.1 },
  { id: "tree_stump", category: "prop", footprint: 0.9, collision: { kind: "box", size: [1.2, 0.5, 1.3], bulletproof: true }, surface: "wood", sink: 0.05 },
  { id: "crate_military", category: "prop", footprint: 0.7, collision: { kind: "box", size: [1.24, 0.47, 0.52], bulletproof: true }, surface: "wood" },
  { id: "crate_military_long", category: "prop", footprint: 0.5, collision: { kind: "box", size: [0.81, 0.3, 0.54], bulletproof: true }, surface: "wood" },
  { id: "barrel_rusty", category: "prop", footprint: 0.35, collision: { kind: "cylinder", radius: 0.32, height: 0.93 }, surface: "metal" },
  { id: "utility_box", category: "prop", footprint: 0.6, collision: { kind: "box", size: [0.92, 1.12, 0.43], bulletproof: true }, surface: "metal" },
  // Map-only props (no environment asset yet; the client draws procedural stand-ins).
  { id: "fence_wood", category: "prop", footprint: 0.3, collision: { kind: "box", size: [4, 1.1, 0.12], bulletproof: false }, surface: "wood", sink: 0.1 },
  { id: "wall_concrete", category: "prop", footprint: 0.4, collision: { kind: "box", size: [4, 2.6, 0.3], bulletproof: true }, surface: "concrete", sink: 0.4 },
  { id: "sandbags", category: "prop", footprint: 1, collision: { kind: "box", size: [2.4, 0.9, 0.7], bulletproof: true }, surface: "dirt" },
  { id: "hay_bale", category: "prop", footprint: 1, collision: { kind: "box", size: [1.3, 1.5, 1.5], bulletproof: true }, surface: "grass" },
  { id: "hay_stack", category: "prop", footprint: 1.6, collision: { kind: "box", size: [2.6, 1.9, 1.3], bulletproof: true }, surface: "grass" },
  // Big trees and cover props from real models (environment manifest, 2026-09-15). Not placed on Map v1 yet; see
  // docs/map/cover-props.md. Boxes are inner approximations of the measured bounds (irregular scans, straws, open doors).
  { id: "tree_oak_large", category: "tree", footprint: 3.5, collision: { kind: "cylinder", radius: 0.62, height: 3.5 }, surface: "wood", sink: 0.2, cover: true },
  { id: "tree_oak_fungi", category: "tree", footprint: 2.5, collision: { kind: "cylinder", radius: 0.36, height: 5.8 }, surface: "wood", sink: 0.2, cover: true },
  { id: "log_mossy", category: "prop", footprint: 1.5, collision: { kind: "box", size: [2.7, 0.8, 0.7], bulletproof: true }, surface: "wood", sink: 0.1, cover: true },
  { id: "stump_boubin", category: "prop", footprint: 1.6, collision: { kind: "cylinder", radius: 0.95, height: 1.05 }, surface: "wood", sink: 0.1, cover: true },
  { id: "car_wreck", category: "prop", footprint: 2.7, collision: { kind: "box", size: [1.9, 1.3, 5], bulletproof: true }, surface: "metal", sink: 0.05, cover: true },
  { id: "pipe_stack", category: "prop", footprint: 2.7, collision: { kind: "box", size: [5, 1.37, 1.9], bulletproof: true }, surface: "concrete", cover: true },
  { id: "hay_bale_stack", category: "prop", footprint: 0.75, collision: { kind: "box", size: [0.94, 1.16, 0.94], bulletproof: true }, surface: "grass", sink: 0.03, cover: true },
  { id: "hay_bale_wall", category: "prop", footprint: 1.6, collision: { kind: "box", size: [2.9, 1.16, 0.47], bulletproof: true }, surface: "grass", sink: 0.03, cover: true },
  { id: "sandbag_barrier", category: "prop", footprint: 2.3, collision: { kind: "box", size: [4.5, 1, 0.7], bulletproof: true }, surface: "dirt", sink: 0.03, cover: true },
  { id: "cable_spool", category: "prop", footprint: 0.75, collision: { kind: "cylinder", radius: 0.7, height: 1.4 }, surface: "wood", cover: true },
  // Vietnamese plants (tools/environment/vn, 2026-09-15): the wilderness woodland on the Saigon maps. Palm trunks are
  // thin but solid; bamboo, banana and shrubs are walk-through sight cover, like the other bushes.
  { id: "vn_palm_coconut", category: "tree", footprint: 2.8, collision: { kind: "cylinder", radius: 0.2, height: 7.5 }, surface: "wood", sink: 0.2, cover: true },
  { id: "vn_palm_coconut_trio", category: "tree", footprint: 4.6, collision: { kind: "cylinder", radius: 0.33, height: 6.8 }, surface: "wood", sink: 0.2, cover: true },
  { id: "vn_bamboo_clump", category: "bush", footprint: 1, collision: { kind: "none" }, surface: "grass", sink: 0.05 },
  { id: "vn_banana_plant", category: "bush", footprint: 0.85, collision: { kind: "none" }, surface: "grass" },
  { id: "vn_monstera", category: "bush", footprint: 0.87, collision: { kind: "none" }, surface: "grass" },
  { id: "vn_tropical_shrub_1", category: "bush", footprint: 1.44, collision: { kind: "none" }, surface: "grass", sink: 0.05 },
  { id: "vn_tropical_shrub_3", category: "bush", footprint: 0.95, collision: { kind: "none" }, surface: "grass", sink: 0.05 },
  { id: "vn_tropical_shrub_5", category: "bush", footprint: 1, collision: { kind: "none" }, surface: "grass" },
  // An open scanned face (no back): place with its back into a slope or cliff, facing downhill.
  { id: "rock_face_large", category: "rock", footprint: 2.6, collision: { kind: "box", size: [3.8, 3.2, 2.6], bulletproof: true }, surface: "concrete", sink: 0.4, cover: true },
  { id: "rock_boulder_large", category: "rock", footprint: 1.4, collision: { kind: "box", size: [2.1, 1.75, 2.1], bulletproof: true }, surface: "concrete", alignToTerrain: true, sink: 0.2, cover: true },
] as const satisfies readonly MapPropDef[];

export type MapPropId = (typeof DEFS)[number]["id"];

export const MAP_PROPS: ReadonlyMap<string, MapPropDef> = new Map(DEFS.map((d) => [d.id, d]));
export const MAP_PROP_IDS: readonly MapPropId[] = DEFS.map((d) => d.id);

export function getMapProp(id: string): MapPropDef {
  const def = MAP_PROPS.get(id);
  if (!def) throw new Error(`Unknown map prop "${id}"`);
  return def;
}
