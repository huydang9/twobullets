import { AbstractMesh, Mesh, SubMesh, VertexBuffer, type Camera, type Material, type Observer, type Scene } from "@babylonjs/core";
import type { Terrain } from "@twobullets/shared";
import { buildChunkGeometry, chunkLayout, distanceToBox, projectionScale, selectLod, type ChunkGeometry } from "./terrainGeometry";

export interface TerrainRenderOptions {
  /** Grid cells per chunk side; must divide resolution − 1. 128 cells = 160 m at 1.25 m spacing. */
  readonly chunkCells: number;
  /** Coarsest LOD index (LOD n steps 2^n samples). */
  readonly maxLod: number;
  /** Max screen-space height error, pixels. */
  readonly pixelError: number;
}

export const TERRAIN_RENDER_DEFAULTS: TerrainRenderOptions = { chunkCells: 128, maxLod: 4, pixelError: 3 };

interface Chunk {
  readonly mesh: Mesh;
  readonly geometry: ChunkGeometry;
  readonly lodSubMeshes: readonly SubMesh[];
  lod: number;
}

export interface TerrainRenderStats {
  readonly chunks: number;
  /** Chunks inside the camera frustum on the last rendered frame. */
  readonly visible: number;
  readonly visibleTriangles: number;
  /** Visible chunk count per LOD. */
  readonly lodHistogram: readonly number[];
}

/**
 * Chunked terrain meshes with screen-space-error LOD. Each chunk is one mesh (one draw call) whose LOD is picked
 * by switching between SubMeshes over a shared vertex buffer, just before active meshes are evaluated. World
 * matrices are frozen; Babylon's frustum culling runs per chunk.
 */
export class TerrainRenderer {
  readonly meshes: readonly Mesh[];
  private readonly chunks: Chunk[] = [];
  private readonly observer: Observer<Scene>;
  private readonly options: TerrainRenderOptions;

  constructor(
    private readonly scene: Scene,
    terrain: Terrain,
    material: Material,
    options: Partial<TerrainRenderOptions> = {},
  ) {
    this.options = { ...TERRAIN_RENDER_DEFAULTS, ...options };
    const layout = chunkLayout(terrain.field, this.options.chunkCells, this.options.maxLod);
    for (let cz = 0; cz < layout.chunksPerSide; cz++) {
      for (let cx = 0; cx < layout.chunksPerSide; cx++) {
        this.chunks.push(this.createChunk(buildChunkGeometry(terrain.field, layout, cx, cz), material));
      }
    }
    this.meshes = this.chunks.map((c) => c.mesh);
    this.observer = scene.onBeforeActiveMeshesEvaluationObservable.add(() => {
      if (scene.activeCamera) this.updateLods(scene.activeCamera);
    });
  }

  getStats(): TerrainRenderStats {
    const active = this.scene.getActiveMeshes();
    const activeSet = new Set<AbstractMesh>(active.data.slice(0, active.length));
    const lodHistogram = new Array<number>(this.options.maxLod + 1).fill(0);
    let visible = 0;
    let visibleTriangles = 0;
    for (const chunk of this.chunks) {
      if (!activeSet.has(chunk.mesh)) continue;
      visible++;
      visibleTriangles += chunk.geometry.lods[chunk.lod]!.count / 3;
      lodHistogram[chunk.lod]!++;
    }
    return { chunks: this.chunks.length, visible, visibleTriangles, lodHistogram };
  }

  dispose(): void {
    this.observer.remove();
    for (const chunk of this.chunks) chunk.mesh.dispose();
  }

  private createChunk(geometry: ChunkGeometry, material: Material): Chunk {
    const mesh = new Mesh(`terrain_${geometry.chunkX}_${geometry.chunkZ}`, this.scene);
    mesh.setVerticesData(VertexBuffer.PositionKind, geometry.positions, false);
    mesh.setVerticesData(VertexBuffer.NormalKind, geometry.normals, false);
    mesh.setIndices(geometry.indices, geometry.vertexCount);
    mesh.position.set(geometry.centerX, 0, geometry.centerZ);
    mesh.material = material;
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_STANDARD;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;

    mesh.subMeshes = [];
    const lodSubMeshes = geometry.lods.map(({ start, count }) => new SubMesh(0, 0, geometry.vertexCount, start, count, mesh, undefined, false, false));
    mesh.subMeshes = [lodSubMeshes[0]!];
    return { mesh, geometry, lodSubMeshes, lod: 0 };
  }

  private updateLods(camera: Camera): void {
    const engine = this.scene.getEngine();
    const scale = projectionScale(engine.getRenderHeight(), camera.fov);
    const { x, y, z } = camera.globalPosition;
    for (const chunk of this.chunks) {
      const g = chunk.geometry;
      const box = chunk.mesh.getBoundingInfo().boundingBox;
      const distance = distanceToBox(x, y, z, box.minimumWorld.x, g.minY, box.minimumWorld.z, box.maximumWorld.x, g.maxY, box.maximumWorld.z);
      const lod = selectLod(g.lodErrors, distance, scale, this.options.pixelError);
      if (lod !== chunk.lod) {
        chunk.lod = lod;
        chunk.mesh.subMeshes = [chunk.lodSubMeshes[lod]!];
      }
    }
  }
}
