import { ARENA_LEVEL, type LevelBlock, type TargetSpawn, type Terrain, type Vec3Tuple } from "@twobullets/shared";

export interface TrainingYardPlacement {
  readonly center: readonly [x: number, z: number];
  /** The arena ground slab sits this far above the flattened pad. */
  readonly floorClearance: number;
  /** Half width of the gate cut into the arena's north wall, m. */
  readonly gateHalfWidth: number;
}

export interface TrainingYard {
  readonly blocks: readonly LevelBlock[];
  /** The soldier range, moved with the arena. */
  readonly targets: readonly TargetSpawn[];
  readonly floorY: number;
}

/** The blockout arena and its soldier range, placed on the Training Yard pad with a gate in the north wall. */
export function createTrainingYard(terrain: Terrain, placement: TrainingYardPlacement): TrainingYard {
  const [x, z] = placement.center;
  const floorY = terrain.sampleHeight(x, z) + placement.floorClearance;
  const by: Vec3Tuple = [x, floorY, z];
  return {
    floorY,
    blocks: withNorthGate(ARENA_LEVEL.blocks, placement.gateHalfWidth).map((block) => ({ ...block, position: offset(block.position, by) })),
    targets: ARENA_LEVEL.targets.map((target) => ({ ...target, position: offset(target.position, by) })),
  };
}

function offset(p: Vec3Tuple, by: Vec3Tuple): Vec3Tuple {
  return [p[0] + by[0], p[1] + by[1], p[2] + by[2]];
}

/** Splits the north wall and its cap around a gate at arena-local x ∈ [-halfWidth, halfWidth]. */
function withNorthGate(blocks: readonly LevelBlock[], halfWidth: number): LevelBlock[] {
  return blocks.flatMap((block) => {
    if (block.name !== "wall_north" && block.name !== "wallCap_north") return [block];
    const [cx, cy, cz] = block.position;
    const [sx, sy, sz] = block.size;
    const piece = (name: string, x0: number, x1: number): LevelBlock => ({ ...block, name, position: [(x0 + x1) / 2, cy, cz], size: [x1 - x0, sy, sz] });
    return [piece(`${block.name}_west`, cx - sx / 2, -halfWidth), piece(`${block.name}_east`, halfWidth, cx + sx / 2)];
  });
}
