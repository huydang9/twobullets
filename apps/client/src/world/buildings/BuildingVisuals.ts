import { Matrix, Mesh, Quaternion, Vector3, VertexData, type Scene } from "@babylonjs/core";
import { buildPrefabGeometry, type BuildingPlacement, type BuildingPrefab, type PrefabGeometry } from "@twobullets/shared";
import type { BuildingVisualHandle, BuildingVisualHost } from "@twobullets/sim";
import { OPTIMIZATIONS } from "../../perf/flags";
import type { Environment } from "../environment";
import { invalidateStaticShadows, markStaticShadowCaster } from "../shadowCulling";
import { BUILDING_SHADE_ATTRIBUTE } from "./buildingShadePlugin";
import { BuildingMaterials, lookOf, type BuildingLookId } from "./BuildingMaterials";

export interface BuildingVisualsOptions {
  /**
   * Instances are batched per prefab within square world cells of this size, so a batch's bounding box (the unit of
   * frustum and shadow-cascade culling for thin instances) stays around one point of interest, m.
   */
  readonly cellSize?: number;
}

export interface BuildingRenderStats {
  readonly prefabs: number;
  readonly batches: number;
  readonly instances: number;
  /** Per camera pass, before culling; shadow cascades repeat these for casters in range. */
  readonly drawCalls: number;
  readonly triangles: number;
}

/** Geometry is pure data and identical for every scene, so it is baked once per prefab per page. */
const geometryCache = new Map<string, PrefabGeometry>();

export function getPrefabGeometry(prefab: BuildingPrefab): PrefabGeometry {
  let geometry = geometryCache.get(prefab.id);
  if (!geometry) geometryCache.set(prefab.id, (geometry = buildPrefabGeometry(prefab)));
  return geometry;
}

/**
 * Client renderer for placed buildings: one merged mesh per look per prefab (prefab-local UVs), drawn with thin
 * instances, so draw calls scale with prefab types in view rather than with building count.
 */
export class BuildingVisuals implements BuildingVisualHost {
  readonly materials: BuildingMaterials;
  private readonly batches = new Map<string, Batch>();
  private readonly cellSize: number;

  constructor(
    private readonly scene: Scene,
    private readonly environment: Pick<Environment, "shadowGenerator" | "skyFill">,
    options: BuildingVisualsOptions = {},
  ) {
    this.materials = new BuildingMaterials(scene);
    this.cellSize = options.cellSize ?? 250;
  }

  add(prefab: BuildingPrefab, placement: BuildingPlacement): BuildingVisualHandle {
    const [x, , z] = placement.position;
    const key = `${prefab.id}@${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`;
    let batch = this.batches.get(key);
    if (!batch) this.batches.set(key, (batch = this.createBatch(key, prefab)));
    const matrix = Matrix.Compose(Vector3.OneReadOnly, Quaternion.RotationAxis(Vector3.Up(), placement.yaw), new Vector3(...placement.position));
    const instance = batch.add(matrix);
    return { meshes: batch.meshes, remove: () => batch.remove(instance) };
  }

  /** Resolves when all materials in use have their textures. */
  whenLoaded(): Promise<void> {
    return this.materials.whenLoaded();
  }

  /** Hides every building mesh (benchmark A/B). Collision and gameplay are unaffected. */
  setEnabled(enabled: boolean): void {
    for (const batch of this.batches.values()) batch.setVisible(enabled);
  }

  stats(): BuildingRenderStats {
    const prefabs = new Set<string>();
    let instances = 0;
    let drawCalls = 0;
    let triangles = 0;
    for (const batch of this.batches.values()) {
      if (batch.count === 0) continue;
      prefabs.add(batch.prefabId);
      instances += batch.count;
      drawCalls += batch.meshes.length;
      triangles += batch.triangles * batch.count;
    }
    return { prefabs: prefabs.size, batches: this.batches.size, instances, drawCalls, triangles };
  }

  dispose(): void {
    this.batches.forEach((b) => b.dispose());
    this.batches.clear();
    this.materials.dispose();
  }

  private createBatch(key: string, prefab: BuildingPrefab): Batch {
    const geometry = getPrefabGeometry(prefab);
    const byLook = new Map<BuildingLookId, MeshGroup[]>();
    for (const group of geometry.groups) {
      const look = lookOf(prefab.id, group.material);
      byLook.set(look, [...(byLook.get(look) ?? []), group]);
    }
    const meshes = [...byLook].map(([look, groups]) => {
      const mesh = new Mesh(`building_${key}_${look}`, this.scene);
      applyGroups(mesh, groups);
      mesh.material = this.materials.get(look);
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      if (OPTIMIZATIONS.staticBatchMatrices) mesh.freezeWorldMatrix();
      this.environment.shadowGenerator.addShadowCaster(mesh);
      markStaticShadowCaster(mesh);
      // PBR is lit by the IBL; the hemispheric fill is for non-PBR meshes only.
      this.environment.skyFill.excludedMeshes.push(mesh);
      return mesh;
    });
    return new Batch(prefab.id, meshes, geometry.triangles);
  }
}

class Batch {
  private readonly matrices = new Map<number, Float32Array>();
  private nextId = 0;
  private visible = true;

  constructor(
    readonly prefabId: string,
    readonly meshes: readonly Mesh[],
    readonly triangles: number,
  ) {}

  get count(): number {
    return this.matrices.size;
  }

  add(matrix: Matrix): number {
    const id = this.nextId++;
    this.matrices.set(id, new Float32Array(matrix.asArray()));
    this.sync();
    return id;
  }

  remove(id: number): void {
    if (this.matrices.delete(id)) this.sync();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const mesh of this.meshes) mesh.setEnabled(visible && this.count > 0);
    invalidateStaticShadows();
  }

  dispose(): void {
    this.meshes.forEach((m) => m.dispose());
  }

  /** Static buffer: buildings are placed at load and rarely change afterwards. */
  private sync(): void {
    const buffer = new Float32Array(this.matrices.size * 16);
    let offset = 0;
    for (const m of this.matrices.values()) {
      buffer.set(m, offset);
      offset += 16;
    }
    invalidateStaticShadows();
    for (const mesh of this.meshes) {
      // With zero thin instances Babylon would draw the source mesh itself at the origin.
      mesh.setEnabled(this.visible && buffer.length > 0);
      if (buffer.length === 0) continue;
      // Also refreshes the bounding info over all instances.
      mesh.thinInstanceSetBuffer("matrix", buffer, 16, true);
    }
  }
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
