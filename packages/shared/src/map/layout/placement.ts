import type { BuildingPrefabId } from "../buildings/prefabs";
import type { PropPlacement, Vec2Tuple } from "../types";
import type { LayoutBuilding } from "./buildings";
import { distance, offsetPoint, round3 } from "./geometry";
import type { MapPropId } from "./props";

/**
 * Authoring frame for one point of interest: local coordinates (meters, +Z = the POI's "north" after `yaw`) turned into
 * world placements. Buildings snap to the terrain; props snap unless a height is given.
 */
export class PoiFrame {
  readonly buildings: LayoutBuilding[] = [];
  readonly props: PropPlacement[] = [];

  readonly poi: string;
  readonly center: Vec2Tuple;
  readonly yaw: number;

  constructor(poi: string, center: Vec2Tuple, yaw = 0) {
    this.poi = poi;
    this.center = center;
    this.yaw = yaw;
  }

  /** World XZ of a local point. */
  at(localX: number, localZ: number): Vec2Tuple {
    const [x, z] = offsetPoint(this.center, this.yaw, localX, localZ);
    return [round3(x), round3(z)];
  }

  building(id: string, prefab: BuildingPrefabId, localX: number, localZ: number, localYaw: number, stackOn?: string): this {
    const [x, z] = this.at(localX, localZ);
    this.buildings.push({
      id: `${this.poi}_${id}`,
      prefab,
      position: [x, 0, z],
      yaw: this.yaw + localYaw,
      snapToTerrain: !stackOn,
      poi: this.poi,
      ...(stackOn ? { stackOn: `${this.poi}_${stackOn}` } : {}),
    });
    return this;
  }

  prop(prop: MapPropId, localX: number, localZ: number, localYaw = 0, scale = 1): this {
    const [x, z] = this.at(localX, localZ);
    this.props.push({ prop, position: [x, 0, z], yaw: this.yaw + localYaw, ...(scale !== 1 ? { scale } : {}), snapToTerrain: true });
    return this;
  }

  /** Fence or wall segments along a local polyline; see `segmentLine`. */
  line(prop: MapPropId, points: readonly Vec2Tuple[], options: SegmentLineOptions = {}): this {
    this.props.push(...segmentLine(prop, points.map(([lx, lz]) => this.at(lx, lz)), options));
    return this;
  }
}

export interface SegmentLineOptions {
  /** Segment length of the prop along its local X, m. Default 4. */
  readonly segment?: number;
  /** Distances along the whole line to leave open, [start, end] m (gates, breaches). */
  readonly gaps?: readonly (readonly [number, number])[];
}

/** Share of its authored width a gap may lose to a single overhanging piece; more and the piece is dropped. */
const MAX_GAP_NARROWING = 0.25;

/**
 * Places a straight-segment prop (fence, wall) along a world polyline. Each leg gets whole segments spread evenly,
 * overlapping slightly where the leg isn't a multiple of the segment length, so corners stay closed.
 *
 * Gaps split a leg into open stretches, each filled on its own so gap edges land where they are authored. Pieces are
 * never scaled (a uniform scale would change the height too), so a stretch takes whole segments:
 * - normally spread flush between its ends like a leg, so the gap is exact (joints overlap by at most half a segment);
 * - a stretch of 1–1.5 segments takes one piece against the leg end it touches: the gap widens by under half a segment;
 * - a shorter one keeps a piece only if the gap it overhangs loses at most `MAX_GAP_NARROWING` of its width.
 */
export function segmentLine(prop: MapPropId, points: readonly Vec2Tuple[], options: SegmentLineOptions = {}): PropPlacement[] {
  const segment = options.segment ?? 4;
  const gaps = [...(options.gaps ?? [])].sort((a, b) => a[0] - b[0]);
  const out: PropPlacement[] = [];
  let travelled = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i]!;
    const [bx, bz] = points[i + 1]!;
    const length = distance(ax, az, bx, bz);
    // Local +X along the leg: yaw turns +X toward (cos yaw, -sin yaw), so yaw = atan2(-dz, dx).
    const yaw = Math.atan2(-(bz - az), bx - ax);
    const place = (along: number): void => {
      const t = along / length;
      out.push({ prop, position: [round3(ax + (bx - ax) * t), 0, round3(az + (bz - az) * t)], yaw, snapToTerrain: true });
    };
    // Leg-local open position and the authored width of the gap that ends there (0 at the leg start).
    let open = 0;
    let openGap = 0;
    for (const [from, to] of gaps) {
      if (to - travelled <= open || from - travelled >= length) continue;
      fillStretch(open, Math.max(open, from - travelled), length, segment, openGap, to - from, place);
      open = Math.min(length, Math.max(open, to - travelled));
      openGap = to - from;
    }
    if (open === 0) fillLeg(length, segment, place);
    else if (open < length) fillStretch(open, length, length, segment, openGap, 0, place);
    travelled += length;
  }
  return out;
}

/** A leg without gaps: whole segments spread evenly, end to end. */
function fillLeg(length: number, segment: number, place: (along: number) => void): void {
  const count = Math.max(1, Math.ceil(length / segment - 0.05));
  for (let k = 0; k < count; k++) place(count === 1 ? length / 2 : segment / 2 + ((length - segment) * k) / (count - 1));
}

/** Open stretch [start, end] of a leg between gaps of authored widths `gapBefore` / `gapAfter`; see `segmentLine`. */
function fillStretch(start: number, end: number, length: number, segment: number, gapBefore: number, gapAfter: number, place: (along: number) => void): void {
  const span = end - start;
  const flush = Math.ceil(span / segment - 0.05);
  if (flush > 1 && flush * segment - span <= ((flush - 1) * segment) / 2) {
    for (let k = 0; k < flush; k++) place(start + segment / 2 + ((span - segment) * k) / (flush - 1));
    return;
  }
  let count = Math.floor(span / segment + 0.5);
  const run = count * segment;
  const first = start === 0 ? 0 : end === length ? end - run : (start + end - run) / 2;
  if (count === 1 && run > span) {
    const intoBefore = start - first;
    if (intoBefore > gapBefore * MAX_GAP_NARROWING || run - span - intoBefore > gapAfter * MAX_GAP_NARROWING) count = 0;
  }
  for (let k = 0; k < count; k++) place(first + segment / 2 + segment * k);
}

/** Closed local polyline around a rectangle centered at (cx, cz). */
export function rectLoop(cx: number, cz: number, halfX: number, halfZ: number): Vec2Tuple[] {
  return [
    [cx - halfX, cz - halfZ],
    [cx + halfX, cz - halfZ],
    [cx + halfX, cz + halfZ],
    [cx - halfX, cz + halfZ],
    [cx - halfX, cz - halfZ],
  ];
}
