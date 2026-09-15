import type { MapData, Vec2Tuple } from "../types";
import { distance, distanceToRect, offsetPoint, polylineDistance, polylineLength, round3, SpatialHash, type OrientedRect } from "./geometry";
import { mapPaths, type MapPath } from "./roads";

/**
 * Street name signs for real-world maps (visual only, no collision): a pole with a blade per road name at the corners of
 * labeled road crossings, poles every `spacing` m along long labeled roads, and a name board on each landmark's facade.
 * Pure and deterministic: the client builds the same plan from `MapData` and the resolved buildings at load.
 */

/** One name board. `dir` is the unit direction the board's width runs along (the road, or the facade). */
export interface StreetSignBlade {
  readonly name: string;
  readonly dir: Vec2Tuple;
}

export interface StreetSign {
  /** `corner`: a crossing of two labeled roads; `street`: along one road; `facade`: a landmark's name on its building. */
  readonly kind: "corner" | "street" | "facade";
  /** Pole foot, or the facade board center (just outside the wall), m. */
  readonly position: Vec2Tuple;
  /** Top blade first. Facade signs have one, facing the building's entrance side (+Z turned by the building yaw). */
  readonly blades: readonly StreetSignBlade[];
  /** Facade signs: the building id. */
  readonly building?: string;
}

/** The part of a resolved building the planner needs. */
export interface SignBuilding {
  readonly id: string;
  readonly bounds: OrientedRect;
  readonly base: OrientedRect;
}

export const STREET_SIGN = {
  /** Distance between poles along one road, m. */
  spacing: 175,
  /** Pole distance past the road edge, tried in order, m (buildings stand `ROAD_GAP` 1.6 m off the edge). */
  offsets: [0.9, 1.3, 2] as const,
  /** Half width of a street blade, m. */
  bladeHalfWidth: 0.55,
  /** Crossings closer than this are one junction (dual carriageways, offset T junctions), m. */
  junctionRadius: 28,
  /** A road gets no second sign within this distance of one naming it, m. */
  sameNameGap: 90,
  /** Poles keep this far from any other sign, m. */
  signGap: 12,
  /** Pole clearance from a road's paved edge, m. */
  roadClearance: 0.6,
  /** Pole and blade clearance from building outlines, m. */
  buildingClearance: 0.35,
  /** Crossings flatter than this (sine of the angle) get no corner sign. */
  minCrossingSine: 0.35,
  /** Along-road targets slide by these amounts when blocked, m. */
  slides: [0, 6, -6, 12, -12, 20, -20, 30, -30] as const,
} as const;

interface Segment {
  readonly name: string;
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
}

interface Crossing {
  readonly x: number;
  readonly z: number;
  readonly a: string;
  readonly b: string;
  readonly da: Vec2Tuple;
  readonly db: Vec2Tuple;
}

/** Street sign plan for a map: empty without road labels or landmarks (Map v1). */
export function planStreetSigns(map: Pick<MapData, "flatten" | "roadLabels" | "landmarks" | "terrain">, buildings: readonly SignBuilding[]): StreetSign[] {
  const signs: StreetSign[] = [];
  const labels = map.roadLabels ?? [];
  const half = map.terrain.playableHalfExtent - 3;
  const paths = mapPaths(map);
  // Paths are bucketed by points sampled every 10 m; a stamp skips repeats of one path within a query.
  const pathHash = new SpatialHash<number>(40);
  for (let p = 0; p < paths.length; p++) {
    const { points, halfWidth } = paths[p]!;
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, az] = points[i]!;
      const [bx, bz] = points[i + 1]!;
      const steps = Math.max(1, Math.ceil(distance(ax, az, bx, bz) / 10));
      for (let k = 0; k <= steps; k++) pathHash.insert(p, ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps, 5 + halfWidth);
    }
  }
  const stamps = new Int32Array(paths.length);
  let stamp = 0;
  const nearPaths = (x: number, z: number, radius: number, visit: (path: MapPath) => boolean | void): boolean => {
    stamp++;
    return pathHash.query(x, z, radius, (p) => {
      if (stamps[p] === stamp) return false;
      stamps[p] = stamp;
      return visit(paths[p]!);
    });
  };
  const buildingHash = new SpatialHash<SignBuilding>(40);
  for (const b of buildings) {
    const r = Math.sqrt(b.bounds.halfExtents[0] ** 2 + b.bounds.halfExtents[1] ** 2);
    buildingHash.insert(b, b.bounds.center[0], b.bounds.center[1], r);
  }

  const roadClear = (x: number, z: number, clearance: number): boolean =>
    !nearPaths(x, z, 12, (path) => polylineDistance(path.points, x, z) < path.halfWidth + clearance);
  const buildingClear = (x: number, z: number): boolean => !buildingHash.query(x, z, 2, (b) => distanceToRect(b.bounds, x, z) < STREET_SIGN.buildingClearance);
  const signClear = (x: number, z: number): boolean => signs.every((s) => distance(s.position[0], s.position[1], x, z) >= STREET_SIGN.signGap);
  const nameNear = (name: string, x: number, z: number): boolean =>
    signs.some((s) => s.blades.some((blade) => blade.name === name) && distance(s.position[0], s.position[1], x, z) < STREET_SIGN.sameNameGap);
  /** Pole, and both ends of every blade, off roads and buildings, inside the map. */
  const fits = (x: number, z: number, dirs: readonly Vec2Tuple[]): boolean => {
    if (Math.abs(x) > half || Math.abs(z) > half) return false;
    if (!roadClear(x, z, STREET_SIGN.roadClearance) || !buildingClear(x, z) || !signClear(x, z)) return false;
    for (const [dx, dz] of dirs) {
      for (const s of [1, -1]) {
        const ex = x + dx * STREET_SIGN.bladeHalfWidth * s;
        const ez = z + dz * STREET_SIGN.bladeHalfWidth * s;
        if (!roadClear(ex, ez, 0.1) || !buildingClear(ex, ez)) return false;
      }
    }
    return true;
  };
  /** Widest paved half width within `radius` of a point (0: no road there). */
  const halfWidthAt = (x: number, z: number, radius: number): number => {
    let best = 0;
    nearPaths(x, z, radius, (path) => {
      if (path.halfWidth > best && polylineDistance(path.points, x, z) <= radius) best = path.halfWidth;
    });
    return best;
  };

  // Corner signs, big roads first (labels are in priority order).
  const segments: Segment[] = [];
  for (const label of labels) {
    for (const line of label.lines) {
      for (let i = 0; i + 1 < line.length; i++) segments.push({ name: label.name, ax: line[i]![0], az: line[i]![1], bx: line[i + 1]![0], bz: line[i + 1]![1] });
    }
  }
  const rankOf = new Map(labels.map((l, i) => [l.name, i] as const));
  const crossings = findCrossings(segments).sort(
    (p, q) => Math.min(rankOf.get(p.a)!, rankOf.get(p.b)!) - Math.min(rankOf.get(q.a)!, rankOf.get(q.b)!) || Math.max(rankOf.get(p.a)!, rankOf.get(p.b)!) - Math.max(rankOf.get(q.a)!, rankOf.get(q.b)!) || p.x - q.x || p.z - q.z,
  );
  const junctions: Vec2Tuple[] = [];
  for (const c of crossings) {
    if (junctions.some(([x, z]) => distance(x, z, c.x, c.z) < STREET_SIGN.junctionRadius)) continue;
    const sine = Math.abs(c.da[0] * c.db[1] - c.da[1] * c.db[0]);
    if (sine < STREET_SIGN.minCrossingSine || Math.abs(c.x) > half || Math.abs(c.z) > half) continue;
    junctions.push([c.x, c.z]);
    const hw = halfWidthAt(c.x, c.z, 6);
    if (hw === 0) continue;
    const na: Vec2Tuple = [c.da[1], -c.da[0]];
    const nb: Vec2Tuple = [c.db[1], -c.db[0]];
    const det = na[0] * nb[1] - na[1] * nb[0];
    let placed: Vec2Tuple | null = null;
    for (const offset of STREET_SIGN.offsets) {
      for (const [sa, sb] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
        // Solve u·na = sa·d, u·nb = sb·d: the corner point `d` past the edge of both roads.
        const d = hw + offset;
        const ux = (sa * d * nb[1] - sb * d * na[1]) / det;
        const uz = (sb * d * na[0] - sa * d * nb[0]) / det;
        const x = c.x + ux;
        const z = c.z + uz;
        if (fits(x, z, [c.da, c.db])) {
          placed = [x, z];
          break;
        }
      }
      if (placed) break;
    }
    if (placed) signs.push({ kind: "corner", position: [round3(placed[0]), round3(placed[1])], blades: [blade(c.a, c.da), blade(c.b, c.db)] });
  }

  // Street signs along long roads, alternating sides.
  for (const label of labels) {
    for (const line of label.lines) {
      const length = polylineLength(line);
      if (length < 60) continue;
      const count = Math.max(1, Math.floor(length / STREET_SIGN.spacing));
      const step = length / count;
      for (let k = 0; k < count; k++) {
        const target = step * (k + 0.5);
        let done = false;
        for (const slide of STREET_SIGN.slides) {
          const at = pointAlong(line, target + slide);
          if (!at) continue;
          const { x, z, dir } = at;
          if (nameNear(label.name, x, z)) {
            done = true;
            break;
          }
          const hw = halfWidthAt(x, z, 4);
          if (hw === 0) continue;
          for (const offset of STREET_SIGN.offsets) {
            for (const side of k % 2 === 0 ? [1, -1] : [-1, 1]) {
              const px = x + dir[1] * side * (hw + offset);
              const pz = z - dir[0] * side * (hw + offset);
              if (fits(px, pz, [dir])) {
                signs.push({ kind: "street", position: [round3(px), round3(pz)], blades: [blade(label.name, dir)] });
                done = true;
                break;
              }
            }
            if (done) break;
          }
          if (done) break;
        }
      }
    }
  }

  // Landmark names on their facades.
  for (const landmark of map.landmarks ?? []) {
    const building = buildings.find((b) => b.id === landmark.building);
    if (!building) continue;
    const { base } = building;
    const [x, z] = offsetPoint(base.center, base.yaw, 0, base.halfExtents[1] + 0.08);
    const [dx, dz] = offsetPoint([0, 0], base.yaw, 1, 0);
    signs.push({ kind: "facade", position: [round3(x), round3(z)], blades: [blade(landmark.name, [dx, dz])], building: building.id });
  }
  return signs;
}

function blade(name: string, dir: Vec2Tuple): StreetSignBlade {
  return { name, dir: [round3(dir[0]), round3(dir[1])] };
}

/** Point and unit direction `at` m along a polyline (null outside it). */
function pointAlong(points: readonly Vec2Tuple[], at: number): { x: number; z: number; dir: Vec2Tuple } | null {
  if (at < 0) return null;
  let walked = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i]!;
    const [bx, bz] = points[i + 1]!;
    const length = distance(ax, az, bx, bz);
    if (length > 0 && walked + length >= at) {
      const t = (at - walked) / length;
      return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, dir: [(bx - ax) / length, (bz - az) / length] };
    }
    walked += length;
  }
  return null;
}

/** Crossings between differently named label lines, T junctions (an end within 2 m of another line) included. */
function findCrossings(segments: readonly Segment[]): Crossing[] {
  const out: Crossing[] = [];
  const unit = (s: Segment): Vec2Tuple => {
    const length = distance(s.ax, s.az, s.bx, s.bz) || 1;
    return [(s.bx - s.ax) / length, (s.bz - s.az) / length];
  };
  for (let i = 0; i < segments.length; i++) {
    const p = segments[i]!;
    for (let j = i + 1; j < segments.length; j++) {
      const q = segments[j]!;
      if (p.name === q.name) continue;
      if (Math.max(p.ax, p.bx) + 2 < Math.min(q.ax, q.bx) || Math.max(q.ax, q.bx) + 2 < Math.min(p.ax, p.bx)) continue;
      if (Math.max(p.az, p.bz) + 2 < Math.min(q.az, q.bz) || Math.max(q.az, q.bz) + 2 < Math.min(p.az, p.bz)) continue;
      const hit = intersect(p, q) ?? touch(p, q) ?? touch(q, p);
      if (hit) out.push({ x: hit[0], z: hit[1], a: p.name, b: q.name, da: unit(p), db: unit(q) });
    }
  }
  return out;
}

function intersect(p: Segment, q: Segment): Vec2Tuple | null {
  const rx = p.bx - p.ax;
  const rz = p.bz - p.az;
  const sx = q.bx - q.ax;
  const sz = q.bz - q.az;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((q.ax - p.ax) * sz - (q.az - p.az) * sx) / denom;
  const u = ((q.ax - p.ax) * rz - (q.az - p.az) * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return [p.ax + rx * t, p.az + rz * t];
}

/** An end of `p` within 2 m of segment `q`: the nearest point on `q`. */
function touch(p: Segment, q: Segment): Vec2Tuple | null {
  for (const [x, z] of [[p.ax, p.az], [p.bx, p.bz]] as const) {
    const sx = q.bx - q.ax;
    const sz = q.bz - q.az;
    const lengthSq = sx * sx + sz * sz;
    let t = lengthSq > 0 ? ((x - q.ax) * sx + (z - q.az) * sz) / lengthSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = q.ax + sx * t;
    const cz = q.az + sz * t;
    if (distance(x, z, cx, cz) <= 2) return [cx, cz];
  }
  return null;
}
