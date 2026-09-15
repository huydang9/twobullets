import { pointInPolygon } from "../../layout/geometry";
import type { Vec2Tuple } from "../../types";
import { assembleRings, clipRingToSquare, openRing, signedArea } from "./geometry";
import type { Projection } from "./projection";
import type { AreaFeature, LineFeature, OsmDocument, OsmLatLon, OsmTags, PointFeature } from "./types";

/** OSM data projected into map meters: area features (closed ways and multipolygons), lines and named points. */
export interface ParsedOsm {
  /** Building footprints, unclipped. */
  readonly buildings: readonly AreaFeature[];
  /** Land use, natural areas, leisure and water areas, clipped to the fetch square. */
  readonly areas: readonly AreaFeature[];
  /** Highways and waterways (unclipped). */
  readonly lines: readonly LineFeature[];
  /** Named nodes: places, amenities, attractions. */
  readonly points: readonly PointFeature[];
  /** OSM snapshot time from the Overpass header, if present. */
  readonly timestamp: string | null;
}

const AREA_KEYS = ["landuse", "natural", "leisure", "water", "amenity"] as const;
/** Closed ways with these tags are areas even when also tagged as something linear. */
const LINEAR_NATURAL = new Set(["tree_row", "cliff", "coastline", "ridge"]);

/** Splits a way geometry at missing nodes and projects each piece. */
function projectPieces(geometry: readonly (OsmLatLon | null)[] | undefined, projection: Projection): Vec2Tuple[][] {
  if (!geometry) return [];
  const pieces: Vec2Tuple[][] = [];
  let current: Vec2Tuple[] = [];
  for (const node of geometry) {
    if (!node) {
      if (current.length >= 2) pieces.push(current);
      current = [];
      continue;
    }
    const p = projection.project(node.lat, node.lon);
    const last = current[current.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) current.push(p);
  }
  if (current.length >= 2) pieces.push(current);
  return pieces;
}

function isClosed(points: readonly Vec2Tuple[]): boolean {
  const a = points[0]!;
  const b = points[points.length - 1]!;
  return points.length >= 4 && Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
}

function isAreaTagged(tags: OsmTags): boolean {
  if (tags.area === "no") return false;
  if (tags.natural && LINEAR_NATURAL.has(tags.natural)) return false;
  return AREA_KEYS.some((key) => tags[key] !== undefined) || tags.waterway === "riverbank";
}

/** Builds area features from outer/inner rings: holes attach to the outer ring that contains them. */
function areaFeatures(id: number, tags: OsmTags, outers: readonly Vec2Tuple[][], inners: readonly Vec2Tuple[][], clipHalf: number | null): AreaFeature[] {
  const out: AreaFeature[] = [];
  for (const rawOuter of outers) {
    const outer = clipHalf === null ? rawOuter : clipRingToSquare(rawOuter, clipHalf);
    if (outer.length < 3) continue;
    const holes = inners
      .filter((inner) => inner.length >= 3 && pointInPolygon(rawOuter, inner[0]![0], inner[0]![1]))
      .map((inner) => (clipHalf === null ? inner : clipRingToSquare(inner, clipHalf)))
      .filter((inner) => inner.length >= 3);
    const area = Math.abs(signedArea(outer)) - holes.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0);
    if (area > 1) out.push({ id, tags, outer, holes, area });
  }
  return out;
}

/**
 * Projects an Overpass `out geom` document. Areas are clipped to the square |x|, |z| ≤ `clipHalf`; buildings and lines
 * are left whole (their converters clip or filter them).
 */
export function parseOsm(doc: OsmDocument, projection: Projection, clipHalf: number): ParsedOsm {
  const buildings: AreaFeature[] = [];
  const areas: AreaFeature[] = [];
  const lines: LineFeature[] = [];
  const points: PointFeature[] = [];

  // Deterministic order regardless of the server's output order.
  const elements = [...doc.elements].sort((a, b) => (a.type === b.type ? a.id - b.id : a.type < b.type ? -1 : 1));
  for (const element of elements) {
    const tags = element.tags ?? {};
    if (element.type === "node") {
      if (tags.name || tags.place) points.push({ id: element.id, tags, at: projection.project(element.lat, element.lon) });
      continue;
    }
    if (element.type === "way") {
      const pieces = projectPieces(element.geometry, projection);
      if (pieces.length === 0) continue;
      const closed = pieces.length === 1 && isClosed(pieces[0]!);
      if (tags.building && closed) {
        buildings.push(...areaFeatures(element.id, tags, [openRing(pieces[0]!)], [], null));
      } else if (!tags.highway && closed && isAreaTagged(tags)) {
        areas.push(...areaFeatures(element.id, tags, [openRing(pieces[0]!)], [], clipHalf));
      }
      if (tags.highway || tags.waterway || tags.natural === "tree_row") {
        if (tags.highway && tags.area === "yes") continue;
        for (const piece of pieces) lines.push({ id: element.id, tags, points: piece });
      }
      continue;
    }
    // Relations: multipolygons (buildings, land use, water, riverbanks).
    if (tags.type !== undefined && tags.type !== "multipolygon") continue;
    const members = element.members ?? [];
    const outers = assembleRings(members.filter((m) => m.type === "way" && m.role !== "inner").flatMap((m) => projectPieces(m.geometry, projection)));
    const inners = assembleRings(members.filter((m) => m.type === "way" && m.role === "inner").flatMap((m) => projectPieces(m.geometry, projection)));
    // Relation ids are negated so they never collide with way ids.
    if (tags.building) buildings.push(...areaFeatures(-element.id, tags, outers, inners, null));
    else if (isAreaTagged(tags)) areas.push(...areaFeatures(-element.id, tags, outers, inners, clipHalf));
  }
  return { buildings, areas, lines, points, timestamp: doc.osm3s?.timestamp_osm_base ?? null };
}
