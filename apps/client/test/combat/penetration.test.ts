import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { PHASE_GLASS_PROP, glassBlocksAt, glassPhaseBucket } from "@twobullets/shared";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { beforeAll, describe, expect, it } from "vitest";
import { PenetrationProbe, paneFromCollider, type PenetrationHit } from "../../src/combat/penetration";
import { PropColliders } from "../../src/world/props/PropColliders";

// A shoot-through pane is on the blocker layer, which the bullet ray deliberately ignores: the round crosses it with no
// hit and no impact event. PenetrationProbe walks the same segment against that layer alone so the client can mark
// where the bullet went through. Nothing here changes what the bullet did.

const instance = (x: number, z: number) => [x, 0, z, 0, 1, 0, 0];

interface Crossing {
  readonly prop: string;
  readonly point: [number, number, number];
  readonly normal: [number, number, number];
}

function collect(probe: PenetrationProbe, from: Vector3, to: Vector3): Crossing[] {
  const out: Crossing[] = [];
  const sink = (hit: PenetrationHit) => {
    out.push({ prop: hit.prop, point: [hit.point.x, hit.point.y, hit.point.z], normal: [hit.normal.x, hit.normal.y, hit.normal.z] });
  };
  probe.scan(from, to, sink);
  return out;
}

describe("paneFromCollider", () => {
  it("reads the pane props out of a collider group's mesh name", () => {
    expect(paneFromCollider("propCollider_wall_mirror_1")).toEqual({ prop: "wall_mirror", halfDepth: 0.15, face: 0.13 });
    // Panes that switch mode carry their phase group in the name: one collider group each, so they don't flip together.
    expect(paneFromCollider("propCollider_wall_glass_1_p2")).toEqual({ prop: "wall_glass", halfDepth: 0.15, face: 0.02 });
    expect(paneFromCollider("propCollider_wall_glass_1")).toEqual({ prop: "wall_glass", halfDepth: 0.15, face: 0.02 });
    // Scaled instances get their own group, and the geometry scales with them.
    expect(paneFromCollider("propCollider_wall_mirror_2")).toEqual({ prop: "wall_mirror", halfDepth: 0.3, face: 0.26 });
  });

  it("ignores everything that is not a pane", () => {
    // Shoot-through, but a chainlink fence is not a pane and a hole in one would be nonsense.
    expect(paneFromCollider("propCollider_fence_chainlink_1")).toBeNull();
    expect(paneFromCollider("propCollider_wall_concrete_1")).toBeNull();
    expect(paneFromCollider("propCollider_not_a_prop_1")).toBeNull();
    expect(paneFromCollider("terrain")).toBeNull();
    expect(paneFromCollider("")).toBeNull();
  });
});

describe("PenetrationProbe", () => {
  let scene: Scene;
  let probe: PenetrationProbe;
  let colliders: PropColliders;

  beforeAll(async () => {
    scene = new Scene(new NullEngine());
    scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(false, await loadHavok()));
    // A mirror pane at z = 0, a second one at z = 8, a concrete wall at z = 16, and a glazed pane at z = 24.
    // All face +Z (yaw 0).
    colliders = new PropColliders(scene, {
      props: [
        { prop: "wall_mirror", data: new Float32Array([...instance(0, 0), ...instance(0, 8)]) },
        { prop: "wall_concrete", data: new Float32Array(instance(0, 16)) },
        { prop: PHASE_GLASS_PROP, data: new Float32Array(instance(0, 24)) },
      ],
    });
    probe = new PenetrationProbe(scene);
  }, 30_000);

  it("marks both faces of a pane a bullet went through", () => {
    const crossings = collect(probe, new Vector3(0, 1, -5), new Vector3(0, 1, 4));
    expect(crossings).toHaveLength(2);
    // On the silvered faces (±0.13), not on the 0.3 m collider box (±0.15): a hole floating a finger off the glass reads wrong.
    expect(crossings[0]!.prop).toBe("wall_mirror");
    expect(crossings[0]!.point[2]).toBeCloseTo(-0.13, 5);
    expect(crossings[0]!.normal).toEqual([0, 0, -1]);
    expect(crossings[1]!.point[2]).toBeCloseTo(0.13, 5);
    expect(crossings[1]!.normal).toEqual([-0, -0, 1]);
  });

  it("marks every pane along the segment", () => {
    const crossings = collect(probe, new Vector3(0, 1, -5), new Vector3(0, 1, 12));
    expect(crossings.map((c) => Math.round(c.point[2] * 100) / 100)).toEqual([-0.13, 0.13, 7.87, 8.13]);
  });

  it("never marks a pane the bullet stopped short of", () => {
    // The segment is the flight this tick and ends where the round ended, so nothing past it is touched.
    expect(collect(probe, new Vector3(0, 1, -5), new Vector3(0, 1, -1))).toEqual([]);
    expect(collect(probe, new Vector3(0, 1, 1), new Vector3(0, 1, 7))).toEqual([]);
  });

  it("ignores walls that stop bullets, which the bullet ray already reported", () => {
    expect(collect(probe, new Vector3(0, 1, 9), new Vector3(0, 1, 20))).toEqual([]);
  });

  it("marks only the entry face of a graze", () => {
    // Nearly along the pane: the round leaves through an edge, not the far face, so guessing an exit would be a lie.
    const crossings = collect(probe, new Vector3(-3, 1, -0.6), new Vector3(3, 1, 0.6));
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.prop).toBe("wall_mirror");
  });

  it("does nothing on a degenerate segment", () => {
    expect(collect(probe, new Vector3(0, 1, 0), new Vector3(0, 1, 0))).toEqual([]);
  });

  // A glazed pane looks the same whether it is stopping bullets or letting them through, so the only way to learn which
  // it is, is to have a round stop in it. That is what the presentation flashes amber on, and what the owner's voice
  // line fires on; both hang off this.
  describe("a round stopped in a pane", () => {
    const glassBucket = glassPhaseBucket(0, 24);
    const armoured = (): number => {
      for (let step = 0; step < 400; step++) if (glassBlocksAt(glassBucket, step / 4)) return step / 4;
      throw new Error("the pane never armours");
    };
    const open = (): number => {
      for (let step = 0; step < 400; step++) if (!glassBlocksAt(glassBucket, step / 4)) return step / 4;
      throw new Error("the pane never opens");
    };
    const at = (z: number) => probe.paneAtImpact({ x: 0, y: 1, z }, { x: 0, y: 0, z: -1 });

    it("names the pane the round stopped in, which proves it was armoured", () => {
      colliders.setPhaseTime(armoured());
      expect(at(24 - 0.15)?.prop).toBe(PHASE_GLASS_PROP);
    });

    it("says nothing while the pane is letting rounds through", () => {
      // Then no round ever stops there in the first place, and the probe cannot see it either.
      colliders.setPhaseTime(open());
      expect(at(24 - 0.15)).toBeNull();
    });

    it("says nothing for the walls that always stop bullets", () => {
      colliders.setPhaseTime(armoured());
      expect(at(16 - 0.15), "concrete").toBeNull();
      expect(at(-3), "open air").toBeNull();
    });
  });
});
