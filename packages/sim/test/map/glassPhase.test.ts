import "@babylonjs/core/Meshes/thinInstanceMesh.js";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { Scene } from "@babylonjs/core/scene.js";
import { GLASS_PHASE, PHASE_GLASS_PROP, glassBlocksAt, glassPhaseBucket } from "@twobullets/shared/map/glassPhase";
import { INSTANCE_STRIDE } from "@twobullets/shared/map/layout/scatter";
import type { MapLayout } from "@twobullets/shared/map/layout/mapLayout";
import { Heightfield } from "@twobullets/shared/map/terrain/heightfield";
import type { Terrain } from "@twobullets/shared/map/terrain/terrain";
import { beforeAll, describe, expect, it } from "vitest";
import { WORLD_ONLY_MASK } from "../../src/collisionLayers";
import { buildMapCollision, type MapCollision } from "../../src/map/mapCollision";
import { loadHavok } from "../../src/node/loadHavok";

// The glazed pane switches between stopping bullets and letting them through on the match clock. This is the server
// half of it: the headless world must answer the shared schedule exactly, pane by pane, because the server is the one
// that decides whether a shot connected. The client half is apps/client/test/world/phaseGlassColliders.test.ts, which
// builds the same panes through its own collider class and must agree tick for tick.

/** Panes on an 8 m spacing, all facing +Z, so each one lands in the phase group its own cell hashes to. */
const PANES = [-32, -24, -16, -8, 0, 8, 16, 24, 32, 40];

function layoutOf(): MapLayout {
  const data = new Float32Array(PANES.length * INSTANCE_STRIDE);
  PANES.forEach((x, i) => data.set([x, 0, 0, 0, 1, 0, 0], i * INSTANCE_STRIDE));
  return { props: [{ prop: PHASE_GLASS_PROP, data }], buildings: [] } as unknown as MapLayout;
}

describe("glass phase collision (headless server)", () => {
  let scene: Scene;
  let plugin: HavokPlugin;
  let collision: MapCollision;

  beforeAll(async () => {
    scene = new Scene(new NullEngine());
    plugin = new HavokPlugin(false, await loadHavok());
    scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);
    const field = new Heightfield(64, 65);
    collision = buildMapCollision(scene, { terrain: { field } as unknown as Terrain, layout: layoutOf() });
  }, 30_000);

  const result = new PhysicsRaycastResult();
  /** True when a bullet fired across the pane at `x` would stop in it (the server's own world-only ray). */
  const stopsBullets = (x: number): boolean => {
    plugin.raycast(new Vector3(x, 1, -3), new Vector3(x, 1, 3), result, { collideWith: WORLD_ONLY_MASK, shouldHitTriggers: false });
    return result.hasHit;
  };

  it("splits the panes into a collider group per phase group", () => {
    // One shape per group, not one per pane and not one for all of them: a group switches without touching the others.
    const groups = new Set(PANES.map((x) => glassPhaseBucket(x, 0)));
    expect(groups.size).toBeGreaterThan(1);
    expect(collision.stats.propShapes).toBe(groups.size);
    expect(collision.stats.propBodies).toBe(PANES.length);
  });

  it("starts shoot-through, the resting mode of a world nobody has told the time to", () => {
    for (const x of PANES) expect(stopsBullets(x), `pane at ${x}`).toBe(false);
  });

  it("answers the shared schedule for every pane at every tick", () => {
    // Two full cycles at 4 Hz, which crosses every flip.
    for (let step = 0; step <= GLASS_PHASE.holdSeconds * 8; step++) {
      const seconds = step / 4;
      collision.setPhaseTime(seconds);
      for (const x of PANES) {
        const bucket = glassPhaseBucket(x, 0);
        expect(stopsBullets(x), `pane at ${x} (group ${bucket}) at ${seconds} s`).toBe(glassBlocksAt(bucket, seconds));
      }
    }
  });

  it("never has every pane in the same mode, so a flip is never a map-wide event", () => {
    for (let step = 0; step <= GLASS_PHASE.holdSeconds * 8; step++) {
      const seconds = step / 4;
      collision.setPhaseTime(seconds);
      const blocking = PANES.filter((x) => stopsBullets(x)).length;
      expect(blocking, `t = ${seconds}`).toBeGreaterThan(0);
      expect(blocking, `t = ${seconds}`).toBeLessThan(PANES.length);
    }
  });

  it("lands on the same state whether the clock was stepped or jumped to", () => {
    // A server stepping ticks and a client that just joined and skipped to the same time must see the same walls.
    const at = 47.5;
    collision.setPhaseTime(at);
    const jumped = PANES.map((x) => stopsBullets(x));
    for (let step = 0; step <= at * 60; step++) collision.setPhaseTime(step / 60);
    collision.setPhaseTime(at);
    expect(PANES.map((x) => stopsBullets(x))).toEqual(jumped);
    expect(jumped).toEqual(PANES.map((x) => glassBlocksAt(glassPhaseBucket(x, 0), at)));
  });
});
