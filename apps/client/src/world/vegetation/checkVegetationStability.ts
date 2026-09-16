/**
 * Headless vegetation stability check (NullEngine, simulated 60 Hz clock):
 *
 *   node --experimental-transform-types --import ./tools/map/lib/resolve.ts apps/client/src/world/vegetation/checkVegetationStability.ts
 *
 * Builds the Map v1 layout and walks scripted camera paths through the western forest and the town. For each path it
 * compares the previous prop LOD scheme (re-bucket every 4 m, exact switch distances, whole-buffer rebuilds) with
 * PropInstances as shipped (per-instance hysteresis, dithered cross-fades, incremental dynamic buffers): LOD and
 * shadow switches, reversals, buffer re-creations and uploads. Then it checks the hysteresis guarantee, impostor
 * facing, grass fade coverage, and the CPU cost of level selection with ~5,000 instances near the camera.
 * Throws (exit code 1) on the first failed check.
 */
import { FreeCamera, Mesh, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { PerformanceObserver, constants } from "node:perf_hooks";
import { CAMERA, MAP_V1, buildMapLayout, buildTerrain, getMapProp } from "@twobullets/shared";
import { OPTIMIZATIONS } from "../../perf/flags";
import { PROP_MANIFEST, isPropId } from "../propAssets";
import { detectImpostorPlanes, faceImpostor, type ImpostorPlanes } from "../props/impostor";
import { CULLED, LodBands, lodZoom } from "../props/lodBands";
import { LodCell, type LodCellSpec, type LodStep } from "../props/LodCell";
import { COVER_CULL_DISTANCE, PropInstances, isCover } from "../props/PropInstances";
import type { PropVisual, PropVisuals } from "../props/PropVisuals";

const HZ = 60;
const DT = 1 / HZ;
const WALK = 6.5;
const SPRINT = 9.5;
const EYE = 1.6;
const HYSTERESIS = 0.1;
const LEGACY_UPDATE_DISTANCE = 4;
/** A switch back to the previous level within this time counts as a reversal (visible flip-flop), s. */
const REVERSAL_WINDOW = 3;
const IMPOSTOR_PLANES: ImpostorPlanes = { spacing: Math.PI / 3, offset: Math.PI / 6 };

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`[vegetation check] ${message}`);
}

const log = (line: string) => console.info(`[vegetation check] ${line}`);

// ---------------------------------------------------------------------------------------------
// World and paths

const terrain = buildTerrain(MAP_V1.terrain, MAP_V1.flatten);
const layout = buildMapLayout(MAP_V1, terrain);
const engine = new NullEngine();
const scene = new Scene(engine);

interface Frame {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function polyline(points: readonly (readonly [number, number])[], speed: number): Frame[] {
  const frames: Frame[] = [];
  for (let s = 0; s + 1 < points.length; s++) {
    const [ax, az] = points[s]!;
    const [bx, bz] = points[s + 1]!;
    const length = Math.hypot(bx - ax, bz - az);
    for (let d = 0; d < length; d += speed * DT) frames.push(at(ax + ((bx - ax) * d) / length, az + ((bz - az) * d) / length));
  }
  return frames;
}

/** A/D strafing: back and forth along x, `amplitude` m each way, one cycle per `period` s. */
function strafe(x: number, z: number, amplitude: number, period: number, seconds: number): Frame[] {
  return Array.from({ length: Math.round(seconds * HZ) }, (_, i) => {
    const phase = ((i * DT) / period) % 1;
    const triangle = phase < 0.5 ? phase * 4 - 1 : 3 - phase * 4;
    return at(x + triangle * amplitude, z);
  });
}

function at(x: number, z: number): Frame {
  return { x, y: terrain.sampleHeight(x, z) + EYE, z };
}

const PATHS: readonly { readonly name: string; readonly frames: Frame[] }[] = [
  {
    name: "forest walk (town → west road → cabins → loop)",
    frames: polyline([[-80, 20], [-100, 50], [-108, 84], [-124, 118], [-150, 157], [-174, 127], [-184, 113], [-215, 96], [-228, 130], [-200, 152], [-184, 113]], WALK),
  },
  { name: "forest sprint loop (r 45 m around the cabins)", frames: polyline(Array.from({ length: 33 }, (_, k) => [-190 + 45 * Math.cos(k / 5), 105 + 45 * Math.sin(k / 5)] as const), SPRINT) },
  { name: "forest strafe (A/D ±2 m, 20 s)", frames: strafe(-218, 152, 2, 1.2, 20) },
  { name: "town walk (main street, cross street)", frames: polyline([[-90, 20], [60, 20], [0, 20], [0, -50], [0, 90]], WALK) },
];

// ---------------------------------------------------------------------------------------------
// Visuals: manifest LOD distances with box meshes (one mesh per batch)

const boxes = new Map<string, PropVisual>();
const visuals = {
  get(prop: string): PropVisual {
    let visual = boxes.get(prop);
    if (visual) return visual;
    const asset = isPropId(prop) && PROP_MANIFEST[prop].ready ? PROP_MANIFEST[prop] : null;
    const lods = asset ? asset.lods : [{ distance: 0, billboard: false }];
    visual = {
      prop,
      asset: asset !== null,
      cullDistance: asset?.cullDistance ?? 300,
      castShadow: asset?.castShadow ?? true,
      levels: lods.map((lod) => ({
        distance: lod.distance,
        billboard: lod.billboard ?? false,
        impostor: lod.billboard ? IMPOSTOR_PLANES : null,
        create: (name: string) => [MeshBuilder.CreateBox(name, { size: 1 }, scene)],
      })),
    };
    boxes.set(prop, visual);
    return visual;
  },
} as unknown as PropVisuals;
const environment = { shadowGenerator: { addShadowCaster() {} }, skyFill: { excludedMeshes: [] as unknown[] } } as never;

// GPU buffer traffic of the shipped system.
const gpu = { created: 0, partial: 0, floats: 0 };
const setBuffer = Mesh.prototype.thinInstanceSetBuffer;
Mesh.prototype.thinInstanceSetBuffer = function (this: Mesh, kind, buffer, stride, staticBuffer) {
  gpu.created++;
  gpu.floats += buffer?.length ?? 0;
  return setBuffer.call(this, kind, buffer, stride, staticBuffer);
};
const partialUpdate = Mesh.prototype.thinInstancePartialBufferUpdate;
Mesh.prototype.thinInstancePartialBufferUpdate = function (this: Mesh, kind, data, offset) {
  gpu.partial++;
  gpu.floats += typeof data === "number" ? data * (kind === "matrix" ? 16 : 1) : data.length;
  return partialUpdate.call(this, kind, data, offset);
};

// ---------------------------------------------------------------------------------------------
// Switch tracking shared by both schemes

class SwitchLog {
  switches = 0;
  shadowSwitches = 0;
  reversals = 0;
  /** Reversals whose distance moved less than the full hysteresis band (2h × switch distance). */
  inBandReversals = 0;
  minReversalBand = Infinity;
  maxPerFrame = 0;
  maxCellChurn = 0;
  private frameSwitches = 0;
  private readonly time: Float64Array;
  private readonly from: Int8Array;
  private readonly to: Int8Array;
  private readonly distance: Float32Array;
  private readonly cellChurn: Float64Array;
  private cellWindowStart = 0;

  constructor(
    readonly instances: number,
    readonly cells: number,
  ) {
    this.time = new Float64Array(instances).fill(-Infinity);
    this.from = new Int8Array(instances);
    this.to = new Int8Array(instances);
    this.distance = new Float32Array(instances);
    this.cellChurn = new Float64Array(cells);
  }

  record(instance: number, cell: number, spec: LodCellSpec, from: number, to: number, distance: number, now: number): void {
    this.switches++;
    this.frameSwitches++;
    this.cellChurn[cell]!++;
    if (now - this.time[instance]! < REVERSAL_WINDOW && this.from[instance] === to && this.to[instance] === from) {
      this.reversals++;
      const boundary = Math.max(from, to) === CULLED || from === CULLED || to === CULLED ? spec.cullDistance : spec.switches[Math.max(from, to)]!;
      const band = Math.abs(distance - this.distance[instance]!) / boundary;
      this.minReversalBand = Math.min(this.minReversalBand, band);
      if (band < 2 * HYSTERESIS * 0.99) this.inBandReversals++;
    }
    this.time[instance] = now;
    this.from[instance] = from;
    this.to[instance] = to;
    this.distance[instance] = distance;
  }

  endFrame(now: number): void {
    this.maxPerFrame = Math.max(this.maxPerFrame, this.frameSwitches);
    this.frameSwitches = 0;
    if (now - this.cellWindowStart >= 1) {
      for (let c = 0; c < this.cells; c++) this.maxCellChurn = Math.max(this.maxCellChurn, this.cellChurn[c]!);
      this.cellChurn.fill(0);
      this.cellWindowStart = now;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Previous scheme: exact thresholds, re-bucket every 4 m, rebuild a batch buffer when its membership changed

interface LegacyResult {
  log: SwitchLog;
  rebuilds: number;
  floats: number;
}

function runLegacy(cells: readonly LodCell[], frames: readonly Frame[]): LegacyResult {
  const total = cells.reduce((n, c) => n + c.count, 0);
  const log = new SwitchLog(total, cells.length);
  const buckets = cells.map((c) => new Int16Array(c.count).fill(-1));
  const last = { x: Infinity, y: Infinity, z: Infinity };
  let rebuilds = 0;
  let floats = 0;
  const pass = (f: Frame, now: number, record: boolean) => {
    let base = 0;
    cells.forEach((cell, c) => {
      const bands = cell.spec.exactBands;
      const previous = buckets[c]!;
      const dirty = new Set<number>();
      const sizes = new Map<number, number>();
      for (let i = 0; i < cell.count; i++) {
        const dx = cell.positions[i * 3]! - f.x;
        const dy = cell.positions[i * 3 + 1]! - f.y;
        const dz = cell.positions[i * 3 + 2]! - f.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const level = bands.select(d2, CULLED);
        const bucket = level === CULLED ? -1 : level * 2 + (bands.casts(d2, level, false) ? 1 : 0);
        sizes.set(bucket, (sizes.get(bucket) ?? 0) + 1);
        const old = previous[i]!;
        if (bucket === old) continue;
        previous[i] = bucket;
        if (!record) continue;
        const oldLevel = old < 0 ? CULLED : old >> 1;
        if (oldLevel !== level) log.record(base + i, c, cell.spec, oldLevel, level, Math.sqrt(d2), now);
        else log.shadowSwitches++;
        dirty.add(old).add(bucket);
      }
      for (const bucket of dirty) {
        const size = sizes.get(bucket) ?? 0;
        if (bucket < 0 || size === 0) continue;
        rebuilds++;
        floats += size * 16;
      }
      base += cell.count;
    });
  };
  // Settle at the path start first, so start-up placement isn't counted.
  pass(frames[0]!, 0, false);
  Object.assign(last, frames[0]!);
  frames.forEach((f, frame) => {
    const now = frame * DT;
    if ((f.x - last.x) ** 2 + (f.y - last.y) ** 2 + (f.z - last.z) ** 2 >= LEGACY_UPDATE_DISTANCE ** 2) {
      Object.assign(last, f);
      pass(f, now, true);
    }
    log.endFrame(now);
  });
  return { log, rebuilds, floats };
}

// ---------------------------------------------------------------------------------------------
// Shipped scheme

interface ShippedResult {
  log: SwitchLog;
  created: number;
  partial: number;
  floats: number;
  maxFading: number;
  frameMs: number[];
}

function runShipped(frames: readonly Frame[], flags: { hysteresis: boolean; crossFade: boolean }): ShippedResult {
  OPTIMIZATIONS.lodHysteresis = flags.hysteresis;
  OPTIMIZATIONS.lodCrossFade = flags.crossFade;
  const props = new PropInstances(scene, visuals, environment, layout.props);
  const cells = props.lodCells;
  const log = new SwitchLog(props.instanceCount, cells.length);
  const camera = new Vector3();
  // Settle at the path start first, so start-up placement isn't counted.
  camera.set(frames[0]!.x, frames[0]!.y, frames[0]!.z);
  props.update(camera, true, 0);
  Object.assign(gpu, { created: 0, partial: 0, floats: 0 });
  let now = 0;
  let base = 0;
  cells.forEach((cell, c) => {
    const offset = base;
    cell.onSwitch = (instance, from, to, d2) => log.record(offset + instance, c, cell.spec, from, to, Math.sqrt(d2), now);
    base += cell.count;
  });
  const shadowBefore = cells.reduce((n, cell) => n + cell.counters.shadowSwitches, 0);

  let maxFading = 0;
  const frameMs: number[] = [];
  frames.forEach((f, frame) => {
    now = frame * DT;
    camera.set(f.x, f.y, f.z);
    const started = performance.now();
    props.update(camera, false, 1000 + now * 1000);
    frameMs.push(performance.now() - started);
    maxFading = Math.max(maxFading, cells.reduce((n, cell) => n + cell.fadingInstances, 0));
    log.endFrame(now);
  });
  log.shadowSwitches = cells.reduce((n, cell) => n + cell.counters.shadowSwitches, 0) - shadowBefore;
  props.dispose();
  return { log, created: gpu.created, partial: gpu.partial, floats: gpu.floats, maxFading, frameMs };
}

// ---------------------------------------------------------------------------------------------
// Pure checks

{
  // Hysteresis bands: a coarsen switch needs t(1 + h), refining needs t(1 − h), culling likewise.
  const bands = new LodBands([0, 35, 110], 1200, [true, true, false], 70, HYSTERESIS);
  const level = (d: number, current: number) => bands.select(d * d, current);
  check(level(38, 0) === 0 && level(38.6, 0) === 1 && level(32, 1) === 1 && level(31.4, 1) === 0, "LOD0/1 band");
  check(level(120, 1) === 1 && level(121.1, 1) === 2 && level(99.1, 2) === 2 && level(98.9, 2) === 1, "LOD1/impostor band");
  check(level(1081, CULLED) === CULLED && level(1079, CULLED) === 2 && level(1319, 2) === 2 && level(1321, 2) === CULLED, "cull band");
  check(level(200, CULLED) === 2 && level(10, 2) === 0, "multi-level jumps");
  check(bands.casts(75 ** 2, 1, true) && !bands.casts(75 ** 2, 1, false) && !bands.casts(10, 2, true), "shadow band");
  // Overlapping bands narrow instead of reordering.
  const tight = new LodBands([0, 10, 11], 12, [true, true, true], 0, 0.3);
  for (let d = 0; d < 20; d += 0.05) for (const c of [CULLED, 0, 1, 2]) check(tight.select(d * d, c) === CULLED || tight.select(d * d, c) >= 0, "tight bands");
  for (const c of [CULLED, 0, 1, 2]) {
    let previous = 0;
    for (let d = 0; d < 20; d += 0.01) {
      const l = tight.select(d * d, c);
      const rank = l === CULLED ? 3 : l;
      check(rank >= previous, `tight bands monotonic from level ${c} at ${d.toFixed(2)} m`);
      previous = rank;
    }
  }
}

{
  // Crossed quads at 30/90/150° (the baked impostors), two triangles each; also a 4-plane set and a non-impostor.
  const quads = (angles: readonly number[]) => {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const angle of angles) {
      // A plane whose normal points at `angle` spans the perpendicular horizontal direction and Y.
      const tx = -Math.sin(angle), tz = Math.cos(angle);
      const base = positions.length / 3;
      positions.push(-tx, 0, -tz, tx, 0, tz, tx, 2, tz, -tx, 2, -tz);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return detectImpostorPlanes(positions, indices);
  };
  const deg = Math.PI / 180;
  const three = quads([30 * deg, 90 * deg, 150 * deg]);
  check(three !== null && Math.abs(three.spacing - Math.PI / 3) < 1e-6 && Math.abs(three.offset - 30 * deg) < 1e-3, `3 planes detected: ${JSON.stringify(three)}`);
  const four = quads([10 * deg, 55 * deg, 100 * deg, 145 * deg]);
  check(four !== null && Math.abs(four.spacing - Math.PI / 4) < 1e-6, "4 planes detected");
  check(quads([0, 20 * deg]) === null, "uneven planes rejected");

  // Facing: after the turn, no plane is within (90° − spacing) of edge-on, for any yaw and camera direction.
  const m = new Float32Array(16);
  for (const planes of [three, four]) {
    let worst = Infinity;
    for (let k = 0; k < 2000; k++) {
      const yaw = k * 2.39996;
      const scale = 0.8 + (k % 7) * 0.07;
      m.fill(0);
      m[0] = Math.cos(yaw) * scale;
      m[2] = -Math.sin(yaw) * scale;
      m[5] = scale;
      m[8] = Math.sin(yaw) * scale;
      m[10] = Math.cos(yaw) * scale;
      m[12] = 5;
      m[14] = -3;
      m[15] = 1;
      const camera = [5 + 100 * Math.cos(k * 0.7), -3 + 100 * Math.sin(k * 0.7)] as const;
      faceImpostor(m, 0, camera[0], camera[1], planes);
      check(Math.abs(Math.hypot(m[0]!, m[2]!) - scale) < 1e-4 && m[12] === 5 && m[14] === -3, "facing keeps scale and pivot");
      const view = Math.atan2(camera[1] + 3, camera[0] - 5);
      for (let p = 0; p * planes.spacing < Math.PI - 1e-6; p++) {
        const theta = planes.offset + p * planes.spacing;
        const nx = Math.cos(theta) * m[0]! + Math.sin(theta) * m[8]!;
        const nz = Math.cos(theta) * m[2]! + Math.sin(theta) * m[10]!;
        const fromNormal = Math.acos(Math.min(1, Math.abs(Math.cos(Math.atan2(nz, nx) - view)))) / deg;
        worst = Math.min(worst, 90 - fromNormal);
      }
    }
    const expected = planes === three ? 30 : 22.5;
    check(worst >= expected - 0.1, `impostor planes stay ≥ ${expected}° from edge-on after facing (worst ${worst.toFixed(1)}°)`);
    log(`impostor facing (${Math.round(Math.PI / planes.spacing)} planes): closest plane to edge-on ${worst.toFixed(1)}° off (unturned: 0°)`);
  }
}

{
  // Cross-fade bookkeeping on one cell: every instance ends with exactly one copy per level, fades complete.
  const count = 400;
  const positions = new Float32Array(count * 3);
  const matrices = new Float32Array(count * 16);
  for (let i = 0; i < count; i++) {
    positions.set([(i % 20) * 7, 0, Math.floor(i / 20) * 7], i * 3);
    matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (i % 20) * 7, 0, Math.floor(i / 20) * 7, 1], i * 16);
  }
  const spec: LodCellSpec = {
    switches: [0, 30, 90],
    cullDistance: 160,
    bands: new LodBands([0, 30, 90], 160, [true, true, false], 70, HYSTERESIS),
    exactBands: new LodBands([0, 30, 90], 160, [true, true, false], 70, 0),
    impostors: [null, null, IMPOSTOR_PLANES],
  };
  const cell = new LodCell(spec, positions, matrices);
  const step: LodStep = { x: 0, y: 1.6, z: 0, zoom: 1, select: true, hysteresis: true, fadeStep: 1, faceImpostors: true };
  cell.step(step);
  for (let f = 0; f < 4000; f++) {
    // A jittery orbit that crosses every band repeatedly, reversing mid-fade now and then.
    step.x = 70 + 150 * Math.cos(f * 0.003) + 6 * Math.sin(f * 0.37);
    step.z = 70 + 150 * Math.sin(f * 0.0021) + 6 * Math.cos(f * 0.41);
    step.select = true;
    step.fadeStep = f % 997 === 0 ? 1 : DT / 0.4;
    cell.step(step);
    const copies = new Int32Array(count);
    for (const batch of cell.batches) {
      if (!batch) continue;
      check(batch.count <= batch.capacity, "batch overflow");
      for (let s = 0; s < batch.count; s++) {
        const owner = batch.owners[s]!;
        const instance = owner >> 1;
        const fade = batch.fades[s]!;
        if (owner & 1) check(batch.level !== cell.levelOf(instance) && !batch.shadow && fade >= 1 && fade <= 2, "fade-out copy state");
        else check(batch.level === cell.levelOf(instance) && batch.shadow === cell.castsShadow(instance) && fade >= 0 && fade <= 1, "main copy state");
        copies[instance]!++;
      }
    }
    for (let i = 0; i < count; i++) check(copies[i]! <= 2 && (cell.levelOf(i) === CULLED || copies[i]! >= 1), `instance ${i} has ${copies[i]} copies`);
  }
  for (let f = 0; f < 60; f++) cell.step({ ...step, select: false });
  check(cell.fadingInstances === 0, "all fades complete within 0.4 s once the camera stops");
  log(`cross-fade bookkeeping: 4,000 jittery frames over 400 instances, ${cell.counters.switches} switches, copies consistent`);
}

{
  // Zoom: magnification against the unzoomed FOV, in powers of two; sprint and iron sights keep 1.
  const vertical = (horizontalDegrees: number) => 2 * Math.atan(Math.tan((horizontalDegrees * Math.PI) / 360) / (16 / 9));
  const reference = vertical(CAMERA.fovDegrees);
  check(lodZoom(reference, reference) === 1 && lodZoom(vertical(CAMERA.sprintFovDegrees), reference) === 1, "no zoom unscoped or sprinting");
  check(lodZoom(vertical(62), reference) === 1 && lodZoom(vertical(75), reference) === 1, "iron sights don't zoom LOD");
  check(lodZoom(vertical(27), reference) === 4, `K-98 scope (27°) zooms LOD 4× (got ${lodZoom(vertical(27), reference)})`);
  check(lodZoom(vertical(2), reference) === 8, "zoom capped at 8");

  // A tree 400 m away is an impostor unzoomed and LOD1 (100 m) through a 4× scope; one at 600 m stays an impostor.
  const positions = new Float32Array([400, 0, 0, 600, 0, 0]);
  const matrices = new Float32Array(32);
  const spec: LodCellSpec = { switches: [0, 45, 140], cullDistance: 700, bands: new LodBands([0, 45, 140], 700, [true, true, false], 70, HYSTERESIS), exactBands: new LodBands([0, 45, 140], 700, [true, true, false], 70, 0), impostors: [null, null, null] };
  const cell = new LodCell(spec, positions, matrices);
  const step: LodStep = { x: 0, y: 0, z: 0, zoom: 1, select: true, hysteresis: true, fadeStep: 1, faceImpostors: false };
  cell.step(step);
  check(cell.levelOf(0) === 2 && cell.levelOf(1) === 2, "unzoomed levels");
  step.zoom = 4;
  cell.step(step);
  check(cell.levelOf(0) === 1 && cell.levelOf(1) === 2, "4× zoom picks near-quality levels");

  // The same through PropInstances reading the active camera's FOV.
  const probe = new PropInstances(scene, visuals, environment, layout.props);
  const camera = new FreeCamera("zoomProbe", Vector3.Zero(), scene);
  scene.activeCamera = camera;
  const fir = probe.lodCellProps.findIndex((prop) => prop === "tree_fir_b");
  const firCell = probe.lodCells[fir]!;
  const position = new Vector3(firCell.positions[0]! + 300, firCell.positions[1]!, firCell.positions[2]!);
  camera.fov = reference;
  probe.update(position, true, 0);
  const unzoomed = firCell.levelOf(0);
  camera.fov = vertical(27);
  probe.update(position, true, 16);
  check(unzoomed === 2 && firCell.levelOf(0) === 1, `scoped fir 300 m away: impostor → LOD1 (got ${unzoomed} → ${firCell.levelOf(0)})`);
  scene.activeCamera = null;
  camera.dispose();

  // Cover never culls inside the map, from any corner or edge, unzoomed.
  const covers = new Set(probe.lodCellProps.filter((prop) => isCover(getMapProp(prop))));
  check(["wall_concrete", "fence_chainlink", "rock_boulder_b", "car_covered", "tree_fir_a"].every((prop) => covers.has(prop)) && !covers.has("bush_a") && !covers.has("rock_small"), `cover set: ${[...covers].join(", ")}`);
  const { minX, minZ, maxX, maxZ } = { minX: -250, minZ: -250, maxX: 250, maxZ: 250 };
  let checked = 0;
  for (const [x, z] of [[minX, minZ], [maxX, maxZ], [minX, maxZ], [maxX, minZ], [0, minZ], [0, 0]] as const) {
    position.set(x, terrain.sampleHeight(Math.max(-249, Math.min(249, x)), Math.max(-249, Math.min(249, z))) + EYE, z);
    probe.update(position, true, 1000 + checked);
    probe.lodCells.forEach((lod, c) => {
      if (!covers.has(probe.lodCellProps[c]!)) return;
      check(lod.spec.cullDistance >= COVER_CULL_DISTANCE, `${probe.lodCellProps[c]} culls at ${lod.spec.cullDistance} m`);
      for (let i = 0; i < lod.count; i++, checked++) {
        check(lod.levelOf(i) !== CULLED, `${probe.lodCellProps[c]} instance ${i} culled from (${x}, ${z})`);
      }
    });
  }
  probe.dispose();
  log(`zoom-aware LOD (K-98 4×) and cover culling: ${checked} cover instance views from the map corners, none culled`);
}

// ---------------------------------------------------------------------------------------------
// Walks: previous scheme vs shipped

const reference = new PropInstances(scene, visuals, environment, layout.props);
const referenceCells = reference.lodCells;
log(`${reference.instanceCount} prop instances in ${referenceCells.length} prop cells`);

const rate = (n: number, seconds: number) => (n / seconds).toFixed(1).padStart(6);
const percentile = (values: readonly number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;
const summary: string[] = [];

for (const path of PATHS) {
  const seconds = path.frames.length * DT;
  const legacy = runLegacy(referenceCells, path.frames);
  const noFade = runShipped(path.frames, { hysteresis: true, crossFade: false });
  const shipped = runShipped(path.frames, { hysteresis: true, crossFade: true });
  const exact = runShipped(path.frames, { hysteresis: false, crossFade: false });
  log(`${path.name}: ${seconds.toFixed(0)} s`);
  const row = (label: string, l: SwitchLog, extra: string) =>
    log(
      `  ${label.padEnd(26)} LOD switches/s ${rate(l.switches, seconds)} · max in one frame ${String(l.maxPerFrame).padStart(4)} · reversals ${String(l.reversals).padStart(4)} (in band ${l.inBandReversals}) · shadow toggles/s ${rate(l.shadowSwitches, seconds)} · max cell churn/s ${String(l.maxCellChurn).padStart(4)} · ${extra}`,
    );
  row("before (4 m re-bucket)", legacy.log, `buffer re-creations/s ${rate(legacy.rebuilds, seconds)} · ${((legacy.floats * 4) / 1024 / seconds).toFixed(0)} KB/s`);
  row("exact, incremental", exact.log, `buffer re-creations/s ${rate(exact.created, seconds)} · partial uploads/s ${rate(exact.partial, seconds)} · ${((exact.floats * 4) / 1024 / seconds).toFixed(0)} KB/s`);
  row("hysteresis", noFade.log, `buffer re-creations/s ${rate(noFade.created, seconds)} · partial uploads/s ${rate(noFade.partial, seconds)} · ${((noFade.floats * 4) / 1024 / seconds).toFixed(0)} KB/s`);
  row("hysteresis + cross-fade", shipped.log, `buffer re-creations/s ${rate(shipped.created, seconds)} · partial uploads/s ${rate(shipped.partial, seconds)} · ${((shipped.floats * 4) / 1024 / seconds).toFixed(0)} KB/s · max fading ${shipped.maxFading}`);
  log(`  update CPU (shipped, NullEngine uploads included): mean ${(shipped.frameMs.reduce((a, b) => a + b, 0) / shipped.frameMs.length).toFixed(3)} ms · p99 ${percentile(shipped.frameMs, 0.99).toFixed(3)} ms · max ${Math.max(...shipped.frameMs).toFixed(2)} ms`);
  check(shipped.log.inBandReversals === 0 && noFade.log.inBandReversals === 0, `${path.name}: an instance reversed a switch within the hysteresis band`);
  check(shipped.log.switches <= legacy.log.switches, `${path.name}: more switches than before`);
  summary.push(`${path.name}: switches ${legacy.log.switches} → ${shipped.log.switches}, reversals ${legacy.log.reversals} → ${shipped.log.reversals}, buffer re-creations ${legacy.rebuilds} → ${shipped.created}`);
}
reference.dispose();
OPTIMIZATIONS.lodHysteresis = true;
OPTIMIZATIONS.lodCrossFade = true;

// ---------------------------------------------------------------------------------------------
// Grass: with the GPU fade the buffer must cover the radius around the live camera until the next rebuild

{
  const cellSize = 16;
  const step = cellSize / 2;
  const margin = step * Math.SQRT2;
  const radius = 45;
  const fade = 12;
  let rebuildX = NaN;
  let rebuildZ = NaN;
  let lastCell = "";
  let maxOffset = 0;
  let cpuJump = 0;
  let gpuJump = 0;
  const smooth = (d: number) => {
    const t = Math.min(1, Math.max(0, 1 - (d - (radius - fade)) / fade));
    return t * t * (3 - 2 * t);
  };
  for (const path of PATHS) {
    let previous: Frame | null = null;
    for (const f of path.frames) {
      const cell = `${Math.floor(f.x / step)},${Math.floor(f.z / step)}`;
      if (cell !== lastCell) {
        // The CPU fade froze clump sizes at the rebuild point: measure the size jump of clumps along the motion.
        if (lastCell !== "") {
          for (let d = radius - fade; d <= radius; d += 0.5) {
            const dirX = f.x - rebuildX, dirZ = f.z - rebuildZ;
            const len = Math.hypot(dirX, dirZ) || 1;
            const px = rebuildX - (dirX / len) * d, pz = rebuildZ - (dirZ / len) * d;
            cpuJump = Math.max(cpuJump, Math.abs(smooth(Math.hypot(px - f.x, pz - f.z)) - smooth(Math.hypot(px - rebuildX, pz - rebuildZ))));
          }
        }
        lastCell = cell;
        rebuildX = f.x;
        rebuildZ = f.z;
      }
      maxOffset = Math.max(maxOffset, Math.hypot(f.x - rebuildX, f.z - rebuildZ));
      if (previous) gpuJump = Math.max(gpuJump, Math.hypot(f.x - previous.x, f.z - previous.z) * (1.5 / fade));
      previous = f;
    }
  }
  check(maxOffset <= margin + 1e-6, `grass buffer margin ${margin.toFixed(1)} m < camera drift ${maxOffset.toFixed(1)} m`);
  log(`grass: camera drifts ≤ ${maxOffset.toFixed(1)} m from the rebuild point (margin ${margin.toFixed(1)} m); largest clump size jump per rebuild with the CPU fade ${(cpuJump * 100).toFixed(0)}%, per frame with the GPU fade ≤ ${(gpuJump * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------------------------
// CPU cost: ~5,000 instances within 150 m of a walking camera

{
  const cellsAround = 8;
  const perCell = 625;
  const spec: LodCellSpec = {
    switches: [0, 35, 110],
    cullDistance: 1200,
    bands: new LodBands([0, 35, 110], 1200, [true, true, false], 70, HYSTERESIS),
    exactBands: new LodBands([0, 35, 110], 1200, [true, true, false], 70, 0),
    impostors: [null, null, IMPOSTOR_PLANES],
  };
  let seed = 12345;
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const cells = Array.from({ length: cellsAround }, (_, c) => {
    const positions = new Float32Array(perCell * 3);
    const matrices = new Float32Array(perCell * 16);
    for (let i = 0; i < perCell; i++) {
      const angle = ((c + random()) / cellsAround) * Math.PI * 2;
      const r = 150 * Math.sqrt(random());
      const x = Math.cos(angle) * r, z = Math.sin(angle) * r;
      positions.set([x, 0, z], i * 3);
      matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1], i * 16);
    }
    return new LodCell(spec, positions, matrices);
  });
  const step: LodStep = { x: 0, y: 1.6, z: 0, zoom: 1, select: true, hysteresis: true, fadeStep: 1, faceImpostors: true };
  const run = (frames: number, selectEvery: number, record: number[] | null, stepCells = true) => {
    for (let f = 0; f < frames; f++) {
      step.x = 60 * Math.sin(f * 0.0015);
      step.z = 60 * Math.cos(f * 0.0011);
      step.select = f % selectEvery === 0;
      step.fadeStep = 1 / (0.4 * 120);
      if (!stepCells) continue;
      const started = record ? performance.now() : 0;
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c]!;
        cell.step(step);
        // The render side cleans batches after uploading.
        if (cell.dirty) {
          cell.dirty = false;
          for (let k = 0; k < cell.batches.length; k++) cell.batches[k]?.clean();
        }
      }
      if (record) record.push(performance.now() - started);
    }
  };
  for (const cell of cells) cell.step(step);
  run(20000, 1, null);
  let scavenges = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if ((entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind === constants.NODE_PERFORMANCE_GC_MINOR) scavenges++;
  });
  observer.observe({ entryTypes: ["gc"] });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const countScavenges = async (frames: number, stepCells: boolean) => {
    await settle();
    scavenges = 0;
    run(frames, 1, null, stepCells);
    await settle();
    return scavenges;
  };
  const baseline = await countScavenges(50000, false);
  const stepping = await countScavenges(50000, true);
  observer.disconnect();
  for (const [label, selectEvery] of [["select every frame", 1], ["select every 0.5 m at 6.5 m/s, 120 Hz", 9]] as const) {
    const times: number[] = [];
    run(3000, selectEvery, times);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    log(`CPU, ${cellsAround * perCell} instances within 150 m, ${label}: mean ${mean.toFixed(3)} ms · p99 ${percentile(times, 0.99).toFixed(3)} ms · max ${Math.max(...times).toFixed(3)} ms`);
    check(mean < 0.5, `LOD selection costs ${mean.toFixed(3)} ms per frame`);
  }
  log(`allocation: ${stepping} young-generation GCs over 50,000 frames of selecting ${cellsAround * perCell} instances (harness loop alone: ${baseline})`);
  check(stepping <= baseline + 1, `LOD stepping allocates: ${stepping} scavenges vs ${baseline} for the bare loop`);
}

log("summary:");
for (const line of summary) log(`  ${line}`);
log("all checks passed");
engine.dispose();
