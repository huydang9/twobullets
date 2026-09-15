import { round3 } from "../../layout/geometry";
import { sinCos } from "../../terrain/math";
import type { Vec2Tuple } from "../../types";

/**
 * Local projection around a place center: +X east, +Z north, meters. An equirectangular tangent plane with the WGS84
 * meters-per-degree series at the center latitude; over a 1.3 km square the distortion stays under a centimeter.
 * Uses the deterministic `sinCos`, so every engine projects identically.
 */
export interface Projection {
  readonly lat: number;
  readonly lon: number;
  readonly metersPerDegreeLat: number;
  readonly metersPerDegreeLon: number;
  /** Projects to local meters, rounded to millimeters. */
  project(lat: number, lon: number): Vec2Tuple;
  unproject(x: number, z: number): { lat: number; lon: number };
}

const DEG = Math.PI / 180;

export function createProjection(lat: number, lon: number): Projection {
  const c1 = sinCos(lat * DEG).cos;
  const c2 = sinCos(2 * lat * DEG).cos;
  const c3 = sinCos(3 * lat * DEG).cos;
  const c4 = sinCos(4 * lat * DEG).cos;
  const metersPerDegreeLat = 111132.92 - 559.82 * c2 + 1.175 * c4;
  const metersPerDegreeLon = 111412.84 * c1 - 93.5 * c3;
  return {
    lat,
    lon,
    metersPerDegreeLat,
    metersPerDegreeLon,
    project: (pLat, pLon) => [round3((pLon - lon) * metersPerDegreeLon), round3((pLat - lat) * metersPerDegreeLat)],
    unproject: (x, z) => ({ lat: lat + z / metersPerDegreeLat, lon: lon + x / metersPerDegreeLon }),
  };
}

/** [south, west, north, east] in degrees (Overpass bbox order) of the square of `halfMeters` around a center. */
export function bboxAround(lat: number, lon: number, halfMeters: number): [south: number, west: number, north: number, east: number] {
  const p = createProjection(lat, lon);
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  const sw = p.unproject(-halfMeters, -halfMeters);
  const ne = p.unproject(halfMeters, halfMeters);
  return [r(sw.lat), r(sw.lon), r(ne.lat), r(ne.lon)];
}
