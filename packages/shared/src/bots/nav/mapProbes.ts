import { getPrefabLootSpots, localToWorld } from "../../map/buildings/placement";
import { getBuildingPrefab } from "../../map/buildings/prefabs";
import type { MapLayout } from "../../map/layout/mapLayout";
import type { Terrain } from "../../map/terrain/terrain";
import type { MapData } from "../../map/types";
import type { NavQuery } from "../types";

// Probe points for map navigation tests and benches: POI centers, spawns, building entrances, one floor point per room
// (upper floors included) and every loot spot. Build-time helper; allocates freely.

export type NavProbeKind = "poi" | "spawn" | "entrance" | "room" | "loot";

export interface NavProbe {
  readonly name: string;
  readonly kind: NavProbeKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Snap distance for `nearest`, m. */
  readonly maxDistance: number;
  readonly building?: string;
  readonly poi?: string;
  /** Room or loot spot above the ground floor (floorY ≥ 2 m). */
  readonly upper: boolean;
}

export function mapNavProbes(map: MapData, terrain: Terrain, layout: MapLayout): NavProbe[] {
  const probes: NavProbe[] = [];
  for (const poi of map.pois) {
    const [x, z] = poi.center;
    probes.push({ name: `poi:${poi.id}`, kind: "poi", x, y: terrain.sampleHeight(x, z), z, maxDistance: 12, poi: poi.id, upper: false });
  }
  map.spawns.forEach((spawn, i) => {
    const [x, z] = spawn.position;
    probes.push({ name: `spawn:${i}`, kind: "spawn", x, y: terrain.sampleHeight(x, z), z, maxDistance: 1, upper: false });
  });
  for (const b of layout.buildings) {
    const prefab = getBuildingPrefab(b.prefab);
    const placement = { position: b.position, yaw: b.yaw };
    const extra = { building: b.id, ...(b.poi ? { poi: b.poi } : {}) };
    prefab.entrances.forEach((e, i) => {
      const [x, y, z] = localToWorld(placement, e);
      probes.push({ name: `entrance:${b.id}:${i}`, kind: "entrance", x, y: Math.max(y, terrain.sampleHeight(x, z)), z, maxDistance: 1.5, ...extra, upper: false });
    });
    const spots = getPrefabLootSpots(b.prefab);
    for (const room of prefab.rooms) {
      const cx = (room.min[0] + room.max[0]) / 2;
      const cz = (room.min[1] + room.max[1]) / 2;
      let best: readonly [number, number, number] = [cx, room.floorY, cz];
      let bestD = Infinity;
      for (const spot of spots) {
        if (spot.roomId !== room.id) continue;
        const d = (spot.position[0] - cx) * (spot.position[0] - cx) + (spot.position[2] - cz) * (spot.position[2] - cz);
        if (d < bestD) [bestD, best] = [d, spot.position];
      }
      const [x, y, z] = localToWorld(placement, best);
      probes.push({ name: `room:${b.id}:${room.id}`, kind: "room", x, y, z, maxDistance: 1.25, ...extra, upper: room.floorY >= 2 });
    }
    spots.forEach((spot, i) => {
      const [x, y, z] = localToWorld(placement, spot.position);
      probes.push({ name: `loot:${b.id}:${spot.roomId}:${i}`, kind: "loot", x, y, z, maxDistance: 1, ...extra, upper: spot.position[1] >= 2 });
    });
  }
  return probes;
}

export interface ProbeResult {
  readonly probe: NavProbe;
  readonly ref: number;
  /** Snapped node height minus the probe height, m. */
  readonly dy: number;
  readonly reachable: boolean;
}

/** Snaps every probe and tests reachability from `from` (O(1) per probe). */
export function resolveProbes(nav: NavQuery, probes: readonly NavProbe[], from: number): ProbeResult[] {
  const out = { x: 0, y: 0, z: 0 };
  return probes.map((probe) => {
    const ref = nav.nearest(probe, probe.maxDistance, out);
    return { probe, ref, dy: ref >= 0 ? out.y - probe.y : NaN, reachable: ref >= 0 && nav.reachable(from, ref) };
  });
}
