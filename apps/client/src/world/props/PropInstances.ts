import { Matrix, Vector3, type Mesh, type Scene } from "@babylonjs/core";
import { CAMERA, INSTANCE_STRIDE, getMapProp, type MapPropDef, type PropCategory, type PropInstanceSet } from "@twobullets/shared";
import { OPTIMIZATIONS } from "../../perf/flags";
import type { Environment } from "../environment";
import { freezeStaticMaterial } from "../materialFreeze";
import { invalidateStaticShadows, markStaticShadowCaster } from "../shadowCulling";
import { LodBands, lodZoom } from "./lodBands";
import { LodCell, type InstanceBatch, type LodCellSpec, type LodStep } from "./LodCell";
import { LOD_FADE_ATTRIBUTE, attachLodFade } from "./lodFadePlugin";
import { MIRROR_PROP, MirrorWalls, type MirrorStats } from "./MirrorWalls";
import type { PropVisual, PropVisuals } from "./PropVisuals";

export interface PropInstancesOptions {
  /** Batches are per prop per square world cell of this size (thin instances cull as one batch), m. */
  readonly cellSize?: number;
  /** Instances cast sun shadows only within this camera distance, per category, m. */
  readonly shadowDistance?: Partial<Record<PropCategory, number>>;
  /** Level selection re-runs after the camera moves this far, m. */
  readonly selectDistance?: number;
  /** Switch distance fraction of the LOD, cull and shadow hysteresis bands (with `lodHysteresis`). */
  readonly hysteresis?: number;
  /** Duration of a dithered LOD cross-fade (with `lodCrossFade`), s. */
  readonly fadeSeconds?: number;
}

export interface PropRenderStats {
  readonly instances: number;
  /** Batches with at least one instance this frame, i.e. draw calls per camera pass before frustum culling. */
  readonly activeBatches: number;
  readonly activeMeshes: number;
  /** Instances in shadow-casting batches. */
  readonly shadowInstances: number;
  readonly culledInstances: number;
  /** Instances cross-fading between levels right now. */
  readonly fadingInstances: number;
  /** Level changes since the start. */
  readonly lodSwitches: number;
  /** Instance counts per 250 m cell, "cx,cz" → count. */
  readonly perCell: Readonly<Record<string, number>>;
  /** Mirror panels and how many of them are reflecting right now. */
  readonly mirrors: MirrorStats;
}

const DEFAULT_SHADOW_DISTANCE: Readonly<Record<PropCategory, number>> = { tree: 70, rock: 50, prop: 50, bush: 25, grass: 0 };
/**
 * Props at most this tall (collision height at scale 1: crates, small rocks, stumps) cast shadows only within
 * SMALL_PROP_SHADOW_DISTANCE. With the sun at 48° their shadow reaches under half a meter past the prop and lies flat,
 * so beyond 30 m it is a thin sliver of pixels.
 */
const SMALL_PROP_HEIGHT = 0.5;
const SMALL_PROP_SHADOW_DISTANCE = 30;
/** A camera jump farther than this (respawn, benchmark viewpoint) switches levels without fading, m. */
const TELEPORT_DISTANCE = 30;
/**
 * Props that block movement and bullets and are taller than SMALL_PROP_HEIGHT (walls, fences, rocks, wrecks, trunks)
 * never cull inside the map (a 500 m square, diagonal ~707 m): nobody may see through cover. They go to their cheapest level.
 */
export const COVER_CULL_DISTANCE = 720;
/** Unzoomed vertical field of view (CAMERA.fovDegrees is horizontal at 16:9), radians. */
const REFERENCE_FOV = 2 * Math.atan(Math.tan((CAMERA.fovDegrees * Math.PI) / 360) / (16 / 9));

/** Batch bounds padding around instance pivots, per level: horizontal radius and vertical extent at the cell's largest scale. */
interface Padding {
  horizontal: number;
  below: number;
  above: number;
}

interface Cell {
  readonly key: string;
  readonly visual: PropVisual;
  readonly lod: LodCell;
  readonly maxScale: number;
  /** Some instance is tilted to the terrain: pad bounds as a sphere. */
  readonly tilted: boolean;
  /** Per batch index (`level × 2 + shadow`). */
  readonly meshes: (Mesh[] | null)[];
  /** Capacity the batch's GPU buffers were created with (0: none yet). */
  readonly uploaded: Int32Array;
  readonly padding: (Padding | null)[];
}

const boundsMin = new Vector3();
const boundsMax = new Vector3();

/**
 * Renders map prop instances: thin instances per prop per world cell, in batches per LOD level and shadow band.
 * Each instance picks its level with hysteresis and cross-fades by dithering (LodCell); batches keep persistent dynamic
 * buffers and upload only the slots that changed.
 */
export class PropInstances {
  private readonly cells: Cell[] = [];
  /** The reflecting faces of the mirror panels: one mesh each, outside the thin-instance batches. */
  readonly mirrors: MirrorWalls;
  private readonly selectDistance: number;
  private readonly fadeSeconds: number;
  private readonly lastSelect = new Vector3(Infinity, Infinity, Infinity);
  private readonly step: LodStep = { x: 0, y: 0, z: 0, zoom: 1, select: true, hysteresis: true, fadeStep: 1, faceImpostors: true };
  private lastTime = -1;
  private lastHysteresis = true;
  private enabled = true;

  constructor(
    private readonly scene: Scene,
    visuals: PropVisuals,
    private readonly environment: Pick<Environment, "shadowGenerator" | "skyFill">,
    sets: readonly PropInstanceSet[],
    options: PropInstancesOptions = {},
  ) {
    const cellSize = options.cellSize ?? 125;
    this.selectDistance = options.selectDistance ?? 0.5;
    this.fadeSeconds = options.fadeSeconds ?? 0.4;
    const hysteresis = options.hysteresis ?? 0.1;
    const shadowDistance = { ...DEFAULT_SHADOW_DISTANCE, ...options.shadowDistance };
    const matrix = new Matrix();
    const yaw = new Matrix();
    const tilt = new Matrix();
    const scaling = new Matrix();
    const axis = new Vector3();
    // A reflection needs a per-plane matrix, so mirror faces cannot share a batch; their frames still do.
    // The silvered faces are the mirror panel's body (its stand-in is only the frame), so they cast its shadow.
    this.mirrors = new MirrorWalls(scene, sets.filter((set) => set.prop === MIRROR_PROP), {
      shadowCaster: (mesh) => {
        environment.shadowGenerator.addShadowCaster(mesh, false);
        markStaticShadowCaster(mesh);
      },
    });

    for (const set of sets) {
      const def = getMapProp(set.prop);
      const { category } = def;
      if (category === "grass") continue;
      const small = OPTIMIZATIONS.smallPropShadowBand && propHeight(def) <= SMALL_PROP_HEIGHT;
      const visual = visuals.get(set.prop);
      const castDistance = !visual.castShadow ? 0 : small ? Math.min(shadowDistance[category], SMALL_PROP_SHADOW_DISTANCE) : shadowDistance[category];
      const cullDistance = isCover(def) ? Math.max(visual.cullDistance, COVER_CULL_DISTANCE) : visual.cullDistance;
      const spec = lodSpec(visual, cullDistance, castDistance, hysteresis);
      const byCell = new Map<string, number[]>();
      for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
        const key = `${Math.floor(set.data[i]! / cellSize)},${Math.floor(set.data[i + 2]! / cellSize)}`;
        let list = byCell.get(key);
        if (!list) byCell.set(key, (list = []));
        list.push(i);
      }
      for (const [key, offsets] of byCell) {
        const matrices = new Float32Array(offsets.length * 16);
        const positions = new Float32Array(offsets.length * 3);
        let maxScale = 0;
        let tilted = false;
        offsets.forEach((offset, n) => {
          const d = set.data;
          const [x, y, z, rotation, scale, nx, nz] = [d[offset]!, d[offset + 1]!, d[offset + 2]!, d[offset + 3]!, d[offset + 4]!, d[offset + 5]!, d[offset + 6]!];
          instanceMatrix(x, y, z, rotation, scale, nx, nz, matrix, yaw, tilt, scaling, axis).copyToArray(matrices, n * 16);
          positions.set([x, y, z], n * 3);
          maxScale = Math.max(maxScale, scale);
          tilted ||= Math.hypot(nx, nz) > 1e-4;
        });
        const batches = spec.bands.levelCount * 2;
        this.cells.push({
          key: `${set.prop}@${key}`,
          visual,
          lod: new LodCell(spec, positions, matrices),
          maxScale,
          tilted,
          meshes: new Array<Mesh[] | null>(batches).fill(null),
          uploaded: new Int32Array(batches),
          padding: new Array<Padding | null>(batches).fill(null),
        });
      }
    }
  }

  get instanceCount(): number {
    return this.cells.reduce((n, c) => n + c.lod.count, 0);
  }

  /** Per-cell LOD state, for headless checks; `lodCellProps` has the prop id of each. */
  get lodCells(): readonly LodCell[] {
    return this.cells.map((c) => c.lod);
  }

  get lodCellProps(): readonly string[] {
    return this.cells.map((c) => c.visual.prop);
  }

  /**
   * Selects levels around the camera and advances cross-fades; call every frame. `now` is a millisecond clock
   * (performance.now by default); `force` re-selects everything without fading.
   */
  update(camera: Vector3, force = false, now = performance.now()): void {
    if (!this.enabled) return;
    const dt = this.lastTime < 0 ? 0 : Math.min(0.25, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const moved = Vector3.DistanceSquared(camera, this.lastSelect);
    const snap = force || moved > TELEPORT_DISTANCE * TELEPORT_DISTANCE;
    const step = this.step;
    const zoom = lodZoom(this.scene.activeCamera?.fov ?? REFERENCE_FOV, REFERENCE_FOV);
    step.hysteresis = OPTIMIZATIONS.lodHysteresis;
    step.select = snap || moved >= this.selectDistance * this.selectDistance || step.hysteresis !== this.lastHysteresis || zoom !== step.zoom;
    step.zoom = zoom;
    step.fadeStep = snap || !OPTIMIZATIONS.lodCrossFade ? 1 : dt / this.fadeSeconds;
    step.faceImpostors = OPTIMIZATIONS.impostorFacing;
    step.x = camera.x;
    step.y = camera.y;
    step.z = camera.z;
    this.lastHysteresis = step.hysteresis;
    if (step.select) this.lastSelect.copyFrom(camera);
    for (const cell of this.cells) {
      cell.lod.step(step);
      if (cell.lod.dirty) this.upload(cell);
    }
    this.mirrors.update(camera, now);
  }

  /** Hides every batch (benchmark A/B); re-enabling shows them again as they were. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.lastTime = -1;
    this.mirrors.setEnabled(enabled);
    invalidateStaticShadows();
    for (const cell of this.cells) {
      cell.lod.batches.forEach((batch, index) => cell.meshes[index]?.forEach((m) => m.setEnabled(enabled && (batch?.count ?? 0) > 0)));
    }
  }

  stats(): PropRenderStats {
    let activeBatches = 0;
    let activeMeshes = 0;
    let shadowInstances = 0;
    let culledInstances = 0;
    let fadingInstances = 0;
    let lodSwitches = 0;
    const perCell: Record<string, number> = {};
    for (const cell of this.cells) {
      const { lod } = cell;
      const key = cell.key.slice(cell.key.indexOf("@") + 1);
      perCell[key] = (perCell[key] ?? 0) + lod.count;
      fadingInstances += lod.fadingInstances;
      lodSwitches += lod.counters.switches;
      for (let i = 0; i < lod.count; i++) if (lod.levelOf(i) < 0) culledInstances++;
      lod.batches.forEach((batch, index) => {
        if (!batch || batch.count === 0 || !cell.meshes[index]) return;
        activeBatches++;
        activeMeshes += cell.meshes[index].length;
        if (batch.shadow) shadowInstances += batch.count;
      });
    }
    return { instances: this.instanceCount, activeBatches, activeMeshes, shadowInstances, culledInstances, fadingInstances, lodSwitches, perCell, mirrors: this.mirrors.stats() };
  }

  dispose(): void {
    this.mirrors.dispose();
    for (const cell of this.cells) for (const meshes of cell.meshes) meshes?.forEach((m) => m.dispose());
    this.cells.length = 0;
  }

  private upload(cell: Cell): void {
    const { lod } = cell;
    lod.dirty = false;
    for (let index = 0; index < lod.batches.length; index++) {
      const batch = lod.batches[index];
      if (!batch?.dirty) continue;
      if (batch.shadow && (batch.membershipChanged || batch.matrixTo > 0)) invalidateStaticShadows();
      const meshes = batch.count > 0 ? this.meshesOf(cell, index, batch) : cell.meshes[index];
      if (meshes) this.write(cell, index, batch, meshes);
      batch.clean();
    }
  }

  private write(cell: Cell, index: number, batch: InstanceBatch, meshes: readonly Mesh[]): void {
    if (batch.count === 0) {
      // With zero thin instances Babylon would draw the source mesh itself.
      for (const mesh of meshes) mesh.setEnabled(false);
      return;
    }
    const recreate = cell.uploaded[index] !== batch.capacity;
    cell.uploaded[index] = batch.capacity;
    if (recreate || batch.membershipChanged) this.computeBounds(cell, index, batch);
    for (const mesh of meshes) {
      if (recreate) {
        mesh.thinInstanceSetBuffer("matrix", batch.matrices, 16, false);
        mesh.thinInstanceSetBuffer(LOD_FADE_ATTRIBUTE, batch.fades, 1, false);
      } else {
        if (batch.matrixTo > batch.matrixFrom) mesh.thinInstancePartialBufferUpdate("matrix", batch.matrices.subarray(batch.matrixFrom * 16, batch.matrixTo * 16), batch.matrixFrom * 16);
        if (batch.fadeTo > batch.fadeFrom) mesh.thinInstancePartialBufferUpdate(LOD_FADE_ATTRIBUTE, batch.fades.subarray(batch.fadeFrom, batch.fadeTo), batch.fadeFrom);
      }
      mesh.thinInstanceCount = batch.count;
      if (recreate || batch.membershipChanged) mesh.getBoundingInfo().reConstruct(boundsMin, boundsMax, mesh.getWorldMatrix());
      mesh.setEnabled(true);
    }
  }

  /** Batch bounds from the member pivots, padded by the level's geometry at the cell's largest instance scale. */
  private computeBounds(cell: Cell, index: number, batch: InstanceBatch): void {
    const { positions } = cell.lod;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let slot = 0; slot < batch.count; slot++) {
      const p = (batch.owners[slot]! >> 1) * 3;
      x0 = Math.min(x0, positions[p]!);
      x1 = Math.max(x1, positions[p]!);
      y0 = Math.min(y0, positions[p + 1]!);
      y1 = Math.max(y1, positions[p + 1]!);
      z0 = Math.min(z0, positions[p + 2]!);
      z1 = Math.max(z1, positions[p + 2]!);
    }
    const pad = cell.padding[index]!;
    boundsMin.set(x0 - pad.horizontal, y0 - pad.below, z0 - pad.horizontal);
    boundsMax.set(x1 + pad.horizontal, y1 + pad.above, z1 + pad.horizontal);
  }

  private meshesOf(cell: Cell, index: number, batch: InstanceBatch): Mesh[] {
    const existing = cell.meshes[index];
    if (existing) return existing;
    const meshes = cell.visual.levels[batch.level]!.create(`prop_${cell.key}_lod${batch.level}${batch.shadow ? "_shadow" : ""}`);
    let horizontal = 0;
    let below = 0;
    let above = 0;
    for (const mesh of meshes) {
      const { minimum, maximum } = mesh.getBoundingInfo();
      horizontal = Math.max(horizontal, -minimum.x, maximum.x, -minimum.z, maximum.z);
      below = Math.max(below, -minimum.y);
      above = Math.max(above, maximum.y);
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = false;
      mesh.receiveShadows = true;
      mesh.doNotSyncBoundingInfo = true;
      // Instance matrices carry the placement; the batch itself stays at the origin.
      if (OPTIMIZATIONS.staticBatchMatrices) mesh.freezeWorldMatrix();
      attachLodFade(mesh.material);
      freezeStaticMaterial(mesh.material);
      if (batch.shadow) {
        this.environment.shadowGenerator.addShadowCaster(mesh, false);
        markStaticShadowCaster(mesh);
      }
      this.environment.skyFill.excludedMeshes.push(mesh);
    }
    const s = cell.maxScale;
    // A tilted instance can swing any extent in any direction.
    const reach = Math.max(horizontal, below, above);
    cell.padding[index] = cell.tilted ? { horizontal: reach * s, below: reach * s, above: reach * s } : { horizontal: horizontal * s, below: below * s, above: above * s };
    cell.meshes[index] = meshes;
    return meshes;
  }
}

/** Bands and impostor layout shared by every cell of one prop. */
function lodSpec(visual: PropVisual, cullDistance: number, shadowDistance: number, hysteresis: number): LodCellSpec {
  const switches = visual.levels.map((l) => l.distance);
  const casts = visual.levels.map((l) => !l.billboard);
  return {
    switches,
    cullDistance,
    bands: new LodBands(switches, cullDistance, casts, shadowDistance, hysteresis),
    exactBands: new LodBands(switches, cullDistance, casts, shadowDistance, 0),
    impostors: visual.levels.map((l) => l.impostor),
  };
}

/** Scale, yaw about Y, then tilt from +Y onto the terrain normal (nx, ny, nz), then translate. */
function instanceMatrix(x: number, y: number, z: number, yaw: number, scale: number, nx: number, nz: number, out: Matrix, rotation: Matrix, tilt: Matrix, scaling: Matrix, axis: Vector3): Matrix {
  Matrix.ScalingToRef(scale, scale, scale, scaling);
  Matrix.RotationYToRef(yaw, rotation);
  scaling.multiplyToRef(rotation, out);
  const horizontal = Math.sqrt(nx * nx + nz * nz);
  if (horizontal > 1e-4) {
    // +Y × n = (nz, 0, -nx); the tilt angle is acos(ny) = asin(|n_xz|).
    Matrix.RotationAxisToRef(axis.set(nz / horizontal, 0, -nx / horizontal), Math.asin(Math.min(1, horizontal)), tilt);
    out.multiplyToRef(tilt, rotation);
    out.copyFrom(rotation);
  }
  out.setTranslationFromFloats(x, y, z);
  return out;
}

export function isCover(def: MapPropDef): boolean {
  return def.collision.kind !== "none" && propHeight(def) > SMALL_PROP_HEIGHT;
}

function propHeight(def: MapPropDef): number {
  const { collision } = def;
  if (collision.kind === "box") return collision.size[1];
  if (collision.kind === "cylinder") return collision.height;
  return Infinity;
}
