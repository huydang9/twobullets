import type { GroundLoot, LootItem } from "@twobullets/shared/equipment/loot";
import type { Vec3 } from "@twobullets/shared/movement/types";

/** GroundLoot's spatial hash cell size (equipment/loot.ts GRID_CELL). */
const GRID_CELL = 8;

let distances = new Float64Array(64);

/**
 * Ground loot within `radius` of `center`, nearest first (ties by loot id), written into `out` (cleared first). Same
 * result as `queryGroundLoot` without allocating per call once `out` and the scratch have grown. With `limit`, only the
 * nearest `limit` items are kept, so dense loot (hundreds of items in range) costs O(n · limit) instead of O(n²).
 */
export function queryGroundLootInto(ground: GroundLoot, center: Vec3, radius: number, out: LootItem[], limit = Infinity): number {
  out.length = 0;
  if (limit <= 0) return 0;
  const r2 = radius * radius;
  const minX = Math.floor((center.x - radius) / GRID_CELL);
  const maxX = Math.floor((center.x + radius) / GRID_CELL);
  const minZ = Math.floor((center.z - radius) / GRID_CELL);
  const maxZ = Math.floor((center.z + radius) / GRID_CELL);
  for (let cx = minX; cx <= maxX; cx++) {
    for (let cz = minZ; cz <= maxZ; cz++) {
      const cell = ground.cells.get((cx + 0x8000) * 0x10000 + (cz + 0x8000));
      if (!cell) continue;
      for (const id of cell) {
        const item = ground.items.get(id);
        if (!item) continue;
        const dx = item.position[0] - center.x;
        const dy = item.position[1] - center.y;
        const dz = item.position[2] - center.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        let i = out.length;
        if (i >= limit) {
          // Full: skip items not nearer than the farthest kept one; otherwise drop that one.
          const last = i - 1;
          if (distances[last]! < d2 || (distances[last] === d2 && out[last]!.lootId < item.lootId)) continue;
          i = last;
        } else {
          if (i >= distances.length) {
            const grown = new Float64Array(distances.length * 2);
            grown.set(distances);
            distances = grown;
          }
          out.push(item);
        }
        // Insertion sort by (distance, lootId).
        while (i > 0 && (distances[i - 1]! > d2 || (distances[i - 1] === d2 && out[i - 1]!.lootId > item.lootId))) {
          out[i] = out[i - 1]!;
          distances[i] = distances[i - 1]!;
          i--;
        }
        out[i] = item;
        distances[i] = d2;
      }
    }
  }
  return out.length;
}
