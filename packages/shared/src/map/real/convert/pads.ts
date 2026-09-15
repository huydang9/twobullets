import { forEachRectSample } from "../../layout/buildings";
import { rectsOverlap, round3 } from "../../layout/geometry";
import { createReliefFunction } from "../../terrain/generate";
import type { FlattenRegion, TerrainSpec } from "../../types";
import { prefabRect, type PlacedBuilding } from "./buildings";

/** Pad margin around a prefab outline and its blend band, m. */
export const PAD_MARGIN = 1.5;
export const PAD_FALLOFF = 6;
/** Neighbouring pads whose natural heights differ by at most this share one level (a village terrace), m. */
const TERRACE_SPREAD = 1.2;

/**
 * One rect pad under each building (outline plus margin), at the mean natural height under it. Pads whose blend bands
 * touch and whose heights are close share their mean, so tight rows of houses sit on one terrace instead of fighting
 * over each other's edges. Heights are explicit numbers, so the result doesn't depend on region order.
 */
export function buildingPads(buildings: readonly PlacedBuilding[], spec: TerrainSpec): FlattenRegion[] {
  const relief = createReliefFunction(spec);
  const rects = buildings.map((b) => prefabRect(b.prefab as Parameters<typeof prefabRect>[0], [b.position[0], b.position[2]], b.yaw, PAD_MARGIN));
  const heights = rects.map((rect) => {
    let sum = 0;
    let count = 0;
    forEachRectSample(rect, 2, (x, z) => {
      sum += relief(x, z);
      count++;
    });
    return sum / count;
  });

  const parent = buildings.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (Math.abs(heights[i]! - heights[j]!) > TERRACE_SPREAD) continue;
      if (rectsOverlap(rects[i]!, rects[j]!, PAD_FALLOFF * 2)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, number[]>();
  rects.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const level = new Map<number, number>();
  for (const members of groups.values()) {
    const values = members.map((i) => heights[i]!);
    const spread = Math.max(...values) - Math.min(...values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    for (const i of members) level.set(i, spread <= TERRACE_SPREAD ? mean : heights[i]!);
  }

  return rects.map((rect, i) => ({
    shape: "rect",
    center: [round3(rect.center[0]), round3(rect.center[1])],
    halfExtents: [round3(rect.halfExtents[0]), round3(rect.halfExtents[1])],
    yaw: rect.yaw,
    falloff: PAD_FALLOFF,
    height: Math.round(level.get(i)! * 100) / 100,
  }));
}
