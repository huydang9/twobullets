import { NullEngine, PBRMaterial, Scene, VertexBuffer } from "@babylonjs/core";
import { getMapProp } from "@twobullets/shared";
import { afterEach, describe, expect, it } from "vitest";
import { PropVisuals } from "../../src/world/props/PropVisuals";
import { COVER_CULL_DISTANCE, isCover } from "../../src/world/props/PropInstances";

// wall_grass: the maze panel with no collider at all — you and your bullets walk through it. Everything that sells the
// lie is geometry, so these checks are about the geometry: opaque, the concrete wall's size and silhouette, the same
// cull distance so it never fades out ahead of its neighbours, and one plain mesh per level so it stays in the
// thin-instance batch with every other stand-in.

let engine: NullEngine | undefined;
afterEach(() => {
  engine?.dispose();
  engine = undefined;
});

describe("wall_grass stand-in", () => {
  it("is an opaque hedge at wall_concrete's size, thin-instanced like the rest", async () => {
    engine = new NullEngine();
    const scene = new Scene(engine);
    const visuals = await PropVisuals.load(scene, ["wall_grass", "wall_concrete"], false);
    const grass = visuals.get("wall_grass");
    const concrete = visuals.get("wall_concrete");
    expect(grass.asset).toBe(false);

    // Nothing transparent: no glazed part, so the shared glass material is never even created.
    for (const [index, level] of grass.levels.entries()) {
      const meshes = level.create(`grass_lod${index}`);
      expect(meshes, `level ${index} must be one plain mesh, or it leaves the thin-instance batch`).toHaveLength(1);
      expect((meshes[0]!.material as PBRMaterial).name).toBe("mat_prop_standin");
    }
    expect(scene.materials.some((m) => m.name === "mat_prop_glass")).toBe(false);

    // A hedge that faded out or stopped casting shadows where the concrete around it did not would mark every
    // walk-through wall on the map from across the maze. `isCover` is false here (no collider), so the spec's own cull
    // distance has to carry the match.
    expect(isCover(getMapProp("wall_grass"))).toBe(false);
    expect(isCover(getMapProp("wall_concrete"))).toBe(true);
    expect(grass.cullDistance).toBeGreaterThanOrEqual(Math.max(concrete.cullDistance, COVER_CULL_DISTANCE));
    expect(grass.castShadow).toBe(true);

    const meshes = grass.levels[0]!.create("grass_lod0");
    const { minimum, maximum } = meshes[0]!.getBoundingInfo();
    // The 4 m span of the lattice, buried below the ground and topping out around the concrete's 2.3 m.
    expect(minimum.x).toBeGreaterThanOrEqual(-2.1);
    expect(maximum.x).toBeLessThanOrEqual(2.1);
    expect(minimum.y).toBeLessThanOrEqual(-0.4);
    expect(maximum.y).toBeGreaterThan(2.3);
    // The fronds stand about half a metre proud of the concrete cap, the way a hedge does. Not more.
    expect(maximum.y).toBeLessThan(3.3);
  });

  it("gets denser, never thinner, as you walk up to it", async () => {
    engine = new NullEngine();
    const scene = new Scene(engine);
    const visuals = await PropVisuals.load(scene, ["wall_grass"], false);
    const grass = visuals.get("wall_grass");
    expect(grass.levels.length).toBeGreaterThan(1);

    let previous = Infinity;
    for (const [index, level] of grass.levels.entries()) {
      const mesh = level.create(`grass_lod${index}`)[0]!;
      const count = mesh.getVerticesData(VertexBuffer.PositionKind)!.length / 3;
      expect(count, `level ${index}`).toBeLessThan(previous);
      previous = count;
      // Every level keeps the full-width slab: the silhouette is the lie and it must not change shape with distance.
      const { minimum, maximum } = mesh.getBoundingInfo();
      expect(maximum.x - minimum.x, `level ${index} span`).toBeGreaterThan(3.9);
      expect(maximum.y, `level ${index} height`).toBeGreaterThan(2.3);
    }
    // The coarsest level is still a solid body, not a handful of blades.
    const last = grass.levels[grass.levels.length - 1]!.create("grass_far")[0]!;
    expect(last.getVerticesData(VertexBuffer.PositionKind)!.length / 3).toBeGreaterThan(60);
  });
});
