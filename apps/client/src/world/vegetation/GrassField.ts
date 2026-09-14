import { Vector3, type Mesh } from "@babylonjs/core";
import { INSTANCE_STRIDE, type ScatterContext, type ScatterRule } from "@twobullets/shared";
import { OPTIMIZATIONS } from "../../perf/flags";
import type { Environment } from "../environment";
import type { PropVisuals } from "../props";

export interface GrassFieldOptions {
  /** Grass is drawn within this horizontal distance of the camera, m. */
  readonly radius?: number;
  /** Instances shrink to nothing over this band at the edge instead of popping, m. */
  readonly fade?: number;
  /** Expansion cell size, m. */
  readonly cellSize?: number;
}

interface PropBuffer {
  readonly meshes: Mesh[];
  data: Float32Array;
  /** Largest local extent of the clump meshes at scale 1 (bounds padding), m. */
  readonly extent: number;
  /** The array the meshes' GPU buffers were created from (dynamic buffers only). */
  uploaded: Float32Array | null;
}

const MAX_CACHED_CELLS = 400;
/** Largest instance scale the detail rules produce, for bounds padding. */
const MAX_SCALE = 1.5;
const boundsMin = new Vector3();
const boundsMax = new Vector3();

/**
 * Grass clumps around the camera from the map's detail scatter rules. Cells expand lazily through the same seeded
 * ScatterContext as the rest of the scatter (so grass stays off roads, pads and buildings), and one thin-instance
 * buffer per grass prop is rebuilt when the camera crosses into a new cell. No collision, no shadows.
 */
export class GrassField {
  private readonly radius: number;
  private readonly fade: number;
  private readonly cellSize: number;
  private readonly cache = new Map<string, Map<string, number[]>>();
  private readonly buffers = new Map<string, PropBuffer>();
  private lastCell = "";
  private visible = 0;
  private enabled = true;

  constructor(
    private readonly visuals: PropVisuals,
    private readonly environment: Pick<Environment, "skyFill">,
    private readonly rules: readonly ScatterRule[],
    private readonly context: ScatterContext,
    options: GrassFieldOptions = {},
  ) {
    this.radius = options.radius ?? 45;
    this.fade = options.fade ?? 12;
    this.cellSize = options.cellSize ?? 16;
  }

  get instances(): number {
    return this.visible;
  }

  update(camera: Vector3): void {
    if (!this.enabled) return;
    // Rebuild on every half cell of movement so the fade band follows smoothly.
    const step = this.cellSize / 2;
    const cell = `${Math.floor(camera.x / step)},${Math.floor(camera.z / step)}`;
    if (cell === this.lastCell) return;
    this.lastCell = cell;
    this.rebuild(camera.x, camera.z);
  }

  /** Hides all grass (benchmark A/B); it rebuilds on the next update after re-enabling. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.lastCell = "";
    if (!enabled) {
      for (const buffer of this.buffers.values()) buffer.meshes.forEach((m) => m.setEnabled(false));
      this.visible = 0;
    }
  }

  dispose(): void {
    for (const buffer of this.buffers.values()) buffer.meshes.forEach((m) => m.dispose());
    this.buffers.clear();
    this.cache.clear();
  }

  private rebuild(cx: number, cz: number): void {
    const s = this.cellSize;
    const reach = this.radius + s;
    const gathered = new Map<string, number[][]>();
    for (let iz = Math.floor((cz - reach) / s); iz * s <= cz + reach; iz++) {
      for (let ix = Math.floor((cx - reach) / s); ix * s <= cx + reach; ix++) {
        const dx = Math.max(ix * s - cx, 0, cx - (ix + 1) * s);
        const dz = Math.max(iz * s - cz, 0, cz - (iz + 1) * s);
        if (dx * dx + dz * dz > this.radius * this.radius) continue;
        for (const [prop, list] of this.cell(ix, iz)) {
          let lists = gathered.get(prop);
          if (!lists) gathered.set(prop, (lists = []));
          lists.push(list);
        }
      }
    }

    this.visible = 0;
    const inner = this.radius - this.fade;
    const used = new Set<string>();
    for (const [prop, lists] of gathered) {
      const levels = this.visuals.get(prop).levels;
      const lodDistance = levels[1]?.distance ?? Infinity;
      const total = lists.reduce((n, l) => n + l.length / INSTANCE_STRIDE, 0);
      const buffers = [this.buffer(prop, 0, total), ...(levels.length > 1 ? [this.buffer(prop, 1, total)] : [])];
      const counts = buffers.map(() => 0);
      const bounds = buffers.map(() => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
      for (const list of lists) {
        for (let i = 0; i < list.length; i += INSTANCE_STRIDE) {
          const x = list[i]!;
          const y = list[i + 1]!;
          const z = list[i + 2]!;
          const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz));
          if (d >= this.radius) continue;
          const t = d <= inner ? 1 : 1 - (d - inner) / this.fade;
          const scale = list[i + 4]! * t * t * (3 - 2 * t);
          const c = Math.cos(list[i + 3]!) * scale;
          const sn = Math.sin(list[i + 3]!) * scale;
          const level = d >= lodDistance && buffers.length > 1 ? 1 : 0;
          // Babylon row-major world matrix: scale × RotationY(yaw) × translation.
          const m = buffers[level]!.data;
          const o = counts[level]! * 16;
          m[o] = c;
          m[o + 1] = 0;
          m[o + 2] = -sn;
          m[o + 3] = 0;
          m[o + 4] = 0;
          m[o + 5] = scale;
          m[o + 6] = 0;
          m[o + 7] = 0;
          m[o + 8] = sn;
          m[o + 9] = 0;
          m[o + 10] = c;
          m[o + 11] = 0;
          m[o + 12] = x;
          m[o + 13] = y;
          m[o + 14] = z;
          m[o + 15] = 1;
          counts[level]!++;
          const b = bounds[level]!;
          b[0] = Math.min(b[0]!, x);
          b[1] = Math.min(b[1]!, y);
          b[2] = Math.min(b[2]!, z);
          b[3] = Math.max(b[3]!, x);
          b[4] = Math.max(b[4]!, y);
          b[5] = Math.max(b[5]!, z);
        }
      }
      buffers.forEach((buffer, level) => {
        const n = counts[level]!;
        this.visible += n;
        used.add(`${prop}#${level}`);
        if (OPTIMIZATIONS.grassDynamicBuffers) {
          this.upload(buffer, n, bounds[level]!);
          return;
        }
        for (const mesh of buffer.meshes) {
          mesh.setEnabled(n > 0);
          if (n > 0) mesh.thinInstanceSetBuffer("matrix", buffer.data.subarray(0, n * 16), 16, false);
        }
      });
    }
    for (const [key, buffer] of this.buffers) if (!used.has(key)) buffer.meshes.forEach((m) => m.setEnabled(false));
  }

  /**
   * Writes the first `count` instances of `buffer.data` into the meshes' dynamic GPU buffers, reallocating only when the
   * array grew, and sets the batch bounds from the instance positions instead of transforming every instance's box.
   */
  private upload(buffer: PropBuffer, count: number, bounds: readonly number[]): void {
    const reallocate = buffer.uploaded !== buffer.data;
    if (reallocate && count > 0) buffer.uploaded = buffer.data;
    const pad = buffer.extent * MAX_SCALE;
    boundsMin.set(bounds[0]! - pad, bounds[1]! - pad, bounds[2]! - pad);
    boundsMax.set(bounds[3]! + pad, bounds[4]! + pad, bounds[5]! + pad);
    for (const mesh of buffer.meshes) {
      // With zero thin instances Babylon would draw the source mesh itself.
      mesh.setEnabled(count > 0);
      if (count === 0) continue;
      if (reallocate) mesh.thinInstanceSetBuffer("matrix", buffer.data, 16, false);
      mesh.thinInstanceCount = count;
      mesh.thinInstanceBufferUpdated("matrix");
      mesh.getBoundingInfo().reConstruct(boundsMin, boundsMax, mesh.getWorldMatrix());
    }
  }

  private cell(ix: number, iz: number): Map<string, number[]> {
    const key = `${ix},${iz}`;
    let cell = this.cache.get(key);
    if (cell) return cell;
    cell = new Map();
    const s = this.cellSize;
    for (const rule of this.rules) this.context.expandRegion(rule, ix * s, iz * s, (ix + 1) * s, (iz + 1) * s, cell);
    if (this.cache.size >= MAX_CACHED_CELLS) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, cell);
    return cell;
  }

  private buffer(prop: string, level: number, capacity: number): PropBuffer {
    const key = `${prop}#${level}`;
    let buffer = this.buffers.get(key);
    if (!buffer) {
      const meshes = this.visuals.get(prop).levels[level]!.create(`grass_${prop}_lod${level}`);
      let extent = 0;
      for (const mesh of meshes) {
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        const { minimum, maximum } = mesh.getBoundingInfo();
        extent = Math.max(extent, -minimum.x, -minimum.y, -minimum.z, maximum.x, maximum.y, maximum.z);
        if (OPTIMIZATIONS.grassDynamicBuffers) mesh.doNotSyncBoundingInfo = true;
        if (OPTIMIZATIONS.staticBatchMatrices) mesh.freezeWorldMatrix();
        this.environment.skyFill.excludedMeshes.push(mesh);
      }
      this.buffers.set(key, (buffer = { meshes, data: new Float32Array(0), extent, uploaded: null }));
    }
    if (buffer.data.length < capacity * 16) buffer.data = new Float32Array(Math.ceil(capacity * 1.5) * 16);
    return buffer;
  }
}
