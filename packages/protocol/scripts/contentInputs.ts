// Inputs of CONTENT_HASH (netcode.md §6.8, architecture.md D10). Imported by scripts/content-hash.ts and by the
// staleness test; pure shared subpaths only (never the barrel).
//
// The hitbox rig (shared/hitreg/rigFit.ts) is in; T4.2's generated fit replaces the hand fit behind the same exports.
// TODO(R9): add LOOT_TABLE_VERSION, LOOT, INTERACT (equipment/loot.ts) once map/buildings drops parameter properties;
// today they break this package's erasableSyntaxOnly typecheck.
import { FALL_DAMAGE, MOVEMENT, SIMULATION } from "@twobullets/shared/constants";
import { EXPLOSION } from "@twobullets/shared/equipment/explosion";
import { FIRE } from "@twobullets/shared/equipment/fire";
import { FLASH } from "@twobullets/shared/equipment/flash";
import { INVENTORY, ITEMS } from "@twobullets/shared/equipment/items";
import { SMOKE } from "@twobullets/shared/equipment/smoke";
import { THROW } from "@twobullets/shared/equipment/throw";
import { THROWABLE_PHYSICS } from "@twobullets/shared/equipment/throwables";
import { VITALS } from "@twobullets/shared/equipment/vitals";
import { RIG_BOUNDS_CENTER_Y, RIG_BOUNDS_RADIUS, RIG_FIT_POSES, RIG_PITCH_SHARE } from "@twobullets/shared/hitreg/rigFit";
import { BALLISTICS, WEAPONS } from "@twobullets/shared/weapons/weapons";

export interface EngineVersions {
  /** Exact `@babylonjs/core` version pinned by packages/sim. */
  readonly babylon: string;
  /** Exact `@babylonjs/havok` version pinned by packages/sim. */
  readonly havok: string;
}

export function contentHashInputs(engine: EngineVersions): unknown {
  return {
    engine,
    tuning: { SIMULATION, MOVEMENT, FALL_DAMAGE, BALLISTICS, WEAPONS },
    equipment: { ITEMS, INVENTORY, VITALS, THROW, THROWABLE_PHYSICS, EXPLOSION, FIRE, FLASH, SMOKE },
    hitreg: { RIG_FIT_POSES, RIG_PITCH_SHARE, RIG_BOUNDS_RADIUS, RIG_BOUNDS_CENTER_Y },
  };
}

/** Reads the engine pins from packages/sim/package.json text. */
export function engineVersionsFromSimPackage(packageJson: string): EngineVersions {
  const deps = (JSON.parse(packageJson) as { dependencies?: Record<string, string> }).dependencies ?? {};
  return { babylon: deps["@babylonjs/core"] ?? "unknown", havok: deps["@babylonjs/havok"] ?? "unknown" };
}
