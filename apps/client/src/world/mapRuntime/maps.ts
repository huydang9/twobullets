import { MAP_V1, MAP_V1_TRAINING_YARD, type MapData } from "@twobullets/shared";
import { REAL_MAPS, findRealMap, type RealMapCreditId } from "@twobullets/shared/map/real/index";
import type { TrainingYardPlacement } from "./trainingYard";

/** Everything `MapRuntime.load` needs for one map: spread it into the load options. */
export interface MapDefinition {
  readonly id: string;
  readonly name: string;
  readonly map: MapData;
  /** Baked terrain for `map` (tools/map/build.ts). */
  readonly bakeUrl: string;
  /** The Training Yard arena and soldier range (Map v1 only); null on real-world maps. */
  readonly trainingYard: TrainingYardPlacement | null;
}

/** A pickable map with the facts menus show, without loading it. */
export interface MapChoice {
  readonly id: string;
  /** Place name (diacritics kept); Map v1's name is localized by the UI (see `fictional`). */
  readonly name: string;
  /** Map v1 is invented; the others are real places. */
  readonly fictional: boolean;
  /** ISO 3166-1 alpha-2, lowercase ("" for Map v1). */
  readonly countryCode: string;
  /** English country name ("" for Map v1). */
  readonly country: string;
  readonly previewUrl: string;
  readonly pois: number;
  readonly buildings: number;
  readonly roadsKm: number | null;
  /** Game relief above the lowest point, m (null for Map v1). */
  readonly reliefMeters: number | null;
  readonly credits: readonly RealMapCreditId[];
  /** OSM snapshot date of a real map. */
  readonly snapshot: string | null;
}

export const MAP_V1_ID = "v1";

function assetUrl(path: string, base: string): string {
  return `${base.endsWith("/") ? base : `${base}/`}${path}`;
}

/** Map v1 first, then the generated real-world maps (recommended default first). */
export function mapChoices(base: string = import.meta.env.BASE_URL): readonly MapChoice[] {
  return [
    {
      id: MAP_V1_ID,
      name: MAP_V1.name,
      fictional: true,
      countryCode: "",
      country: "",
      previewUrl: assetUrl("assets/map/mapV1.preview.svg", base),
      pois: MAP_V1.pois.filter((p) => p.kind !== "training").length,
      buildings: MAP_V1.buildings.length,
      roadsKm: null,
      reliefMeters: null,
      credits: [],
      snapshot: null,
    },
    ...REAL_MAPS.map(({ info }): MapChoice => ({
      id: info.id,
      name: info.name,
      fictional: false,
      countryCode: info.countryCode,
      country: info.country,
      previewUrl: assetUrl(info.previewUrl, base),
      pois: info.stats.pois,
      buildings: info.stats.buildings,
      roadsKm: info.stats.roadsKm,
      reliefMeters: info.elevation.mode === "real" ? info.elevation.relief : null,
      credits: info.credits,
      snapshot: info.osmTimestamp ? info.osmTimestamp.slice(0, 10) : null,
    })),
  ];
}

export function isMapId(id: string | null | undefined): id is string {
  return id === MAP_V1_ID || (id !== null && id !== undefined && findRealMap(id) !== undefined);
}

/**
 * Resolves a map id (`?map=`) to a definition: "v1" is Map v1 with its Training Yard; a real-world id loads that map's
 * module (its own chunk). Null, "arena" or an unknown id (warned) give null: the blockout arena.
 */
export async function resolveMapDefinition(id: string | null | undefined, base: string = import.meta.env.BASE_URL): Promise<MapDefinition | null> {
  if (!id || id === "arena") return null;
  if (id === MAP_V1_ID) return { id, name: MAP_V1.name, map: MAP_V1, bakeUrl: assetUrl("assets/map/mapV1.terrain.bin", base), trainingYard: MAP_V1_TRAINING_YARD };
  const entry = findRealMap(id);
  if (!entry) {
    console.warn(`[map] unknown map "${id}" (known: ${[MAP_V1_ID, ...REAL_MAPS.map((m) => m.info.id)].join(", ")}); loading the arena`);
    return null;
  }
  const module = await entry.load();
  return { id, name: module.info.name, map: module.map, bakeUrl: assetUrl(module.info.bakeUrl, base), trainingYard: null };
}
