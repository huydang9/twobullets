import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { PhysicsShape, PhysicsShapeBox } from "@babylonjs/core/Physics/v2/physicsShape.js";
import type { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { LevelBlock } from "@twobullets/shared/level/types";

// Collision shape factory shared by the client's rendered level and the server's collision-only level (R13), so both
// sides build bit-identical Havok shapes. No Mesh or VertexData: convex hulls go straight to Havok.

/** Surface response of level blocks and buildings. */
export const LEVEL_MATERIAL = { friction: 0.6, restitution: 0 } as const;

type V3 = readonly [number, number, number];

/** Havok plugin of a scene with v2 physics enabled. */
export function havokPluginOf(scene: Scene): HavokPlugin {
  const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
  if (!plugin || !("shapeCast" in plugin) || plugin.getPluginVersion() !== 2) throw new Error("requires the Havok physics plugin (v2)");
  return plugin as HavokPlugin;
}

/** Convex hull from local-space points, fed to Havok in the order given. */
export function createConvexHullShape(scene: Scene, points: readonly V3[]): PhysicsShape {
  const plugin = havokPluginOf(scene) as unknown as { _hknp: HavokNative; _shapes: Map<unknown, PhysicsShape> };
  const hknp = plugin._hknp;
  const offset = hknp._malloc(points.length * 12);
  const buffer = new Float32Array(hknp.HEAPU8.buffer, offset, points.length * 3);
  points.forEach((p, i) => buffer.set(p, i * 3));
  const pluginData = hknp.HP_Shape_CreateConvexHull(offset, points.length)[1];
  hknp._free(offset);
  const shape = new PhysicsShape({ pluginData }, scene);
  // What PhysicsShape's own initShape does, so shape ids in query results resolve to this shape.
  plugin._shapes.set(pluginData[0], shape);
  return shape;
}

/**
 * The block's shape in its local space (centered on `block.position`, before `rotationY`): a box, or for ramps the
 * wedge hull. Matches what PhysicsAggregate derived from the rendered block mesh (same extents, same hull points).
 */
export function createBlockShape(scene: Scene, block: LevelBlock): PhysicsShape {
  const [hx, hy, hz] = [block.size[0] / 2, block.size[1] / 2, block.size[2] / 2];
  const shape =
    block.kind === "ramp"
      ? createConvexHullShape(scene, wedgeHullPoints(hx, hy, hz))
      : new PhysicsShapeBox(Vector3.Zero(), Quaternion.Identity(), new Vector3(hx * 2, hy * 2, hz * 2), scene);
  shape.material = LEVEL_MATERIAL;
  return shape;
}

/**
 * Wedge rising along +Z: the corners of the rendered faces in buildLevel's face order (slope, bottom, back, +X, -X),
 * duplicates included, so the hull is built from exactly the vertex stream the mesh used to provide.
 */
export function wedgeHullPoints(hx: number, hy: number, hz: number): V3[] {
  return [
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, hz], [-hx, hy, hz],
    [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz],
    [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    [hx, -hy, -hz], [hx, -hy, hz], [hx, hy, hz],
    [-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz],
  ];
}

/** The emscripten Havok API surface used here (untyped in @babylonjs/havok's plugin typings). */
interface HavokNative {
  readonly HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(offset: number): void;
  HP_Shape_CreateConvexHull(offset: number, count: number): [unknown, [bigint]];
}
