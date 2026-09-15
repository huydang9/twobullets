import { PrefabBuilder, type Range } from "../kit";
import type { BuildingPrefab } from "../types";

/**
 * Road bridges for real maps (`convert/bridges.ts`): a raised deck along local Z over a road that crosses water, with
 * sidewalks, solid parapets, lamp posts and a ramp at each end. The deck body reaches below the ground, so nothing
 * crawls under it, and it closes the gap the bank fences leave for the road.
 */
export interface BridgeSpec {
  readonly id: string;
  readonly name: string;
  /** Total length including both ramps, m. */
  readonly length: number;
  /** Roadway width between the sidewalks, m. */
  readonly roadway: number;
  readonly sidewalk: number;
}

const DECK = 0.75;
const CURB = 0.15;
const RAMP = 4;
const PARAPET = 0.25;
const BODY_DEPTH = 1.2;

export function bridge(spec: BridgeSpec): BuildingPrefab {
  const b = new PrefabBuilder(spec.id, spec.name);
  const hl = spec.length / 2;
  const hw = spec.roadway / 2 + spec.sidewalk;
  const road: Range = [-spec.roadway / 2, spec.roadway / 2];
  const span: Range = [-hl + RAMP, hl - RAMP];

  b.box(road, [-BODY_DEPTH, DECK], span, "concrete", "structure", { "+y": "roofAsphalt" });
  for (const side of [-1, 1] as const) {
    const walk: Range = side < 0 ? [-hw, road[0]] : [road[1], hw];
    const parapet: Range = side < 0 ? [-hw - PARAPET, -hw] : [hw, hw + PARAPET];
    b.box(walk, [-BODY_DEPTH, DECK + CURB], span, "concrete", "structure");
    b.box(parapet, [-BODY_DEPTH, DECK + CURB + 1.0], span, "plaster", "railing");
    for (const end of [-1, 1] as const) {
      const z: Range = end < 0 ? [-hl, span[0]] : [span[1], hl];
      b.box(parapet, [0, DECK + CURB + 1.0], z, "plaster", "railing");
      b.wedge(walk, [0, DECK + CURB], z, end < 0 ? "+z" : "-z", "concrete", "concrete", "floor");
    }
    // Lamp posts on the parapets, arms reaching over the roadway.
    const posts = Math.max(1, Math.round((span[1] - span[0]) / 16));
    for (let k = 0; k < posts; k++) {
      const z = span[0] + ((k + 0.5) * (span[1] - span[0])) / posts;
      const px = side * (hw + PARAPET / 2);
      const postTop = DECK + CURB + 1.0 + 5;
      b.box([px - 0.06, px + 0.06], [DECK + CURB + 1.0, postTop], [z - 0.06, z + 0.06], "darkSteel", "prop");
      const arm: Range = side < 0 ? [px + 0.06, px + 1.3] : [px - 1.3, px - 0.06];
      b.box(arm, [postTop - 0.12, postTop], [z - 0.05, z + 0.05], "darkSteel", "prop");
    }
  }
  for (const end of [-1, 1] as const) {
    const z: Range = end < 0 ? [-hl, span[0]] : [span[1], hl];
    b.wedge(road, [0, DECK], z, end < 0 ? "+z" : "-z", "concrete", "roofAsphalt", "floor");
    b.box([-hw - PARAPET, hw + PARAPET], [-0.8, 0], z, "concrete", "foundation");
  }
  return { ...b.entrance(0, 0, hl + 0.6).entrance(0, 0, -hl - 0.6).build(), spansRoad: true };
}

/** Lane bridges carry alleys and service roads up to 3.9 m wide; road bridges carry streets up to 8.6 m. */
export const BRIDGES: readonly BridgeSpec[] = [
  { id: "bridge_lane_16", name: "Lane bridge (16 m)", length: 16, roadway: 3.6, sidewalk: 0.8 },
  { id: "bridge_lane_80", name: "Lane bridge (80 m)", length: 80, roadway: 3.6, sidewalk: 0.8 },
  { id: "bridge_road_24", name: "Road bridge (24 m)", length: 24, roadway: 7.6, sidewalk: 1.2 },
  { id: "bridge_road_40", name: "Road bridge (40 m)", length: 40, roadway: 7.6, sidewalk: 1.2 },
];
