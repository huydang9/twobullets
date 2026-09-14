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

  constructor(
    readonly poi: string,
    readonly center: Vec2Tuple,
    readonly yaw = 0,
  ) {}

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

/**
 * Places a straight-segment prop (fence, wall) along a world polyline. Each leg gets whole segments spread evenly,
 * overlapping slightly where the leg isn't a multiple of the segment length, so corners stay closed.
 */
export function segmentLine(prop: MapPropId, points: readonly Vec2Tuple[], options: SegmentLineOptions = {}): PropPlacement[] {
  const segment = options.segment ?? 4;
  const out: PropPlacement[] = [];
  let travelled = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i]!;
    const [bx, bz] = points[i + 1]!;
    const length = distance(ax, az, bx, bz);
    const count = Math.max(1, Math.ceil(length / segment - 0.05));
    // Local +X along the leg: yaw turns +X toward (cos yaw, -sin yaw), so yaw = atan2(-dz, dx).
    const yaw = Math.atan2(-(bz - az), bx - ax);
    for (let k = 0; k < count; k++) {
      const along = count === 1 ? length / 2 : segment / 2 + ((length - segment) * k) / (count - 1);
      const t = along / length;
      const center = travelled + along;
      if (options.gaps?.some(([from, to]) => center + segment / 2 > from && center - segment / 2 < to)) continue;
      out.push({ prop, position: [round3(ax + (bx - ax) * t), 0, round3(az + (bz - az) * t)], yaw, snapToTerrain: true });
    }
    travelled += length;
  }
  return out;
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
