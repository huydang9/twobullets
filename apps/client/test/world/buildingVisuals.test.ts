import { Matrix, NullEngine, PBRMaterial, Quaternion, Scene, Vector3, type AbstractMesh, type Mesh } from "@babylonjs/core";
import { facadeColor, getBuildingPrefab, type BuildingPrefabId } from "@twobullets/shared";
import { afterEach, describe, expect, it } from "vitest";
import { OPTIMIZATIONS } from "../../src/perf/flags";
import { BuildingVisuals, getPrefabGeometry } from "../../src/world/buildings";
import { facadeLook, lookOf } from "../../src/world/buildings/BuildingMaterials";
import { freezeStaticMaterial } from "../../src/world/materialFreeze";
import { SHADOW_ONLY_LAYER } from "../../src/world/shadowCulling";

// Merged building cells (buildingCellMerge + buildingShadowProxy) against the placement transforms: per-look world
// bounds, draw counts, the shadow proxy wiring, removal, and frozen world materials picking up dirty marks.

const PLACEMENTS: readonly { prefab: BuildingPrefabId; position: [number, number, number]; yaw: number }[] = [
  { prefab: "tube_house_3", position: [12.5, 1, 7], yaw: 0.7 },
  { prefab: "tube_house_3", position: [31, 1.5, 4], yaw: -2.1 },
  { prefab: "tube_house_wide", position: [18, 0.5, 22], yaw: Math.PI / 2 },
  { prefab: "tube_house_narrow", position: [40, 2, 40], yaw: 3 },
];

let engine: NullEngine | undefined;
const saved = { ...OPTIMIZATIONS };
afterEach(() => {
  engine?.dispose();
  Object.assign(OPTIMIZATIONS, saved);
});

function setup() {
  engine = new NullEngine();
  const scene = new Scene(engine);
  const casters: AbstractMesh[] = [];
  const environment = { shadowGenerator: { addShadowCaster: (mesh: AbstractMesh) => void casters.push(mesh) }, skyFill: { excludedMeshes: [] as AbstractMesh[] } };
  const visuals = new BuildingVisuals(scene, environment as never, { mergedCellSize: 1000 });
  return { scene, casters, visuals };
}

/** Expected world bounds per look, transforming every prefab vertex with Babylon's own matrix math. */
function expectedBounds(placements: typeof PLACEMENTS): Map<string, { min: Vector3; max: Vector3 }> {
  const bounds = new Map<string, { min: Vector3; max: Vector3 }>();
  const p = new Vector3();
  for (const placement of placements) {
    const prefab = getBuildingPrefab(placement.prefab);
    const matrix = Matrix.Compose(Vector3.OneReadOnly, Quaternion.RotationAxis(Vector3.Up(), placement.yaw), new Vector3(...placement.position));
    const color = facadeColor(prefab.id, placement.position[0], placement.position[2]);
    for (const group of getPrefabGeometry(prefab).groups) {
      const look = facadeLook(lookOf(prefab.id, group.material), color);
      const entry = bounds.get(look) ?? { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
      for (let i = 0; i < group.positions.length; i += 3) {
        Vector3.TransformCoordinatesFromFloatsToRef(group.positions[i]!, group.positions[i + 1]!, group.positions[i + 2]!, matrix, p);
        entry.min.minimizeInPlace(p);
        entry.max.maximizeInPlace(p);
      }
      bounds.set(look, entry);
    }
  }
  return bounds;
}

describe("merged building cells", () => {
  it("bakes placements into one mesh with a submesh per look at the right world bounds", () => {
    const { scene, visuals } = setup();
    const handles = PLACEMENTS.map((p) => visuals.add(getBuildingPrefab(p.prefab), { position: p.position, yaw: p.yaw }));
    visuals.flush();

    const mesh = handles[0]!.meshes[0] as Mesh;
    expect(handles.every((h) => h.meshes.length === 1 && h.meshes[0] === mesh)).toBe(true);
    expect(mesh.isEnabled()).toBe(true);
    const expected = expectedBounds(PLACEMENTS);
    expect(mesh.subMeshes.length).toBe(expected.size);
    expect(visuals.stats()).toMatchObject({ instances: PLACEMENTS.length, drawCalls: expected.size, batches: 1 });

    const materials = (mesh.material as unknown as { subMaterials: PBRMaterial[] }).subMaterials;
    for (const subMesh of mesh.subMeshes) {
      const look = materials[subMesh.materialIndex]!.name.replace("mat_building_", "");
      const box = subMesh.getBoundingInfo().boundingBox;
      const want = expected.get(look)!;
      expect(want, look).toBeDefined();
      for (const axis of ["x", "y", "z"] as const) {
        expect(box.minimumWorld[axis]).toBeCloseTo(want.min[axis], 3);
        expect(box.maximumWorld[axis]).toBeCloseTo(want.max[axis], 3);
      }
    }
    expect(scene.meshes.filter((m) => m.name.startsWith("building_")).length).toBe(2);
  });

  it("casts through a hidden proxy sharing the geometry, or through the mesh itself without proxies", () => {
    const withProxy = setup();
    const handle = withProxy.visuals.add(getBuildingPrefab("tube_house_3"), { position: [0, 0, 0], yaw: 0 });
    withProxy.visuals.flush();
    const mesh = handle.meshes[0] as Mesh;
    expect(withProxy.casters).toHaveLength(1);
    const proxy = withProxy.casters[0] as Mesh;
    expect(proxy).not.toBe(mesh);
    expect(proxy.layerMask).toBe(SHADOW_ONLY_LAYER);
    expect(proxy.layerMask & 0x0fffffff).toBe(0);
    expect(proxy.geometry).toBe(mesh.geometry);
    expect(proxy.subMeshes).toHaveLength(1);
    expect(proxy.subMeshes[0]!.indexCount).toBe(mesh.getTotalIndices());
    engine!.dispose();

    OPTIMIZATIONS.buildingShadowProxy = false;
    const direct = setup();
    const own = direct.visuals.add(getBuildingPrefab("tube_house_3"), { position: [0, 0, 0], yaw: 0 });
    direct.visuals.flush();
    expect(direct.casters).toEqual([own.meshes[0]]);
  });

  it("rebuilds without removed placements and hides an emptied cell", () => {
    const { visuals } = setup();
    const a = visuals.add(getBuildingPrefab("tube_house_3"), { position: [0, 0, 0], yaw: 0 });
    const b = visuals.add(getBuildingPrefab("tube_house_wide"), { position: [30, 0, 0], yaw: 1 });
    visuals.flush();
    const both = visuals.stats().triangles;
    b.remove();
    visuals.flush();
    expect(visuals.stats().triangles).toBe(getPrefabGeometry(getBuildingPrefab("tube_house_3")).triangles);
    expect(visuals.stats().triangles).toBeLessThan(both);
    a.remove();
    visuals.flush();
    expect(a.meshes[0]!.isEnabled()).toBe(false);
  });

  it("instanced mode keeps one thin-instanced mesh per look per prefab", () => {
    OPTIMIZATIONS.buildingCellMerge = false;
    const { visuals } = setup();
    const handle = visuals.add(getBuildingPrefab("tube_house_3"), { position: [0, 0, 0], yaw: 0 });
    expect(handle.meshes.length).toBeGreaterThan(1);
    expect((handle.meshes[0] as Mesh).thinInstanceCount).toBe(1);
  });
});

describe("frozen world materials", () => {
  it("re-evaluate their shader after a dirty mark", () => {
    const { scene, visuals } = setup();
    const handle = visuals.add(getBuildingPrefab("tube_house_3"), { position: [0, 0, 0], yaw: 0 });
    visuals.flush();
    const mesh = handle.meshes[0] as Mesh;
    const material = mesh.subMeshes[0]!.getMaterial()!;
    expect(material.isFrozen).toBe(true);
    const wrapper = mesh.subMeshes[0]!._drawWrapper as unknown as { _wasPreviouslyReady: boolean; effect: unknown };
    wrapper._wasPreviouslyReady = true;
    scene.markAllMaterialsAsDirty(1);
    expect(wrapper._wasPreviouslyReady).toBe(false);
    expect(material.isFrozen).toBe(true);

    OPTIMIZATIONS.freezeStaticMaterials = false;
    const plain = new PBRMaterial("plain", scene);
    freezeStaticMaterial(plain);
    expect(plain.isFrozen).toBe(false);
  });
});
