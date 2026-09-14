import "@babylonjs/core/Physics/joinedPhysicsEngineComponent.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { Scene } from "@babylonjs/core/scene.js";
import type { HavokPhysicsWithBindings } from "@babylonjs/havok";
import { MOVEMENT } from "@twobullets/shared/constants";
import { OPEN_MOVE_GATES, deriveMoveModifiers, moveInputFrom, type MoveGates, type PlayerInput, type PlayerState } from "@twobullets/shared/input";
import type { LevelData } from "@twobullets/shared/level/types";
import type { Stance, Vec3 } from "@twobullets/shared/movement/types";
import type { FiredShot, RaycastFn, WeaponEvent } from "@twobullets/shared/weapons/types";
import { CharacterBody } from "./CharacterBody";
import { buildCollision } from "./level/collision";
import { WorldRaycaster } from "./WorldRaycaster";

// Babylon NullEngine + Havok simulation shared by client, server and bots (ADR 0005). Deep @babylonjs/core imports
// only, never the barrel. Interface contract from architecture.md §7.1.

export { CharacterBody, KEEP_DISTANCE } from "./CharacterBody";
export { CollisionLayer, WORLD_ONLY_MASK } from "./collisionLayers";
export { WorldRaycaster, type WorldRaycasterOptions } from "./WorldRaycaster";
export { attachBlockBody, buildCollision, type BlockBody, type CollisionLevel } from "./level/collision";
export { buildLevel, type BuiltLevel } from "./level/buildLevel";
export { LEVEL_MATERIAL, createBlockShape, createConvexHullShape, havokPluginOf, wedgeHullPoints } from "./level/shapes";
export { createTerrainBody, createTerrainShape, heightfieldToHavokOrder, type TerrainBody, type TerrainShapeOptions } from "./map/terrainBody";
export { buildBuilding, type BuildingVisualHandle, type BuildingVisualHost, type BuiltBuilding } from "./map/buildBuilding";
export { createBuildingBody, getBuildingShape, type BuildingBody } from "./map/buildingPhysics";
export { buildMapCollision, createMapSimWorld, type MapCollision, type MapCollisionInput, type MapCollisionStats, type MapSimWorld } from "./map/mapCollision";
export * from "./match/index";

/** The instantiated Havok WASM module (`await HavokPhysics()`). */
export type HavokModule = HavokPhysicsWithBindings;

/** Collision-only level input (R13). The arena's `LevelData` for M3; Map v1 terrain/buildings are added in M5 (T5.3). */
export type ServerLevel = LevelData;

/** Precreated collision shapes shared across matches in packed mode (ADR 0004). Opaque until T3.4 needs packing. */
export interface SharedShapes {
  readonly kind: "sharedShapes";
}

/** Non-weapon events from a player step; extended additively. */
export type MoveEvent =
  | { readonly type: "jumped" }
  | { readonly type: "landed"; readonly fallSpeed: number }
  | { readonly type: "stanceChanged"; readonly stance: Stance };

export type SimEvent = WeaponEvent | MoveEvent;

export interface SimWorld {
  /** Static world only; direct HP_* allowed (ADR 0302 §4). */
  readonly raycastWorld: RaycastFn;
  /** The headless scene (NullEngine + Havok), for server-side bodies such as hitboxes. */
  readonly scene: Scene;
  createBody(feet: Vec3): PlayerBody;
  dispose(): void;
}

/**
 * Headless world: NullEngine scene, Havok with a fixed 1/60 s world step, the level as static collision only. Several
 * worlds can share one Havok module (packed matches).
 */
export function createSimWorld(havok: HavokModule, level: ServerLevel, opts: { shared?: SharedShapes } = {}): Promise<SimWorld> {
  void opts;
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.enablePhysics(new Vector3(0, -MOVEMENT.gravity, 0), new HavokPlugin(false, havok));
  const collision = buildCollision(scene, level);
  const raycaster = new WorldRaycaster(scene);
  const bodies = new Set<CharacterBody>();
  const world: SimWorld = {
    raycastWorld: raycaster.cast,
    scene,
    createBody(feet) {
      const body = new CharacterBody(scene, feet);
      bodies.add(body);
      const dispose = body.dispose.bind(body);
      body.dispose = () => {
        bodies.delete(body);
        dispose();
      };
      return body;
    },
    dispose() {
      for (const body of [...bodies]) body.dispose();
      collision.dispose();
      scene.dispose();
      engine.dispose();
    },
  };
  return Promise.resolve(world);
}

export interface PlayerBody {
  readonly feet: Readonly<Vec3>;
  /** Includes resetForReplay(): clears hidden controller state, sets stance without forcing stand (R5). */
  restore(feet: Vec3, velocity: Vec3, stance: Stance): void;
  dispose(): void;
}

export interface StepResult {
  readonly state: PlayerState;
  readonly shots: readonly FiredShot[];
  readonly events: readonly SimEvent[];
}

export interface StepOptions {
  /** Replaying after a correction: callers must not emit observers/FX for this step (R11). */
  readonly replay: boolean;
  /**
   * Movement gates from state the sim doesn't own yet (equipment: healing, knocked, boost). Default: open. Server and
   * client must pass the same gates for a tick; M5 derives them from `PlayerState` vitals/item state.
   */
  readonly gates?: MoveGates;
}

const NO_SHOTS: readonly FiredShot[] = Object.freeze([]);
const NO_EVENTS: readonly SimEvent[] = Object.freeze([]);

/**
 * One 60 Hz tick, movement only (T3.1): modifiers from start-of-tick weapon state and the input's buttons →
 * movement. The weapon state passes through unchanged; M4 adds the weapon step after movement.
 * Deterministic for (body restored to `s.move`'s feet/velocity/stance, `s`, `i`, `dt`, `gates`).
 */
export function stepPlayer(body: PlayerBody, s: PlayerState, i: PlayerInput, dt: number, o: StepOptions): StepResult {
  if (!(body instanceof CharacterBody)) throw new Error("stepPlayer needs a CharacterBody (SimWorld.createBody or new CharacterBody)");
  const moveInput = moveInputFrom(i, deriveMoveModifiers(s.weapon, i), o.gates ?? OPEN_MOVE_GATES);
  const previous = s.move;
  const move = body.step(previous, moveInput, dt);

  let events: SimEvent[] | null = null;
  if (move.groundIgnoreTimer > previous.groundIgnoreTimer) (events ??= []).push({ type: "jumped" });
  if (!previous.grounded && move.grounded) (events ??= []).push({ type: "landed", fallSpeed: previous.fallSpeed });
  if (move.stance !== previous.stance) (events ??= []).push({ type: "stanceChanged", stance: move.stance });

  return { state: { move, weapon: s.weapon }, shots: NO_SHOTS, events: events ?? NO_EVENTS };
}
