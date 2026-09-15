/**
 * DEV page (vn-props.html): the Vietnamese street set (tools/environment/vn, VN_PROP_MANIFEST) on flat ground under the
 * game's environment lighting, not placed on a map. One row per group (sidewalk, shopfront, …); each prop shows LOD0 in
 * front and its far levels behind it. Fly around, jump between props, toggle the manifest colliders and a player-sized
 * scale marker.
 */
import { Color3, Engine, LoadAssetContainerAsync, Mesh, MeshBuilder, Scene, StandardMaterial, TargetCamera, Vector3, type AbstractMesh, type AssetContainer } from "@babylonjs/core";
import HavokPhysics from "@babylonjs/havok";
import { registerBuiltInLoaders } from "@babylonjs/loaders/dynamic";
import type {} from "@babylonjs/loaders/glTF/glTFFileLoader.types";
import { MOVEMENT } from "@twobullets/shared";
import { configureDecoders } from "../assets/decoders";
import type { AssetManifest } from "../assets/manifest";
import { VN_PROP_IDS, VN_PROP_MANIFEST, type VnPropAsset } from "../assets/vnPropsManifest";
import { installDebugTools } from "../debug/debugTools";
import { InputManager } from "../input/InputManager";
import { createEnvironment } from "../world/environment";
import { createVnPreview, type PlacedVnProp as Placed } from "./vnPropsPreviewScene";

const FLY_SPEED = 10;

async function main(): Promise<void> {
  const canvas = document.getElementById("game");
  const panel = document.getElementById("panel");
  if (!(canvas instanceof HTMLCanvasElement) || !panel) throw new Error("vn-props.html is missing #game or #panel");

  const engine = new Engine(canvas, true, { stencil: true }, true);
  const scene = new Scene(engine);
  const environment = createEnvironment(scene);
  const camera = new TargetCamera("flyCamera", new Vector3(-6, 5, 10), scene);
  camera.minZ = 0.05;
  camera.setTarget(new Vector3(6, 0.5, -4));
  scene.activeCamera = camera;
  // Render while props stream in, so the page shows progress instead of a frozen tab.
  engine.runRenderLoop(() => scene.render());

  const loadStart = performance.now();
  registerBuiltInLoaders();
  const assetsRoot = new URL(`${import.meta.env.BASE_URL}assets/`, location.href);
  const manifest = (await (await fetch(new URL("manifest.json", assetsRoot))).json()) as AssetManifest;
  configureDecoders(manifest.decoders, assetsRoot);
  const envRoot = new URL("environment/", assetsRoot);
  const loadFile = async (url: string): Promise<AssetContainer> => {
    const response = await fetch(new URL(url, envRoot));
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const container = await LoadAssetContainerAsync(new Uint8Array(await response.arrayBuffer()), scene, { name: url, pluginExtension: ".glb" });
    container.addAllToScene();
    return container;
  };

  const { placed, fileCount } = await createVnPreview(scene, {
    havok: await HavokPhysics(),
    loadFile,
    decorateLevel: (level) => environment.decorateLevel(level),
    addShadowCaster: (mesh) => environment.addShadowCaster(mesh),
    onProgress: (done, total, id) => (panel.textContent = `Loading Vietnamese street props… ${done} / ${total}  (${id})`),
  });
  const loadMs = performance.now() - loadStart;
  engine.stopRenderLoop();
  const colliders = createColliders(scene, placed);
  const markers = createScaleMarkers(scene, placed);

  const input = new InputManager(canvas);
  installDebugTools(scene, input);
  let selected = 0;

  const goTo = (index: number) => {
    const { id, position } = placed[index]!;
    const { min, max } = VN_PROP_MANIFEST[id].bounds;
    const reach = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1.2);
    camera.position.set(position.x - 0.5 * reach, 0.6 * reach + 0.6, position.z + max[2] + 1.6 * reach);
    camera.setTarget(new Vector3(position.x, (max[1] - min[1]) / 2, position.z));
  };

  let panelTimer = 0;
  engine.runRenderLoop(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
    if (input.wasPressed("BracketRight")) goTo((selected = (selected + 1) % placed.length));
    if (input.wasPressed("BracketLeft")) goTo((selected = (selected + placed.length - 1) % placed.length));
    if (input.wasPressed("KeyT")) goTo(selected);
    if (input.wasPressed("KeyK")) colliders.forEach((m) => (m.isVisible = !m.isVisible));
    if (input.wasPressed("KeyM")) markers.setEnabled(!markers.isEnabled());
    updateFly(camera, input, dt);
    scene.render();
    panelTimer -= dt;
    if (panelTimer <= 0) {
      panelTimer = 0.2;
      panel.textContent = describe(placed[selected]!, engine.getFps(), loadMs, fileCount);
    }
    input.endFrame();
  });
  window.addEventListener("resize", () => engine.resize());
  Object.assign(window, { __vnProps: { scene, placed, goTo } });
}

/** Manifest collision shapes in front of LOD0, as wireframes (hidden until K). */
function createColliders(scene: Scene, placed: readonly Placed[]): AbstractMesh[] {
  const material = new StandardMaterial("mat_vn_preview_collider", scene);
  material.emissiveColor = new Color3(0.2, 1, 0.4);
  material.disableLighting = true;
  material.wireframe = true;
  return placed.flatMap(({ id, position }) => {
    const collision = VN_PROP_MANIFEST[id].collision;
    let mesh: Mesh;
    if (collision.kind === "box") {
      mesh = MeshBuilder.CreateBox(`collider_${id}`, { width: collision.size[0], height: collision.size[1], depth: collision.size[2] }, scene);
      mesh.position.set(position.x + collision.center[0], collision.center[1], position.z + collision.center[2]);
    } else if (collision.kind === "cylinder") {
      mesh = MeshBuilder.CreateCylinder(`collider_${id}`, { height: collision.height, diameter: collision.radius * 2, tessellation: 20 }, scene);
      mesh.position.set(position.x + collision.center[0], collision.center[1], position.z + collision.center[2]);
    } else if (collision.kind === "convexHull") {
      // Support points only: a closed polyline through them is enough to judge the hull's extent.
      const lines = MeshBuilder.CreateLines(`collider_${id}`, { points: [...collision.points, collision.points[0]!].map((p) => new Vector3(position.x + p[0], p[1], position.z + p[2])) }, scene);
      lines.color = new Color3(0.2, 1, 0.4);
      lines.isPickable = false;
      lines.isVisible = false;
      return [lines];
    } else {
      return [];
    }
    mesh.material = material;
    mesh.isPickable = false;
    mesh.isVisible = false;
    return [mesh];
  });
}

/** Standing (1.8 m) and crouching player boxes beside each LOD0. */
function createScaleMarkers(scene: Scene, placed: readonly Placed[]): Mesh {
  const material = new StandardMaterial("mat_vn_preview_scale", scene);
  material.diffuseColor = new Color3(0.85, 0.3, 0.2);
  const root = MeshBuilder.CreateBox("vnScaleMarkers", { size: 0.01 }, scene);
  root.isVisible = false;
  root.setEnabled(false);
  for (const { id, position } of placed) {
    const { min, max } = VN_PROP_MANIFEST[id].bounds;
    for (const [height, dx] of [[MOVEMENT.standHeight, 0], [MOVEMENT.crouchHeight, 0.6]] as const) {
      const marker = MeshBuilder.CreateBox(`vn_scale_${id}_${height}`, { width: 0.45, height, depth: 0.3 }, scene);
      marker.position.set(position.x + min[0] - 0.8 + dx, height / 2, position.z + max[2] + 0.6);
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
  camera.position.addInPlace(camera.getDirection(Vector3.Forward()).scale(axis("KeyW", "KeyS") * speed));
  camera.position.addInPlace(camera.getDirection(Vector3.Right()).scale(axis("KeyD", "KeyA") * speed));
  camera.position.y += axis("Space", "KeyC") * speed;
}

function describe({ id, levels }: Placed, fps: number, loadMs: number, fileCount: number): string {
  const asset: VnPropAsset = VN_PROP_MANIFEST[id];
  const { min, max } = asset.bounds;
  const f = (v: number) => v.toFixed(2);
  const c = asset.collision;
  const shape = c.kind === "box" ? `box ${c.size.map(f).join(" × ")}` : c.kind === "cylinder" ? `cylinder r ${c.radius} h ${c.height}` : c.kind === "convexHull" ? `convex hull (${c.points.length} points)` : "none";
  return [
    "VIETNAMESE STREET PROPS  (click to capture the mouse)",
    "WASD/Space/C fly (Shift fast)   [ ] select   T go to   K colliders   M scale markers   F9 inspector",
    "rows: groups; LOD0 in front, far levels behind it (4 m apart)",
    "",
    `selected   ${id}  [${asset.group}, ${asset.category}, ${asset.surface}]`,
    `use        ${asset.use}`,
    `size       ${f(max[0] - min[0])} × ${f(max[2] - min[2])} m, ${f(max[1])} m tall`,
    `LODs       ${asset.lods.map((l) => `${l.triangles} @${l.distance} m`).join("  /  ")}   cull ${asset.cullDistance} m`,
    `draw calls ${levels.map((l) => l.length).join(" / ")} (meshes per level)`,
    `collider   ${shape}   footprint r ${f(asset.footprintRadius)} m`,
    `file       ${asset.url} ${(asset.bytes / 1e6).toFixed(2)} MB`,
    `source     ${asset.source ? `${asset.source.name} by ${asset.source.authors.join(", ")} (${asset.source.license})` : "-"}`,
    "",
    `library    ${VN_PROP_IDS.length} props from ${fileCount} files in ${loadMs.toFixed(0)} ms, ${fps.toFixed(0)} fps`,
  ].join("\n");
}

main().catch((err: unknown) => {
  console.error("[vn props preview]", err);
  const panel = document.getElementById("panel");
  if (panel) panel.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
