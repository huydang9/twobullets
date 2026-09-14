import { MOVEMENT } from "../../constants";
import { getBuildingPrefab, type BuildingPrefabId } from "../../map/buildings/prefabs";
import { wedgePlane } from "../../map/buildings/raycast";
import { NavFlag, type NavGrid } from "../types";
import { CROUCH_CLEARANCE, NAV_STEP_HEIGHT, STAND_CLEARANCE, asNavGridData } from "./navGrid";

// Independent audit of building ↔ terrain links for tests and benches: a square capsule of the controller radius is
// stepped along each link every 5 cm against the prefab's parts (the same boxes and wedges the physics compounds use)
// and must never overlap a part between step height and headroom. Build-time helper; allocates freely.

export interface LinkViolation {
  readonly placement: string;
  readonly from: readonly [number, number, number];
  readonly to: readonly [number, number, number];
  /** Role and local bounds of the first part hit. */
  readonly part: string;
}

export function auditBuildingLinks(grid: NavGrid, radius: number = MOVEMENT.capsuleRadius, step = 0.05): LinkViolation[] {
  const d = asNavGridData(grid);
  const { linkFrom, linkTo } = d.arrays;
  const out: LinkViolation[] = [];
  for (let i = 0; i < linkFrom.length; i++) {
    const from = linkFrom[i]!;
    const to = linkTo[i]!;
    if (from < d.terrainNodes) continue;
    const g = from - d.terrainNodes;
    const p = d.placements[d.spanPlacement[g]!]!;
    const layer = d.layers[p.layer]!;
    const prefab = getBuildingPrefab(layer.prefab as BuildingPrefabId);
    const t = layer.spanY[g - p.base]!;
    const y0 = t + NAV_STEP_HEIGHT;
    const y1 = t + ((d.spanFlags[g]! & NavFlag.crouchOnly) !== 0 ? CROUCH_CLEARANCE : STAND_CLEARANCE);
    const local = (ref: number): [number, number] => {
      const dx = d.nodeX(ref) - p.x;
      const dz = d.nodeZ(ref) - p.z;
      return [dx * p.cos - dz * p.sin, dx * p.sin + dz * p.cos];
    };
    const [ax, az] = local(from);
    const [bx, bz] = local(to);
    const n = Math.max(1, Math.ceil(Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az)) / step));
    let hit: string | null = null;
    for (let s = 0; s <= n && !hit; s++) {
      const x = ax + ((bx - ax) * s) / n;
      const z = az + ((bz - az) * s) / n;
      for (const part of prefab.parts) {
        if (part.min[0] >= x + radius || part.max[0] <= x - radius || part.min[2] >= z + radius || part.max[2] <= z - radius) continue;
        if (part.min[1] >= y1) continue;
        let top = part.max[1];
        if (part.kind === "wedge") {
          const [nx, ny, nz, w] = wedgePlane(part);
          top = -Infinity;
          for (const cx of [Math.max(part.min[0], x - radius), Math.min(part.max[0], x + radius)]) {
            for (const cz of [Math.max(part.min[2], z - radius), Math.min(part.max[2], z + radius)]) {
              top = Math.max(top, Math.min(part.max[1], Math.max(part.min[1], (w - nx * cx - nz * cz) / ny)));
            }
          }
        }
        if (top <= y0) continue;
        hit = `${part.role} [${part.min.join(",")}]-[${part.max.join(",")}]`;
        break;
      }
    }
    if (hit) out.push({ placement: p.id, from: [d.nodeX(from), d.nodeY(from), d.nodeZ(from)], to: [d.nodeX(to), d.nodeY(to), d.nodeZ(to)], part: hit });
  }
  return out;
}
