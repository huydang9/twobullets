import type { LineOpening } from "../layout/placement";
import type { RoadSpec } from "../layout/roads";
import type { ValidationOptions } from "../layout/validate";
import type { MapData, Vec2Tuple } from "../types";

/** Attribution a real map needs wherever it is shown (see apps/client/public/assets/map/credits.json). */
export type RealMapCreditId = "osm" | "terrain-tiles" | "eu-dem";

/** Small, always-loaded facts about a generated real-world map (the picker shows these without loading the map). */
export interface RealMapInfo {
  readonly id: string;
  /** Diacritics kept. */
  readonly name: string;
  /** English country name; UIs localize by `countryCode`. */
  readonly country: string;
  readonly countryCode: string;
  readonly lat: number;
  readonly lon: number;
  /** OSM snapshot the map was generated from (Overpass `timestamp_osm_base`). */
  readonly osmTimestamp: string | null;
  /** Public asset paths, relative to the client base URL. */
  readonly bakeUrl: string;
  readonly previewUrl: string;
  readonly elevation: {
    readonly mode: "real" | "flat";
    readonly scale: number;
    /** Real elevation inside the playable square, m above sea level (null when flat). */
    readonly realMin: number | null;
    readonly realMax: number | null;
    /** Game relief above the lowest point, m. */
    readonly relief: number;
  };
  readonly stats: {
    readonly pois: number;
    readonly buildings: number;
    /** Footprints that mapped to a prefab. */
    readonly buildingCandidates: number;
    readonly spawns: number;
    readonly roadsKm: number;
    readonly waterHa: number;
  };
  readonly credits: readonly RealMapCreditId[];
}

/** A generated real-world map module (`packages/shared/src/map/real/<id>.ts`). */
export interface RealMapModule {
  readonly info: RealMapInfo;
  readonly map: MapData;
  readonly roads: readonly RoadSpec[];
  /** Water outlines (fenced off, not walkable; no water renderer yet). */
  readonly water: readonly (readonly Vec2Tuple[])[];
  readonly openings: readonly LineOpening[];
  /** Options this map validates with (POI spacing for villages, fence openings). */
  readonly validation: ValidationOptions;
}
