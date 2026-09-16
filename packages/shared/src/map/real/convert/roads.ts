import { distance, polylineLength, round3 } from "../../layout/geometry";
import type { RoadKind, RoadSpec } from "../../layout/roads";
import type { FlattenRegion, Vec2Tuple } from "../../types";
import { clipPolylineToSquare, simplifyPolyline } from "./geometry";
import type { LineFeature, OsmTags } from "./types";

/** Roads stop this far inside the playable edge, m (the border foothills start 20 m in). */
export const ROAD_CLIP = 244;

interface RoadClass {
  readonly kind: RoadKind;
  readonly width: number;
  /** Chains shorter than this are dropped (driveway stubs), m. */
  readonly minLength: number;
}

/** OSM highway classes kept as roads. Motorways (tunnels and viaducts in these places), footways and paths are skipped. */
const CLASSES: Readonly<Record<string, RoadClass>> = {
  trunk: { kind: "asphalt", width: 8, minLength: 10 },
  trunk_link: { kind: "asphalt", width: 6, minLength: 10 },
  primary: { kind: "asphalt", width: 7.5, minLength: 10 },
  primary_link: { kind: "asphalt", width: 6, minLength: 10 },
  secondary: { kind: "asphalt", width: 7, minLength: 10 },
  secondary_link: { kind: "asphalt", width: 6, minLength: 10 },
  tertiary: { kind: "asphalt", width: 6.5, minLength: 10 },
  tertiary_link: { kind: "asphalt", width: 5.5, minLength: 10 },
  residential: { kind: "asphalt", width: 5.5, minLength: 15 },
  living_street: { kind: "asphalt", width: 4.5, minLength: 15 },
  pedestrian: { kind: "asphalt", width: 4.5, minLength: 20 },
  road: { kind: "dirt", width: 4.5, minLength: 20 },
  unclassified: { kind: "dirt", width: 5, minLength: 15 },
  service: { kind: "dirt", width: 3.8, minLength: 35 },
  track: { kind: "dirt", width: 3.5, minLength: 40 },
};

const PAVED = new Set(["asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes", "paving_stones", "sett", "cobblestone", "chipseal", "metal", "wood"]);
const UNPAVED = new Set(["unpaved", "gravel", "fine_gravel", "dirt", "ground", "earth", "grass", "compacted", "sand", "mud", "pebblestone", "grass_paver", "rock"]);
const SKIPPED_SERVICE = new Set(["driveway", "parking_aisle", "drive-through", "emergency_access"]);

/** Foot and cycle bridges: the only river crossing in some villages (Shirakawa-gō's Deai-bashi). */
const FOOTBRIDGE: RoadClass = { kind: "asphalt", width: 3, minLength: 8 };
const FOOT_WAYS = new Set(["footway", "path", "pedestrian", "cycleway", "bridleway"]);

/** City alleys (hẻm) and service lanes are paved concrete, narrower than village service roads. */
const URBAN_SERVICE_WIDTH = 3.5;

export function roadClassOf(tags: OsmTags, urban = false): RoadClass | null {
  if (FOOT_WAYS.has(tags.highway ?? "") && tags.bridge && tags.bridge !== "no") return { ...FOOTBRIDGE, kind: tags.surface && UNPAVED.has(tags.surface) ? "dirt" : "asphalt" };
  const base = CLASSES[tags.highway ?? ""];
  if (!base) return null;
  if (tags.tunnel && tags.tunnel !== "no") return null;
  if (tags.highway === "service" && tags.service && SKIPPED_SERVICE.has(tags.service)) return null;
  if (tags.access === "private" && tags.highway === "service") return null;
  const surface = tags.surface ?? "";
  const kind: RoadKind = PAVED.has(surface) ? "asphalt" : UNPAVED.has(surface) ? "dirt" : urban ? "asphalt" : base.kind;
  const tagged = Number.parseFloat(tags.width ?? "");
  const fallback = urban && tags.highway === "service" ? URBAN_SERVICE_WIDTH : base.width;
  const width = Number.isFinite(tagged) && tagged >= 2.5 ? Math.min(9, Math.max(3.5, tagged)) : fallback;
  return { kind, width, minLength: base.minLength };
}

export interface RoadReport {
  readonly asphaltKm: number;
  readonly dirtKm: number;
  readonly roads: number;
  readonly droppedStubs: number;
}

/**
 * OSM highways to `RoadSpec`s: classified, joined into chains where same-style ways meet end to end, simplified to 1 m,
 * clipped inside the playable edge and stripped of short stubs. Every road keeps straight legs (the OSM geometry already
 * follows the curve).
 */
export function convertRoads(lines: readonly LineFeature[], urban = false): { roads: RoadSpec[]; report: RoadReport } {
  interface Piece {
    readonly key: string;
    readonly cls: RoadClass;
    readonly osmClass: string;
    readonly id: number;
    points: Vec2Tuple[];
  }
  const pieces: Piece[] = [];
  for (const line of lines) {
    const cls = roadClassOf(line.tags, urban);
    if (!cls) continue;
    pieces.push({ key: `${cls.kind}:${cls.width}`, cls, osmClass: line.tags.highway!, id: line.id, points: [...line.points] });
  }

  // Join end-to-end pieces of the same style where exactly two meet (no junction), so a road is one flatten polyline.
  const endKey = (p: Vec2Tuple) => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`;
  const degree = new Map<string, number>();
  for (const piece of pieces) {
    for (const end of [piece.points[0]!, piece.points[piece.points.length - 1]!]) degree.set(endKey(end), (degree.get(endKey(end)) ?? 0) + 1);
  }
  const merged: Piece[] = [];
  const used = new Set<Piece>();
  for (const piece of pieces) {
    if (used.has(piece)) continue;
    used.add(piece);
    let points = piece.points;
    for (let grew = true; grew; ) {
      grew = false;
      for (const other of pieces) {
        if (used.has(other) || other.key !== piece.key) continue;
        const head = points[0]!;
        const tail = points[points.length - 1]!;
        const oHead = other.points[0]!;
        const oTail = other.points[other.points.length - 1]!;
        const joint = (p: Vec2Tuple) => degree.get(endKey(p)) === 2;
        if (endKey(tail) === endKey(oHead) && joint(tail)) points = [...points, ...other.points.slice(1)];
        else if (endKey(tail) === endKey(oTail) && joint(tail)) points = [...points, ...[...other.points].reverse().slice(1)];
        else if (endKey(head) === endKey(oTail) && joint(head)) points = [...other.points.slice(0, -1), ...points];
        else if (endKey(head) === endKey(oHead) && joint(head)) points = [...[...other.points].reverse().slice(0, -1), ...points];
        else continue;
        used.add(other);
        grew = true;
      }
    }
    merged.push({ ...piece, points });
  }

  const roads: RoadSpec[] = [];
  let asphalt = 0;
  let dirt = 0;
  let dropped = 0;
  const idCount = new Map<string, number>();
  // Longer and wider roads first, so they flatten first and side roads cut into them.
  merged.sort((a, b) => b.cls.width - a.cls.width || polylineLength(b.points) - polylineLength(a.points) || a.id - b.id);
  for (const piece of merged) {
    for (const clipped of clipPolylineToSquare(piece.points, ROAD_CLIP)) {
      const points = simplifyPolyline(dedupe(clipped), 1).map((p): Vec2Tuple => [round3(p[0]), round3(p[1])]);
      const length = polylineLength(points);
      if (points.length < 2 || length < piece.cls.minLength) {
        dropped++;
        continue;
      }
      const base = `${piece.osmClass}_${piece.id}`;
      const n = idCount.get(base) ?? 0;
      idCount.set(base, n + 1);
      roads.push({ id: n === 0 ? base : `${base}_${n}`, kind: piece.cls.kind, straight: true, width: piece.cls.width, points });
      if (piece.cls.kind === "asphalt") asphalt += length;
      else dirt += length;
    }
  }
  return { roads, report: { asphaltKm: round3(asphalt / 1000), dirtKm: round3(dirt / 1000), roads: roads.length, droppedStubs: dropped } };
}

function dedupe(points: readonly Vec2Tuple[]): Vec2Tuple[] {
  const out: Vec2Tuple[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || distance(last[0], last[1], p[0], p[1]) > 0.05) out.push(p);
  }
  return out;
}

/** Stream classes that become dry creek beds: [flat width, cut depth, falloff], m. */
const CREEKS: Readonly<Record<string, readonly [number, number, number]>> = {
  river: [6, 1.4, 5],
  canal: [4, 1, 3],
  stream: [2.5, 0.8, 3],
  ditch: [1.8, 0.5, 2],
  drain: [1.8, 0.5, 2],
};

/**
 * Streams and ditches as dry creek beds: cut flatten polylines painted dirt (so scatter and buildings keep off them,
 * like dirt tracks). Skips waterways inside water areas (those are excluded areas) and culverts.
 */
export function convertCreeks(lines: readonly LineFeature[], insideWater: (x: number, z: number) => boolean): FlattenRegion[] {
  const out: FlattenRegion[] = [];
  for (const line of [...lines].sort((a, b) => a.id - b.id)) {
    const spec = CREEKS[line.tags.waterway ?? ""];
    if (!spec || line.tags.tunnel === "culvert" || (line.tags.tunnel && line.tags.tunnel !== "no")) continue;
    const [width, depth, falloff] = spec;
    for (const clipped of clipPolylineToSquare(line.points, ROAD_CLIP)) {
      const dry: Vec2Tuple[][] = [[]];
      for (const p of simplifyPolyline(dedupe(clipped), 1)) {
        if (insideWater(p[0], p[1])) {
          if (dry[dry.length - 1]!.length > 0) dry.push([]);
        } else {
          dry[dry.length - 1]!.push([round3(p[0]), round3(p[1])]);
        }
      }
      for (const points of dry) {
        if (points.length < 2 || polylineLength(points) < 25) continue;
        out.push({ shape: "polyline", points, width, falloff, height: "auto", heightOffset: -depth, mode: "cut", surface: "dirt", surfaceFalloff: 1 });
      }
    }
  }
  return out;
}
