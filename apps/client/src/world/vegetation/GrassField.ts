import type { Mesh, Vector3 } from "@babylonjs/core";
import { INSTANCE_STRIDE, type ScatterContext, type ScatterRule } from "@twobullets/shared";
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
}

const MAX_CACHED_CELLS = 400;

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
    // Rebuild on every half cell of movement so the fade band follows smoothly.
    const step = this.cellSize / 2;
    const cell = `${Math.floor(camera.x / step)},${Math.floor(camera.z / step)}`;
    if (cell === this.lastCell) return;
    this.lastCell = cell;
    this.rebuild(camera.x, camera.z);
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
      for (const list of lists) {
        for (let i = 0; i < list.length; i += INSTANCE_STRIDE) {
          const x = list[i]!;
          const z = list[i + 2]!;
          const d = Math.sqrt((x - cx) * (x - cx) + (z - cz) * (z - cz));
          if (d >= this.radius) continue;
          const t = d <= inner ? 1 : 1 - (d - inner) / this.fade;
          const scale = list[i + 4]! * t * t * (3 - 2 * t);
          const c = Math.cos(list[i + 3]!) * scale;
          const sn = Math.sin(list[i + 3]!) * scale;
          const level = d >= lodDistance && buffers.length > 1 ? 1 : 0;
          // Babylon row-major world matrix: scale × RotationY(yaw) × translation.
          buffers[level]!.data.set([c, 0, -sn, 0, 0, scale, 0, 0, sn, 0, c, 0, x, list[i + 1]!, z, 1], counts[level]! * 16);
          counts[level]!++;
        }
      }
      buffers.forEach((buffer, level) => {
        const n = counts[level]!;
        this.visible += n;
        used.add(`${prop}#${level}`);
        for (const mesh of buffer.meshes) {
          mesh.setEnabled(n > 0);
          if (n > 0) mesh.thinInstanceSetBuffer("matrix", buffer.data.subarray(0, n * 16), 16, false);
        }
      });
    }
    for (const [key, buffer] of this.buffers) if (!used.has(key)) buffer.meshes.forEach((m) => m.setEnabled(false));
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
      for (const mesh of meshes) {
        mesh.isPickable = false;
        mesh.receiveShadows = true;
        this.environment.skyFill.excludedMeshes.push(mesh);
      }
      this.buffers.set(key, (buffer = { meshes, data: new Float32Array(0) }));
    }
    if (buffer.data.length < capacity * 16) buffer.data = new Float32Array(Math.ceil(capacity * 1.5) * 16);
    return buffer;
  }
}
