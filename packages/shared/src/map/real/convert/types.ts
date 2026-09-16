import type { Vec2Tuple } from "../../types";
import type { WildernessOptions } from "./wilderness";

/**
 * Input contract of the real-world map converter: the parts of an Overpass API `out geom` response it reads, plus a
 * sampled elevation grid. Everything here is plain data, so the converter is pure and unit-testable with a fixture.
 */

export interface OsmLatLon {
  readonly lat: number;
  readonly lon: number;
}

export type OsmTags = Readonly<Record<string, string>>;

export interface OsmNode {
  readonly type: "node";
  readonly id: number;
  readonly lat: number;
  readonly lon: number;
  readonly tags?: OsmTags;
}

export interface OsmWay {
  readonly type: "way";
  readonly id: number;
  readonly tags?: OsmTags;
  /** `out geom`: one lat/lon per node (null for nodes outside the query bbox on some servers). */
  readonly geometry?: readonly (OsmLatLon | null)[];
}

export interface OsmRelationMember {
  readonly type: "node" | "way" | "relation";
  readonly ref: number;
  readonly role: string;
  readonly geometry?: readonly (OsmLatLon | null)[];
}

export interface OsmRelation {
  readonly type: "relation";
  readonly id: number;
  readonly tags?: OsmTags;
  readonly members?: readonly OsmRelationMember[];
}

export type OsmElement = OsmNode | OsmWay | OsmRelation;

export interface OsmDocument {
  readonly osm3s?: { readonly timestamp_osm_base?: string; readonly copyright?: string };
  readonly elements: readonly OsmElement[];
}

/**
 * Elevation above sea level on a regular local grid centered on the place: `columns` × `rows` samples `spacing` m
 * apart, row-major from the south-west corner (x = -half, z = -half). Heights in meters.
 */
export interface ElevationSamples {
  readonly spacing: number;
  readonly columns: number;
  readonly rows: number;
  readonly heights: readonly number[];
}

/** How real elevation becomes game terrain. */
export interface ElevationOptions {
  /** `real`: scaled DEM relief; `flat`: gentle procedural relief only (the DEM is ignored). */
  readonly mode: "real" | "flat";
  /** Multiplies relief above the lowest playable point (Shirakawa-go uses about 0.3). */
  readonly scale: number;
  /** Relief above the lowest playable point is compressed smoothly toward this, m. */
  readonly maxRelief: number;
}

/** Everything about one place the converter needs besides its data. */
export interface PlaceConfig {
  /** Map id (URL `?map=<id>`, file names). Lowercase letters, digits and dashes. */
  readonly id: string;
  /** Display name, diacritics kept. */
  readonly name: string;
  /** Country display name (English; the picker localizes by `countryCode`). */
  readonly country: string;
  /** ISO 3166-1 alpha-2, lowercase. */
  readonly countryCode: string;
  readonly lat: number;
  readonly lon: number;
  readonly elevation: ElevationOptions;
  /** Buildings kept at most (the rest are thinned from the outskirts first). Default 90. */
  readonly buildingCap?: number;
  /** Tree palette: temperate conifers and broadleaf, or broadleaf only. */
  readonly climate?: "temperate" | "tropical";
  /** Words appended to split POI names: [north, south, east, west]. Default English. */
  readonly directionWords?: readonly [north: string, south: string, east: string, west: string];
  /** Settlement name used for POIs when OSM has no place node nearby (e.g. "Cẩm Thanh"). */
  readonly localName?: string;
  /** Generic POI name when nothing nearby is named: [village, farm, forest]. Default English. */
  readonly genericNames?: readonly [village: string, farm: string, forest: string];
  /** Terrain seed; defaults to a hash of the id. */
  readonly seed?: number;
  /**
   * Named buildings by OSM way id (a negative id is a relation). A footprint the regular pass leaves out is placed after
   * it (over the cap) with `prefab`, or its mapped prefab, facing `frontsWay`; the converter reports any that still get no building. Names go
   * through the political filter like POI names.
   */
  readonly landmarks?: readonly { readonly osmId: number; readonly name: string; readonly prefab?: string; /** OSM way id of the street its entrance faces (default the nearest road). */ readonly frontsWay?: number }[];
  /** Dense city mode (Saigon streets); absent for villages, whose output it never changes. See `convert/urban.ts`. */
  readonly urban?: UrbanOptions;
  /**
   * Hills and tropical woodland over the ground the OSM square never covers (`convert/wilderness.ts`). Defaults to on
   * for city maps, which have no village groves to fill their outskirts, and off for villages, whose output it never
   * changes. `false` turns it off.
   */
  readonly wilderness?: WildernessOptions | false;
}

/** How a dense city square is built: tube-house rows along the real streets, paved alleys, landmark names. */
export interface UrbanOptions {
  /** No frontage rows within this distance of the center, so the junction stays open to fight in, m. Default 40. */
  readonly openCenter?: number;
  /** Row houses before a walk-through gap between rows. Default 6. */
  readonly rowLength?: number;
  /** At most this many buildings per 100 m grid cell, so the cap spreads over the map. Default 14. */
  readonly cellQuota?: number;
}

export type Polygon = readonly Vec2Tuple[];

/** A projected area feature: outer ring and holes, clipped to the map square. */
export interface AreaFeature {
  readonly id: number;
  readonly tags: OsmTags;
  readonly outer: Polygon;
  readonly holes: readonly Polygon[];
  /** Area of `outer` minus holes, m². */
  readonly area: number;
}

/** A projected line feature (roads, streams), clipped to the map square; one entry per clipped piece. */
export interface LineFeature {
  readonly id: number;
  readonly tags: OsmTags;
  readonly points: readonly Vec2Tuple[];
}

/** A projected named point. */
export interface PointFeature {
  readonly id: number;
  readonly tags: OsmTags;
  readonly at: Vec2Tuple;
}
