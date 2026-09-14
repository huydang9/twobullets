import type { BotDifficulty } from "../bots/types";
import type { ArmorLoadout, ArmorSlot, DamageKind } from "../equipment/armor";
import type { SmokeCloud } from "../equipment/smoke";
import type { ThrowRelease } from "../equipment/throw";
import type { DamageContext, DamageOutcome, LifeState, Vitals, VitalsHit } from "../equipment/vitals";
import type { ThrowableKind } from "../equipment/items";
import type { Stance, Vec3 } from "../movement/types";
import type { FiredShot, HitZone, WeaponEvent, WeaponId } from "../weapons/types";

// Battle royale match contracts (docs/bots/design.md §8–9): phases, zone, teams, placements and events. Pure data, no
// engine imports. The offline match (client), the headless bot match (Node tests) and the M5 match server share them.
// Names avoid `MatchPhase`/`MatchRules`/`MatchConfig`/`MatchResult`, which packages/contracts already uses for the
// server lifecycle. Times are u32 ticks at SIMULATION.tickRate unless a field says seconds. Additive changes only.

// ---------------------------------------------------------------------------------------------------------------
// Phases and configuration
// ---------------------------------------------------------------------------------------------------------------

/**
 * Gameplay phases (netcode.md §8). Offline v1 runs warmup (countdown) → combat; `landing` and `glide` exist with zero
 * duration as the hook for landing select and gliding.
 */
export type BrPhase = "warmup" | "landing" | "glide" | "combat" | "ended";

export interface ZoneCircle {
  /** Center X, m. */
  readonly cx: number;
  /** Center Z, m. */
  readonly cz: number;
  /** Radius, m. */
  readonly r: number;
}

/** One row of the zone tuning table. */
export interface ZonePhaseSpec {
  /** Circle announced → shrink starts, s. */
  readonly waitSeconds: number;
  readonly shrinkSeconds: number;
  /** Radius at the end of the shrink, m. */
  readonly radius: number;
  /** Damage per second outside the circle from this phase's announcement on. */
  readonly dps: number;
}

export interface ZoneSpec {
  /** Circle before phase 1 (covers the playable square; no damage). */
  readonly initial: ZoneCircle;
  readonly phases: readonly ZonePhaseSpec[];
  /** Combat start → phase 1 announcement, s. */
  readonly firstAnnounceSeconds: number;
  /** Zone damage is applied every this many ticks (netcode.md §8.2: 6). */
  readonly damageIntervalTicks: number;
  /** New centers stay at least this far inside the playable square edge, m. */
  readonly edgeMargin: number;
}

/**
 * A scheduled zone phase. Field for field the `ZonePhase` wire message (netcode.md §8.2), so clients compute the same
 * circle from `zoneAt(tick)`. `index` is 1-based.
 */
export interface ZonePhase {
  readonly index: number;
  readonly waitStartTick: number;
  readonly shrinkStartTick: number;
  readonly shrinkEndTick: number;
  readonly from: ZoneCircle;
  readonly to: ZoneCircle;
  readonly dps: number;
}

export type ZoneStage = "idle" | "waiting" | "shrinking" | "closed";

/** Zone at one tick, derived purely from the phase list. */
export interface ZoneState {
  /** Active phase index (1-based), 0 before the first announcement. */
  readonly phaseIndex: number;
  readonly stage: ZoneStage;
  /** The circle at this tick (lerped while shrinking). Outside it takes `dps`. */
  readonly current: ZoneCircle;
  /** Announced next circle, or null before the first announcement and after the last shrink. */
  readonly next: ZoneCircle | null;
  readonly dps: number;
  /** Ticks until the stage changes (wait → shrink, shrink → next wait); 0 when closed. */
  readonly ticksToChange: number;
  readonly phase: ZonePhase | null;
}

export interface BrTimings {
  /** Warmup countdown before combat, s (players can't move or shoot). */
  readonly countdownSeconds: number;
  /** Landing select and glide, s. 0 offline until those exist. */
  readonly landingSeconds: number;
  readonly glideSeconds: number;
  /** Combat start → forced end, s (the zone normally ends the match first). */
  readonly timeCapSeconds: number;
  /** Ended → result screen stays up / headless run stops, s. */
  readonly endLingerSeconds: number;
}

export interface BrRules {
  readonly friendlyFire: boolean;
  /** 0 disables knock-down (solo rules). */
  readonly reviveSeconds: number;
  /** Product rule ON; bots may run with it off until CharacterBody collides with players (design.md §2.6). */
  readonly bodyBlocking: boolean;
}

export type ActorKind = "human" | "bot";

/** One participant. `slot` is the entity id everywhere (equipment ids, kill feed, projectile shooter). */
export interface ActorConfig {
  /** 0-based and dense; slot = team * teamSize + member. The local human is slot 0 offline. */
  readonly slot: number;
  readonly team: number;
  readonly kind: ActorKind;
  readonly name: string;
  /** Bots only; null for humans. */
  readonly difficulty: BotDifficulty | null;
}

export interface BrMatchConfig {
  /** u32; seeds zone centers, spawns, loot, bot RNG. */
  readonly seed: number;
  readonly mapId: string;
  readonly teamCount: number;
  readonly teamSize: number;
  readonly actors: readonly ActorConfig[];
  readonly rules: BrRules;
  readonly zone: ZoneSpec;
  readonly timings: BrTimings;
  /** Multiplies every zone and timing duration (tests and DEV `?zoneScale=`); 1 in play. */
  readonly timeScale: number;
}

/** Offline stand-in for landing select: where a team starts. The glide phase replaces it later. */
export interface TeamSpawnPlan {
  readonly team: number;
  /** POI the team starts at (map POI id). */
  readonly poiId: string;
  /** Feet position per member, in member order. Y resolved from terrain. */
  readonly feet: readonly Vec3[];
  readonly yaw: number;
}

// ---------------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------------

/**
 * Per-actor state for HUD, presentation, spectating and results. The match reuses these objects and mutates them in
 * place each tick: read every frame, copy if you need history. Enemy `health` is for UI of the viewer's own team and
 * results only; bot perception never reads it (design.md §4).
 */
export interface ActorState {
  readonly slot: number;
  readonly team: number;
  readonly kind: ActorKind;
  readonly name: string;
  readonly life: LifeState;
  readonly health: number;
  readonly downedHealth: number;
  readonly boost: number;
  readonly feet: Vec3;
  readonly velocity: Vec3;
  /** Simulated (dequantized) aim, radians, MoveInput convention. */
  readonly yaw: number;
  readonly pitch: number;
  readonly stance: Stance;
  readonly grounded: boolean;
  readonly sprinting: boolean;
  readonly adsBlend: number;
  /** Weapon in hand, null while unarmed or holding a throwable / item. */
  readonly weaponId: WeaponId | null;
  readonly helmetLevel: 0 | 1 | 2 | 3;
  readonly vestLevel: 0 | 1 | 2 | 3;
  readonly usingItem: boolean;
  readonly reviveProgress: number;
  /** Slot reviving this actor, or -1. */
  readonly reviverSlot: number;
  readonly kills: number;
  readonly knocks: number;
  readonly damageDealt: number;
  /** Tick of death, or -1. */
  readonly deathTick: number;
}

export interface TeamState {
  readonly team: number;
  readonly slots: readonly number[];
  /** Members with life "alive". */
  readonly standing: number;
  /** Members alive or downed. */
  readonly inPlay: number;
  readonly eliminated: boolean;
  readonly eliminatedTick: number;
  /** 1 = winner. Null while in play. Teams wiped on the same tick share a placement. */
  readonly placement: number | null;
  readonly kills: number;
}

export type BrEndReason = "lastTeam" | "allDead" | "timeCap";

export interface MatchState {
  readonly tick: number;
  readonly phase: BrPhase;
  readonly phaseStartTick: number;
  /** -1 when the phase has no fixed end (combat). */
  readonly phaseEndTick: number;
  /** Tick combat started, -1 before. */
  readonly combatStartTick: number;
  readonly zone: ZoneState;
  /** Every zone phase announced so far (future centers are not known in advance, ADR 0207). */
  readonly zonePhases: readonly ZonePhase[];
  readonly teams: readonly TeamState[];
  /** Indexed by slot. */
  readonly actors: readonly ActorState[];
  readonly teamsInPlay: number;
  readonly actorsInPlay: number;
  readonly winnerTeam: number | null;
  readonly endReason: BrEndReason | null;
}

export interface TeamResult {
  readonly team: number;
  readonly placement: number;
  readonly kills: number;
  readonly slots: readonly number[];
}

// ---------------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------------

/** What knocked or killed someone: a gun, a throwable, or the world. */
export type KillCause = WeaponId | Extract<ThrowableKind, "frag" | "molotov"> | "zone" | "fall" | "bleedOut" | "teamWipe" | "outOfBounds" | "unknown";

/** Gameplay events in sim order. `-1` in an actor field means the world. */
export type MatchEvent =
  | { readonly type: "phaseChanged"; readonly tick: number; readonly phase: BrPhase; readonly endTick: number }
  | { readonly type: "zoneAnnounced"; readonly tick: number; readonly phase: ZonePhase }
  | { readonly type: "zoneShrinkStarted"; readonly tick: number; readonly phaseIndex: number }
  /** Sent at 30 s and 10 s before a shrink (netcode `ZoneWarning`). */
  | { readonly type: "zoneWarning"; readonly tick: number; readonly phaseIndex: number; readonly secondsLeft: number }
  | {
      readonly type: "damage";
      readonly tick: number;
      readonly attacker: number;
      readonly victim: number;
      /** Health or downed pool actually removed. */
      readonly amount: number;
      readonly kind: DamageKind;
      readonly zone: HitZone | null;
      readonly weaponId: WeaponId | null;
      readonly armorAbsorbed: number;
      readonly armorSlot: ArmorSlot | null;
      readonly armorDestroyed: boolean;
      /** World hit point (feet for zone/fire/fall). */
      readonly position: Vec3;
    }
  | { readonly type: "knock"; readonly tick: number; readonly attacker: number; readonly victim: number; readonly cause: KillCause; readonly headshot: boolean }
  | { readonly type: "reviveStarted"; readonly tick: number; readonly reviver: number; readonly target: number }
  | { readonly type: "reviveCancelled"; readonly tick: number; readonly reviver: number; readonly target: number }
  | { readonly type: "revived"; readonly tick: number; readonly reviver: number; readonly target: number }
  | {
      readonly type: "kill";
      readonly tick: number;
      /** Credited killer: the finisher, or the knocker for bleed-out and team wipes; -1 for the world. */
      readonly killer: number;
      readonly victim: number;
      readonly cause: KillCause;
      readonly headshot: boolean;
      /** Who knocked the victim before the kill, or -1. */
      readonly knockedBy: number;
      readonly teamKill: boolean;
    }
  | { readonly type: "teamEliminated"; readonly tick: number; readonly team: number; readonly placement: number }
  | { readonly type: "win"; readonly tick: number; readonly team: number }
  | { readonly type: "matchEnded"; readonly tick: number; readonly reason: BrEndReason; readonly results: readonly TeamResult[] };

/**
 * Presentation-only events for actors the client doesn't simulate itself (bots offline, remote players later): shots
 * for tracers/muzzle/audio, weapon events for animation, impacts for FX. Not needed by rules or bots.
 */
export type MatchFxEvent =
  | { readonly type: "shot"; readonly tick: number; readonly slot: number; readonly shot: FiredShot }
  | { readonly type: "weapon"; readonly tick: number; readonly slot: number; readonly event: WeaponEvent }
  | {
      readonly type: "impact";
      readonly tick: number;
      readonly slot: number;
      readonly weaponId: WeaponId;
      readonly point: Vec3;
      readonly normal: Vec3;
      /** Actor hit, or -1 for world geometry. */
      readonly victim: number;
      readonly zone: HitZone | null;
      /** Unit bullet direction. */
      readonly direction: Vec3;
    }
  | { readonly type: "throwRelease"; readonly tick: number; readonly slot: number; readonly kind: ThrowableKind }
  | { readonly type: "itemUse"; readonly tick: number; readonly slot: number; readonly phase: "started" | "cancelled" | "completed" };

// ---------------------------------------------------------------------------------------------------------------
// Ports between the match simulation and its host (client offline match vs headless)
// ---------------------------------------------------------------------------------------------------------------

/** Pose a hitbox rig and bot perception need from an actor the match doesn't step itself. */
export interface ExternalActorPose {
  feet: Vec3;
  eye: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  stance: Stance;
  grounded: boolean;
  sprinting: boolean;
  adsBlend: number;
  weaponId: WeaponId | null;
}

/**
 * An actor simulated outside the match (the offline human: PlayerController + CombatSystem + EquipmentSystem). The
 * match reads its pose after the host's tick, routes bot damage to it and drives team rules and revives through it.
 */
export interface MatchExternalActor {
  readonly slot: number;
  readonly vitals: Vitals;
  readonly armor: ArmorLoadout;
  /** Writes the pose at the end of this tick's movement step. */
  readPose(out: ExternalActorPose): void;
  /** Applies damage through the host's vitals (armor included). Null when ignored (dead). */
  applyDamage(hit: VitalsHit, ctx: DamageContext, position: Vec3): DamageOutcome | null;
  /** Team rule: reaching 0 HP knocks while a teammate stands. */
  setCanBeKnocked(value: boolean): void;
  /** A teammate starts (slot) or stops (null) reviving this actor. */
  setReviver(slot: number | null): void;
  /** The actor is out of the match (no respawn). */
  eliminate(): void;
}

/** Damage an externally simulated shooter deals to a match actor (human bullets and grenades hitting bots). */
export interface ExternalDamage {
  readonly attacker: number;
  readonly victim: number;
  readonly amount: number;
  readonly kind: DamageKind;
  readonly zone: HitZone | null;
  readonly weaponId: WeaponId | null;
  readonly position: Vec3;
  /** Unit direction of the bullet or blast. */
  readonly direction: Vec3;
}

export interface ExternalDamageResult {
  readonly dealt: number;
  readonly remainingHealth: number;
  readonly knocked: boolean;
  readonly killed: boolean;
  readonly armorAbsorbed: number;
  readonly armorSlot: ArmorSlot | null;
  readonly armorDestroyed: boolean;
}

/**
 * Where throwables and area effects live. Headless: the match's own EquipmentWorld. Client: EquipmentSystem's world, so
 * the presentation renders bot grenades and the human's own grenades reach bots.
 */
export interface MatchEquipmentPort {
  readonly smokes: readonly SmokeCloud[];
  /** Spawns a released throwable owned by `slot`. Returns its id, or -1. */
  spawnRelease(release: ThrowRelease, slot: number): number;
}

/** Read side of a running match for HUD, spectating and DEV tools. */
export interface MatchView {
  readonly config: BrMatchConfig;
  readonly state: MatchState;
  /** Called synchronously in sim order. Returns an unsubscribe function. */
  onEvent(listener: (event: MatchEvent) => void): () => void;
  onFx(listener: (event: MatchFxEvent) => void): () => void;
}
