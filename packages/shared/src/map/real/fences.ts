import { lineOpenings, segmentLine, type LineOpening } from "../layout/placement";
import type { PropPlacement, Vec2Tuple } from "../types";

/** A wooden fence along a world polyline with open stretches ([start, end] m along it). Water edges and bridge railings. */
export interface FenceLine {
  readonly points: readonly Vec2Tuple[];
  readonly gaps?: readonly (readonly [number, number])[];
}

export function fenceProps(lines: readonly FenceLine[]): PropPlacement[] {
  return lines.flatMap((line) => segmentLine("fence_wood", line.points, line.gaps ? { gaps: line.gaps } : {}));
}

export function fenceOpenings(lines: readonly FenceLine[]): LineOpening[] {
  return lines.flatMap((line) => lineOpenings(line.points, line.gaps ?? []));
}
