import { TERRAIN_V1 } from "./terrain/presets";
import type { FlattenRegion, MapData, PointOfInterest, Vec2Tuple } from "./types";

/**
 * Training Yard stand-in: the blockout arena, translated onto a flattened pad. The pad sits `floorClearance` below
 * the arena floor so the terrain hides under the arena's ground slab without z-fighting (a 0.2 m lip is below the
 * 0.35 m step height).
 */
export const TRAINING_YARD = {
  center: [-140, -90] as Vec2Tuple,
  /** Arena footprint including walls is ±36.2 m; the pad adds an 8 m apron. */
  padHalfExtent: 44,
  floorClearance: 0.2,
  /** Gate cut into the arena's north wall (arena-local X range), facing the map center. */
  gateHalfWidth: 4,
} as const;

const POIS: readonly PointOfInterest[] = [
  { id: "town", name: "Central Town", kind: "town", center: [0, 20], radius: 110, lootTier: 2 },
  { id: "farm", name: "Farm", kind: "farm", center: [300, 280], radius: 90, lootTier: 1 },
  { id: "military", name: "Military Compound", kind: "military", center: [320, -260], radius: 90, lootTier: 2 },
  { id: "radar", name: "Radar Hill", kind: "radar", center: [-300, 255], radius: 70, lootTier: 1 },
  { id: "quarry", name: "Quarry", kind: "quarry", center: [-60, -330], radius: 100, lootTier: 1 },
  { id: "forest", name: "Forest Cabins", kind: "forest", center: [-330, -110], radius: 100, lootTier: 0 },
  { id: "training", name: "Training Yard", kind: "training", center: TRAINING_YARD.center, radius: 60, lootTier: 0 },
];

const FLATTEN: readonly FlattenRegion[] = [
  // POI pads first.
  { shape: "circle", center: [0, 20], radius: 75, falloff: 60, height: "auto" },
  { shape: "circle", center: [-300, 255], radius: 16, falloff: 22, height: "auto", surface: "dirt", surfaceFalloff: 4 },
  { shape: "circle", center: [300, 280], radius: 55, falloff: 45, height: "auto" },
  { shape: "rect", center: [320, -260], halfExtents: [65, 50], yaw: 0.3, falloff: 30, height: "auto", surface: "dirt", surfaceFalloff: 4 },
  { shape: "circle", center: [-330, -110], radius: 14, falloff: 16, height: "auto" },
  {
    shape: "rect",
    center: TRAINING_YARD.center,
    halfExtents: [TRAINING_YARD.padHalfExtent, TRAINING_YARD.padHalfExtent],
    falloff: 28,
    height: "auto",
    heightOffset: -TRAINING_YARD.floorClearance,
    surface: "dirt",
    surfaceFalloff: 3,
  },
  // Quarry access: a straight ramp from outside the rim down to the pit floor (~16°).
  { shape: "polyline", points: [[-60, -205], [-60, -292]], width: 7, falloff: 6, height: "auto", profile: "linear", surface: "dirt", surfaceFalloff: 2 },
  // Example roads.
  { shape: "polyline", points: [[0, 20], [-50, -10], [-100, -30], [-140, -48]], width: 6, falloff: 5, height: "auto", surface: "road", surfaceFalloff: 1 },
  { shape: "polyline", points: [[10, -20], [-20, -120], [-50, -185], [-60, -205]], width: 4, falloff: 4, height: "auto", surface: "dirt", surfaceFalloff: 1.5 },
];

/**
 * Draft Map v1 for the dev map mode: terrain, POI pads, two example roads and POI metadata. Buildings, props and
 * scatters are left for the layout pass.
 */
export const DRAFT_MAP_V1: MapData = {
  id: "v1-draft",
  name: "Map v1 (draft)",
  terrain: TERRAIN_V1,
  flatten: FLATTEN,
  bounds: { outOfBoundsGraceSeconds: 5, killY: -40, landingAltitude: 300 },
  pois: POIS,
  buildings: [],
  props: [],
  scatters: [],
  // Just south-west of the town, facing the Training Yard.
  spawns: [{ position: [-40, -25], yaw: -2.1 }],
};
