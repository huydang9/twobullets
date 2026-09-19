import { NullEngine, PhysicsRaycastResult, Scene, Vector3 } from "@babylonjs/core";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { GLASS_PHASE, INSTANCE_STRIDE, PHASE_GLASS_PROP, glassBlocksAt, glassPhaseBucket, type MapLayout, type PropInstanceSet } from "@twobullets/shared";
import { WORLD_ONLY_MASK } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import { PropColliders, colliderName } from "../../src/world/props/PropColliders";

// The client half of the phase-shifting pane. The headless server has its own (packages/sim/test/map/glassPhase.test.ts)
// and neither knows about the other: both derive every pane's mode from the shared schedule and the match clock, and
// this asserts the client's physics world lands where the schedule says at every tick. If these two ever disagree, a
// networked player shoots through a wall the server says is solid.

/** Each pane stands on its own constant-X lattice line, so it runs along Z and its yaw is -π/2. That is what puts
 * them in different phase groups (map/glassPhase.ts reads the group off the line the wall stands on). */
const PANE_YAW = -Math.PI / 2;
const PANES = [-32, -24, -16, -8, 0, 8, 16, 24, 32, 40];

function sets(): PropInstanceSet[] {
  const data = new Float32Array(PANES.length * INSTANCE_STRIDE);
  PANES.forEach((x, i) => data.set([x, 0, 0, PANE_YAW, 1, 0, 0], i * INSTANCE_STRIDE));
  return [{ prop: PHASE_GLASS_PROP, data }];
}

describe("phase glass colliders (client)", () => {
  let scene: Scene;
  let plugin: HavokPlugin;
  let colliders: PropColliders;

  beforeAll(async () => {
    scene = new Scene(new NullEngine());
    plugin = new HavokPlugin(false, await loadHavok());
    scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);
    colliders = new PropColliders(scene, { props: sets() } as unknown as Pick<MapLayout, "props">);
  }, 30_000);

  const result = new PhysicsRaycastResult();
  const stopsBullets = (x: number): boolean => {
    plugin.raycast(new Vector3(x, 1, -3), new Vector3(x, 1, 3), result, { collideWith: WORLD_ONLY_MASK, shouldHitTriggers: false });
    return result.hasHit;
  };

  it("gives each phase group its own shape and its own collider mesh", () => {
    const groups = new Set(PANES.map((x) => glassPhaseBucket(x, 0, PANE_YAW)));
    expect(colliders.stats().shapes).toBe(groups.size);
    expect(colliders.stats().bodies).toBe(PANES.length);
    for (const group of groups) expect(scene.meshes.some((m) => m.name === colliderName(PHASE_GLASS_PROP, 1, group))).toBe(true);
  });

  it("matches the shared schedule tick for tick, exactly as the headless server does", () => {
    for (let step = 0; step <= GLASS_PHASE.holdSeconds * 8; step++) {
      const seconds = step / 4;
      colliders.setPhaseTime(seconds);
      const expected = PANES.map((x) => glassBlocksAt(glassPhaseBucket(x, 0, PANE_YAW), seconds));
      expect(PANES.map((x) => stopsBullets(x)), `t = ${seconds}`).toEqual(expected);
      expect(colliders.stats().blockingPanes).toBe(new Set(PANES.filter((x) => glassBlocksAt(glassPhaseBucket(x, 0, PANE_YAW), seconds)).map((x) => glassPhaseBucket(x, 0, PANE_YAW))).size);
    }
  });

  it("gives every pane half its cycle armoured, and never lets a pane give that away", () => {
    // The pane has no tell: it looks the same in both modes and you find out by firing. So the property that has to
    // hold is the schedule itself — every pane spends half of every cycle stopping bullets, measured here through the
    // physics world rather than through the function that decides it.
    const steps = GLASS_PHASE.holdSeconds * 2 * 10;
    const blocking = new Map(PANES.map((x) => [x, 0]));
    for (let step = 0; step < steps; step++) {
      const seconds = step / 10;
      colliders.setPhaseTime(seconds);
      for (const x of PANES) if (stopsBullets(x)) blocking.set(x, blocking.get(x)! + 1);
    }
    for (const x of PANES) expect(blocking.get(x)! / steps, `pane at ${x}`).toBeCloseTo(0.5, 6);
  });
});
