import type { Scene } from "@babylonjs/core";
import {
  ARENA_LEVEL,
  DRAFT_MAP_V1,
  TRAINING_YARD,
  buildTerrain,
  type LevelBlock,
  type LevelData,
  type MapData,
  type Terrain,
  type Vec3Tuple,
} from "@twobullets/shared";
import { createTerrainBody, type TerrainBody } from "@twobullets/sim";
import type { Environment } from "../environment";
import { TerrainMaterial } from "./TerrainMaterial";
import { TerrainRenderer } from "./TerrainRenderer";
import { createHorizonMesh } from "./horizon";

/** Camera far plane for 1 km views plus the horizon mountains, m. */
export const LARGE_WORLD_FAR_PLANE = 4000;

export interface DevMapWorld {
  readonly map: MapData;
  readonly terrain: Terrain;
  readonly physics: TerrainBody;
  readonly renderer: TerrainRenderer;
  /** Level for the player and combat systems: the Training Yard blocks, soldier targets and map spawns. */
  readonly level: LevelData;
  /** Resolves when terrain textures are loaded. */
  readonly ready: Promise<void>;
}

/**
 * DEV map mode (`?map=v1`): Map v1 terrain (render + Havok heightfield) with the blockout arena placed on a flattened
 * pad as the Training Yard. Requires Havok physics on the scene.
 */
export function createDevMapV1(scene: Scene, environment: Environment): DevMapWorld {
  const map = DRAFT_MAP_V1;
  const started = performance.now();
  const terrain = buildTerrain(map.terrain, map.flatten);
  const built = performance.now();
  const physics = createTerrainBody(scene, terrain.field);

  const material = new TerrainMaterial(scene, terrain);
  const renderer = new TerrainRenderer(scene, terrain, material.material);
  const horizon = createHorizonMesh(scene, terrain, material.material);
  // PBR surfaces are lit by the IBL; keep the hemispheric fill (for non-PBR placeholders) off them.
  environment.skyFill.excludedMeshes.push(...renderer.meshes, horizon);
  console.info(
    `[terrain] ${map.terrain.resolution}² heights + mask ${(built - started).toFixed(0)} ms, physics + ${renderer.meshes.length} chunks ${(performance.now() - built).toFixed(0)} ms, checksum ${terrain.checksum()}`,
  );

  const [yardX, yardZ] = TRAINING_YARD.center;
  const yardY = terrain.sampleHeight(yardX, yardZ) + TRAINING_YARD.floorClearance;
  const level: LevelData = {
    name: `${map.name}: Training Yard`,
    blocks: withNorthGate(ARENA_LEVEL.blocks, TRAINING_YARD.gateHalfWidth).map((block) => translateBlock(block, [yardX, yardY, yardZ])),
    targets: ARENA_LEVEL.targets.map((target) => ({ ...target, position: offset(target.position, [yardX, yardY, yardZ]) })),
    spawnPoints: map.spawns.map(({ position: [x, z], yaw }) => ({ position: [x, terrain.sampleHeight(x, z), z], yaw })),
    killY: map.bounds.killY,
  };

  return { map, terrain, physics, renderer, level, ready: material.ready };
}

function offset(p: Vec3Tuple, by: Vec3Tuple): Vec3Tuple {
  return [p[0] + by[0], p[1] + by[1], p[2] + by[2]];
}

function translateBlock(block: LevelBlock, by: Vec3Tuple): LevelBlock {
  return { ...block, position: offset(block.position, by) };
}

/** The arena is walled in; cut a gate through the north wall and its cap so players can walk in from the map. */
function withNorthGate(blocks: readonly LevelBlock[], halfWidth: number): LevelBlock[] {
  return blocks.flatMap((block) => {
    if (block.name !== "wall_north" && block.name !== "wallCap_north") return [block];
    const [cx, cy, cz] = block.position;
    const [sx, sy, sz] = block.size;
    const minX = cx - sx / 2;
    const maxX = cx + sx / 2;
    const piece = (name: string, x0: number, x1: number): LevelBlock => ({ ...block, name, position: [(x0 + x1) / 2, cy, cz], size: [x1 - x0, sy, sz] });
    return [piece(`${block.name}_west`, minX, -halfWidth), piece(`${block.name}_east`, halfWidth, maxX)];
  });
}
