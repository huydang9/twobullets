import type { EquipmentModifiers } from "../equipment/equipmentStep";
import type { InventoryState } from "../equipment/inventory";
import type { ThrowableKind } from "../equipment/items";
import type { ItemUseState } from "../equipment/itemUse";
import type { LootItem } from "../equipment/loot";
import type { SmokeCloud } from "../equipment/smoke";
import type { ThrowState } from "../equipment/throw";
import type { LifeState, Vitals } from "../equipment/vitals";
import type { PlayerInput } from "../input";
import type { MapLayout } from "../map/layout/mapLayout";
import type { Terrain } from "../map/terrain/terrain";
import type { MapData } from "../map/types";
import type { BrPhase, ZoneCircle, ZoneState } from "../match/types";
import type { MoveState, Stance, Vec3 } from "../movement/types";
import type { RaycastFn, WeaponId, WeaponState } from "../weapons/types";

// Bot contracts (docs/bots/design.md). Pure: bots emit one PlayerInput per tick through the same shared simulation as
// players, read only a BotWorldView, and use seeded RNG. The same brain runs offline in the client, in headless Node
// tests and as M5 lobby bots on the match server. Additive changes only.

// ---------------------------------------------------------------------------------------------------------------
// Difficulty and tuning
// ---------------------------------------------------------------------------------------------------------------

export type BotDifficulty = "easy" | "normal" | "hard";

export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = "normal";

/** [min, max] inclusive; a seeded sample picks a value per use. */
export type BotSpan = readonly [min: number, max: number];

export interface BotPerceptionProfile {
  /** Full horizontal field of view, degrees. */
  readonly fovDegrees: number;
  /** Awareness gain multiplier outside the central 30° of the view. */
  readonly peripheralFactor: number;
  /** Beyond this distance a standing target in the open is never spotted, m (scoped ADS extends it ×1.5). */
  readonly spotRangeMeters: number;
  /** Awareness gained per second for a standing, moving target at 50 m in the view center (1 = spotted). */
  readonly awarenessPerSecond: number;
  /** Any actor this close is sensed regardless of view direction (footsteps, rustle), m. */
  readonly proximityMeters: number;
  /** Spotted → first aim movement, s. */
  readonly reactionSeconds: BotSpan;
  /** Multiplier on noise radii. */
  readonly hearingScale: number;
  /** Heard position error as a fraction of the distance (σ). */
  readonly noiseErrorFraction: number;
  /** Memory entries fade to zero confidence after this long unseen, s. */
  readonly forgetSeconds: number;
}

export interface BotAimProfile {
  /** Max aim angular speed, degrees/s. */
  readonly maxTurnRateDeg: number;
  /** Time constant of the acquisition error decay, s. */
  readonly acquireSeconds: number;
  /** Initial aim offset on a new target, degrees (plus `velocityErrorScale` × target angular speed). */
  readonly acquireErrorDeg: number;
  /** RMS of the smooth seeded tracking noise, degrees. */
  readonly trackingNoiseDeg: number;
  /** Frequency of the tracking noise, Hz. */
  readonly trackingNoiseHz: number;
  /** Degrees of extra error per degree/s of target angular velocity. */
  readonly velocityErrorScale: number;
  /** 0..1 fraction of the correct lead (bullet travel time) applied. */
  readonly leadAccuracy: number;
  /** 0..1 fraction of the correct bullet drop compensation applied. */
  readonly dropAccuracy: number;
  /** 0..1 fraction of each recoil kick pulled back. */
  readonly recoilCompensation: number;
  /** Delay before recoil compensation starts after a shot, s. */
  readonly recoilDelaySeconds: number;
  /** Aim on target → first trigger press, s. */
  readonly firstShotDelaySeconds: number;
  /** Fire only while aim error < scale × target angular radius. */
  readonly fireToleranceScale: number;
  /** Aim point on the body. */
  readonly aimPoint: "chest" | "upperChest" | "neck";
  /** Aim punch when taking damage, degrees. */
  readonly flinchDeg: number;
}

export interface BotFireProfile {
  readonly closeMeters: number;
  readonly midMeters: number;
  /** Automatic-weapon burst lengths in rounds by range band (≥ midMeters is long). */
  readonly burstClose: BotSpan;
  readonly burstMid: BotSpan;
  readonly burstLong: BotSpan;
  readonly burstPauseSeconds: BotSpan;
  /** Hip-fire instead of ADS inside this range, m. */
  readonly hipFireMeters: number;
  /** Max engagement distance per weapon, m. Targets beyond are avoided or approached. */
  readonly maxRange: Readonly<Record<WeaponId, number>>;
  /** Chance to keep firing at a target's last-known position after it enters smoke. */
  readonly smokeSuppressChance: number;
  readonly smokeSuppressSeconds: number;
}

export interface BotTacticsProfile {
  /** Chance per strafe decision to strafe while shooting. */
  readonly strafeChance: number;
  readonly strafeIntervalSeconds: BotSpan;
  /** Chance to move to cover when taking fire. */
  readonly coverChance: number;
  /** Time exposed per peek from cover, s. */
  readonly peekSeconds: BotSpan;
  /** Chance per eligible moment (target hidden in cover ≥ 4 s, 8–35 m) to throw a frag or molotov. */
  readonly grenadeChance: number;
  readonly grenadeCooldownSeconds: number;
  /** Chance to throw smoke before reviving in the open. */
  readonly smokeReviveChance: number;
  /** Chance to turn away from a visible flashbang in flight. */
  readonly flashDodgeChance: number;
  /** Health below which the bot disengages to heal. */
  readonly fleeHealth: number;
  /** No threat seen or heard for this long before healing in place, s. */
  readonly healSafeSeconds: number;
  /** Extra seconds kept in hand when deciding to rotate to the zone. */
  readonly zoneMarginSeconds: number;
  /** Max seconds chasing a lost target's last-known position. */
  readonly chaseSeconds: number;
  /** 0..1 risk accepted to revive (1 = revives under fire). */
  readonly reviveRisk: number;
}

/** Complete tuning of one difficulty (design.md §6 table). */
export interface BotProfile {
  readonly difficulty: BotDifficulty;
  readonly perception: BotPerceptionProfile;
  readonly aim: BotAimProfile;
  readonly fire: BotFireProfile;
  readonly tactics: BotTacticsProfile;
}

/** Tick schedule shared by the brain and its host (design.md §7). All brains stagger by `slot`. */
export const BOT_SCHEDULE = {
  /** Perception runs every N ticks (10 Hz), on ticks where (tick + slot) % N === 0. */
  perceptionTicks: 6,
  /** Goal selection every N ticks (4 Hz), staggered the same way. */
  planningTicks: 15,
  /** Loot scan every N ticks (2 Hz). */
  lootTicks: 30,
  /** Fine A* node expansions per tick for all bots together; the host calls `NavQuery.update` once per tick. */
  navExpansionsPerTick: 1500,
  /** Max perception candidates ray-tested per bot per update (nearest first). */
  maxLosCandidates: 6,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------------------------

export interface NavBuildOptions {
  /** Terrain layer cell size, m (default 0.5). */
  readonly cellSize?: number;
  /** Building layer cell size in prefab-local space, m (default 0.25). */
  readonly buildingCellSize?: number;
  /** Coarse guide grid cell size, m (default 4). */
  readonly coarseCellSize?: number;
  /** Obstacle inflation, m (default 0.3: slightly under the 0.35 capsule; collide-and-slide absorbs the rest). */
  readonly agentRadius?: number;
  /** Steepest terrain marked walkable, degrees (default 40, under MOVEMENT.maxSlopeDegrees 50). */
  readonly maxSlopeDegrees?: number;
}

export interface NavBuildInput {
  readonly map: MapData;
  readonly terrain: Terrain;
  readonly layout: MapLayout;
  readonly options?: NavBuildOptions;
}

/** Per-cell flag bits (terrain cells and building spans). */
export const NavFlag = {
  walkable: 1,
  /** Only a crouched capsule fits (ruined-house beam, low openings). */
  crouchOnly: 2,
  road: 4,
  /** Bushes or ferns without collision: conceals a crouched target from far viewers. */
  vegetation: 8,
  indoor: 16,
  stairs: 32,
  /** Doorway or entrance link. */
  door: 64,
  /** Within one cell of a blocked cell (cover candidate). */
  nearObstacle: 128,
} as const;

/** Packed node id: terrain cells first, then building spans. -1 = none. */
export type NavNodeRef = number;

export interface NavGridInfo {
  /** Bump when the build changes output for the same inputs. */
  readonly version: number;
  readonly cellSize: number;
  readonly buildingCellSize: number;
  readonly coarseCellSize: number;
  /** World X/Z of the terrain grid's min corner. */
  readonly originX: number;
  readonly originZ: number;
  /** Terrain cells along X and Z. */
  readonly width: number;
  readonly depth: number;
  readonly terrainNodes: number;
  readonly buildingNodes: number;
  readonly components: number;
  readonly byteLength: number;
  /** Hash of every array; equal in Node and the browser for the same map (determinism test). */
  readonly checksum: string;
}

/** Built navigation data. Immutable after build; shareable across matches on one map. */
export interface NavGrid {
  readonly info: NavGridInfo;
}

export type PathStatus = "pending" | "found" | "partial" | "unreachable" | "released";

/** Extra traversal cost around a point (danger, enemy last-known position, fire). */
export interface NavAvoidCircle {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  /** Cost multiplier inside the circle (> 1). */
  readonly cost: number;
}

export interface PathOptions {
  /** Paths longer than this fail as unreachable, m. */
  readonly maxLength?: number;
  readonly allowCrouchOnly?: boolean;
  readonly avoid?: readonly NavAvoidCircle[];
  /** 0..1: discount for cells flagged vegetation/nearObstacle, so routes hug cover. */
  readonly preferCover?: number;
  /** Cells outside this circle cost extra (zone rotation). */
  readonly zone?: ZoneCircle | null;
  /** Return the best partial path when the goal is unreachable or the search budget is exceeded. */
  readonly partial?: boolean;
}

/** Smoothed waypoints written by `readPath`. Fixed capacity; the caller owns and reuses it. */
export interface NavPath {
  /** xyz per waypoint (feet height). */
  readonly points: Float32Array;
  /** NavFlag bits of each waypoint's cell (crouchOnly, stairs, door). */
  readonly flags: Uint8Array;
  count: number;
  /** Total length, m. */
  length: number;
}

export interface NavQuery {
  readonly grid: NavGrid;
  /** Nearest walkable node within `maxDistance` of `p` (3D, so floors resolve), written to `out`. */
  nearest(p: Vec3, maxDistance: number, out: { x: number; y: number; z: number }): NavNodeRef;
  flagsAt(ref: NavNodeRef): number;
  /** Same connected component: a path exists ignoring costs. O(1). */
  reachable(a: NavNodeRef, b: NavNodeRef): boolean;
  /** Straight walkable line on one layer (string pulling, strafe and cover checks). */
  lineWalkable(from: Vec3, to: Vec3): boolean;
  /** Queues a path search. Searches run inside `update`; poll with `readPath`. Returns a handle. */
  requestPath(from: Vec3, to: Vec3, options: PathOptions | null): number;
  /** Status, and the path when found/partial. Doesn't free the handle. */
  readPath(handle: number, out: NavPath): PathStatus;
  releasePath(handle: number): void;
  /** Runs queued searches up to `maxExpansions` node expansions. Returns expansions used. */
  update(maxExpansions: number): number;
  /**
   * Up to `max` walkable points in the ring [minRadius, maxRadius] around `center` (same component), seeded, written as
   * xyz into `out`. Candidates for cover, strafe, flee and loot-approach positions.
   */
  sampleRing(center: Vec3, minRadius: number, maxRadius: number, seed: number, out: Float32Array, max: number): number;
}

// ---------------------------------------------------------------------------------------------------------------
// World view (the only thing a brain may read)
// ---------------------------------------------------------------------------------------------------------------

/** Observable pose of another actor. Health is not observable for enemies (only `life`: knocked shows). */
export interface ActorSnapshot {
  readonly slot: number;
  readonly team: number;
  readonly life: LifeState;
  readonly feet: Vec3;
  readonly eye: Vec3;
  readonly velocity: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly stance: Stance;
  readonly sprinting: boolean;
  readonly adsBlend: number;
  readonly weaponId: WeaponId | null;
  /** Tick this actor last fired, or -1. */
  readonly lastShotTick: number;
}

/** Squad knowledge (teammates share positions and health, like voice comms). */
export interface TeammateView extends ActorSnapshot {
  readonly kind: "human" | "bot";
  readonly health: number;
  readonly downedHealth: number;
  /** Slot reviving this teammate, or -1. */
  readonly reviverSlot: number;
  readonly healCount: number;
}

export type NoiseKind = "shot" | "footstep" | "land" | "reload" | "heal" | "explosion" | "impact";

/** Something audible that happened this tick. Radii are already per-noise (ADR 0207 table) before `hearingScale`. */
export interface NoiseEvent {
  readonly kind: NoiseKind;
  readonly sourceSlot: number;
  readonly position: Vec3;
  readonly radius: number;
  readonly weaponId: WeaponId | null;
}

export interface DamageTakenEvent {
  readonly attackerSlot: number;
  /** Unit direction the damage travelled (bullet direction; from the blast for explosions). */
  readonly direction: Vec3;
  readonly amount: number;
  readonly kind: "bullet" | "explosion" | "fire" | "fall" | "zone" | "bleed";
}

export interface ThrowableView {
  readonly id: number;
  readonly ownerSlot: number;
  readonly kind: ThrowableKind;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly atRest: boolean;
}

export interface BotSelfView {
  readonly slot: number;
  readonly team: number;
  readonly feet: Vec3;
  readonly eye: Vec3;
  readonly velocity: Vec3;
  readonly move: MoveState;
  /** The bot's own continuous aim before quantization (radians); recoil already applied. */
  readonly aimYaw: number;
  readonly aimPitch: number;
  readonly vitals: Vitals;
  readonly inventory: InventoryState;
  readonly weapon: WeaponState;
  readonly throwState: ThrowState;
  readonly use: ItemUseState;
  readonly modifiers: EquipmentModifiers;
}

export interface BotWorldView {
  readonly tick: number;
  readonly dt: number;
  readonly matchSeed: number;
  readonly phase: BrPhase;
  readonly self: BotSelfView;
  readonly teammates: readonly TeammateView[];
  /**
   * Every other living or downed actor, teammates included. Only the perception step may read it; decisions use
   * `BotBrain.perception` and `memory` (no wallhacks).
   */
  readonly actors: readonly ActorSnapshot[];
  /** This tick's noises (all of them; perception applies radii). */
  readonly noises: readonly NoiseEvent[];
  /** Damage this bot took this tick. */
  readonly damageTaken: readonly DamageTakenEvent[];
  /** Throwables in flight or at rest (visibility-tested by perception). */
  readonly throwables: readonly ThrowableView[];
  readonly smokes: readonly SmokeCloud[];
  readonly zone: ZoneState;
  readonly teamsInPlay: number;
  readonly actorsInPlay: number;
  /** Static world only: no hitboxes, players or fences (fences don't block sight or bullets). */
  readonly raycast: RaycastFn;
  readonly nav: NavQuery;
  /** Ground loot within `radius` of `center`, nearest first, written into `out` (cleared first). Returns the count. */
  queryLoot(center: Vec3, radius: number, out: LootItem[]): number;
  /** First actor slot other than `excludeSlot` whose hitbox rig the segment crosses, or -1 (friendly fire check). */
  actorOnSegment(from: Vec3, to: Vec3, excludeSlot: number): number;
}

// ---------------------------------------------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------------------------------------------

export interface PerceivedActor {
  readonly slot: number;
  readonly hostile: boolean;
  /** 0..1; spotted at 1. */
  readonly awareness: number;
  readonly visible: boolean;
  /** Visible: true feet position. Otherwise the last estimate (heard, damaged, remembered). */
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly life: LifeState;
  readonly distance: number;
  readonly lastSeenTick: number;
  /** Tick from which the bot may react to this actor (spotted + reaction time). */
  readonly reactTick: number;
}

export interface BotPerception {
  /** Tick of the last perception update. */
  readonly tick: number;
  readonly actors: readonly PerceivedActor[];
  /** Highest-priority visible or recent hostile, or -1. */
  readonly threatSlot: number;
  readonly lastDamageTick: number;
  /** Estimated direction toward the last attacker (unit, horizontal). */
  readonly lastDamageFrom: Vec3;
  readonly blind: boolean;
  readonly deaf: boolean;
}

export type MemorySource = "seen" | "heard" | "damage" | "teammate";

export interface MemoryEntry {
  readonly slot: number;
  readonly hostile: boolean;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly tick: number;
  /** 0..1, fades over `forgetSeconds`. */
  readonly confidence: number;
  readonly source: MemorySource;
}

export interface BotMemory {
  /** Fixed-size pool (8); `count` live entries. */
  readonly entries: readonly MemoryEntry[];
  readonly count: number;
  /** Recent grenade landings, fires and heavy-fire spots to avoid, as nav avoid circles. */
  readonly danger: readonly NavAvoidCircle[];
  /** Loot ids that failed to pick up (full, unreachable), skipped until this tick. */
  readonly skippedLoot: ReadonlyMap<number, number>;
}

export type BotGoalKind = "idle" | "loot" | "rotate" | "engage" | "cover" | "heal" | "revive" | "regroup" | "flee" | "investigate" | "dead";

/** Mutable PlayerInput the brain writes each tick (the host copies it into any ring it keeps). */
export type BotInput = { -readonly [K in keyof PlayerInput]: PlayerInput[K] };

/**
 * Intent that has no PlayerInput wire field yet (M5 adds them). Pickup, drop and item use go through
 * `PlayerInput.action`; revive holds `Btn.interact`; the throwable key is `select = 5`.
 */
export interface BotIntents {
  /** G: next throwable kind. */
  cycleThrowable: boolean;
  /** X: put a throwable away (pin back / cooking grenade dropped). */
  holster: boolean;
  /** Weapon slot to replace when `action` picks up a weapon with both primaries full, or -1. */
  replaceSlot: -1 | 0 | 1 | 2;
  /** Downed teammate the interact hold targets, or -1. */
  reviveSlot: number;
}

export interface BotTickOutput {
  readonly input: BotInput;
  readonly intents: BotIntents;
}

export interface BotDebugState {
  readonly goal: BotGoalKind;
  readonly goalScore: number;
  /** Behavior sub-state label ("peek", "reload-in-cover", "follow-path"...). */
  readonly subState: string;
  readonly targetSlot: number;
  /** Current angular aim error to the target, degrees (NaN without a target). */
  readonly aimErrorDeg: number;
  readonly path: NavPath | null;
  /** Next move point, or null. */
  readonly moveTarget: Vec3 | null;
  readonly lootTargetId: number;
}

export interface BotBrainOptions {
  readonly slot: number;
  readonly team: number;
  /** u32; the brain's RNG derives from (seed, slot, counters) only. */
  readonly seed: number;
  readonly profile: BotProfile;
}

export interface BotBrain {
  readonly slot: number;
  readonly profile: BotProfile;
  readonly perception: BotPerception;
  readonly memory: BotMemory;
  /**
   * Once per 60 Hz tick, before this bot's simulation step. Writes the tick's input (tick, axes, buttons, select,
   * quantized aim, action) and intents. Allocation-free in steady state; deterministic for (options, view sequence).
   */
  tick(view: BotWorldView, out: BotTickOutput): void;
  /** Recoil kick from a shot fired this tick, radians (applied to the bot's aim like PlayerController.kickAim). */
  kickAim(up: number, right: number): void;
  /** Fresh life at a spawn (clears perception, memory and goals). */
  reset(yaw: number): void;
  debug(): BotDebugState;
}

export type BotBrainFactory = (options: BotBrainOptions) => BotBrain;
