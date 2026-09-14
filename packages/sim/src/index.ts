import type { HavokPhysicsWithBindings } from "@babylonjs/havok";
import type { PlayerInput, PlayerState } from "@twobullets/shared/input";
import type { LevelData } from "@twobullets/shared/level/types";
import type { Stance, Vec3 } from "@twobullets/shared/movement/types";
import type { FiredShot, RaycastFn, WeaponEvent } from "@twobullets/shared/weapons/types";

// Babylon NullEngine + Havok simulation shared by client, server and bots (ADR 0005). Deep @babylonjs/core imports
// only, never the barrel. Interface contract from architecture.md §7.1; CharacterBody/buildLevel move here in T3.1.

/** The instantiated Havok WASM module (`await HavokPhysics()`). */
export type HavokModule = HavokPhysicsWithBindings;

/** Collision-only level input (R13). The arena's `LevelData` for M3; Map v1 terrain/buildings are added in M5 (T5.3). */
export type ServerLevel = LevelData;

/** Precreated collision shapes shared across matches in packed mode (ADR 0004). Opaque until T3.1. */
export interface SharedShapes {
  readonly kind: "sharedShapes";
}

/** Non-weapon events from a player step; T3.1 extends this union additively. */
export type MoveEvent =
  | { readonly type: "jumped" }
  | { readonly type: "landed"; readonly fallSpeed: number }
  | { readonly type: "stanceChanged"; readonly stance: Stance };

export type SimEvent = WeaponEvent | MoveEvent;

export interface SimWorld {
  /** Static world only; direct HP_* allowed (ADR 0302 §4). */
  readonly raycastWorld: RaycastFn;
  createBody(feet: Vec3): PlayerBody;
  dispose(): void;
}

export function createSimWorld(havok: HavokModule, level: ServerLevel, opts?: { shared?: SharedShapes }): Promise<SimWorld> {
  return Promise.reject(new Error("not implemented"));
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

/** One 60 Hz tick: modifiers from start-of-tick weapon state → movement → weapon. `replay` suppresses observers (R11). */
export function stepPlayer(body: PlayerBody, s: PlayerState, i: PlayerInput, dt: number, o: { replay: boolean }): StepResult {
  throw new Error("not implemented");
}
