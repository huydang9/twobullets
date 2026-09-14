import type { LevelBlock, Vec3Tuple } from "../../level/types";
import { getBuildingPrefab, type BuildingPrefabId } from "./prefabs";
import { PartBvh } from "./raycast";
import type { BuildingCollisionShape, BuildingPlacement, BuildingPrefab, BuildingRoom, HorizontalDir, LootSpot } from "./types";

const collisionCache = new Map<BuildingPrefabId, readonly BuildingCollisionShape[]>();
const lootCache = new Map<BuildingPrefabId, readonly LootSpot[]>();

/**
 * Prefab-local collision shapes, one per part, identical to the visuals. Pure data for a headless server:
 * build one static compound shape per prefab and share it across every placement.
 */
export function getPrefabCollision(id: BuildingPrefabId): readonly BuildingCollisionShape[] {
  let shapes = collisionCache.get(id);
  if (!shapes) {
    shapes = getBuildingPrefab(id).parts.map((part): BuildingCollisionShape => {
      const center: Vec3Tuple = [(part.min[0] + part.max[0]) / 2, (part.min[1] + part.max[1]) / 2, (part.min[2] + part.max[2]) / 2];
      const size: Vec3Tuple = [part.max[0] - part.min[0], part.max[1] - part.min[1], part.max[2] - part.min[2]];
      return part.kind === "box" ? { kind: "box", center, size } : { kind: "wedge", center, size, rises: part.rises };
    });
    collisionCache.set(id, shapes);
  }
  return shapes;
}

/** The six corners of a collision wedge, prefab-local, for building a convex hull. */
export function wedgeCorners(shape: Extract<BuildingCollisionShape, { kind: "wedge" }>): Vec3Tuple[] {
  const [cx, cy, cz] = shape.center;
  const [hx, hy, hz] = [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2];
  const sign = shape.rises[0] === "+" ? 1 : -1;
  if (shape.rises[1] === "z") {
    const [low, high] = [cz - sign * hz, cz + sign * hz];
    return [[cx - hx, cy - hy, low], [cx + hx, cy - hy, low], [cx - hx, cy - hy, high], [cx + hx, cy - hy, high], [cx - hx, cy + hy, high], [cx + hx, cy + hy, high]];
  }
  const [low, high] = [cx - sign * hx, cx + sign * hx];
  return [[low, cy - hy, cz - hz], [low, cy - hy, cz + hz], [high, cy - hy, cz - hz], [high, cy - hy, cz + hz], [high, cy + hy, cz - hz], [high, cy + hy, cz + hz]];
}

/** Prefab-local point to world space. */
export function localToWorld(placement: BuildingPlacement, p: Vec3Tuple): Vec3Tuple {
  const s = Math.sin(placement.yaw);
  const c = Math.cos(placement.yaw);
  const [px, py, pz] = placement.position;
  return [px + p[0] * c + p[2] * s, py + p[1], pz - p[0] * s + p[2] * c];
}

/** World point to prefab-local space. */
export function worldToLocal(placement: BuildingPlacement, p: Vec3Tuple): Vec3Tuple {
  const s = Math.sin(placement.yaw);
  const c = Math.cos(placement.yaw);
  const [dx, dy, dz] = [p[0] - placement.position[0], p[1] - placement.position[1], p[2] - placement.position[2]];
  return [dx * c - dz * s, dy, dx * s + dz * c];
}

/** World-space axis-aligned bounds of a placed prefab. */
export function placedBounds(prefab: BuildingPrefab, placement: BuildingPlacement): { min: Vec3Tuple; max: Vec3Tuple } {
  const { min, max } = prefab.bounds;
  const corners = [min[0], max[0]].flatMap((x) => [min[2], max[2]].map((z) => localToWorld(placement, [x, 0, z])));
  const xs = corners.map((c) => c[0]);
  const zs = corners.map((c) => c[2]);
  const y = placement.position[1];
  return { min: [Math.min(...xs), y + min[1], Math.min(...zs)], max: [Math.max(...xs), y + max[1], Math.max(...zs)] };
}

const YAW_OF_RISE: Record<HorizontalDir, number> = { "+z": 0, "+x": Math.PI / 2, "-z": Math.PI, "-x": -Math.PI / 2 };

/**
 * The prefab as LevelBlocks (one body per part through buildLevel), for tools that already consume LevelData such as the
 * runtime benchmarks. Games should prefer one compound body per building (see createBuildingBody).
 */
export function prefabLevelBlocks(id: BuildingPrefabId, placement: BuildingPlacement): LevelBlock[] {
  return getPrefabCollision(id).map((shape, i): LevelBlock => {
    const position = localToWorld(placement, shape.center);
    const name = `${id}_${i}`;
    if (shape.kind === "box") return { kind: "box", name, surface: "wall", position, size: shape.size, rotationY: placement.yaw };
    // LevelBlock ramps rise along local +Z; rotate the prefab-local size into that frame.
    const alongX = shape.rises[1] === "x";
    const size: Vec3Tuple = alongX ? [shape.size[2], shape.size[1], shape.size[0]] : shape.size;
    return { kind: "ramp", name, surface: "ramp", position, size, rotationY: placement.yaw + YAW_OF_RISE[shape.rises] };
  });
}

export interface LootOptions {
  /** Grid spacing, m. */
  readonly spacing?: number;
  /** Minimum distance from the room edge, m. */
  readonly inset?: number;
}

const LOOT_CLEARANCE_HALF = 0.3;
const LOOT_CLEARANCE_HEIGHT = 1;

/**
 * Floor-level loot spots on a grid inside each room, skipping spots blocked by furniture, stairs or walls and spots
 * without a floor under them (stair holes). Deterministic; prefab-local.
 */
export function getPrefabLootSpots(id: BuildingPrefabId, options: LootOptions = {}): readonly LootSpot[] {
  const cacheable = options.spacing === undefined && options.inset === undefined;
  const cached = cacheable ? lootCache.get(id) : undefined;
  if (cached) return cached;
  const prefab = getBuildingPrefab(id);
  const bvh = new PartBvh(prefab.parts);
  const spots = prefab.rooms.flatMap((room) => roomLootSpots(bvh, room, options.spacing ?? 1.5, options.inset ?? 0.6));
  if (cacheable) lootCache.set(id, spots);
  return spots;
}

function roomLootSpots(bvh: PartBvh, room: BuildingRoom, spacing: number, inset: number): LootSpot[] {
  const axis = (lo: number, hi: number): number[] => {
    const span = hi - lo - 2 * inset;
    if (span < 0) return [];
    const count = Math.floor(span / spacing) + 1;
    const start = lo + inset + (span - (count - 1) * spacing) / 2;
    return Array.from({ length: count }, (_, i) => start + i * spacing);
  };
  const y = room.floorY;
  const spots: LootSpot[] = [];
  for (const x of axis(room.min[0], room.max[0])) {
    for (const z of axis(room.min[1], room.max[1])) {
      const r = LOOT_CLEARANCE_HALF;
      if (bvh.overlapsBox([x - r, y + 0.01, z - r], [x + r, y + LOOT_CLEARANCE_HEIGHT, z + r])) continue;
      const floor = bvh.raycast([x, y + 0.05, z], [0, -1, 0], 0.1);
      if (floor === null) continue;
      spots.push({ position: [round(x), y, round(z)], roomId: room.id });
    }
  }
  return spots;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
