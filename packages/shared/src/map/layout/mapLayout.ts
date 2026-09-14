import { checksumBytes } from "../terrain/heightfield";
import type { Terrain } from "../terrain/terrain";
import type { MapData } from "../types";
import { resolveBuildings, type ResolvedBuilding } from "./buildings";
import { ScatterContext, type ScatterRule } from "./scatter";

/** All instances of one prop, INSTANCE_STRIDE floats each. */
export interface PropInstanceSet {
  readonly prop: string;
  readonly data: Float32Array;
}

/**
 * A map resolved against its built terrain: building heights, explicit props and expanded scatter. Pure data, the same
 * on the client (rendering, collision) and a server (collision only).
 */
export interface MapLayout {
  readonly buildings: readonly ResolvedBuilding[];
  /** Explicit props and scatter instances, one set per prop id in id order. */
  readonly props: readonly PropInstanceSet[];
  /** Instances placed by each scatter rule (detail rules excluded). */
  readonly ruleCounts: Readonly<Record<string, number>>;
  /** Hash of every building position and prop instance. */
  readonly checksum: string;
}

export function buildMapLayout(map: MapData, terrain: Terrain): MapLayout {
  const buildings = resolveBuildings(map, terrain);
  const context = new ScatterContext(map, terrain, buildings);
  const lists = new Map<string, number[]>();
  for (const placement of map.props) context.addPlacedProp(placement);
  for (const placement of map.props) context.pushPlaced(placement, lists);
  const ruleCounts: Record<string, number> = {};
  for (const rule of map.scatters as readonly ScatterRule[]) {
    if (!rule.detail) ruleCounts[rule.id] = context.expand(rule, lists);
  }
  const props = [...lists.keys()].sort().map((prop) => ({ prop, data: new Float32Array(lists.get(prop)!) }));
  return { buildings, props, ruleCounts, checksum: layoutChecksum(buildings, props) };
}

function layoutChecksum(buildings: readonly ResolvedBuilding[], props: readonly PropInstanceSet[]): string {
  const positions = new Float32Array(buildings.flatMap((b) => [...b.position, b.yaw]));
  const parts = [`buildings:${buildings.length}:${checksumBytes(positions)}`, ...props.map((set) => `${set.prop}:${set.data.length}:${checksumBytes(set.data)}`)];
  return checksumBytes(new TextEncoder().encode(parts.join("|")));
}

/** Detail rules (grass) of a map, for the client's near-viewer expansion. */
export function detailRules(map: MapData): ScatterRule[] {
  return (map.scatters as readonly ScatterRule[]).filter((rule) => rule.detail);
}
