import type { MapLayout } from "./mapLayout";
import { getMapProp } from "./props";
import { INSTANCE_STRIDE } from "./scatter";

export type PropColliderShape =
  | { readonly kind: "cylinder"; readonly radius: number; readonly height: number }
  | { readonly kind: "box"; readonly size: readonly [number, number, number]; readonly centerY: number };

/**
 * Static colliders for every prop instance with the same prop and scale: one shape, many transforms. Instances are
 * upright (yaw only) even when their visual is tilted to the terrain.
 */
export interface PropColliderGroup {
  readonly prop: string;
  readonly scale: number;
  /** Shape at this scale, relative to an instance origin (its base on the ground). */
  readonly shape: PropColliderShape;
  /** Solid to bullets; otherwise a movement-only blocker (fences). */
  readonly bulletproof: boolean;
  /** x, y, z, yaw per instance. */
  readonly transforms: Float32Array;
}

export const COLLIDER_STRIDE = 4;

export function propColliderGroups(layout: Pick<MapLayout, "props">): PropColliderGroup[] {
  const groups: PropColliderGroup[] = [];
  for (const set of layout.props) {
    const def = getMapProp(set.prop);
    const collision = def.collision;
    if (collision.kind === "none") continue;
    const byScale = new Map<number, number[]>();
    for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
      const scale = set.data[i + 4]!;
      let list = byScale.get(scale);
      if (!list) byScale.set(scale, (list = []));
      list.push(set.data[i]!, set.data[i + 1]!, set.data[i + 2]!, set.data[i + 3]!);
    }
    for (const scale of [...byScale.keys()].sort((a, b) => a - b)) {
      const shape: PropColliderShape =
        collision.kind === "cylinder"
          ? { kind: "cylinder", radius: collision.radius * scale, height: collision.height * scale }
          : {
              kind: "box",
              size: [collision.size[0] * scale, collision.size[1] * scale, collision.size[2] * scale],
              centerY: ((collision.size[1] / 2) + (collision.offsetY ?? 0)) * scale,
            };
      const bulletproof = collision.kind === "cylinder" || collision.bulletproof;
      groups.push({ prop: set.prop, scale, shape, bulletproof, transforms: new Float32Array(byScale.get(scale)!) });
    }
  }
  return groups;
}
