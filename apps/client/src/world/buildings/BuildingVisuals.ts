import { Matrix, Mesh, MultiMaterial, Quaternion, StandardMaterial, SubMesh, Vector3, VertexData, type Observer, type Scene } from "@babylonjs/core";
import { buildPrefabGeometry, facadeColor, type BuildingPlacement, type BuildingPrefab, type FacadeColor, type PrefabGeometry } from "@twobullets/shared";
import type { BuildingVisualHandle, BuildingVisualHost } from "@twobullets/sim";
import { OPTIMIZATIONS } from "../../perf/flags";
import type { Environment } from "../environment";
import { SHADOW_ONLY_LAYER, invalidateStaticShadows, markStaticShadowCaster } from "../shadowCulling";
import { BUILDING_SHADE_ATTRIBUTE } from "./buildingShadePlugin";
import { BuildingMaterials, facadeLook, lookOf, type BuildingLookId } from "./BuildingMaterials";

export interface BuildingVisualsOptions {
  /**
   * Instanced mode: instances are batched per prefab within square world cells of this size, so a batch's bounding box
   * (the unit of frustum and shadow-cascade culling for thin instances) stays around one point of interest, m.
   */
  readonly cellSize?: number;
  /** Merged mode (`buildingCellMerge`): every building in a square world cell of this size is baked into one mesh, m. */
  readonly mergedCellSize?: number;
}

export interface BuildingRenderStats {
  readonly prefabs: number;
  readonly batches: number;
  readonly instances: number;
  /** Per camera pass, before culling; shadow cascades repeat these for casters in range. */
  readonly drawCalls: number;
  readonly triangles: number;
}

/** Defaults (headless benches may tune them before a map loads). */
export const BUILDING_RENDER = {
  /** Merged cell size, m. Smaller cells cull tighter (fewer triangles, mostly in the shadow maps) but add draws. */
  mergedCellSize: 100,
};

/** Geometry is pure data and identical for every scene, so it is baked once per prefab per page. */
const geometryCache = new Map<string, PrefabGeometry>();

export function getPrefabGeometry(prefab: BuildingPrefab): PrefabGeometry {
  let geometry = geometryCache.get(prefab.id);
  if (!geometry) geometryCache.set(prefab.id, (geometry = buildPrefabGeometry(prefab)));
  return geometry;
}

interface RenderBatch {
  readonly count: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly prefabIds: Iterable<string>;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Client renderer for placed buildings.
 *
 * Merged mode (`buildingCellMerge`, default): all buildings in a world cell are baked into one static mesh with one
 * SubMesh per look (MultiMaterial), so the scene holds one mesh per cell and draws one call per look in view; submeshes
 * are frustum culled individually. With `buildingShadowProxy`, a second mesh sharing the same GPU buffers draws the whole
 * cell into the shadow map in one call per cascade and is hidden from cameras by its layer mask; the visible mesh
 * doesn't cast. Cells rebuild lazily (before the next active mesh evaluation, or on `flush`) when placements change.
 *
 * Instanced mode: one merged mesh per look per prefab per cell (prefab-local UVs), drawn with thin instances.
 */
export class BuildingVisuals implements BuildingVisualHost {
  readonly materials: BuildingMaterials;
  private readonly batches = new Map<string, RenderBatch>();
  private readonly dirty = new Set<MergedCell>();
  private readonly cellSize: number;
  private readonly mergedCellSize: number;
  private readonly merged: boolean;
  private readonly observers: Observer<unknown>[] = [];
  private visible = true;

  constructor(
    private readonly scene: Scene,
    private readonly environment: Pick<Environment, "shadowGenerator" | "skyFill">,
    options: BuildingVisualsOptions = {},
  ) {
    this.materials = new BuildingMaterials(scene);
    this.cellSize = options.cellSize ?? 250;
    this.mergedCellSize = options.mergedCellSize ?? BUILDING_RENDER.mergedCellSize;
    this.merged = OPTIMIZATIONS.buildingCellMerge;
    if (this.merged) {
      this.observers.push(scene.onBeforeActiveMeshesEvaluationObservable.add(() => this.flush()) as Observer<unknown>);
      // Merged cells keep no CPU copy of their buffers; rebuild them from the placements after a context loss.
      this.observers.push(
        scene.getEngine().onContextRestoredObservable.add(() => {
          for (const batch of this.batches.values()) if (batch instanceof MergedCell) this.dirty.add(batch);
          this.flush();
        }) as Observer<unknown>,
      );
    }
  }

  add(prefab: BuildingPrefab, placement: BuildingPlacement): BuildingVisualHandle {
    const [x, , z] = placement.position;
    const color = facadeColor(prefab.id, x, z);
    const matrix = Matrix.Compose(Vector3.OneReadOnly, Quaternion.RotationAxis(Vector3.Up(), placement.yaw), new Vector3(...placement.position));
    if (this.merged) {
      const key = `${Math.floor(x / this.mergedCellSize)},${Math.floor(z / this.mergedCellSize)}`;
      let cell = this.batches.get(key) as MergedCell | undefined;
      if (!cell) this.batches.set(key, (cell = new MergedCell(key, this.scene, this.materials, this.environment)));
      const merged = cell;
      const id = merged.add(prefab, matrix, color);
      this.dirty.add(merged);
      return {
        meshes: [merged.mesh],
        remove: () => {
          if (merged.remove(id)) this.dirty.add(merged);
        },
      };
    }
    const key = `${prefab.id}@${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`;
    let batch = this.batches.get(key) as Batch | undefined;
    if (!batch) this.batches.set(key, (batch = new Batch(key, prefab, this.scene, this.materials, this.environment)));
    const instance = batch.add(matrix, color);
    if (!this.visible) batch.setVisible(false);
    const target = batch;
    return { meshes: instance.meshes, remove: () => target.remove(instance.id) };
  }

  /** Rebuilds merged cells whose placements changed. Runs by itself before rendering; call after bulk loading to pay the cost there. */
  flush(): void {
    if (this.dirty.size === 0) return;
    for (const cell of this.dirty) {
      cell.rebuild();
      cell.setVisible(this.visible);
    }
    this.dirty.clear();
    invalidateStaticShadows();
  }

  /** Resolves when all materials in use have their textures. */
  whenLoaded(): Promise<void> {
    return this.materials.whenLoaded();
  }

  /** Hides every building mesh (benchmark A/B). Collision and gameplay are unaffected. */
  setEnabled(enabled: boolean): void {
    this.visible = enabled;
    for (const batch of this.batches.values()) batch.setVisible(enabled);
    invalidateStaticShadows();
  }

  stats(): BuildingRenderStats {
    this.flush();
    const prefabs = new Set<string>();
    let instances = 0;
    let drawCalls = 0;
    let triangles = 0;
    for (const batch of this.batches.values()) {
      if (batch.count === 0) continue;
      for (const id of batch.prefabIds) prefabs.add(id);
      instances += batch.count;
      drawCalls += batch.drawCalls;
      triangles += batch.triangles;
    }
    return { prefabs: prefabs.size, batches: this.batches.size, instances, drawCalls, triangles };
  }

  dispose(): void {
    for (const observer of this.observers) observer.remove();
    this.batches.forEach((b) => b.dispose());
    this.batches.clear();
    this.dirty.clear();
    this.materials.dispose();
  }
}

interface MergedPlacement {
  readonly prefab: BuildingPrefab;
  readonly matrix: Float32Array;
  readonly color: FacadeColor | null;
}

/** Stands in for building materials in the shadow pass, where only geometry and culling state matter. */
const shadowProxyMaterials = new WeakMap<Scene, StandardMaterial>();

function shadowProxyMaterial(scene: Scene): StandardMaterial {
  let material = shadowProxyMaterials.get(scene);
  if (!material) {
    material = new StandardMaterial("mat_building_shadowProxy", scene);
    material.freeze();
    shadowProxyMaterials.set(scene, material);
  }
  return material;
}

/**
 * Every building in one world cell baked into world space: vertices grouped by look into contiguous ranges, one SubMesh
 * per look. The optional shadow proxy shares the geometry with a single SubMesh over all of it.
 */
class MergedCell implements RenderBatch {
  readonly mesh: Mesh;
  private readonly material: MultiMaterial;
  private proxy: Mesh | null = null;
  private readonly placements = new Map<number, MergedPlacement>();
  private nextId = 0;
  private looks = 0;
  private triangleCount = 0;
  private visible = true;

  constructor(
    private readonly key: string,
    private readonly scene: Scene,
    private readonly materials: BuildingMaterials,
    private readonly environment: Pick<Environment, "shadowGenerator" | "skyFill">,
  ) {
    this.mesh = new Mesh(`building_cell_${key}`, scene);
    this.material = new MultiMaterial(`mat_building_cell_${key}`, scene);
    this.mesh.material = this.material;
    this.mesh.isPickable = false;
    this.mesh.receiveShadows = true;
    this.mesh.setEnabled(false);
    // PBR is lit by the IBL; the hemispheric fill is for non-PBR meshes only.
    environment.skyFill.excludedMeshes.push(this.mesh);
    if (!OPTIMIZATIONS.buildingShadowProxy) {
      environment.shadowGenerator.addShadowCaster(this.mesh, false);
      markStaticShadowCaster(this.mesh);
    }
  }

  get count(): number {
    return this.placements.size;
  }

  get drawCalls(): number {
    return this.count > 0 ? this.looks : 0;
  }

  get triangles(): number {
    return this.triangleCount;
  }

  get prefabIds(): Iterable<string> {
    return new Set([...this.placements.values()].map((p) => p.prefab.id));
  }

  add(prefab: BuildingPrefab, matrix: Matrix, color: FacadeColor | null): number {
    const id = this.nextId++;
    this.placements.set(id, { prefab, matrix: new Float32Array(matrix.asArray()), color });
    return id;
  }

  remove(id: number): boolean {
    return this.placements.delete(id);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    const show = visible && this.placements.size > 0;
    this.mesh.setEnabled(show);
    this.proxy?.setEnabled(show);
  }

  dispose(): void {
    this.proxy?.dispose();
    this.mesh.dispose();
    this.material.dispose();
  }

  rebuild(): void {
    // Group every placed mesh group by the look it draws with.
    const byLook = new Map<BuildingLookId, { placement: MergedPlacement; group: MeshGroup }[]>();
    for (const placement of this.placements.values()) {
      for (const group of getPrefabGeometry(placement.prefab).groups) {
        const look = facadeLook(lookOf(placement.prefab.id, group.material), placement.color);
        let list = byLook.get(look);
        if (!list) byLook.set(look, (list = []));
        list.push({ placement, group });
      }
    }
    let vertexCount = 0;
    let indexCount = 0;
    for (const list of byLook.values()) {
      for (const { group } of list) {
        vertexCount += group.positions.length / 3;
        indexCount += group.indices.length;
      }
    }
    this.looks = byLook.size;
    this.triangleCount = indexCount / 3;
    if (vertexCount === 0) {
      this.mesh.setEnabled(false);
      this.proxy?.setEnabled(false);
      return;
    }

    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const shade = new Float32Array(vertexCount * 2);
    const indices = new Uint32Array(indexCount);
    const ranges: { look: BuildingLookId; vertexStart: number; vertexCount: number; indexStart: number; indexCount: number }[] = [];
    let v = 0;
    let i = 0;
    for (const [look, list] of byLook) {
      const vertexStart = v;
      const indexStart = i;
      for (const { placement, group } of list) {
        const m = placement.matrix;
        const source = group.positions;
        const sourceNormals = group.normals;
        const n = source.length / 3;
        for (let k = 0; k < n; k++) {
          const x = source[k * 3]!;
          const y = source[k * 3 + 1]!;
          const z = source[k * 3 + 2]!;
          positions[(v + k) * 3] = x * m[0]! + y * m[4]! + z * m[8]! + m[12]!;
          positions[(v + k) * 3 + 1] = x * m[1]! + y * m[5]! + z * m[9]! + m[13]!;
          positions[(v + k) * 3 + 2] = x * m[2]! + y * m[6]! + z * m[10]! + m[14]!;
          const nx = sourceNormals[k * 3]!;
          const ny = sourceNormals[k * 3 + 1]!;
          const nz = sourceNormals[k * 3 + 2]!;
          normals[(v + k) * 3] = nx * m[0]! + ny * m[4]! + nz * m[8]!;
          normals[(v + k) * 3 + 1] = nx * m[1]! + ny * m[5]! + nz * m[9]!;
          normals[(v + k) * 3 + 2] = nx * m[2]! + ny * m[6]! + nz * m[10]!;
        }
        uvs.set(group.uvs, v * 2);
        shade.set(group.shade, v * 2);
        const sourceIndices = group.indices;
        for (let k = 0; k < sourceIndices.length; k++) indices[i + k] = sourceIndices[k]! + v;
        v += n;
        i += sourceIndices.length;
      }
      ranges.push({ look, vertexStart, vertexCount: v - vertexStart, indexStart, indexCount: i - indexStart });
    }

    const mesh = this.mesh;
    if (mesh.isWorldMatrixFrozen) mesh.unfreezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = false;
    const data = new VertexData();
    Object.assign(data, { positions, normals, uvs, indices });
    data.applyToMesh(mesh, false);
    mesh.setVerticesData(BUILDING_SHADE_ATTRIBUTE, shade, false, 2);
    this.material.subMaterials = ranges.map((r) => this.materials.get(r.look));
    mesh.subMeshes = [];
    ranges.forEach((r, index) => new SubMesh(index, r.vertexStart, r.vertexCount, r.indexStart, r.indexCount, mesh));
    mesh.refreshBoundingInfo();
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;

    if (OPTIMIZATIONS.buildingShadowProxy) {
      let proxy = this.proxy;
      if (!proxy) {
        proxy = this.proxy = new Mesh(`building_cell_${this.key}_shadow`, this.scene);
        proxy.material = shadowProxyMaterial(this.scene);
        proxy.isPickable = false;
        proxy.receiveShadows = false;
        // Drawn by the shadow generator's render list only; no camera shares this layer.
        proxy.layerMask = SHADOW_ONLY_LAYER;
        this.environment.shadowGenerator.addShadowCaster(proxy, false);
        markStaticShadowCaster(proxy);
      }
      if (proxy.isWorldMatrixFrozen) proxy.unfreezeWorldMatrix();
      proxy.doNotSyncBoundingInfo = false;
      mesh.geometry!.applyToMesh(proxy);
      proxy.subMeshes = [];
      new SubMesh(0, 0, vertexCount, 0, indexCount, proxy);
      proxy.refreshBoundingInfo();
      proxy.freezeWorldMatrix();
      proxy.doNotSyncBoundingInfo = true;
    }
    // Bounds are computed; the GPU holds the only copy (rebuilt from the placements on context loss).
    mesh.geometry!.clearCachedData();
    this.setVisible(this.visible);
  }
}

/**
 * All placements of one prefab in one world cell. One mesh per look, drawn with thin instances; a placement's facade
 * colour swaps the look of its exterior plaster group only, so colours add one draw each and share everything else.
 */
class Batch implements RenderBatch {
  private readonly groups: Map<BuildingLookId, MeshGroup[]>;
  /** Keyed by the prefab's own look and the look it is drawn with (they differ for recoloured facades). */
  private readonly meshes = new Map<string, InstancedMesh>();
  private readonly instances = new Set<number>();
  private nextId = 0;
  private visible = true;
  readonly prefabId: string;
  private readonly prefabTriangles: number;

  constructor(
    private readonly key: string,
    prefab: BuildingPrefab,
    private readonly scene: Scene,
    private readonly materials: BuildingMaterials,
    private readonly environment: Pick<Environment, "shadowGenerator" | "skyFill">,
  ) {
    const geometry = getPrefabGeometry(prefab);
    this.prefabId = prefab.id;
    this.prefabTriangles = geometry.triangles;
    this.groups = new Map();
    for (const group of geometry.groups) {
      const look = lookOf(prefab.id, group.material);
      this.groups.set(look, [...(this.groups.get(look) ?? []), group]);
    }
  }

  get count(): number {
    return this.instances.size;
  }

  get prefabIds(): Iterable<string> {
    return [this.prefabId];
  }

  get triangles(): number {
    return this.prefabTriangles * this.instances.size;
  }

  get drawCalls(): number {
    let n = 0;
    for (const m of this.meshes.values()) if (m.matrices.size > 0) n++;
    return n;
  }

  add(matrix: Matrix, color: FacadeColor | null): { id: number; meshes: Mesh[] } {
    const id = this.nextId++;
    const looks = [...this.groups.keys()].map((look) => facadeLook(look, color));
    const data = new Float32Array(matrix.asArray());
    this.instances.add(id);
    const meshes: Mesh[] = [];
    [...this.groups.keys()].forEach((base, i) => {
      const entry = this.mesh(base, looks[i]!);
      entry.matrices.set(id, data);
      entry.dirty = true;
      meshes.push(entry.mesh);
    });
    this.sync();
    return { id, meshes };
  }

  remove(id: number): void {
    if (!this.instances.delete(id)) return;
    for (const entry of this.meshes.values()) if (entry.matrices.delete(id)) entry.dirty = true;
    this.sync();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const entry of this.meshes.values()) entry.mesh.setEnabled(visible && entry.matrices.size > 0);
    invalidateStaticShadows();
  }

  dispose(): void {
    this.meshes.forEach((m) => m.mesh.dispose());
  }

  private mesh(base: BuildingLookId, look: BuildingLookId): InstancedMesh {
    const key = `${base}>${look}`;
    let entry = this.meshes.get(key);
    if (entry) return entry;
    const mesh = new Mesh(`building_${this.key}_${look}`, this.scene);
    applyGroups(mesh, this.groups.get(base)!);
    mesh.material = this.materials.get(look);
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    if (OPTIMIZATIONS.staticBatchMatrices) mesh.freezeWorldMatrix();
    this.environment.shadowGenerator.addShadowCaster(mesh);
    markStaticShadowCaster(mesh);
    // PBR is lit by the IBL; the hemispheric fill is for non-PBR meshes only.
    this.environment.skyFill.excludedMeshes.push(mesh);
    entry = { mesh, matrices: new Map(), dirty: true };
    this.meshes.set(key, entry);
    return entry;
  }

  /** Static buffers: buildings are placed at load and rarely change afterwards. */
  private sync(): void {
    invalidateStaticShadows();
    for (const entry of this.meshes.values()) {
      if (!entry.dirty) continue;
      entry.dirty = false;
      const buffer = new Float32Array(entry.matrices.size * 16);
      let offset = 0;
      for (const m of entry.matrices.values()) {
        buffer.set(m, offset);
        offset += 16;
      }
      // With zero thin instances Babylon would draw the source mesh itself at the origin.
      entry.mesh.setEnabled(this.visible && buffer.length > 0);
      if (buffer.length === 0) continue;
      // Also refreshes the bounding info over all instances.
      entry.mesh.thinInstanceSetBuffer("matrix", buffer, 16, true);
    }
  }
}

interface InstancedMesh {
  readonly mesh: Mesh;
  readonly matrices: Map<number, Float32Array>;
  dirty: boolean;
}

type MeshGroup = PrefabGeometry["groups"][number];

/** Concatenates several material groups that share a look into one mesh. */
function applyGroups(mesh: Mesh, groups: readonly MeshGroup[]): void {
  const total = (pick: (g: MeshGroup) => ArrayLike<number>) => groups.reduce((n, g) => n + pick(g).length, 0);
  const data = new VertexData();
  const positions = new Float32Array(total((g) => g.positions));
  const normals = new Float32Array(positions.length);
  const uvs = new Float32Array(total((g) => g.uvs));
  const shade = new Float32Array(uvs.length);
  const indices = new Uint32Array(total((g) => g.indices));
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const g of groups) {
    positions.set(g.positions, vertexOffset * 3);
    normals.set(g.normals, vertexOffset * 3);
    uvs.set(g.uvs, vertexOffset * 2);
    shade.set(g.shade, vertexOffset * 2);
    for (let i = 0; i < g.indices.length; i++) indices[indexOffset + i] = g.indices[i]! + vertexOffset;
    vertexOffset += g.positions.length / 3;
    indexOffset += g.indices.length;
  }
  Object.assign(data, { positions, normals, uvs, indices });
  data.applyToMesh(mesh, false);
  mesh.setVerticesData(BUILDING_SHADE_ATTRIBUTE, shade, false, 2);
}
