import { Matrix, Vector3, type Mesh, type Scene } from "@babylonjs/core";
import { INSTANCE_STRIDE, getMapProp, type MapPropDef, type PropCategory, type PropInstanceSet } from "@twobullets/shared";
import { OPTIMIZATIONS } from "../../perf/flags";
import type { Environment } from "../environment";
import { invalidateStaticShadows, markStaticShadowCaster } from "../shadowCulling";
import type { PropVisual, PropVisuals } from "./PropVisuals";

export interface PropInstancesOptions {
  /** Batches are per prop per square world cell of this size (thin instances cull as one batch), m. */
  readonly cellSize?: number;
  /** Instances cast sun shadows only within this camera distance, per category, m. */
  readonly shadowDistance?: Partial<Record<PropCategory, number>>;
  /** Re-bucket instances after the camera moves this far, m. */
  readonly updateDistance?: number;
}

export interface PropRenderStats {
  readonly instances: number;
  /** Batches with at least one instance this frame, i.e. draw calls per camera pass before frustum culling. */
  readonly activeBatches: number;
  readonly activeMeshes: number;
  /** Instances in shadow-casting batches. */
  readonly shadowInstances: number;
  readonly culledInstances: number;
  /** Instance counts per 250 m cell, "cx,cz" → count. */
  readonly perCell: Readonly<Record<string, number>>;
}

const DEFAULT_SHADOW_DISTANCE: Readonly<Record<PropCategory, number>> = { tree: 70, rock: 50, prop: 50, bush: 25, grass: 0 };
/**
 * Props at most this tall (collision height at scale 1: crates, small rocks, stumps) cast shadows only within
 * SMALL_PROP_SHADOW_DISTANCE. With the sun at 48° their shadow reaches under half a meter past the prop and lies flat,
 * so beyond 30 m it is a thin sliver of pixels.
 */
const SMALL_PROP_HEIGHT = 0.5;
const SMALL_PROP_SHADOW_DISTANCE = 30;

/** One (level, casts shadow) bucket of a cell's instances of one prop. */
class Batch {
  meshes: Mesh[] | null = null;
  signature = -1;

  constructor(
    readonly name: string,
    readonly level: number,
    readonly shadow: boolean,
  ) {}
}

interface Cell {
  readonly key: string;
  readonly visual: PropVisual;
  /** 16 floats per instance. */
  readonly matrices: Float32Array;
  readonly positions: Float32Array;
  readonly min: Vector3;
  readonly max: Vector3;
  readonly batches: Map<number, Batch>;
  readonly shadowDistance: number;
}

/**
 * Renders map prop instances: thin instances per prop per world cell, split into LOD levels and a shadow-casting
 * near band by camera distance. Instances are re-bucketed when the camera has moved a few meters; a batch's GPU
 * buffer is rewritten only when its membership changed.
 */
export class PropInstances {
  private readonly cells: Cell[] = [];
  private readonly cellSize: number;
  private readonly updateDistance: number;
  private readonly lastCamera = new Vector3(Infinity, Infinity, Infinity);
  private shadowInstances = 0;
  private culledInstances = 0;
  private enabled = true;

  constructor(
    scene: Scene,
    visuals: PropVisuals,
    private readonly environment: Pick<Environment, "shadowGenerator" | "skyFill">,
    sets: readonly PropInstanceSet[],
    options: PropInstancesOptions = {},
  ) {
    this.cellSize = options.cellSize ?? 250;
    this.updateDistance = options.updateDistance ?? 4;
    const shadowDistance = { ...DEFAULT_SHADOW_DISTANCE, ...options.shadowDistance };
    const matrix = new Matrix();
    const yaw = new Matrix();
    const tilt = new Matrix();
    const scaling = new Matrix();
    const axis = new Vector3();

    for (const set of sets) {
      const def = getMapProp(set.prop);
      const { category } = def;
      if (category === "grass") continue;
      const small = OPTIMIZATIONS.smallPropShadowBand && propHeight(def) <= SMALL_PROP_HEIGHT;
      const castDistance = small ? Math.min(shadowDistance[category], SMALL_PROP_SHADOW_DISTANCE) : shadowDistance[category];
      const visual = visuals.get(set.prop);
      const byCell = new Map<string, number[]>();
      for (let i = 0; i < set.data.length; i += INSTANCE_STRIDE) {
        const key = `${Math.floor(set.data[i]! / this.cellSize)},${Math.floor(set.data[i + 2]! / this.cellSize)}`;
        let list = byCell.get(key);
        if (!list) byCell.set(key, (list = []));
        list.push(i);
      }
      for (const [key, offsets] of byCell) {
        const matrices = new Float32Array(offsets.length * 16);
        const positions = new Float32Array(offsets.length * 3);
        const min = new Vector3(Infinity, Infinity, Infinity);
        const max = new Vector3(-Infinity, -Infinity, -Infinity);
        offsets.forEach((offset, n) => {
          const d = set.data;
          const [x, y, z, rotation, scale, nx, nz] = [d[offset]!, d[offset + 1]!, d[offset + 2]!, d[offset + 3]!, d[offset + 4]!, d[offset + 5]!, d[offset + 6]!];
          instanceMatrix(x, y, z, rotation, scale, nx, nz, matrix, yaw, tilt, scaling, axis).copyToArray(matrices, n * 16);
          positions.set([x, y, z], n * 3);
          min.minimizeInPlaceFromFloats(x, y, z);
          max.maximizeInPlaceFromFloats(x, y, z);
        });
        this.cells.push({ key: `${set.prop}@${key}`, visual, matrices, positions, min, max, batches: new Map(), shadowDistance: visual.castShadow ? castDistance : 0 });
      }
    }
  }

  get instanceCount(): number {
    return this.cells.reduce((n, c) => n + c.positions.length / 3, 0);
  }

  /** Re-buckets instances around the camera; cheap to call every frame (does nothing until the camera moves). */
  update(camera: Vector3, force = false): void {
    if (!this.enabled) return;
    if (!force && Vector3.DistanceSquared(camera, this.lastCamera) < this.updateDistance * this.updateDistance) return;
    this.lastCamera.copyFrom(camera);
    this.shadowInstances = 0;
    this.culledInstances = 0;
    for (const cell of this.cells) this.updateCell(cell, camera);
  }

  /** Hides every batch (benchmark A/B); after re-enabling, the next update re-buckets. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.lastCamera.set(Infinity, Infinity, Infinity);
    invalidateStaticShadows();
    if (enabled) return;
    for (const cell of this.cells) {
      for (const batch of cell.batches.values()) {
        batch.meshes?.forEach((m) => m.setEnabled(false));
        batch.signature = -1;
      }
    }
  }

  stats(): PropRenderStats {
    let activeBatches = 0;
    let activeMeshes = 0;
    const perCell: Record<string, number> = {};
    for (const cell of this.cells) {
      const key = cell.key.slice(cell.key.indexOf("@") + 1);
      perCell[key] = (perCell[key] ?? 0) + cell.positions.length / 3;
      for (const batch of cell.batches.values()) {
        if (batch.meshes?.[0]?.isEnabled()) {
          activeBatches++;
          activeMeshes += batch.meshes.length;
        }
      }
    }
    return { instances: this.instanceCount, activeBatches, activeMeshes, shadowInstances: this.shadowInstances, culledInstances: this.culledInstances, perCell };
  }

  dispose(): void {
    for (const cell of this.cells) for (const batch of cell.batches.values()) batch.meshes?.forEach((m) => m.dispose());
    this.cells.length = 0;
  }

  private updateCell(cell: Cell, camera: Vector3): void {
    const count = cell.positions.length / 3;
    const near = distanceToBox(camera, cell.min, cell.max);
    const far = farthestInBox(camera, cell.min, cell.max);
    const nearBucket = this.bucket(cell, near);
    const members = new Map<number, number[]>();

    if (nearBucket === this.bucket(cell, far)) {
      // The whole cell lands in one bucket (usually far away): no per-instance work.
      if (nearBucket >= 0) members.set(nearBucket, [-1]);
    } else {
      for (let i = 0; i < count; i++) {
        const dx = cell.positions[i * 3]! - camera.x;
        const dy = cell.positions[i * 3 + 1]! - camera.y;
        const dz = cell.positions[i * 3 + 2]! - camera.z;
        const bucket = this.bucket(cell, Math.sqrt(dx * dx + dy * dy + dz * dz));
        if (bucket < 0) continue;
        let list = members.get(bucket);
        if (!list) members.set(bucket, (list = []));
        list.push(i);
      }
    }

    let visible = 0;
    for (const [bucket, indices] of members) {
      const all = indices[0] === -1;
      const size = all ? count : indices.length;
      visible += size;
      if (bucket % 2 === 1) this.shadowInstances += size;
      const batch = this.batch(cell, bucket);
      const signature = all ? -2 : signatureOf(indices);
      if (batch.signature === signature && batch.meshes?.[0]?.isEnabled()) continue;
      batch.signature = signature;
      if (batch.shadow) invalidateStaticShadows();
      const buffer = all ? cell.matrices : new Float32Array(size * 16);
      if (!all) indices.forEach((index, n) => buffer.set(cell.matrices.subarray(index * 16, index * 16 + 16), n * 16));
      for (const mesh of this.meshesOf(batch, cell)) {
        mesh.thinInstanceSetBuffer("matrix", buffer, 16, true);
        mesh.setEnabled(true);
      }
    }
    this.culledInstances += count - visible;
    for (const [bucket, batch] of cell.batches) {
      if (!members.has(bucket) && batch.meshes?.[0]?.isEnabled()) {
        if (batch.shadow) invalidateStaticShadows();
        batch.meshes.forEach((m) => m.setEnabled(false));
        batch.signature = -1;
      }
    }
  }

  /** Bucket = level * 2 + (casts shadow ? 1 : 0), or -1 when culled. */
  private bucket(cell: Cell, distance: number): number {
    const { visual } = cell;
    if (distance > visual.cullDistance) return -1;
    let level = 0;
    for (let i = 1; i < visual.levels.length; i++) if (distance >= visual.levels[i]!.distance) level = i;
    const shadow = distance < cell.shadowDistance && !visual.levels[level]!.billboard;
    return level * 2 + (shadow ? 1 : 0);
  }

  private batch(cell: Cell, bucket: number): Batch {
    let batch = cell.batches.get(bucket);
    if (!batch) cell.batches.set(bucket, (batch = new Batch(`prop_${cell.key}_lod${bucket >> 1}${bucket & 1 ? "_shadow" : ""}`, bucket >> 1, (bucket & 1) === 1)));
    return batch;
  }

  private meshesOf(batch: Batch, cell: Cell): Mesh[] {
    if (batch.meshes) return batch.meshes;
    batch.meshes = cell.visual.levels[batch.level]!.create(batch.name);
    for (const mesh of batch.meshes) {
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = false;
      mesh.receiveShadows = true;
      // Instance matrices carry the placement; the batch itself stays at the origin.
      if (OPTIMIZATIONS.staticBatchMatrices) mesh.freezeWorldMatrix();
      if (batch.shadow) {
        this.environment.shadowGenerator.addShadowCaster(mesh, false);
        markStaticShadowCaster(mesh);
      }
      this.environment.skyFill.excludedMeshes.push(mesh);
    }
    return batch.meshes;
  }
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

function distanceToBox(p: Vector3, min: Vector3, max: Vector3): number {
  const dx = Math.max(min.x - p.x, 0, p.x - max.x);
  const dy = Math.max(min.y - p.y, 0, p.y - max.y);
  const dz = Math.max(min.z - p.z, 0, p.z - max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function farthestInBox(p: Vector3, min: Vector3, max: Vector3): number {
  const dx = Math.max(Math.abs(p.x - min.x), Math.abs(p.x - max.x));
  const dy = Math.max(Math.abs(p.y - min.y), Math.abs(p.y - max.y));
  const dz = Math.max(Math.abs(p.z - min.z), Math.abs(p.z - max.z));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function propHeight(def: MapPropDef): number {
  const { collision } = def;
  if (collision.kind === "box") return collision.size[1];
  if (collision.kind === "cylinder") return collision.height;
  return Infinity;
}

function signatureOf(indices: readonly number[]): number {
  let hash = 0x811c9dc5 ^ indices.length;
  for (const index of indices) hash = Math.imul(hash ^ index, 0x01000193);
  return hash >>> 0;
}
