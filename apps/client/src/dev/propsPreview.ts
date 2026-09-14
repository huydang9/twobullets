/**
 * DEV page (props.html): the big trees and cover props from real models, lined up on flat ground under the game's
 * environment lighting without placing them on a map. Row 1 is LOD0, rows 2-3 the far levels side by side, so the
 * simplification can be judged up close. Walk (the real player controller, with the catalog colliders as static
 * bodies) to check cover height and trunk width, or fly.
 */
import { Color3, Engine, HavokPlugin, MeshBuilder, PhysicsAggregate, PhysicsShapeType, Scene, StandardMaterial, TargetCamera, Vector3, type Mesh } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import { MOVEMENT, getMapProp, type LevelData } from "@twobullets/shared";
import { buildLevel } from "@twobullets/sim";
import { installDebugTools } from "../debug/debugTools";
import { InputManager } from "../input/InputManager";
import { PlayerController } from "../player/PlayerController";
import { createEnvironment } from "../world/environment";
import { PROP_MANIFEST, PropLibrary, type PropId } from "../world/propAssets";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const PREVIEW_PROPS: readonly PropId[] = [
  "tree_oak_large",
  "tree_oak_fungi",
  "rock_face_large",
  "rock_boulder_large",
  "stump_boubin",
  "log_mossy",
  "car_wreck",
  "pipe_stack",
  "sandbag_barrier",
  "hay_bale_wall",
  "hay_bale_stack",
  "cable_spool",
];
const GAP = 5;
const ROW_SPACING = 18;
const FLY_SPEED = 14;

interface Placed {
  readonly id: PropId;
  readonly x: number;
  readonly rows: Mesh[][];
}

async function main(): Promise<void> {
  const canvas = document.getElementById("game");
  const panel = document.getElementById("panel");
  if (!(canvas instanceof HTMLCanvasElement) || !panel) throw new Error("props.html is missing #game or #panel");

  const engine = new Engine(canvas, true, { stencil: true }, true);
  const scene = new Scene(engine);
  scene.enablePhysics(new Vector3(0, -MOVEMENT.gravity, 0), new HavokPlugin(true, await HavokPhysics()));
  const environment = createEnvironment(scene);

  const widths = PREVIEW_PROPS.map((id) => PROP_MANIFEST[id].bounds.max[0] - PROP_MANIFEST[id].bounds.min[0]);
  const length = widths.reduce((a, w) => a + w + GAP, 0);
  const ground = buildLevel(scene, {
    name: "props preview ground",
    blocks: [{ kind: "box", name: "ground", surface: "ground", position: [length / 2 - 10, -1, -ROW_SPACING], size: [length + 60, 2, 110] }],
    spawnPoints: [],
    targets: [],
    killY: -30,
  });
  environment.decorateLevel(ground);

  const loadStart = performance.now();
  const library = await PropLibrary.load(scene, { ids: PREVIEW_PROPS });
  const loadMs = performance.now() - loadStart;

  let cursor = 0;
  const placed: Placed[] = PREVIEW_PROPS.map((id, i) => {
    const asset = PROP_MANIFEST[id];
    const x = cursor + widths[i]! / 2 - (asset.bounds.min[0] + asset.bounds.max[0]) / 2;
    cursor += widths[i]! + GAP;
    const rows = asset.lods.map((_, level) =>
      library.createBatch(id, level, `preview_${id}_lod${level}`).map((mesh) => {
        mesh.position.set(x, 0, -level * ROW_SPACING);
        environment.addShadowCaster(mesh);
        mesh.receiveShadows = true;
        return mesh;
      }),
    );
    return { id, x, rows };
  });
  const colliders = createColliders(scene, placed);
  const scaleMarkers = createScaleMarkers(scene, placed);

  const input = new InputManager(canvas);
  installDebugTools(scene, input);
  const level: Mutable<LevelData> = { name: "props preview", blocks: [], spawnPoints: [{ position: [placed[0]!.x, 0.1, 12], yaw: Math.PI }], targets: [], killY: -30 };
  const player = new PlayerController(scene, input, level);
  const fly = new TargetCamera("flyCamera", new Vector3(-12, 12, 22), scene);
  fly.minZ = 0.05;
  fly.fov = player.camera.fov;
  fly.setTarget(new Vector3(20, 2, -10));
  let flying = true;
  let selected = 0;
  scene.activeCamera = fly;

  const goTo = (index: number) => {
    const { x, id } = placed[index]!;
    const { min, max } = PROP_MANIFEST[id].bounds;
    const reach = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 2);
    if (flying) {
      fly.position.set(x - 0.4 * reach, 0.5 * reach + 1, max[2] + 1.2 * reach);
      fly.setTarget(new Vector3(x, (max[1] - min[1]) / 2, 0));
    } else {
      level.spawnPoints = [{ position: [x, 0.1, max[2] + 3], yaw: Math.PI }];
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
      if (!flying) goTo(selected);
    }
    if (input.wasPressed("BracketRight")) selected = (selected + 1) % placed.length;
    if (input.wasPressed("BracketLeft")) selected = (selected + placed.length - 1) % placed.length;
    if (input.wasPressed("KeyT")) goTo(selected);
    if (input.wasPressed("KeyK")) colliders.forEach((m) => (m.isVisible = !m.isVisible));
    if (input.wasPressed("KeyM")) scaleMarkers.setEnabled(!scaleMarkers.isEnabled());

    if (flying) updateFly(fly, input, dt);
    else player.update(dt);
    scene.render();

    panelTimer -= dt;
    if (panelTimer <= 0) {
      panelTimer = 0.2;
      panel.textContent = describe(placed[selected]!, flying, engine.getFps(), loadMs);
    }
    input.endFrame();
  });
  window.addEventListener("resize", () => engine.resize());
  Object.assign(window, { __props: { scene, library, placed, player } });
}

/** Catalog collision (packages/shared map/layout/props.ts) as static bodies in front of LOD0, shown as wireframes. */
function createColliders(scene: Scene, placed: readonly Placed[]): Mesh[] {
  const material = new StandardMaterial("mat_preview_collider", scene);
  material.emissiveColor = new Color3(0.2, 1, 0.4);
  material.disableLighting = true;
  material.wireframe = true;
  return placed.flatMap(({ id, x }) => {
    const { collision } = getMapProp(id);
    if (collision.kind === "none") return [];
    const mesh =
      collision.kind === "cylinder"
        ? MeshBuilder.CreateCylinder(`collider_${id}`, { height: collision.height, diameter: collision.radius * 2, tessellation: 20 }, scene)
        : MeshBuilder.CreateBox(`collider_${id}`, { width: collision.size[0], height: collision.size[1], depth: collision.size[2] }, scene);
    const height = collision.kind === "cylinder" ? collision.height : collision.size[1];
    const offsetY = collision.kind === "box" ? (collision.offsetY ?? 0) : 0;
    mesh.position.set(x, height / 2 + offsetY, 0);
    mesh.material = material;
    mesh.isPickable = false;
    new PhysicsAggregate(mesh, collision.kind === "cylinder" ? PhysicsShapeType.CYLINDER : PhysicsShapeType.BOX, { mass: 0 }, scene);
    return [mesh];
  });
}

/** A 1.8 m standing and 1.1 m crouching player silhouette beside each LOD0 prop. */
function createScaleMarkers(scene: Scene, placed: readonly Placed[]): Mesh {
  const material = new StandardMaterial("mat_preview_scale", scene);
  material.diffuseColor = new Color3(0.85, 0.3, 0.2);
  const root = MeshBuilder.CreateBox("scaleMarkers", { size: 0.01 }, scene);
  root.isVisible = false;
  for (const { id, x } of placed) {
    const { min, max } = PROP_MANIFEST[id].bounds;
    for (const [height, dx] of [[MOVEMENT.standHeight, 0], [MOVEMENT.crouchHeight, 0.7]] as const) {
      const marker = MeshBuilder.CreateBox(`scale_${id}_${height}`, { width: 0.5, height, depth: 0.3 }, scene);
      marker.position.set(x + min[0] - 0.9 + dx, height / 2, max[2] + 0.8);
      marker.material = material;
      marker.isPickable = false;
      marker.parent = root;
    }
  }
  return root;
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

function describe({ id, rows }: Placed, flying: boolean, fps: number, loadMs: number): string {
  const asset = PROP_MANIFEST[id];
  const def = getMapProp(id);
  const { min, max } = asset.bounds;
  const f = (v: number) => v.toFixed(2);
  const collision = def.collision;
  const shape =
    collision.kind === "cylinder"
      ? `cylinder r ${collision.radius} h ${collision.height}`
      : collision.kind === "box"
        ? `box ${collision.size.join(" × ")}${collision.bulletproof ? "" : " (movement only)"}`
        : "none";
  return [
    "COVER PROPS PREVIEW  (click to capture the mouse)",
    "F walk/fly   [ ] select   T go to selected   K colliders   M scale markers",
    "rows: LOD0 (z 0), LOD1 (z −18), LOD2 (z −36)   F8 physics   F9 inspector",
    "",
    `selected   ${id}${asset.ready ? "" : "  (NOT READY: placeholder)"}`,
    `size       ${f(max[0] - min[0])} × ${f(max[2] - min[2])} m, ${f(max[1])} m tall`,
    `LODs       ${asset.lods.map((l) => `${l.triangles}${l.billboard ? " impostor" : ""} @${l.distance} m`).join("  /  ")}`,
    `draw calls ${rows.map((r) => r.length).join(" / ")} (meshes per level)`,
    `collider   ${shape}   footprint ${def.footprint} m   cover ${def.cover ? "yes" : "no"}`,
    `file       ${asset.url} ${(asset.bytes / 1e6).toFixed(2)} MB`,
    `source     ${asset.source ? `${asset.source.name} by ${asset.source.authors.join(", ")} (${asset.source.license})` : "-"}`,
    "",
    `library    ${PREVIEW_PROPS.length} props loaded in ${loadMs.toFixed(0)} ms, ${fps.toFixed(0)} fps, camera ${flying ? "fly" : "walk"}`,
  ].join("\n");
}

main().catch((err: unknown) => {
  console.error("[props preview]", err);
  const panel = document.getElementById("panel");
  if (panel) panel.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
