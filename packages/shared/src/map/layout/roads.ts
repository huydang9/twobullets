import type { FlattenRegion, MapData, Vec2Tuple } from "../types";
import { catmullRom, polylineLength } from "./geometry";

export type RoadKind = "asphalt" | "dirt";

/** Authored road: control points joined by a smooth curve. Becomes a flatten polyline painted road or dirt. */
export interface RoadSpec {
  readonly id: string;
  readonly kind: RoadKind;
  readonly points: readonly Vec2Tuple[];
  /** Keep straight segments between control points (town streets). Default false: Catmull-Rom curve. */
  readonly straight?: boolean;
  /** Flat width, m. Default: the kind's `ROAD_STYLES` width (real-world maps set it per road class). */
  readonly width?: number;
}

export const ROAD_STYLES: Readonly<Record<RoadKind, { width: number; falloff: number; surfaceFalloff: number }>> = {
  asphalt: { width: 7, falloff: 5, surfaceFalloff: 1 },
  dirt: { width: 4.5, falloff: 4, surfaceFalloff: 1.5 },
};

/** Curve sample spacing, m (the flatten pass resamples at 4 m). */
const CURVE_STEP = 8;

export function roadFlatten(road: RoadSpec): FlattenRegion {
  const style = ROAD_STYLES[road.kind];
  return {
    shape: "polyline",
    points: road.straight ? road.points : catmullRom(road.points, CURVE_STEP),
    width: road.width ?? style.width,
    falloff: style.falloff,
    height: "auto",
    surface: road.kind === "asphalt" ? "road" : "dirt",
    surfaceFalloff: style.surfaceFalloff,
  };
}

/** A painted path from the map's flatten list (roads, streets, ramps), for clearance tests and scatter exclusion. */
export interface MapPath {
  readonly index: number;
  readonly kind: RoadKind;
  readonly points: readonly Vec2Tuple[];
  readonly halfWidth: number;
  readonly length: number;
}

/** Every painted polyline in the flatten list: road paint is asphalt, dirt paint is a dirt road or ramp. */
export function mapPaths(map: Pick<MapData, "flatten">): MapPath[] {
  const paths: MapPath[] = [];
  map.flatten.forEach((region, index) => {
    if (region.shape !== "polyline" || (region.surface !== "road" && region.surface !== "dirt")) return;
    const points = region.points.map((p): Vec2Tuple => [p[0], p[1]]);
    paths.push({ index, kind: region.surface === "road" ? "asphalt" : "dirt", points, halfWidth: region.width / 2, length: polylineLength(points) });
  });
  return paths;
}
