import { offsetPoint, type OrientedRect } from "../layout/geometry";
import type { Vec2Tuple } from "../types";

/** World outline of prefab bounds placed at `position` with `yaw`. */
export function prefabRectOf(bounds: { readonly min: readonly number[]; readonly max: readonly number[] }, position: Vec2Tuple, yaw: number): OrientedRect {
  const { min, max } = bounds;
  const center = offsetPoint(position, yaw, (min[0]! + max[0]!) / 2, (min[2]! + max[2]!) / 2);
  return { center, halfExtents: [(max[0]! - min[0]!) / 2, (max[2]! - min[2]!) / 2], yaw };
}
