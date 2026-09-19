import { NullEngine, PhysicsRaycastResult, Scene, Vector3 } from "@babylonjs/core";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { GLASS_PHASE, INSTANCE_STRIDE, PHASE_GLASS_PROPS, SIMULATION, glassBlocksAt, glassPhaseBucket, type MapLayout, type PropInstanceSet } from "@twobullets/shared";
import { WORLD_ONLY_MASK, buildMapCollision, type MapCollision } from "@twobullets/sim";
import { Heightfield } from "@twobullets/shared/map/terrain/heightfield";
import type { Terrain } from "@twobullets/shared/map/terrain/terrain";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import { NetMatchView } from "../../src/net/NetMatchView";
import { PropColliders } from "../../src/world/props/PropColliders";

// Client and server must agree about the glazed panes, tick for tick, with nothing sent over the wire.
//
// Each side already answers the shared schedule at a given *second*: packages/sim/test/map/glassPhase.test.ts and
// apps/client/test/world/phaseGlassColliders.test.ts prove that separately. What they can't prove on their own is that
// both sides reach the same second from the same match tick — the client's physics world is turned by
// `PropColliders.setPhaseTick`, the server's by `MapCollision.setPhaseTick`, and they are different files in different
// packages. If those two drift apart, a round goes through a pane that stopped somebody else's and neither log says
// why. So this builds both worlds over the same panes, drives them from the *tick* through each side's own production
// entry point, and fires a real bullet at every pane in each.

/** A pane on a constant-X lattice line runs along Z (yaw -π/2); one on a constant-Z line runs along X (yaw 0). */
const ALONG_Z = -Math.PI / 2;
/** Panes on their own wall lines, in both pane lengths, so several phase groups are represented. */
const PANES = [-32, -24, -16, -8, 0, 8, 16, 24, 32, 40];

function panes(): PropInstanceSet[] {
  return PHASE_GLASS_PROPS.map((prop, p) => {
    const data = new Float32Array(PANES.length * INSTANCE_STRIDE);
    // The second prop's panes sit on the same lines but a lane over in Z, which changes nothing about their group:
    // the group comes from the line the wall stands on, so both lengths of one wall stay in step.
    PANES.forEach((x, i) => data.set([x, 0, p * 40, ALONG_Z, 1, 0, 0], i * INSTANCE_STRIDE));
    return { prop, data };
  });
}

/** Panes and the phase group each one is in, in the order they are fired at. */
const TARGETS = PHASE_GLASS_PROPS.flatMap((_, p) => PANES.map((x) => ({ x, z: p * 40, bucket: glassPhaseBucket(x, p * 40, ALONG_Z) })));

describe("glass phase: client and server agree tick for tick", () => {
  let client: PropColliders;
  let clientPlugin: HavokPlugin;
  let server: MapCollision;
  let serverPlugin: HavokPlugin;

  beforeAll(async () => {
    const havok = await loadHavok();
    const clientScene = new Scene(new NullEngine());
    clientPlugin = new HavokPlugin(false, havok);
    clientScene.enablePhysics(new Vector3(0, -9.81, 0), clientPlugin);
    client = new PropColliders(clientScene, { props: panes() } as unknown as Pick<MapLayout, "props">);

    const serverScene = new Scene(new NullEngine());
    serverPlugin = new HavokPlugin(false, havok);
    serverScene.enablePhysics(new Vector3(0, -9.81, 0), serverPlugin);
    server = buildMapCollision(serverScene, {
      terrain: { field: new Heightfield(64, 65) } as unknown as Terrain,
      layout: { props: panes(), buildings: [] } as unknown as MapLayout,
    });
  }, 60_000);

  const result = new PhysicsRaycastResult();
  /** True when a bullet fired across the pane at (x, z) stops in it, in that side's own physics world. */
  const stops = (plugin: HavokPlugin, x: number, z: number): boolean => {
    plugin.raycast(new Vector3(x, 1, z - 3), new Vector3(x, 1, z + 3), result, { collideWith: WORLD_ONLY_MASK, shouldHitTriggers: false });
    return result.hasHit;
  };

  it("both worlds stand in the same mode at the same match tick", () => {
    // Guards the assertions below against passing on a world where nothing ever blocks: several groups, both modes.
    expect(new Set(TARGETS.map((t) => t.bucket)).size).toBeGreaterThan(1);
    expect(client.stats().bodies).toBe(TARGETS.length);
    expect(server.stats.propBodies).toBe(TARGETS.length);

    // Two and a bit full cycles, every fourth tick, which crosses every group's flip several times.
    const ticks = GLASS_PHASE.holdSeconds * 2 * SIMULATION.tickRate * 2.5;
    let blocked = 0;
    let open = 0;
    for (let tick = 0; tick <= ticks; tick += 4) {
      client.setPhaseTick(tick);
      server.setPhaseTick(tick);
      const expected = TARGETS.map((t) => glassBlocksAt(t.bucket, tick / SIMULATION.tickRate));
      expect(TARGETS.map((t) => stops(clientPlugin, t.x, t.z)), `client at tick ${tick}`).toEqual(expected);
      expect(TARGETS.map((t) => stops(serverPlugin, t.x, t.z)), `server at tick ${tick}`).toEqual(expected);
      for (const armoured of expected) if (armoured) blocked++;
      else open++;
    }
    // Both modes were really exercised, and the map was never all one or the other.
    expect(blocked / (blocked + open)).toBeCloseTo(0.5, 1);
  });

  it("a tick reached by stepping and a tick jumped to land in the same mode, so a late joiner agrees too", () => {
    const at = 2857; // mid-hold for some groups, a few ticks off a flip for others
    client.setPhaseTick(at);
    server.setPhaseTick(at);
    const jumped = TARGETS.map((t) => stops(clientPlugin, t.x, t.z));
    for (let tick = 0; tick <= at; tick++) server.setPhaseTick(tick);
    expect(TARGETS.map((t) => stops(serverPlugin, t.x, t.z))).toEqual(jumped);
    expect(jumped).toEqual(TARGETS.map((t) => glassBlocksAt(t.bucket, at / SIMULATION.tickRate)));
  });

  it("the networked client's clock is the server's own tick number", () => {
    // NetMatch drives MapRuntime's phase clock from this, and the server resolves bullets at the tick it passes to
    // ServerProjectiles.step. Both are the same number, so both sides land on the same second above.
    const view = new NetMatchView({ mapId: "mazebr" });
    expect(view.phaseTick).toBeNull(); // nothing to derive from before the first time sync
    view.update(4321, null, null);
    expect(view.phaseTick).toBe(4321);
    view.update(-1, null, null); // a frame with no estimate keeps the last tick rather than restarting the clock
    expect(view.phaseTick).toBe(4321);
  });
});
