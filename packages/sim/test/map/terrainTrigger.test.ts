import "@babylonjs/core/Physics/joinedPhysicsEngineComponent.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
import { PhysicsShapeCapsule } from "@babylonjs/core/Physics/v2/physicsShape.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Heightfield } from "@twobullets/shared/map/terrain/heightfield";
import { describe, expect, it } from "vitest";
import { CollisionLayer, WORLD_ONLY_MASK } from "../../src/collisionLayers";
import { createTerrainBody } from "../../src/map/terrainBody";
import { loadHavok } from "../../src/node/loadHavok";

// Regression: practice with bots froze on real-world maps when combat started. Bots' hitbox triggers (ANIMATED bodies)
// dipped into the terrain heightfield at their spawns, and Havok's step never returned (browser: "memory access out of
// bounds"). The terrain now doesn't collide with the hitbox layer. A regression hangs this test rather than failing it.
describe("terrain heightfield and hitbox triggers", () => {
  it("steps with a hitbox trigger buried in the terrain, and rays still hit both", async () => {
    const scene = new Scene(new NullEngine());
    const plugin = new HavokPlugin(false, await loadHavok());
    scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);
    const field = new Heightfield(64, 65);
    for (let i = 0; i < field.heights.length; i++) field.heights[i] = 20 + 0.3 * Math.sin(i * 0.37);
    const terrain = createTerrainBody(scene, field);
    expect(terrain.shape.filterCollideMask & CollisionLayer.hitbox).toBe(0);

    const node = new TransformNode("hitbox", scene);
    node.rotationQuaternion = Quaternion.Identity();
    node.position.set(0.3, 50, 0.7);
    const shape = new PhysicsShapeCapsule(new Vector3(0, -0.2, 0), new Vector3(0, 0.2, 0), 0.12, scene);
    shape.isTrigger = true;
    shape.filterMembershipMask = CollisionLayer.hitbox;
    const body = new PhysicsBody(node, PhysicsMotionType.ANIMATED, false, scene);
    body.shape = shape;
    body.disablePreStep = false;
    body.disableSync = true;
    const physics = scene.getPhysicsEngine()!;
    for (let t = 0; t < 10; t++) physics._step(1 / 60);
    node.position.set(0.3, 20, 0.7);
    for (let t = 0; t < 30; t++) physics._step(1 / 60);

    const result = new PhysicsRaycastResult();
    plugin.raycast(new Vector3(-3, 20.1, 0.7), new Vector3(3, 20.1, 0.7), result, { collideWith: CollisionLayer.hitbox, shouldHitTriggers: true });
    expect(result.body).toBe(body);
    plugin.raycast(new Vector3(20, 60, 20), new Vector3(20, -10, 20), result, { collideWith: WORLD_ONLY_MASK });
    expect(result.body).toBe(terrain.body);
    scene.dispose();
  });
});
