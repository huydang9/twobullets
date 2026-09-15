/**
 * Headless render-side CPU bench of a full map world (NullEngine: no GPU, but Babylon still runs active mesh selection,
 * render-list dispatch, shadow render targets with per-cascade caster lists, material binding and draw submission).
 *
 *   node --experimental-transform-types tools/bench/render/world.ts [--map=vn-hangxanh|v1|...] [--frames=300]
 *        [--opt=flag:0,...] [--cell=100] [--dump=1]
 *
 * Builds the real MapRuntime (terrain chunks, buildings, props with procedural stand-ins, grass, street signs) and the
 * environment (sun cascades), walks a street-level loop around the map centre, and reports per-frame averages of
 * scene.render, active mesh evaluation, shadow render targets and the main draw phase, plus mesh, active mesh, draw
 * call and triangle counts (shadow passes separately). Soldiers, viewmodel and loot are not included. WebGL calls are
 * no-ops, so times understate a browser's per-draw cost; use them for before/after comparisons, and the draw counts as
 * the browser-relevant number. `--opt` takes the same syntax as `?opt=`; `--cell` sets the merged building cell size.
 */
import "./resolve.ts";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = "1"] = a.replace(/^--/, "").split("=");
    return [k!, v];
  }),
) as Record<string, string>;
const mapId = args.map ?? "vn-hangxanh";
const FRAMES = Number(args.frames ?? 300);
const WARMUP = 30;

const watchdog = setTimeout(() => {
  console.error("[render bench] watchdog: took too long");
  process.exit(2);
}, 300_000);
watchdog.unref();

// Browser globals some client modules touch at import or construction time.
const context2d: object = new Proxy(
  {},
  {
    get: (_target, key) => {
      if (key === "measureText") return (text: string) => ({ width: text.length * 20, actualBoundingBoxAscent: 40, actualBoundingBoxDescent: 10 });
      if (key === "createImageData" || key === "getImageData") return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
      return () => {};
    },
    set: () => true,
  },
);
class FakeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return context2d;
  }
}
Object.assign(globalThis, { devicePixelRatio: 2, OffscreenCanvas: FakeCanvas });

const core = await import("@babylonjs/core");
const { NullEngine, Scene, FreeCamera, Vector3, HavokPlugin, SceneInstrumentation } = core;
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { REPO_ROOT } = await import("../runtime/lib/paths.ts");
const flags = await import("../../../apps/client/src/perf/flags.ts");
if (args.opt) {
  const unknown = flags.applyOptimizationOverrides(args.opt);
  if (unknown.length) throw new Error(`unknown --opt entries: ${unknown.join(", ")}`);
}
const { loadHavok } = await import("../runtime/lib/havok.ts");
const shared = await import("@twobullets/shared");
const { decodeTerrainBake } = await import("../../../packages/shared/src/map/terrain/bake.ts");
const { findRealMap } = await import("../../../packages/shared/src/map/real/index.ts");
const { createEnvironment } = await import("../../../apps/client/src/world/environment.ts");
const { MapRuntime } = await import("../../../apps/client/src/world/mapRuntime/MapRuntime.ts");
const { BUILDING_RENDER } = await import("../../../apps/client/src/world/buildings/BuildingVisuals.ts");
if (args.cell) BUILDING_RENDER.mergedCellSize = Number(args.cell);

const quiet = console.info;
console.info = () => {};
const warn = console.warn;
console.warn = () => {};
const error = console.error;
console.error = () => {};

let map: import("@twobullets/shared").MapData;
let bakePath: string;
if (mapId === "v1") {
  map = shared.MAP_V1;
  bakePath = join(REPO_ROOT, "apps/client/public/assets/map/mapV1.terrain.bin");
} else {
  const entry = findRealMap(mapId);
  if (!entry) throw new Error(`unknown map ${mapId}`);
  map = (await entry.load()).map;
  bakePath = join(REPO_ROOT, `apps/client/public/assets/map/${mapId}.terrain.bin`);
}
const bake = await decodeTerrainBake(new Uint8Array(readFileSync(bakePath)), map.terrain, map.flatten);
const terrain = bake.ok ? bake.terrain : shared.buildTerrain(map.terrain, map.flatten);
const layout = shared.buildMapLayout(map, terrain);

const engine = new NullEngine({ renderWidth: 2048, renderHeight: 1152, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 1 });
// Cascaded shadows need texture arrays and a depth texture, which NullEngine doesn't fake; both only need to exist here.
(engine as unknown as { _features: { supportCSM: boolean } })._features.supportCSM = true;
// Thin instances draw with hardware instancing only when the caps say so (as in any WebGL2 browser).
engine.getCaps().instancedArrays = true;
(engine as unknown as { _createDepthStencilTexture: unknown })._createDepthStencilTexture = (size: { width?: number; height?: number } | number) => {
  const texture = new core.InternalTexture(engine, core.InternalTextureSource.DepthStencil);
  texture.width = texture.baseWidth = typeof size === "number" ? size : (size.width ?? 1);
  texture.height = texture.baseHeight = typeof size === "number" ? size : (size.height ?? 1);
  texture.isReady = true;
  return texture;
};
const createTarget = engine.createRenderTargetTexture.bind(engine);
engine.createRenderTargetTexture = (size, options) => {
  const wrapper = createTarget(size, options);
  const layers = typeof size === "object" && "layers" in size ? (size.layers ?? 0) : 0;
  if (layers > 0 && wrapper.texture) {
    wrapper.texture.is2DArray = true;
    wrapper.texture.depth = wrapper.texture.baseDepth = layers;
  }
  return wrapper;
};
let draws = 0;
let shadowDraws = 0;
let triangles = 0;
let shadowTriangles = 0;
let inShadow = false;
engine.drawElementsType = (_fill, _start, count, instances) => {
  draws++;
  if (inShadow) shadowDraws++;
  const t = (count / 3) * Math.max(1, instances ?? 1);
  triangles += t;
  if (inShadow) shadowTriangles += t;
};
engine.drawArraysType = () => void draws++;
const scene = new Scene(engine);
scene.skipPointerMovePicking = flags.OPTIMIZATIONS.skipPointerMovePicking;
const havok = await loadHavok();
scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(false, havok));

const environment = createEnvironment(scene, { largeWorld: true });
scene.blockMaterialDirtyMechanism = flags.OPTIMIZATIONS.blockMaterialDirtyOnLoad;
const built = performance.now();
const world = await MapRuntime.load(scene, environment, {
  map,
  world: { terrain, layout, terrainSource: "bake", timings: {} },
  trainingYard: mapId === "v1" ? shared.MAP_V1_TRAINING_YARD : null,
  propAssets: false,
});
scene.blockMaterialDirtyMechanism = false;
const buildMs = performance.now() - built;
// NullEngine leaves raw and dynamic textures (terrain mask, sign atlas) unready; mark them so their meshes draw.
for (const texture of scene.textures) {
  const internal = texture.getInternalTexture();
  if (internal) internal.isReady = true;
}
let markDirtyCalls = 0;
const markDirty = core.Material.prototype.markDirty;
core.Material.prototype.markDirty = function (this: import("@babylonjs/core").Material, force?: boolean) {
  markDirtyCalls++;
  return markDirty.call(this, force);
};

const camera = new FreeCamera("bench", new Vector3(0, 0, 0), scene);
camera.fov = 1.2;
camera.minZ = 0.05;
camera.maxZ = 4000;
scene.activeCamera = camera;

// A street-level loop through the map centre: a slow walk with yaw sweeps, which the renderer sees as a player does.
const spawn = map.spawns?.[0];
const center = { x: 0, z: 0 };
void spawn;
function pose(frame: number): void {
  const t = frame / 60;
  const radius = 60;
  const angle = t * 0.15;
  const x = center.x + Math.cos(angle) * radius;
  const z = center.z + Math.sin(angle) * radius;
  camera.position.set(x, terrain.sampleHeight(x, z) + 1.7, z);
  camera.rotation.set(0.05, angle + Math.PI / 2 + Math.sin(t * 0.8) * 0.9, 0);
}

const shadowMap = environment.shadowGenerator.getShadowMap()!;
shadowMap.onBeforeBindObservable.add(() => (inShadow = true));
shadowMap.onAfterUnbindObservable.add(() => (inShadow = false));
const instrumentation = new SceneInstrumentation(scene);
instrumentation.captureFrameTime = true;
instrumentation.captureRenderTime = true;
instrumentation.captureRenderTargetsRenderTime = true;
instrumentation.captureActiveMeshesEvaluationTime = true;

// Warm up (shader "compiles", first uploads).
// Effects compile asynchronously (shader modules load by dynamic import), so warmup frames yield to the event loop.
for (let f = 0; f < WARMUP; f++) {
  pose(f);
  world.updateView(camera.position);
  scene.render();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

markDirtyCalls = 0;
const totals = { frame: 0, update: 0, render: 0, eval: 0, rtt: 0, draw: 0, draws: 0, shadowDraws: 0, triangles: 0, shadowTriangles: 0, active: 0 };
for (let f = 0; f < FRAMES; f++) {
  pose(WARMUP + f);
  const t0 = performance.now();
  world.updateView(camera.position);
  const t1 = performance.now();
  draws = shadowDraws = triangles = shadowTriangles = 0;
  scene.render();
  const t2 = performance.now();
  totals.update += t1 - t0;
  totals.render += t2 - t1;
  totals.frame += instrumentation.frameTimeCounter.current;
  totals.eval += instrumentation.activeMeshesEvaluationTimeCounter.current;
  totals.rtt += instrumentation.renderTargetsRenderTimeCounter.current;
  totals.draw += instrumentation.renderTimeCounter.current;
  totals.draws += draws;
  totals.shadowDraws += shadowDraws;
  totals.triangles += triangles;
  totals.shadowTriangles += shadowTriangles;
  totals.active += scene.getActiveMeshes().length;
}

console.info = quiet;
console.warn = warn;
console.error = error;
const avg = (v: number) => (v / FRAMES).toFixed(2);
const meshes = scene.meshes;
const enabled = meshes.filter((m) => m.isEnabled() && m.isVisible);
const casters = environment.shadowGenerator.getShadowMap()?.renderList?.length ?? 0;
console.log(`[render bench] map ${mapId}, opt ${flags.describeOptimizations()}, build ${buildMs.toFixed(0)} ms, ${FRAMES} frames`);
console.log(
  `  meshes ${meshes.length} (enabled+visible ${enabled.length}), active ${avg(totals.active)}, draws/frame ${avg(totals.draws)} (shadow ${avg(totals.shadowDraws)}), triangles/frame ${(totals.triangles / FRAMES / 1000).toFixed(0)}k (shadow ${(totals.shadowTriangles / FRAMES / 1000).toFixed(0)}k), shadow casters ${casters}, cascades ${JSON.stringify(environment.shadowCulling?.counts)}`,
);
console.log(`  markDirty calls during the measured frames: ${markDirtyCalls}`);
console.log(`  update ${avg(totals.update)} ms, scene.render ${avg(totals.render)} ms (instr frame ${avg(totals.frame)}), eval ${avg(totals.eval)}, shadow RTT ${avg(totals.rtt)}, draw ${avg(totals.draw)}`);

if (args.dump) {
  const groups = new Map<string, { n: number; enabled: number; active: number; casters: number }>();
  const active = new Set(scene.getActiveMeshes().data.slice(0, scene.getActiveMeshes().length));
  const casterSet = new Set(environment.shadowGenerator.getShadowMap()?.renderList ?? []);
  for (const m of meshes) {
    const key = m.name.replace(/[_@].*$/, "") + (m.name.startsWith("prop_") ? "" : "");
    const g = groups.get(key) ?? { n: 0, enabled: 0, active: 0, casters: 0 };
    g.n++;
    if (m.isEnabled() && m.isVisible) g.enabled++;
    if (active.has(m)) g.active++;
    if (casterSet.has(m)) g.casters++;
    groups.set(key, g);
  }
  for (const [k, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(28)} n ${g.n} enabled ${g.enabled} active ${g.active} casters ${g.casters}`);
  console.log("  stats", JSON.stringify(world.stats()));
  const notReady = new Map<string, number>();
  for (const m of scene.getActiveMeshes().data.slice(0, scene.getActiveMeshes().length)) {
    for (const sm of m.subMeshes ?? []) {
      const mat = sm.getMaterial();
      const ok = mat ? mat.isReadyForSubMesh(m, sm, m.hasThinInstances) : false;
      if (!ok) notReady.set(mat?.name ?? "none", (notReady.get(mat?.name ?? "none") ?? 0) + 1);
    }
  }
  console.log("  not ready", JSON.stringify([...notReady]));
}
process.exit(0);
