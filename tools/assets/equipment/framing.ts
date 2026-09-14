/**
 * First-person framing check for the throw arms and held items:
 * `node --experimental-transform-types --no-warnings tools/assets/equipment/framing.ts [--verbose]`
 *
 * Drives the real ThrowableViewmodel (headless Babylon, real equipment GLBs) through the debugThrow / debugUse
 * timelines, CPU-skins the arms each sampled frame and rasterizes arms and item into a coarse screen grid through the
 * game camera (90° horizontal FOV at 16:9, near 0.05 m; the viewmodel's FOV compensation makes that exact). Prints per
 * phase: screen coverage, the hand's and item's screen boxes (NDC, x right / y up, −1..1) and the nearest depth, and
 * fails on stretched skinning (any skinned vertex > 1.2 m from the camera) or framing outside the per-phase limits.
 * The rifle viewmodel at the hip is measured as the reference.
 */
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

setTimeout(() => {
  console.error("framing: aborted after 120s");
  process.exit(2);
}, 120_000).unref();

const verbose = process.argv.includes("--verbose");
const clientDir = resolve("apps/client");
register(
  `data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier.startsWith("@babylonjs/") || specifier.startsWith("@twobullets/")) {
      const client = { ...context, parentURL: ${JSON.stringify(pathToFileURL(join(clientDir, "package.json")).href)} };
      try { return await next(specifier, client); } catch { return next(specifier + ".js", client); }
    }
    if (specifier.startsWith(".") && (context.parentURL?.includes("/apps/client/src/") || context.parentURL?.includes("/packages/")) && !/\\.[cm]?[jt]s$/.test(specifier)) {
      try { return await next(specifier + ".ts", context); } catch { return next(specifier + "/index.ts", context); }
    }
    return next(specifier, context);
  }`)}`,
);

const { NullEngine, Scene, MeshoptCompression, Tools, TransformNode, Vector3, HemisphericLight, Matrix, Mesh } = await import("@babylonjs/core");
const { MeshoptDecoder } = await import("meshoptimizer");
// Client modules are loaded by computed path: they need --experimental-transform-types, and keeping them out of the
// static import graph keeps the whole client out of `pnpm assets:typecheck` (tools/assets uses erasableSyntaxOnly).
const client = (path: string): Promise<any> => import(new URL(`../../../apps/client/src/${path}`, import.meta.url).href);
const { AssetLibrary } = (await import("../../../apps/client/src/assets/AssetLibrary.ts")) as typeof import("../../../apps/client/src/assets/AssetLibrary.ts");
const { ItemMeshLibrary } = await client("equipment/presentation/itemMeshes.ts");
const { ThrowableViewmodel, createHandsFrame } = await client("equipment/presentation/ThrowableViewmodel.ts");
const { VIEWMODEL_PROFILES } = await client("viewmodel/weaponProfiles.ts");
const shared = "@twobullets/shared";
const { ITEMS } = (await import(shared)) as { ITEMS: Record<string, { fuseSeconds: number; useSeconds: number }> };
type AbstractMesh = import("@babylonjs/core").AbstractMesh;
interface HandsFrame {
  phase: string;
  kind: string | null;
  underhand: boolean;
  cookProgress: number;
  useItem: string | null;
  useProgress: number;
}

await MeshoptDecoder.ready;
Object.assign(globalThis, { MeshoptDecoder });
Tools.LoadBabylonScriptAsync = async () => {};
MeshoptCompression.prototype.decodeGltfBufferAsync = async (source, count, stride, mode, filter) => {
  const target = new Uint8Array(count * stride);
  MeshoptDecoder.decodeGltfBuffer(target, count, stride, source, mode as never, filter as never);
  return target;
};

const engine = new NullEngine();
const scene = new Scene(engine);
const assetsDir = pathToFileURL(`${resolve("apps/client/public/assets")}/`);
const library = await AssetLibrary.load(scene, undefined, {
  baseUrl: assetsDir,
  headless: true,
  fetch: async (url) => new Response(await readFile(new URL(url.split("?")[0]!))),
});

// ---- Screen model ---------------------------------------------------------------------------------------------------
const HALF_TAN_X = 1;
const HALF_TAN_Y = 9 / 16;
const NEAR = 0.05;
const GW = 192;
const GH = 108;

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  nearZ: number;
  farthest: number;
}
const emptyBox = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, nearZ: Infinity, farthest: 0 });

/** Skinned camera-space triangles of `meshes`, rasterized into `grid`; returns the screen box of the in-front vertices. */
function project(meshes: readonly AbstractMesh[], grid: Uint8Array, vertexFilter?: (mesh: AbstractMesh, index: number) => boolean, depth?: Float32Array): Box {
  const box = emptyBox();
  const p = new Vector3();
  for (const mesh of meshes) {
    if (!mesh.isEnabled() || !(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue;
    // No render loop here: prepare the skeleton the way the renderer would before skinning.
    mesh.skeleton?.prepare(true);
    const positions = mesh.getPositionData(true, false)!;
    const world = mesh.computeWorldMatrix(true);
    const count = positions.length / 3;
    const sx = new Float32Array(count);
    const sy = new Float32Array(count);
    const sz = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      Vector3.TransformCoordinatesFromFloatsToRef(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!, world, p);
      box.farthest = Math.max(box.farthest, p.length());
      sz[i] = p.z;
      sx[i] = p.x / (p.z * HALF_TAN_X);
      sy[i] = p.y / (p.z * HALF_TAN_Y);
      if (p.z > NEAR && (!vertexFilter || vertexFilter(mesh, i))) {
        box.nearZ = Math.min(box.nearZ, p.z);
        if (Math.abs(sx[i]!) < 3 && Math.abs(sy[i]!) < 3) {
          box.minX = Math.min(box.minX, sx[i]!);
          box.maxX = Math.max(box.maxX, sx[i]!);
          box.minY = Math.min(box.minY, sy[i]!);
          box.maxY = Math.max(box.maxY, sy[i]!);
        }
      }
    }
    const indices = mesh.getIndices()!;
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!;
      if (sz[a]! <= NEAR || sz[b]! <= NEAR || sz[c]! <= NEAR) continue;
      rasterize(grid, sx[a]!, sy[a]!, sx[b]!, sy[b]!, sx[c]!, sy[c]!, depth, sz[a]!, sz[b]!, sz[c]!);
    }
  }
  return box;
}

function rasterize(grid: Uint8Array, ax: number, ay: number, bx: number, by: number, cx: number, cy: number, depth?: Float32Array, az = 0, bz = 0, cz = 0): void {
  const toX = (x: number) => ((x + 1) / 2) * GW;
  const toY = (y: number) => ((1 - y) / 2) * GH;
  const [x0, y0, x1, y1, x2, y2] = [toX(ax), toY(ay), toX(bx), toY(by), toX(cx), toY(cy)];
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-9) return;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(GW - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(GH - 1, Math.ceil(Math.max(y0, y1, y2)));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
      const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
      if (w0 < 0 || w1 < 0 || 1 - w0 - w1 < 0) continue;
      grid[y * GW + x] = 1;
      if (depth) depth[y * GW + x] = Math.min(depth[y * GW + x]!, w0 * az + w1 * bz + (1 - w0 - w1) * cz);
    }
  }
}

const coverage = (grid: Uint8Array) => grid.reduce((sum, v) => sum + v, 0) / grid.length;
const fmtBox = (b: Box) => (b.minX === Infinity ? "off-screen" : `x ${b.minX.toFixed(2)}..${b.maxX.toFixed(2)} y ${b.minY.toFixed(2)}..${b.maxY.toFixed(2)}`);

// ---- Rig under a camera-space parent ----------------------------------------------------------------------------------
const environment = { skyFill: new HemisphericLight("sky", new Vector3(0, 1, 0), scene) };
const fovRoot = new TransformNode("vm_fovRoot", scene);
const motion = new TransformNode("vm_motion", scene);
motion.parent = fovRoot;
let flameStreaks = 0;
const fx = { viewmodelBatch: { streak: () => flameStreaks++ } };
const hands = new ThrowableViewmodel(scene, motion, library, environment as never, new ItemMeshLibrary(scene), fx as never);
// `--tune=file.json` ({ poses?, grips?, clip? }) overrides the live-tunable values, for trying numbers before baking them in.
const tuneFile = process.argv.find((a) => a.startsWith("--tune="))?.slice(7);
if (tuneFile) {
  const tune = JSON.parse(await readFile(tuneFile, "utf8")) as { poses?: object; grips?: object; clip?: object };
  for (const [name, pose] of Object.entries(tune.poses ?? {})) Object.assign((hands.poses as Record<string, object>)[name]!, pose);
  Object.assign(hands.grips, tune.grips ?? {});
  Object.assign(hands.clip, tune.clip ?? {});
}
const rig = (hands as unknown as { hands: { clip: unknown; meshes: readonly AbstractMesh[] } | null }).hands;
const heldItem = () => (hands as unknown as { item: { kind: string; meshes: readonly AbstractMesh[]; root: { isEnabled(): boolean } } | null }).item;
if (!rig?.clip) {
  console.error("framing: the throw arms didn't load (build them with node tools/assets/equipment.ts)");
  process.exit(1);
}
const arms = rig.meshes;
const armsMesh = arms[0] as InstanceType<typeof Mesh>;
const skeleton = armsMesh.skeleton!;
// Right-hand vertices: weighted mostly to the right wrist or finger bones.
const handBones = new Set(skeleton.bones.map((b, i) => [b.name, i] as const).filter(([name]) => /^R_(wrist|thumb|point|middle|ring|pink)/.test(name)).map(([, i]) => i));
const jointsData = armsMesh.getVerticesData("matricesIndices")!;
const weightsData = armsMesh.getVerticesData("matricesWeights")!;
const handVertex = (_mesh: AbstractMesh, i: number) => {
  let w = 0;
  for (let k = 0; k < 4; k++) if (handBones.has(jointsData[i * 4 + k]!)) w += weightsData[i * 4 + k]!;
  return w > 0.5;
};

interface Sample {
  label: string;
  cover: number;
  /** Coverage of the upper-left quadrant, where an arm passing next to the camera shows up as a band. */
  upperLeft: number;
  hand: Box;
  item: Box | null;
  armsFar: number;
  itemVisible: boolean;
  /** Share of the item's screen pixels not hidden behind the arms. */
  itemUnoccluded: number;
}
const samples: Sample[] = [];
const errors: string[] = [];

function sample(label: string): Sample {
  const grid = new Uint8Array(GW * GH);
  const all = project(arms, grid);
  const hand = project(arms, new Uint8Array(GW * GH), handVertex);
  const item = heldItem();
  const itemVisible = !!item?.root.isEnabled();
  const itemBox = item && itemVisible ? project(item.meshes, grid) : null;
  let itemUnoccluded = 0;
  if (item && itemVisible) {
    const armsDepth = new Float32Array(GW * GH).fill(Infinity);
    const itemDepth = new Float32Array(GW * GH).fill(Infinity);
    project(arms, new Uint8Array(GW * GH), undefined, armsDepth);
    project(item.meshes, new Uint8Array(GW * GH), undefined, itemDepth);
    let total = 0;
    let front = 0;
    for (let i = 0; i < itemDepth.length; i++) {
      if (itemDepth[i] === Infinity) continue;
      total++;
      if (itemDepth[i]! <= armsDepth[i]!) front++;
    }
    itemUnoccluded = total ? front / total : 0;
  }
  let upperLeft = 0;
  for (let y = 0; y < GH / 2; y++) for (let x = 0; x < GW / 2; x++) upperLeft += grid[y * GW + x]!;
  const s: Sample = { label, cover: coverage(grid), upperLeft: upperLeft / ((GW / 2) * (GH / 2)), hand, item: itemBox, armsFar: all.farthest, itemVisible, itemUnoccluded };
  const ascii = process.argv.find((a) => a.startsWith("--ascii="))?.slice(8);
  if (ascii && label.includes(ascii)) {
    console.log(`-- ${label}`);
    for (let y = 0; y < GH; y += 4) {
      let row = "";
      for (let x = 0; x < GW; x += 2) row += grid[y * GW + x] ? "#" : ".";
      console.log(row);
    }
  }
  samples.push(s);
  if (all.farthest > 1.2) errors.push(`${label}: stretched skin, a vertex is ${all.farthest.toFixed(2)} m from the camera`);
  return s;
}

const DT = 1 / 60;
let time = 0;
const frame: HandsFrame = createHandsFrame();
const sweepMaxCover = 0.35;
const worst = { cover: 0 };
const onlyRuns = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
function run(label: string, seconds: number, script: (t: number) => void, marks: readonly [number, string][], checkEvery = 1 / 30): void {
  if (onlyRuns && !onlyRuns.split(",").includes(label)) return;
  const pending = [...marks];
  const reported = new Set<string>();
  let nextCheck = 0;
  for (let t = 0; t <= seconds + 1e-6; t += DT) {
    script(t);
    hands.update(DT, frame);
    time += DT;
    while (pending.length && t >= pending[0]![0]) sample(pending.shift()![1]);
    if (t >= nextCheck) {
      // Sweep every phase, not only the marked samples: stretched skin, and arms or items swinging next to the camera.
      const grid = new Uint8Array(GW * GH);
      const box = project(arms, grid);
      const item = heldItem();
      if (item?.root.isEnabled()) project(item.meshes, grid);
      let upperLeft = 0;
      for (let y = 0; y < GH / 2; y++) for (let x = 0; x < GW / 2; x++) upperLeft += grid[y * GW + x]!;
      const where = `${label} t=${t.toFixed(2)} (${frame.useItem ?? frame.phase})`;
      // One report per run and kind of failure (the first frame where it happens).
      const fail = (kind: string, message: string) => {
        if (reported.has(kind)) return;
        reported.add(kind);
        errors.push(`${where}: ${message}`);
      };
      if (box.farthest > 1.2) fail("stretch", `stretched skin, ${box.farthest.toFixed(2)} m`);
      if (coverage(grid) > sweepMaxCover) fail("cover", `covers ${(coverage(grid) * 100).toFixed(0)}%`);
      if (upperLeft / ((GW / 2) * (GH / 2)) > 0.08) fail("band", `${((upperLeft / ((GW / 2) * (GH / 2))) * 100).toFixed(0)}% of the upper-left quadrant`);
      worst.cover = Math.max(worst.cover, coverage(grid));
      nextCheck += checkEvery;
    }
  }
}

/** EquipmentPresentation.debugThrow's timeline: draw 0.5 s, pin 0.7 s, cook 1.0 s, release 1.6 s (2.4 s cooked). */
function throwScript(kind: "frag" | "smoke" | "flash" | "molotov", style: "overhand" | "underhand", cook: boolean) {
  let step = 0;
  const release = cook ? 2.4 : 1.6;
  return (t: number) => {
    frame.kind = kind;
    frame.underhand = style === "underhand";
    frame.useItem = null;
    frame.cookProgress = cook && t > 1 ? Math.min(1, (t - 1) / ITEMS[kind]!.fuseSeconds) : 0;
    if (step === 0) (hands.equip(kind), (step = 1));
    if (step === 1 && t >= 0.7) (hands.pinPulled(), (step = 2));
    if (step === 2 && cook && t >= 1) (hands.cookStarted(), (step = 3));
    if (step < 4 && t >= release) (hands.released(style), (step = 4));
    frame.phase = t < 0.5 ? "equipping" : t < 0.7 ? "ready" : t < release ? (cook && t >= 1 ? "cooking" : "primed") : "releasing";
    if (t >= release + 0.35 && step === 4) (hands.putAway(), (step = 5), (frame.phase = "idle"));
  };
}

function useScript(item: "bandage" | "first_aid" | "medkit" | "energy_drink" | "painkiller", seconds: number) {
  let started = false;
  return (t: number) => {
    frame.phase = "idle";
    frame.kind = null;
    if (!started) (hands.useStarted(item), (started = true));
    frame.useItem = t < seconds ? item : null;
    frame.useProgress = Math.min(1, t / seconds);
    if (t >= seconds && frame.useItem === null) hands.putAway();
  };
}

run("frag cooked", 3, throwScript("frag", "overhand", true), [
  [0.25, "frag draw 0.25s"],
  [0.6, "frag ready 0.6s"],
  [0.8, "frag pin pull 0.8s"],
  [1.5, "frag cook hold 1.5s"],
  [2.43, "frag release +0.03"],
  [2.48, "frag release +0.08"],
  [2.55, "frag release +0.15"],
  [2.7, "frag release +0.30"],
]);
for (const kind of ["smoke", "flash", "molotov"] as const) {
  run(kind, 2.3, throwScript(kind, "overhand", false), [
    [0.6, `${kind} ready 0.6s`],
    [1.3, `${kind} primed hold`],
    [1.68, `${kind} release +0.08`],
  ]);
}
run("frag underhand", 2.3, throwScript("frag", "underhand", false), [
  [1.3, "frag underhand hold"],
  [1.68, "frag underhand release +0.08"],
]);
for (const item of ["bandage", "first_aid", "medkit", "energy_drink", "painkiller"] as const) {
  const seconds = ITEMS[item]!.useSeconds;
  run(item, seconds + 0.4, useScript(item, seconds), [
    [seconds * 0.15, `${item} use 15%`],
    [seconds * 0.5, `${item} use 50%`],
    [seconds * 0.75, `${item} use 75% (raised)`],
  ]);
}

// ---- Reference: the rifle at the hip, idle frame ---------------------------------------------------------------------
{
  const rifle = library.instantiateWeapon("rifle");
  const profile = VIEWMODEL_PROFILES.rifle;
  const sight = library.manifest.weapons.rifle.anchors.scopeLens!;
  rifle.goToFrame(library.manifest.weapons.rifle.clips.idle![0]);
  rifle.root.position.set(profile.hipSight[0] - sight[0], profile.hipSight[1] - sight[1], profile.hipSight[2] - sight[2]);
  const grid = new Uint8Array(GW * GH);
  const box = project(rifle.meshes, grid);
  const skel = (rifle.nodes.arms as InstanceType<typeof Mesh>).skeleton!;
  const rHand = new Set(skel.bones.map((b, i) => [b.name, i] as const).filter(([n]) => /^R_(wrist|thumb|point|middle|ring|pink)/.test(n)).map(([, i]) => i));
  const armsNode = rifle.nodes.arms as InstanceType<typeof Mesh>;
  const j = armsNode.getVerticesData("matricesIndices")!;
  const w = armsNode.getVerticesData("matricesWeights")!;
  const hand = project([armsNode], new Uint8Array(GW * GH), (_m, i) => [0, 1, 2, 3].reduce((s, k) => s + (rHand.has(j[i * 4 + k]!) ? w[i * 4 + k]! : 0), 0) > 0.5);
  console.log(`reference rifle hip: cover ${(coverage(grid) * 100).toFixed(0)}%, all ${fmtBox(box)}, right hand ${fmtBox(hand)} nearest ${hand.nearZ.toFixed(2)} m`);
  rifle.dispose();
}

// ---- Report and limits --------------------------------------------------------------------------------------------
for (const s of samples) {
  const hand = s.hand;
  console.log(
    `${s.label.padEnd(30)} cover ${String(Math.round(s.cover * 100)).padStart(3)}% UL ${String(Math.round(s.upperLeft * 100)).padStart(3)}%  hand ${fmtBox(hand).padEnd(32)} z ${hand.nearZ === Infinity ? "  - " : hand.nearZ.toFixed(2)}  item ${s.item ? `${fmtBox(s.item)} z ${s.item.nearZ.toFixed(2)}` : s.itemVisible ? "visible" : "hidden"}${s.item ? ` shown ${Math.round(s.itemUnoccluded * 100)}%` : ""}`,
  );
}
const within = (b: Box | null, x0: number, x1: number, y0: number, y1: number) => !!b && b.minX >= x0 && b.maxX <= x1 && b.minY >= y0 && b.maxY <= y1;
for (const s of samples) {
  const holding = /ready|pin pull|cook hold|primed hold|underhand hold/.test(s.label);
  const using = /use /.test(s.label);
  if (s.upperLeft > 0.05 && !/raised/.test(s.label)) errors.push(`${s.label}: ${(s.upperLeft * 100).toFixed(0)}% of the upper-left quadrant covered (an arm next to the camera)`);
  if (/release/.test(s.label) && s.cover > 0.35) errors.push(`${s.label}: covers ${(s.cover * 100).toFixed(0)}% during the throw (max 35%)`);
  if (holding || using) {
    if (s.cover > 0.25) errors.push(`${s.label}: covers ${(s.cover * 100).toFixed(0)}% of the screen (max 25%)`);
    const minZ = /raised/.test(s.label) ? 0.22 : 0.28;
    if (s.hand.nearZ < minZ) errors.push(`${s.label}: hand ${s.hand.nearZ.toFixed(2)} m from the camera (min ${minZ})`);
  }
  if (holding) {
    // Grenade in the lower-right quadrant (its centre), not rising past the middle, not tiny.
    if (!s.item) errors.push(`${s.label}: item not visible`);
    else {
      const cx = (s.item.minX + s.item.maxX) / 2;
      const cy = (s.item.minY + s.item.maxY) / 2;
      if (cx < 0.05 || cx > 0.9 || cy < -0.9 || cy > 0.05 || s.item.maxY > 0.35) errors.push(`${s.label}: item ${fmtBox(s.item)} (want lower right)`);
      if (s.item.maxX - s.item.minX < 0.05) errors.push(`${s.label}: item too small on screen`);
      if (s.itemUnoccluded < 0.4) errors.push(`${s.label}: only ${(s.itemUnoccluded * 100).toFixed(0)}% of the item is in front of the hand`);
    }
  }
  if (using) {
    const raised = /raised/.test(s.label);
    if (!s.item) errors.push(`${s.label}: item not visible`);
    else if (!raised && ((s.item.minY + s.item.maxY) / 2 > 0 || s.item.maxY > 0.2)) errors.push(`${s.label}: item ${fmtBox(s.item)} (want held low)`);
    else if (s.item.nearZ < (raised ? 0.22 : 0.28)) errors.push(`${s.label}: item ${s.item.nearZ.toFixed(2)} m from the camera`);
    if (s.item && s.itemUnoccluded < 0.4) errors.push(`${s.label}: only ${(s.itemUnoccluded * 100).toFixed(0)}% of the item is in front of the hand`);
  }
}
console.log(`sweep (every 1/30 s, all phases): worst coverage ${(worst.cover * 100).toFixed(0)}%`);
if (verbose) console.log(`flame streaks ${flameStreaks}`);
if (errors.length) {
  for (const e of [...new Set(errors)]) console.error(`  ✗ ${e}`);
  process.exitCode = 1;
} else {
  console.log("framing checks passed");
}
hands.dispose();
library.dispose();
engine.dispose();
