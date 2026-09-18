import { NullEngine, PBRMaterial, Scene, type Mesh } from "@babylonjs/core";
import { createMoveState, createWeaponState, OPEN_MOVE_GATES, quantizePitch, quantizeYaw, type MapLayout } from "@twobullets/shared";
import { ARENA_LEVEL } from "@twobullets/shared/level/arena";
import { createSimWorld, WorldRaycaster, stepPlayer, type SimWorld } from "@twobullets/sim/index";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BULLET_COLLIDE_MASK } from "../../src/combat/hitboxes";
import { PropColliders } from "../../src/world/props/PropColliders";
import { PropVisuals } from "../../src/world/props/PropVisuals";

// The wall_glass stand-in: an opaque metal frame plus a transparent pane, both thin-instanced, sharing one glass
// material across every level and batch. Bullets and sight pass the collider (packages/shared), so the pane only has
// to read as glass and never cost a per-instance material.

let engine: NullEngine | undefined;
afterEach(() => {
  engine?.dispose();
  engine = undefined;
});

async function visuals(props: readonly string[]) {
  engine = new NullEngine();
  const scene = new Scene(engine);
  // `false` skips the environment asset library: wall_glass has no GLB, it is always a stand-in.
  return { scene, propVisuals: await PropVisuals.load(scene, props, false) };
}

const glassOf = (meshes: readonly Mesh[]) => meshes.filter((m) => m.material instanceof PBRMaterial && m.material.name === "mat_prop_glass");

describe("wall_glass stand-in", () => {
  it("draws a solid frame and a separate glazed mesh per level", async () => {
    const { propVisuals } = await visuals(["wall_glass", "wall_concrete"]);
    const glass = propVisuals.get("wall_glass");
    const concrete = propVisuals.get("wall_concrete");
    expect(glass.asset).toBe(false);
    // Shadow maps render depth only, so a glazed panel would cast a solid slab.
    expect(glass.castShadow).toBe(false);
    expect(concrete.castShadow).toBe(true);

    expect(glass.levels).toHaveLength(2);
    for (const [index, level] of glass.levels.entries()) {
      const meshes = level.create(`glass_lod${index}`);
      expect(meshes).toHaveLength(2);
      expect((meshes[0]!.material as PBRMaterial).name).toBe("mat_prop_standin");
      expect((meshes[1]!.material as PBRMaterial).name).toBe("mat_prop_glass");
    }
    expect(concrete.levels[0]!.create("concrete_lod0")).toHaveLength(1);
  });

  it("keeps the panel inside the wall_concrete collider so the two swap in a lattice", async () => {
    const { propVisuals } = await visuals(["wall_glass", "wall_concrete"]);
    const bounds = (prop: string) =>
      propVisuals
        .get(prop)
        .levels[0]!.create(`${prop}_bounds`)
        .reduce(
          (box, mesh) => {
            const { minimum, maximum } = mesh.getBoundingInfo();
            return { min: [Math.min(box.min[0], minimum.x), Math.min(box.min[1], minimum.y), Math.min(box.min[2], minimum.z)], max: [Math.max(box.max[0], maximum.x), Math.max(box.max[1], maximum.y), Math.max(box.max[2], maximum.z)] };
          },
          { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
        );
    const glass = bounds("wall_glass");
    const concrete = bounds("wall_concrete");
    // 4 m long, sunk 0.4 m, capped just above the 2.6 m collider, no deeper than the concrete wall.
    expect(glass.min[0]).toBeCloseTo(-2, 6);
    expect(glass.max[0]).toBeCloseTo(2, 6);
    expect(glass.min[1]).toBeCloseTo(-0.4, 6);
    expect(glass.max[1]).toBeCloseTo(concrete.max[1], 6);
    expect(Math.max(-glass.min[2], glass.max[2])).toBeLessThanOrEqual(Math.max(-concrete.min[2], concrete.max[2]) + 1e-6);
  });

  it("shares one alpha-blended glass material across levels and batches, and disposes it", async () => {
    const { propVisuals } = await visuals(["wall_glass"]);
    const levels = propVisuals.get("wall_glass").levels;
    const materials = new Set([...levels.flatMap((l, i) => glassOf(l.create(`a${i}`))), ...glassOf(levels[0]!.create("b"))].map((m) => m.material));
    expect(materials.size).toBe(1);

    const material = [...materials][0] as PBRMaterial;
    expect(material.alpha).toBeLessThan(1);
    expect(material.transparencyMode).toBe(PBRMaterial.MATERIAL_ALPHABLEND);
    expect(material.needAlphaBlending()).toBe(true);
    // No depth write and back faces culled: a pane box blends once from either side and panes behind it still show.
    expect(material.disableDepthWrite).toBe(true);
    expect(material.backFaceCulling).toBe(true);
    // Visible tint and a sharp sky highlight, so it never reads as an invisible wall.
    expect(material.albedoColor.r + material.albedoColor.g + material.albedoColor.b).toBeGreaterThan(0);
    expect(material.roughness).toBeLessThan(0.2);

    propVisuals.dispose();
    expect(material.getScene().materials).not.toContain(material);
  });

  it("creates the glass material only for glazed props", async () => {
    const { scene, propVisuals } = await visuals(["wall_concrete"]);
    propVisuals.get("wall_concrete").levels[0]!.create("concrete");
    expect(scene.materials.some((m) => m.name === "mat_prop_glass")).toBe(false);
  });
});

// The flag the whole prop rests on: `bulletproof: false` -> propColliderGroups -> PhysicsShapeBox on
// CollisionLayer.blocker. Bullet rays (BULLET_COLLIDE_MASK) and world/bot-vision rays (WORLD_ONLY_MASK) both drop that
// bit, so they pass; the character capsule's MOVEMENT_COLLIDE_MASK keeps it, so the player is stopped.
describe("wall_glass collision", () => {
  let world: SimWorld;
  let colliders: PropColliders;
  /** Wall centre: on the arena floor beside a spawn, with its 4 m length along X, so it blocks travel along +Z. */
  let wall: { x: number; y: number; z: number };

  beforeAll(async () => {
    world = await createSimWorld(await loadHavok(), ARENA_LEVEL);
    const [x, , z] = ARENA_LEVEL.spawnPoints[0]!.position;
    const ground = world.raycastWorld({ x, y: 20, z: z + 2 }, { x, y: -20, z: z + 2 })!;
    wall = { x, y: ground.point.y, z: z + 2 };
    // Nothing else stands here: every assertion below is about the props we add.
    expect(world.raycastWorld({ x, y: wall.y + 1.4, z: wall.z - 2 }, { x, y: wall.y + 1.4, z: wall.z + 2 })).toBeNull();
    const instance = (dx: number) => [wall.x + dx, wall.y - 0.4, wall.z, 0, 1, 0, 0];
    const layout = {
      props: [
        { prop: "wall_glass", data: new Float32Array(instance(0)) },
        { prop: "wall_concrete", data: new Float32Array(instance(20)) },
      ],
    } as Pick<MapLayout, "props">;
    colliders = new PropColliders(world.scene, layout);
  }, 60_000);

  afterAll(() => {
    colliders?.dispose();
    world?.dispose();
  });

  /** Chest-height segment crossing a wall 4 m away from `dx`, along +Z. */
  const across = (dx: number) => [
    { x: wall.x + dx, y: wall.y + 1.4, z: wall.z - 2 },
    { x: wall.x + dx, y: wall.y + 1.4, z: wall.z + 2 },
  ] as const;

  it("lets bullets and sight through the glass but not through the concrete", () => {
    const bullets = new WorldRaycaster(world.scene, { collideWith: BULLET_COLLIDE_MASK });
    expect(bullets.cast(...across(0))).toBeNull();
    expect(bullets.cast(...across(20))).not.toBeNull();
    // Bots perceive with the world-only raycast, which also drops the blocker bit: glass is see-through for them too.
    expect(world.raycastWorld(...across(0))).toBeNull();
    expect(world.raycastWorld(...across(20))).not.toBeNull();
  });

  it("stops a player walking into it, like the concrete wall", () => {
    // Facing +Z (yaw 0), walking into the wall for 2 s.
    const walk = (dx: number) => {
      const body = world.createBody({ x: wall.x + dx, y: wall.y, z: wall.z - 2 });
      let state = { move: createMoveState(), weapon: createWeaponState([null, null, null]) };
      const input = { tick: 0, forward: 1 as const, right: 0 as const, buttons: 0, select: 0, yawQ: quantizeYaw(0), pitchQ: quantizePitch(0), viewOffset8: 0, action: null };
      for (let i = 0; i < 120; i++) state = stepPlayer(body, state, { ...input, tick: i }, 1 / 60, { replay: false, gates: OPEN_MOVE_GATES }).state;
      const z = body.feet.z;
      body.dispose();
      return z;
    };
    // Off to the side there is no wall, so the same walk crosses the line.
    expect(walk(10)).toBeGreaterThan(wall.z);
    for (const dx of [0, 20]) {
      const z = walk(dx);
      expect(z).toBeLessThan(wall.z - 0.3);
      expect(z).toBeGreaterThan(wall.z - 1.5);
    }
  });
});
