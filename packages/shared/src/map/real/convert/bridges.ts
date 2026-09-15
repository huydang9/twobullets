import { getBuildingPrefab, type BuildingPrefabId } from "../../buildings/prefabs";
import type { LayoutBuilding } from "../../layout/buildings";
import { distance, pointInPolygon, round3, segmentDistance, type OrientedRect } from "../../layout/geometry";
import type { RoadSpec } from "../../layout/roads";
import type { Vec2Tuple } from "../../types";
import { prefabRect } from "./buildings";
import type { LineFeature, Polygon } from "./types";

/**
 * Walkable bridges for city maps: where a road crosses a water area (after `trimRoadsAtWater`, only bridges and
 * causeways do) or an OSM `bridge=*` highway crosses a waterway line, a bridge prefab is laid along the road, centered
 * on the crossing, long enough to land its ramps on both banks. The road must run straight under it. Ids are
 * `bld_<BRIDGE_ID_BASE + n>` in road order, so validation and reachability passes can exclude them like buildings.
 */

const BRIDGE_ID_BASE = 8_000_000_000_000;
/** Bank on each side of the water before the ramp starts, plus the ramp itself, m. */
const LANDING = 2 + 4;
/** The road may stray this far from the bridge axis, m. */
const STRAIGHTNESS = 0.8;
/** Channel widths of waterway lines (creek beds), m: flat width plus both falloffs. */
const CHANNEL: Readonly<Record<string, number>> = { river: 16, canal: 10, stream: 8.5, ditch: 5.8, drain: 5.8 };

/** Bridge prefabs by the widest road they carry, shortest first. */
const SIZES: readonly { readonly prefab: BuildingPrefabId; readonly maxRoad: number; readonly length: number }[] = [
  { prefab: "bridge_lane_16", maxRoad: 3.9, length: 16 },
  { prefab: "bridge_lane_80", maxRoad: 3.9, length: 80 },
  { prefab: "bridge_road_24", maxRoad: 8.6, length: 24 },
  { prefab: "bridge_road_40", maxRoad: 8.6, length: 40 },
];

export interface BridgeSite extends LayoutBuilding {
  readonly prefab: BuildingPrefabId;
  readonly bounds: OrientedRect;
  /** Road it carries and the length of water or channel under it, m. */
  readonly road: string;
  readonly span: number;
}

interface Crossing {
  readonly road: RoadSpec;
  /** Distance along the road of the crossing's middle, and the width to span, m. */
  readonly at: number;
  readonly span: number;
}

export function findBridges(roads: readonly RoadSpec[], water: readonly Polygon[], lines: readonly LineFeature[]): BridgeSite[] {
  const crossings: Crossing[] = [];
  const inWater = (x: number, z: number) => water.some((w) => pointInPolygon(w, x, z));

  for (const road of roads) {
    const samples = sampleRoad(road);
    let start = -1;
    for (let i = 0; i <= samples.length; i++) {
      const wet = i < samples.length && inWater(samples[i]![0], samples[i]![1]);
      if (wet && start < 0) start = i;
      if (!wet && start >= 0) {
        crossings.push({ road, at: (start + i - 1) / 2, span: i - start });
        start = -1;
      }
    }
  }

  // Tagged bridges over waterway lines (creek beds), unless a water area crossing already covers them.
  const waterways = lines.filter((l) => CHANNEL[l.tags.waterway ?? ""] !== undefined && !(l.tags.tunnel && l.tags.tunnel !== "no"));
  for (const line of [...lines].sort((a, b) => a.id - b.id)) {
    if (!line.tags.highway || !line.tags.bridge || line.tags.bridge === "no") continue;
    for (const waterway of waterways) {
      const hit = firstIntersection(line.points, waterway.points);
      if (!hit || inWater(hit[0], hit[1])) continue;
      const found = nearestRoad(roads, hit);
      if (!found) continue;
      if (crossings.some((c) => c.road === found.road && Math.abs(c.at - found.at) < 20)) continue;
      crossings.push({ road: found.road, at: found.at, span: CHANNEL[waterway.tags.waterway!]! });
    }
  }

  const sites: BridgeSite[] = [];
  for (const crossing of crossings) {
    const width = crossing.road.width ?? 5;
    const size = SIZES.find((s) => width <= s.maxRoad && s.length >= crossing.span + 2 * LANDING);
    if (!size) continue;
    const placed = alignOnRoad(crossing, size.length);
    if (!placed) continue;
    const { center, dir } = placed;
    const yaw = round3(Math.atan2(dir[0], dir[1])) || 0;
    const position: Vec2Tuple = [round3(center[0]) || 0, round3(center[1]) || 0];
    const bounds = prefabRect(size.prefab, position, yaw);
    if (sites.some((s) => distance(s.position[0], s.position[2], position[0], position[1]) < (size.length + getBuildingPrefab(s.prefab).bounds.max[2] * 2) / 2)) continue;
    sites.push({ id: `bld_${BRIDGE_ID_BASE + sites.length}`, prefab: size.prefab, position: [position[0], 0, position[1]], yaw, snapToTerrain: true, bounds, road: crossing.road.id, span: round3(crossing.span) });
  }
  return sites;
}

/** Points every meter along a road. */
function sampleRoad(road: RoadSpec): Vec2Tuple[] {
  const out: Vec2Tuple[] = [];
  for (let i = 0; i + 1 < road.points.length; i++) {
    const [ax, az] = road.points[i]!;
    const [bx, bz] = road.points[i + 1]!;
    const steps = Math.max(1, Math.ceil(distance(ax, az, bx, bz)));
    for (let k = 0; k < steps; k++) out.push([ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps]);
  }
  out.push(road.points[road.points.length - 1]!);
  return out;
}

/** The bridge's center and axis: the chord of the road over the bridge length, shifted inside the road if needed. */
function alignOnRoad(crossing: Crossing, length: number): { center: Vec2Tuple; dir: Vec2Tuple } | null {
  const samples = sampleRoad(crossing.road);
  const half = length / 2;
  const last = samples.length - 1;
  // Keep the whole bridge on the road; the crossing must stay between the ramps.
  const lo = Math.max(half, crossing.at + crossing.span / 2 + LANDING - half);
  const hi = Math.min(last - half, crossing.at - crossing.span / 2 - LANDING + half);
  if (lo > hi) return null;
  const mid = Math.round(Math.min(hi, Math.max(lo, crossing.at)));
  const a = samples[Math.round(mid - half)]!;
  const b = samples[Math.round(mid + half)]!;
  const chord = distance(a[0], a[1], b[0], b[1]);
  if (chord < length - 1) return null;
  for (let i = Math.round(mid - half); i <= Math.round(mid + half); i++) {
    if (segmentDistance(samples[i]![0], samples[i]![1], a[0], a[1], b[0], b[1]) > STRAIGHTNESS) return null;
  }
  return { center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dir: [(b[0] - a[0]) / chord, (b[1] - a[1]) / chord] };
}

function firstIntersection(a: readonly Vec2Tuple[], b: readonly Vec2Tuple[]): Vec2Tuple | null {
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const [ax, az] = a[i]!;
      const [bx, bz] = a[i + 1]!;
      const [cx, cz] = b[j]!;
      const [dx, dz] = b[j + 1]!;
      const rx = bx - ax;
      const rz = bz - az;
      const sx = dx - cx;
      const sz = dz - cz;
      const den = rx * sz - rz * sx;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((cx - ax) * sz - (cz - az) * sx) / den;
      const u = ((cx - ax) * rz - (cz - az) * rx) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return [ax + rx * t, az + rz * t];
    }
  }
  return null;
}

/** The road passing within its half width (+1 m) of a point, and the distance along it. */
function nearestRoad(roads: readonly RoadSpec[], p: Vec2Tuple): { road: RoadSpec; at: number } | null {
  let best: { road: RoadSpec; at: number } | null = null;
  let bestDistance = Infinity;
  for (const road of roads) {
    let travelled = 0;
    for (let i = 0; i + 1 < road.points.length; i++) {
      const [ax, az] = road.points[i]!;
      const [bx, bz] = road.points[i + 1]!;
      const length = distance(ax, az, bx, bz);
      const d = segmentDistance(p[0], p[1], ax, az, bx, bz);
      if (d < (road.width ?? 5) / 2 + 1 && d < bestDistance) {
        const t = length > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - az) * (bz - az)) / (length * length))) : 0;
        best = { road, at: travelled + t * length };
        bestDistance = d;
      }
      travelled += length;
    }
  }
  return best;
}
