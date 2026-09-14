import { getBuildingPrefab, worldToLocal, type BuildingMaterialId, type BuildingPart, type BuildingPrefab, type FaceDir, type ResolvedBuilding } from "@twobullets/shared";
import type { EnclosureProvider } from "../../audio/AudioWorldProbe";
import { taggedSurface, type SurfaceProvider } from "../../audio/surfaces";

/** Story height used as a room's vertical extent above its floor, m (the kit's slab-to-slab height). */
const STORY = 3;
/** A point this close to a part's box counts as touching it (feet on floors, impacts on walls), m. */
const TOUCH = 0.2;
const CELL = 32;

interface Entry {
  readonly building: ResolvedBuilding;
  readonly prefab: BuildingPrefab;
}

/**
 * Audio lookups against placed buildings, from pure prefab data (no rays):
 * - `surface`: the material of the building part at a footstep or impact point, mapped by audio's `taggedSurface`;
 * - `enclosure`: 1 inside an indoor room, 0 in an open-air one (balconies, roofless ruins, tower platforms), 0 out in
 *   the open, and null (let the probe's rays decide) inside a building but outside its rooms or within `rayZones`.
 */
export class BuildingAcoustics {
  private readonly grid = new Map<string, Entry[]>();

  constructor(
    buildings: readonly ResolvedBuilding[],
    /** Areas where geometry other than buildings may roof the listener (the Training Yard arena): [minX, minZ, maxX, maxZ]. */
    private readonly rayZones: readonly (readonly [number, number, number, number])[] = [],
  ) {
    for (const building of buildings) {
      const entry = { building, prefab: getBuildingPrefab(building.prefab) };
      const [hx, hz] = building.bounds.halfExtents;
      const r = Math.sqrt(hx * hx + hz * hz);
      const [cx, cz] = building.bounds.center;
      for (let iz = Math.floor((cz - r) / CELL); iz <= Math.floor((cz + r) / CELL); iz++) {
        for (let ix = Math.floor((cx - r) / CELL); ix <= Math.floor((cx + r) / CELL); ix++) {
          const key = `${ix},${iz}`;
          this.grid.set(key, [...(this.grid.get(key) ?? []), entry]);
        }
      }
    }
  }

  readonly surface: SurfaceProvider = {
    surfaceAt: (x, y, z) => {
      let best: BuildingMaterialId | null = null;
      let bestDistance = TOUCH;
      for (const { building, prefab } of this.near(x, z)) {
        const local = worldToLocal(building, [x, y, z]);
        for (const part of prefab.parts) {
          const face = nearestFace(part, local);
          if (face.distance < bestDistance) [best, bestDistance] = [faceMaterial(part, face.dir), face.distance];
        }
      }
      return best === null ? null : taggedSurface({ name: "", metadata: { surface: best } });
    },
  };

  readonly enclosure: EnclosureProvider = ({ x, y, z }) => {
    for (const [minX, minZ, maxX, maxZ] of this.rayZones) if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) return null;
    let insideBounds = false;
    for (const { building, prefab } of this.near(x, z)) {
      const [lx, ly, lz] = worldToLocal(building, [x, y, z]);
      const { min, max } = prefab.bounds;
      if (lx < min[0] || lx > max[0] || lz < min[2] || lz > max[2] || ly < min[1] || ly > max[1]) continue;
      insideBounds = true;
      for (const room of prefab.rooms) {
        if (lx >= room.min[0] && lx <= room.max[0] && lz >= room.min[1] && lz <= room.max[1] && ly >= room.floorY - 0.3 && ly < room.floorY + STORY) {
          return room.indoor ? 1 : 0;
        }
      }
    }
    return insideBounds ? null : 0;
  };

  private near(x: number, z: number): readonly Entry[] {
    return this.grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? [];
  }
}

const FACES: readonly (readonly [FaceDir, FaceDir])[] = [["-x", "+x"], ["-y", "+y"], ["-z", "+z"]];

/**
 * The face of a part's box closest to a point, and how far the point is from the box (0 inside). Outside the box the
 * face is on the axis the point sticks out furthest; inside, it is the face with the least penetration.
 */
function nearestFace(part: BuildingPart, p: readonly [number, number, number]): { dir: FaceDir; distance: number } {
  let outside = 0;
  let outsideDir: FaceDir = "+y";
  let inside = Infinity;
  let insideDir: FaceDir = "+y";
  for (let axis = 0; axis < 3; axis++) {
    const below = part.min[axis]! - p[axis]!;
    const above = p[axis]! - part.max[axis]!;
    if (below > outside) [outside, outsideDir] = [below, FACES[axis]![0]];
    if (above > outside) [outside, outsideDir] = [above, FACES[axis]![1]];
    if (-below < inside) [inside, insideDir] = [-below, FACES[axis]![0]];
    if (-above < inside) [inside, insideDir] = [-above, FACES[axis]![1]];
  }
  return outside > 0 ? { dir: outsideDir, distance: outside } : { dir: insideDir, distance: 0 };
}

function faceMaterial(part: BuildingPart, dir: FaceDir): BuildingMaterialId {
  if (part.kind === "box") return part.faces?.[dir] ?? part.material;
  return dir === "+y" ? (part.slopeMaterial ?? part.material) : part.material;
}
