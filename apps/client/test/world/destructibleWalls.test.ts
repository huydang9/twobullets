import { NullEngine, PhysicsRaycastResult, Scene, Vector3 } from "@babylonjs/core";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { INSTANCE_STRIDE, buildDestructibleWalls, type MapLayout, type PropInstanceSet } from "@twobullets/shared";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CollisionLayer } from "../../src/combat/hitboxes";
import { MirrorWalls, MIRROR_PROP } from "../../src/world/props/MirrorWalls";
import { PropColliders } from "../../src/world/props/PropColliders";

// The client half of the destructible walls: taking one pane out of the prop colliders, and
// the mirror's own visuals (the pane goes, the apertures close). What is destroyed is the match's call
// (packages/sim/test/match/destructibleWalls.test.ts); this only has to follow it.

/** Four mirrored panes on a wall along world X, 6 m apart, so each one is its own gap. */
const PANES = [-9, -3, 3, 9];

function sets(): PropInstanceSet[] {
  const data = new Float32Array(PANES.length * INSTANCE_STRIDE);
  PANES.forEach((x, i) => data.set([x, 0, 0, 0, 1, 0, 0], i * INSTANCE_STRIDE));
  return [{ prop: MIRROR_PROP, data }];
}

const layout = { props: sets() } as unknown as Pick<MapLayout, "props">;

describe("taking one pane out of the collider world", () => {
  let scene: Scene;
  let plugin: HavokPlugin;
  let colliders: PropColliders;

  beforeAll(async () => {
    scene = new Scene(new NullEngine());
    plugin = new HavokPlugin(false, await loadHavok());
    scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);
    colliders = new PropColliders(scene, layout);
  }, 30_000);

  const result = new PhysicsRaycastResult();
  /** A mirror is a movement blocker, not bullet-solid, so the probe is a movement-style ray. */
  const blocks = (x: number): boolean => {
    plugin.raycast(new Vector3(x, 1, -2), new Vector3(x, 1, 2), result, { collideWith: CollisionLayer.blocker, shouldHitTriggers: false });
    return result.hasHit;
  };

  it("drops the one instance and leaves every other pane standing", () => {
    expect(PANES.map(blocks)).toEqual([true, true, true, true]);
    expect(colliders.stats().bodies).toBe(4);

    // Instance 1 is at x = -3: its own static body goes, and Havok stops reporting it the same instant.
    expect(colliders.removeInstance(MIRROR_PROP, 1)).toBe(true);
    expect(PANES.map(blocks)).toEqual([true, false, true, true]);
    expect(colliders.stats().bodies).toBe(3);

    // Every other pane is exactly where it was: nothing was moved to fill the gap.
    expect(colliders.removeInstance(MIRROR_PROP, 3)).toBe(true);
    expect(PANES.map(blocks)).toEqual([true, false, true, false]);
    expect(colliders.removeInstance(MIRROR_PROP, 1)).toBe(false);
    expect(colliders.stats().bodies).toBe(2);

    // The shape is shared, so removing instances must never take one away.
    expect(colliders.stats().shapes).toBe(1);
  });
});

/**
 * Hole masks are DynamicTextures, which Babylon builds on an OffscreenCanvas that Node does not have. The same
 * stand-in `mirrorWall.test.ts` uses, recording the circles cut into it — which is what a heal changes.
 */
class FakeContext {
  readonly arcs: { x: number; y: number; r: number }[] = [];
  readonly fills: string[] = [];
  globalCompositeOperation = "source-over";
  fillStyle: unknown = "";
  private pending: { x: number; y: number; r: number } | null = null;
  fillRect(): void {
    this.fills.push(String(this.fillStyle));
  }
  createRadialGradient(): { addColorStop(): void } {
    return { addColorStop: () => {} };
  }
  beginPath(): void {}
  arc(x: number, y: number, r: number): void {
    this.pending = { x, y, r };
  }
  fill(): void {
    if (this.pending) this.arcs.push(this.pending);
    this.pending = null;
  }
}

const contexts: FakeContext[] = [];

class FakeCanvas {
  private readonly context = new FakeContext();
  constructor(
    public width: number,
    public height: number,
  ) {
    contexts.push(this.context);
  }
  getContext(): FakeContext {
    return this.context;
  }
}

describe("mirror panes follow the match's walls", () => {
  const original = (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;
  beforeAll(() => {
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = FakeCanvas;
  });
  afterAll(() => {
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = original;
    contexts.length = 0;
  });

  it("a destroyed pane goes, a healed one closes up, and a destroyed one takes no more holes", async () => {
    const scene = new Scene(new NullEngine());
    scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(false, await loadHavok()));
    const mirrors = new MirrorWalls(scene, sets());
    const walls = buildDestructibleWalls(layout);
    mirrors.bindWalls(walls, layout);
    expect(mirrors.count).toBe(4);

    // A round through pane 1 counts an aperture in the match's state as well as cutting the mask.
    expect(mirrors.punch(new Vector3(-3.5, 1.2, 0))).toBe(true);
    expect(walls.holes[1]).toBe(1);
    expect(mirrors.stats().holed).toBe(1);

    // Smoke closing it: the mask is redrawn with the aperture shrinking, then solid.
    const ctx = contexts[contexts.length - 1]!;
    const cut = ctx.arcs[0]!.r;
    mirrors.setHeal(1, 0.5);
    expect(ctx.arcs[1]!.r).toBeLessThan(cut);
    expect(ctx.arcs[1]!.r).toBeGreaterThan(0);
    // The same progress again redraws nothing: a heal costs a handful of small repaints in all.
    const drawn = ctx.arcs.length;
    mirrors.setHeal(1, 0.5);
    expect(ctx.arcs.length).toBe(drawn);
    mirrors.healed(1);
    expect(ctx.arcs.length).toBe(drawn);
    expect(mirrors.stats().holed).toBe(1); // the texture stays; the glass is solid again
    expect(mirrors.punch(new Vector3(-3.5, 1.2, 0))).toBe(true);

    // A frag takes it: the mesh is off, it is out of the live-slot running, and nothing can hole it again.
    mirrors.destroy(1);
    expect(mirrors.stats().gone).toBe(1);
    expect(scene.meshes.filter((m) => m.name.startsWith("mirror_") && m.isEnabled()).length).toBe(3);
    expect(mirrors.punch(new Vector3(-3.5, 1.2, 0))).toBe(false);
    // A pane it never heard of is not an error.
    mirrors.destroy(99);
    mirrors.healed(99);
    mirrors.dispose();
  }, 30_000);
});
