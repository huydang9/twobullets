import { existsSync } from "node:fs";
import { AssetContainer, MeshBuilder, NullEngine, Scene, TransformNode } from "@babylonjs/core";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { afterEach, describe, expect, it } from "vitest";
import { VN_PROP_IDS, VN_PROP_MANIFEST } from "../../src/assets/vnPropsManifest";
import { createVnPreview, LEVEL_SPACING, layoutVnProps } from "../../src/dev/vnPropsPreviewScene";

// vn-props.html bootstrap on NullEngine + Havok: the ground needs physics (the "No Physics Engine available" crash),
// files load one at a time with a yield after every prop, and every manifest level node is placed.

const ENV_ROOT = new URL("../../public/assets/environment/", import.meta.url);

/** Stand-in GLB: one transform node per level node of the file, each with a box. */
function fakeFile(scene: Scene, url: string): AssetContainer {
  const container = new AssetContainer(scene);
  const nodes = new Set(VN_PROP_IDS.flatMap((id) => VN_PROP_MANIFEST[id].lods.filter((l) => l.url === url).map((l) => l.node!)));
  for (const name of nodes) {
    const node = new TransformNode(name, scene);
    const box = MeshBuilder.CreateBox(`${name}_mesh`, { size: 0.5 }, scene);
    box.parent = node;
    container.transformNodes.push(node);
    container.meshes.push(box);
  }
  return container;
}

let engine: NullEngine | undefined;
afterEach(() => engine?.dispose());

describe("vn props preview", () => {
  it("every manifest file exists on disk", () => {
    const urls = new Set(VN_PROP_IDS.flatMap((id) => VN_PROP_MANIFEST[id].lods.map((l) => l.url)));
    for (const url of urls) expect(existsSync(new URL(url, ENV_ROOT)), url).toBe(true);
  });

  it("lays props out in one row per group without overlaps", () => {
    const { positions, groups } = layoutVnProps();
    expect(positions.size).toBe(VN_PROP_IDS.length);
    for (const group of groups) {
      const row = VN_PROP_IDS.filter((id) => VN_PROP_MANIFEST[id].group === group).map((id) => {
        const { min, max } = VN_PROP_MANIFEST[id].bounds;
        const x = positions.get(id)!.x;
        return [x + min[0], x + max[0]] as const;
      });
      for (let i = 1; i < row.length; i++) expect(row[i]![0]).toBeGreaterThanOrEqual(row[i - 1]![1]);
    }
  });

  it("boots with Havok and loads files sequentially, yielding between props", async () => {
    engine = new NullEngine();
    const scene = new Scene(engine);
    let inFlight = 0;
    let maxInFlight = 0;
    const loaded: string[] = [];
    let yields = 0;
    const progress: number[] = [];
    const preview = await createVnPreview(scene, {
      havok: await loadHavok(),
      loadFile: async (url) => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight--;
        loaded.push(url);
        return fakeFile(scene, url);
      },
      yieldToLoop: async () => {
        yields++;
      },
      onProgress: (done) => progress.push(done),
    });

    expect(scene.isPhysicsEnabled()).toBe(true);
    expect(preview.ground.meshes.length).toBe(1);
    expect(maxInFlight).toBe(1);
    expect(new Set(loaded).size).toBe(loaded.length);
    expect(preview.fileCount).toBe(new Set(VN_PROP_IDS.map((id) => VN_PROP_MANIFEST[id].url)).size);
    expect(yields).toBe(VN_PROP_IDS.length);
    expect(progress.at(-1)).toBe(VN_PROP_IDS.length);
    for (const { id, position, levels } of preview.placed) {
      expect(levels.length, id).toBe(VN_PROP_MANIFEST[id].lods.length);
      levels.forEach((meshes, level) => {
        expect(meshes.length, `${id} LOD${level}`).toBeGreaterThan(0);
        for (const mesh of meshes) {
          expect(mesh.parent).toBeNull();
          expect(mesh.position.z).toBeCloseTo(position.z - level * LEVEL_SPACING);
        }
      });
    }
  });
});
