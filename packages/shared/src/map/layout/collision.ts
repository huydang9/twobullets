import { glassPhaseBucket, isPhaseGlass } from "../glassPhase";
import type { MapLayout } from "./mapLayout";
import { getMapProp } from "./props";
import { INSTANCE_STRIDE } from "./scatter";

export type PropColliderShape =
  | { readonly kind: "cylinder"; readonly radius: number; readonly height: number }
  | { readonly kind: "box"; readonly size: readonly [number, number, number]; readonly centerY: number };

/**
 * Static colliders for every prop instance with the same prop, scale and phase group: one shape, many transforms.
 * Instances are upright (yaw only) even when their visual is tilted to the terrain.
 */
export interface PropColliderGroup {
  readonly prop: string;
  readonly scale: number;
  /** Shape at this scale, relative to an instance origin (its base on the ground). */
  readonly shape: PropColliderShape;
  /** Solid to bullets; otherwise a movement-only blocker (fences, panes in their shoot-through mode). */
  readonly bulletproof: boolean;
  /**
   * Phase group of a pane whose mode switches during the match (`map/glassPhase.ts`), else -1. One shape per group is
   * the whole reason this splits: the engines flip `filterMembershipMask` on the shape, and panes sharing one shape
   * would flip together — which is exactly what the design forbids.
   */
  readonly phase: number;
  /** x, y, z, yaw per instance. */
  readonly transforms: Float32Array;
  /**
   * The instance index inside `layout.props[...].data` each transform came from (its offset / `INSTANCE_STRIDE`).
   * Grouping by scale and phase shuffles the order, so this is how a host that has to take one instance out of a
   * shared batch again — a mirror pane a frag destroyed (`equipment/destructible.ts`) — finds its slot.
   */
  readonly instances: Int32Array;
}

export const COLLIDER_STRIDE = 4;

export function propColliderGroups(layout: Pick<MapLayout, "props">): PropColliderGroup[] {
  const groups: PropColliderGroup[] = [];
  for (const set of layout.props) {
    const def = getMapProp(set.prop);
    const collision = def.collision;
    if (collision.kind === "none") continue;
    const phased = isPhaseGlass(set.prop);
    // Key: scale, then phase group. Sorted so the group order is the same on every machine and every run.
    const byKey = new Map<number, Map<number, number[]>>();
    const indexByKey = new Map<number, Map<number, number[]>>();
    for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
      const scale = set.data[i + 4]!;
      const phase = phased ? glassPhaseBucket(set.data[i]!, set.data[i + 2]!, set.data[i + 3]!) : -1;
      let byPhase = byKey.get(scale);
      if (!byPhase) byKey.set(scale, (byPhase = new Map()));
      let list = byPhase.get(phase);
      if (!list) byPhase.set(phase, (list = []));
      list.push(set.data[i]!, set.data[i + 1]!, set.data[i + 2]!, set.data[i + 3]!);
      let indexByPhase = indexByKey.get(scale);
      if (!indexByPhase) indexByKey.set(scale, (indexByPhase = new Map()));
      let indices = indexByPhase.get(phase);
      if (!indices) indexByPhase.set(phase, (indices = []));
      indices.push(i / INSTANCE_STRIDE);
    }
    for (const scale of [...byKey.keys()].sort((a, b) => a - b)) {
      const byPhase = byKey.get(scale)!;
      const shape: PropColliderShape =
        collision.kind === "cylinder"
          ? { kind: "cylinder", radius: collision.radius * scale, height: collision.height * scale }
          : {
              kind: "box",
              size: [collision.size[0] * scale, collision.size[1] * scale, collision.size[2] * scale],
              centerY: ((collision.size[1] / 2) + (collision.offsetY ?? 0)) * scale,
            };
      const bulletproof = collision.kind === "cylinder" || collision.bulletproof;
      for (const phase of [...byPhase.keys()].sort((a, b) => a - b)) {
        groups.push({
          prop: set.prop,
          scale,
          shape,
          bulletproof,
          phase,
          transforms: new Float32Array(byPhase.get(phase)!),
          instances: new Int32Array(indexByKey.get(scale)!.get(phase)!),
        });
      }
    }
  }
  return groups;
}
