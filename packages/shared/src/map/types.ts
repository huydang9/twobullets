/**
 * MapData: the data contract for a battle royale map. Everything here is plain, serializable data, so the same
 * file drives the client, the headless server and editor tooling.
 *
 * Conventions (same as the level code): meters, Y up, +X = east, +Z = north, yaw 0 = facing +Z and π/2 = facing +X.
 * The map is centered on the world origin. All heights are absolute world Y.
 */
import type { Vec3Tuple } from "../level/types";
import type { BuildingPlacement } from "./buildings/types";

export type Vec2Tuple = readonly [x: number, z: number];

// ---------------------------------------------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------------------------------------------

/** Ground surface layers, in mask channel order (R, G, B, A). Shared by footsteps, impacts and the terrain material. */
export const TERRAIN_SURFACES = ["grass", "dirt", "rock", "road"] as const;
export type TerrainSurface = (typeof TERRAIN_SURFACES)[number];

/** Procedural relief: layered noise around a base height. Amplitudes are meters, wavelengths are meters per cycle. */
export interface TerrainRelief {
  readonly baseHeight: number;
  /** Large rolling landforms. */
  readonly macroAmplitude: number;
  readonly macroWavelength: number;
  /** Hills and valleys a player walks over. */
  readonly hillAmplitude: number;
  readonly hillWavelength: number;
  /** Small bumps that break up flat ground (keep well under a meter). */
  readonly detailAmplitude: number;
  readonly detailWavelength: number;
  /** Domain-warp distance: bends the noise so hills don't line up on a grid. */
  readonly warp: number;
}

/** Out-of-bounds mountain ring outside the playable square. */
export interface TerrainBorder {
  /** Distance inside the playable edge where foothills start rising, m. */
  readonly foothillInset: number;
  /** Distance outside the playable edge where the mountains reach full height, m. */
  readonly rampDistance: number;
  /** Mountain height above the relief, m. */
  readonly height: number;
  /** Wavelength of the ridged mountain noise, m. */
  readonly ridgeWavelength: number;
}

/** Authored landforms blended into the relief before flattening. Heights are relative to the relief (not absolute). */
export type TerrainFeature =
  /** Smooth dome, e.g. a lookout hill. */
  | { readonly kind: "hill"; readonly center: Vec2Tuple; readonly radius: number; readonly height: number }
  /** Raised crest along a polyline (radar hill). `width` is the full base width. */
  | { readonly kind: "ridge"; readonly path: readonly Vec2Tuple[]; readonly width: number; readonly height: number }
  /** Lowered channel along a polyline (valleys, dry river beds). */
  | { readonly kind: "valley"; readonly path: readonly Vec2Tuple[]; readonly width: number; readonly depth: number }
  /**
   * Pit with a flat floor and terraced walls (quarry). Floor within `floorRadius`, rim at `radius`.
   * Walls between benches are steeper than the 50° walk limit, so access needs a flatten ramp.
   */
  | {
      readonly kind: "basin";
      readonly center: Vec2Tuple;
      readonly radius: number;
      readonly floorRadius: number;
      readonly depth: number;
      readonly terraces: number;
    }
  /**
   * Sampled relief (real-world elevation): `columns` × `rows` heights `spacing` m apart, row-major from `origin` (the
   * south-west sample), added to the relief with a Catmull-Rom bicubic spline. Outside the grid the edge samples extend.
   */
  | {
      readonly kind: "heightGrid";
      readonly origin: Vec2Tuple;
      readonly spacing: number;
      readonly columns: number;
      readonly rows: number;
      readonly heights: readonly number[];
    };

export interface TerrainSpec {
  /** Bump when generation changes in a way that alters heights for the same inputs. */
  readonly version: 1;
  /** uint32 seed for all terrain noise. */
  readonly seed: number;
  /** Side of the square heightfield (playable area + border), m. */
  readonly size: number;
  /** Samples per side. Use 2^k + 1 so chunks and physics downsampling line up (1025 → 1.25 m spacing at 1280 m). */
  readonly resolution: number;
  /** Half size of the square players may land in and move around, m (1 km map → 500). The border lies outside it. */
  readonly playableHalfExtent: number;
  readonly relief: TerrainRelief;
  readonly border: TerrainBorder;
  readonly features: readonly TerrainFeature[];
}

/**
 * How a flatten region combines with the terrain under it.
 * `set` cuts and fills, `cut` only lowers ground above the target, `fill` only raises ground below it.
 */
export type FlattenMode = "set" | "cut" | "fill";

interface FlattenCommon {
  /**
   * Absolute target height, or "auto": the mean terrain height over the footprint (circle/rect) or the
   * terrain height at each polyline point, smoothed along the path. Resolved against the terrain as it is
   * when this region is applied (regions apply in array order).
   */
  readonly height: number | "auto";
  /** Width of the blend band outside the shape where the terrain eases back to natural, m. */
  readonly falloff: number;
  readonly mode?: FlattenMode;
  /** Paint this surface over the shape (for example "road" or "dirt"). */
  readonly surface?: TerrainSurface;
  /** Soft edge of the painted surface outside the shape, m. Defaults to min(falloff, 1.5). */
  readonly surfaceFalloff?: number;
  /** Offset applied after resolving `height`, e.g. -0.2 to sink a pad under a building floor slab. */
  readonly heightOffset?: number;
}

export type FlattenRegion =
  | (FlattenCommon & { readonly shape: "circle"; readonly center: Vec2Tuple; readonly radius: number })
  | (FlattenCommon & {
      readonly shape: "rect";
      readonly center: Vec2Tuple;
      /** Half size along the rect's local X and Z before rotation. */
      readonly halfExtents: Vec2Tuple;
      /** Rotation around Y in radians (local +Z turns toward world (sin, 0, cos)). */
      readonly yaw?: number;
    })
  | (FlattenCommon & {
      readonly shape: "polyline";
      /**
       * Path points [x, z] or [x, z, y]. A point's y pins the height there (a number `height` pins every point).
       */
      readonly points: readonly (Vec2Tuple | Vec3Tuple)[];
      /** Full width of the flat part, m. */
      readonly width: number;
      /**
       * Height between points. `follow` (default): ride the terrain, smoothed over ~40 m. `linear`: straight grade
       * between consecutive points (a point without y takes the terrain height there), e.g. a quarry ramp.
       */
      readonly profile?: "follow" | "linear";
    });

// ---------------------------------------------------------------------------------------------------------------
// Placements and points of interest
// ---------------------------------------------------------------------------------------------------------------

/**
 * A building prefab placed on the map. Position and yaw follow BuildingPlacement from the buildings kit (origin at
 * the ground-floor finished floor level, footprint center); `prefab` is a BuildingPrefab id. Flatten the prefab's
 * footprint with a rect region whose height sits a little below `position[1]`, or use `snapToTerrain`.
 */
export interface MapBuilding extends BuildingPlacement {
  readonly id: string;
  readonly prefab: string;
  /** Resolve Y from the terrain at load (after flattening) instead of using position[1]. */
  readonly snapToTerrain?: boolean;
  /** Point of interest this building belongs to, for loot tables and map labels. */
  readonly poi?: string;
}

/** Instanced environment props: trees, rocks, fences, crates. Rendered with thin instances; collision per catalog entry. */
export interface PropPlacement {
  /** Catalog id, e.g. "tree_pine_a". */
  readonly prop: string;
  readonly position: Vec3Tuple;
  readonly yaw: number;
  readonly scale?: number;
  /** Tilt to the terrain normal (rocks, small debris). Trees stay upright. */
  readonly alignToTerrain?: boolean;
  readonly snapToTerrain?: boolean;
}

/** Scatter rule for dense props (forests, grass clumps). Expanded deterministically from the map seed. */
export interface PropScatter {
  readonly id: string;
  readonly props: readonly { readonly prop: string; readonly weight: number }[];
  /** Area to fill: a closed polygon of [x, z] points. */
  readonly area: readonly Vec2Tuple[];
  /** Instances per 100 m². */
  readonly density: number;
  /** Rejects spots steeper than this, degrees. */
  readonly maxSlopeDegrees?: number;
  /** Rejects spots whose dominant surface is in this list (e.g. keep trees off roads). */
  readonly excludeSurfaces?: readonly TerrainSurface[];
  readonly scaleRange?: readonly [min: number, max: number];
}

export type PoiKind = "town" | "farm" | "military" | "radar" | "quarry" | "forest" | "training" | "village";

export interface PointOfInterest {
  readonly id: string;
  readonly name: string;
  readonly kind: PoiKind;
  /** Label anchor and the center used for loot density and landing hints. */
  readonly center: Vec2Tuple;
  /** Rough extent for map UI and loot tiering, m. */
  readonly radius: number;
  /** 0 = sparse outskirts, 1 = normal, 2 = hot drop. */
  readonly lootTier: 0 | 1 | 2;
}

/**
 * A named road for map labels (real-world maps): same-name OSM ways merged and clipped to the playable square. Labels
 * only; the road surfaces themselves are `flatten` polylines.
 */
export interface RoadLabel {
  readonly name: string;
  /** 0 trunk or primary, 1 secondary, 2 tertiary, 3 any other named road: label priority. */
  readonly rank: 0 | 1 | 2 | 3;
  /** Total centerline length inside the map, m. */
  readonly length: number;
  /** Centerlines (continuous chains), m. */
  readonly lines: readonly (readonly Vec2Tuple[])[];
}

/**
 * A named building (real-world maps): labeled on the map screen and signed on its facade. Not a POI: it adds no spawns,
 * loot tier or spacing rules.
 */
export interface MapLandmark {
  readonly name: string;
  /** `MapBuilding.id` it names; its entrance side (+Z) is the facade that gets the sign. */
  readonly building: string;
  /** Label anchor: the building's footprint center, m. */
  readonly center: Vec2Tuple;
}

/** Gameplay limits. The playable square itself is `terrain.playableHalfExtent`, so terrain and bounds can't disagree. */
export interface MapBounds {
  /** Players outside the playable square get this long before being pushed back or killed, s. */
  readonly outOfBoundsGraceSeconds: number;
  /** Players below this Y are respawned or killed. */
  readonly killY: number;
  /** Landing: glide start altitude above the highest terrain, m. Landing targets are clamped to the playable square. */
  readonly landingAltitude: number;
}

/** Fixed spawn used before the landing phase exists (dev map mode, training). */
export interface MapSpawn {
  /** Feet [x, z]; Y is resolved from the terrain. */
  readonly position: Vec2Tuple;
  readonly yaw: number;
}

export interface MapData {
  readonly id: string;
  readonly name: string;
  readonly terrain: TerrainSpec;
  /** Applied in order after generation: POI pads first, then roads, so roads cut cleanly through pad edges. */
  readonly flatten: readonly FlattenRegion[];
  readonly bounds: MapBounds;
  readonly pois: readonly PointOfInterest[];
  readonly buildings: readonly MapBuilding[];
  readonly props: readonly PropPlacement[];
  readonly scatters: readonly PropScatter[];
  readonly spawns: readonly MapSpawn[];
  /** Road names the map screen draws along big roads (real-world maps; absent when none qualify). */
  readonly roadLabels?: readonly RoadLabel[];
  /** Named buildings for map labels and facade signs (real-world maps; absent when none). */
  readonly landmarks?: readonly MapLandmark[];
}
