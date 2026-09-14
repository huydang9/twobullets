/**
 * DEV page (buildings.html): every building prefab on flat ground under the game's environment lighting, with walk
 * (the real player controller) and free-fly cameras, plus stats and debug toggles.
 */
import { Color3, Engine, HavokPlugin, Matrix, MeshBuilder, Scene, StandardMaterial, TargetCamera, Vector3 } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import {
  MOVEMENT,
  buildBuilding,
  buildLevel,
  getBuildingPrefab,
  getPrefabCollision,
  type BuildingPlacement,
  type BuildingPrefabId,
  type BuiltBuilding,
  type LevelData,
  type SpawnPoint,
} from "@twobullets/shared";
import { installDebugTools } from "../debug/debugTools";
import { InputManager } from "../input/InputManager";
import { PlayerController } from "../player/PlayerController";
import { BuildingVisuals, getPrefabGeometry, lookOf } from "../world/buildings";
import { createEnvironment } from "../world/environment";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const SHOWCASE: readonly BuildingPrefabId[] = [
  "house_small",
  "house_small_ruined",
  "house_two_story",
  "barn",
  "warehouse",
  "barracks",
  "watchtower",
  "guard_booth",
  "radar_station",
  "container_open",
];
/** Repeats in a second row: rotations and stacking share the first row's batches (no new draw calls). */
const REPEATS: readonly { id: BuildingPrefabId; yaw: number; y?: number }[] = [
  { id: "house_small", yaw: Math.PI / 2 },
  { id: "house_small", yaw: Math.PI },
  { id: "house_two_story", yaw: -Math.PI / 2 },
  { id: "container_open_blue", yaw: 0.4 },
  { id: "container_closed", yaw: 0 },
  { id: "container_closed", yaw: 0, y: 2.59 },
  { id: "container_open", yaw: Math.PI },
];

const GAP = 8;
const FLY_SPEED = 14;

async function main(): Promise<void> {
  const canvas = document.getElementById("game");
  const panel = document.getElementById("panel");
  if (!(canvas instanceof HTMLCanvasElement) || !panel) throw new Error("buildings.html is missing #game or #panel");

  const engine = new Engine(canvas, true, { stencil: true }, true);
  const scene = new Scene(engine);
  scene.enablePhysics(new Vector3(0, -MOVEMENT.gravity, 0), new HavokPlugin(true, await HavokPhysics()));

  const environment = createEnvironment(scene);
  const ground = buildLevel(scene, {
    name: "preview ground",
    // Top 5 cm below the floors, as terrain flattening should leave it, so floors don't z-fight with the ground.
    blocks: [{ kind: "box", name: "ground", surface: "ground", position: [0, -1.05, -20], size: [260, 2, 160] }],
    spawnPoints: [],
    targets: [],
    killY: -30,
  });
  environment.decorateLevel(ground);

  const visuals = new BuildingVisuals(scene, environment);
  const bakeStart = performance.now();
  const buildings = [...layoutRow(SHOWCASE.map((id) => ({ id, yaw: 0 })), 0), ...layoutRow(REPEATS, -40)].map(({ id, placement }) => buildBuilding(scene, id, placement, visuals));
  const bakeMs = performance.now() - bakeStart;
  const lootMarkers = createLootMarkers(scene, buildings);

  const input = new InputManager(canvas);
  installDebugTools(scene, input);

  const level: Mutable<LevelData> = { name: "buildings preview", blocks: [], spawnPoints: [entranceSpawn(buildings[0]!)], targets: [], killY: -30 };
  const player = new PlayerController(scene, input, level);
  const fly = new TargetCamera("flyCamera", new Vector3(-60, 25, 45), scene);
  fly.minZ = 0.05;
  fly.fov = player.camera.fov;
  fly.setTarget(new Vector3(-20, 0, 0));
  let flying = false;
  let selected = 0;
  scene.activeCamera = player.camera;

  const goTo = (index: number) => {
    const building = buildings[index]!;
    if (flying) {
      const { min, max } = building.bounds;
      const center = new Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
      const reach = Math.max(max[0] - min[0], max[2] - min[2]);
      fly.position.copyFrom(center.add(new Vector3(-0.6 * reach, 0.5 * reach, 0.9 * reach)));
      fly.setTarget(center);
    } else {
      level.spawnPoints = [entranceSpawn(building)];
      player.respawn();
    }
  };

  let panelTimer = 0;
  engine.runRenderLoop(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
    if (input.wasPressed("KeyF")) {
      flying = !flying;
      if (flying) {
        fly.position.copyFrom(player.camera.position);
        fly.rotation.copyFrom(player.camera.rotation);
      }
      scene.activeCamera = flying ? fly : player.camera;
    }
    if (input.wasPressed("BracketRight")) selected = (selected + 1) % buildings.length;
    if (input.wasPressed("BracketLeft")) selected = (selected + buildings.length - 1) % buildings.length;
    if (input.wasPressed("KeyT")) goTo(selected);
    if (input.wasPressed("KeyO")) visuals.materials.setOcclusionEnabled(!visuals.materials.isOcclusionEnabled);
    if (input.wasPressed("KeyL")) lootMarkers.setEnabled(!lootMarkers.isEnabled());

    if (flying) updateFly(fly, input, dt);
    else player.update(dt);
    scene.render();

    panelTimer -= dt;
    if (panelTimer <= 0) {
      panelTimer = 0.2;
      panel.textContent = describe(buildings[selected]!, visuals, player, flying, engine.getFps(), bakeMs);
    }
    input.endFrame();
  });
  window.addEventListener("resize", () => engine.resize());
  Object.assign(window, { __buildings: { scene, visuals, buildings, player } });
}

/** Places prefabs left to right along a row at `z`, fronts facing +Z, spaced by their footprints. */
function layoutRow(entries: readonly { id: BuildingPrefabId; yaw: number; y?: number }[], z: number): { id: BuildingPrefabId; placement: BuildingPlacement }[] {
  let cursor = -110;
  let previousStacked = 0;
  return entries.map(({ id, yaw, y = 0 }) => {
    const { min, max } = getBuildingPrefab(id).bounds;
    const turned = Math.abs(Math.sin(yaw)) > 0.7;
    const width = turned ? max[2] - min[2] : max[0] - min[0];
    // A stacked entry sits on the previous one instead of taking a new slot.
    if (y > 0) return { id, placement: { position: [previousStacked, y, z], yaw } };
    // Unrotated prefabs may be off-center (the booth's barrier); rotated repeats are close enough to symmetric.
    const x = cursor + width / 2 - (yaw === 0 ? (min[0] + max[0]) / 2 : 0);
    cursor += width + GAP;
    previousStacked = x;
    return { id, placement: { position: [x, 0, z], yaw } };
  });
}

function entranceSpawn(building: BuiltBuilding): SpawnPoint {
  const position = building.toWorld(building.prefab.entrances[0] ?? [0, 0, building.prefab.bounds.max[2] + 2]);
  const [cx, , cz] = building.toWorld([0, 0, 0]);
  return { position, yaw: Math.atan2(cx - position[0], cz - position[2]) };
}

function updateFly(camera: TargetCamera, input: InputManager, dt: number): void {
  const { dx, dy } = input.lookDelta();
  camera.rotation.y += dx * 0.0022;
  camera.rotation.x = Math.max(-1.5, Math.min(1.5, camera.rotation.x + dy * 0.0022));
  const axis = (a: string, b: string) => (input.isDown(a) ? 1 : 0) - (input.isDown(b) ? 1 : 0);
  const speed = FLY_SPEED * (input.isDown("ShiftLeft") ? 3 : 1) * dt;
  const forward = camera.getDirection(Vector3.Forward()).scale(axis("KeyW", "KeyS") * speed);
  const right = camera.getDirection(Vector3.Right()).scale(axis("KeyD", "KeyA") * speed);
  camera.position.addInPlace(forward).addInPlace(right);
  camera.position.y += axis("Space", "KeyC") * speed;
}

function createLootMarkers(scene: Scene, buildings: readonly BuiltBuilding[]) {
  const marker = MeshBuilder.CreateBox("lootMarker", { size: 0.2 }, scene);
  const material = new StandardMaterial("mat_lootMarker", scene);
  material.emissiveColor = new Color3(1, 0.8, 0.1);
  material.disableLighting = true;
  marker.material = material;
  marker.isPickable = false;
  const spots = buildings.flatMap((b) => b.lootSpots);
  const matrices = new Float32Array(spots.length * 16);
  spots.forEach(({ position: [x, y, z] }, i) => Matrix.Translation(x, y + 0.1, z).copyToArray(matrices, i * 16));
  marker.thinInstanceSetBuffer("matrix", matrices, 16, true);
  marker.setEnabled(false);
  return marker;
}

function describe(building: BuiltBuilding, visuals: BuildingVisuals, player: PlayerController, flying: boolean, fps: number, bakeMs: number): string {
  const { prefab } = building;
  const geometry = getPrefabGeometry(prefab);
  const looks = [...new Set(geometry.groups.map((g) => lookOf(prefab.id, g.material)))];
  const { min, max } = prefab.bounds;
  const scene = visuals.stats();
  const debug = player.getDebugState();
  const f = (v: number) => v.toFixed(1);
  return [
    "BUILDINGS PREVIEW  (click to capture the mouse)",
    "F walk/fly   [ ] select   T go to selected   O interior occlusion   L loot spots",
    "F8 collision shapes   F9 inspector   fly: WASD, Space/C up/down, Shift fast",
    "",
    `selected   ${prefab.name} (${prefab.id})`,
    `size       ${f(max[0] - min[0])} × ${f(max[2] - min[2])} m, ${f(max[1])} m tall`,
    `render     ${geometry.triangles} tris, ${looks.length} draw calls (${looks.join(", ")})`,
    `physics    ${getPrefabCollision(prefab.id as BuildingPrefabId).length} shapes in one static compound body`,
    `metadata   ${prefab.rooms.length} rooms, ${building.lootSpots.length} loot spots, ${prefab.stairs.length} stair flights`,
    "",
    `scene      ${scene.instances} buildings, ${scene.prefabs} prefabs, ${scene.drawCalls} building draw calls, ${(scene.triangles / 1000).toFixed(1)}k tris`,
    `           geometry bake + placement ${bakeMs.toFixed(0)} ms, ${fps.toFixed(0)} fps`,
    `occlusion  ${visuals.materials.isOcclusionEnabled ? "on" : "off"}`,
    `camera     ${flying ? "fly" : `walk  feet (${debug.position.map(f).join(", ")}) ${debug.grounded ? "grounded" : "air"} ${debug.stance}`}`,
  ].join("\n");
}

main().catch((err: unknown) => {
  console.error("[buildings preview]", err);
  const panel = document.getElementById("panel");
  if (panel) panel.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
