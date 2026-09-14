import { dequantizePitch, dequantizeYaw, quantizePitch, quantizeYaw } from "@twobullets/shared/aim";
import {
  BOT_SCHEDULE,
  type ActorSnapshot,
  type BotBrain,
  type BotBrainFactory,
  type BotDifficulty,
  type BotProfile,
  type BotSelfView,
  type BotTickOutput,
  type BotWorldView,
  type DamageTakenEvent,
  type NavQuery,
  type NoiseEvent,
  type NoiseKind,
  type TeammateView,
  type ThrowableView,
} from "@twobullets/shared/bots/types";
import { SIMULATION } from "@twobullets/shared/constants";
import { armorLoadout, createInventory, drop as dropFromInventory, pickUp, withArmor, type InventoryState, type ItemInstance, type WeaponSlot } from "@twobullets/shared/equipment/inventory";
import type { ArmorLoadout, DamageKind } from "@twobullets/shared/equipment/armor";
import {
  createEquipmentWorld,
  createPlayerEquipment,
  deriveEquipmentModifiers,
  spawnRelease,
  stepEquipmentWorld,
  stepPlayerEquipment,
  type EquipmentInput,
  type EquipmentModifiers,
  type EquipmentWorld,
  type EquipmentWorldEvent,
  type PlayerEquipmentState,
  type WorldEntity,
} from "@twobullets/shared/equipment/equipmentStep";
import { ITEM_IDS, ITEMS, THROWABLE_KINDS, type ConsumableItemId } from "@twobullets/shared/equipment/items";
import { dropGroundItem, INTERACT, LOOT, setGroundQuantity, type GroundLoot, type LootItem } from "@twobullets/shared/equipment/loot";
import { hash32 } from "@twobullets/shared/equipment/math";
import { applyDamage, eliminate, stepRevive, VITALS, type DamageOutcome, type Vitals, type VitalsHit } from "@twobullets/shared/equipment/vitals";
import { commitWeaponsToInventory, gateCombatInput, syncWeaponsFromInventory, weaponStateFromInventory, type WeaponLoadoutOptions } from "@twobullets/shared/equipment/weaponLoadout";
import { stanceBlendOf, poseHitboxes, RIG_BUFFER_LENGTH, segmentNearRig, segmentVsRigInto, type HitPose, type MutableRigHit } from "@twobullets/shared/hitreg/rig";
import { Btn, PlayerActionType, type PlayerInput } from "@twobullets/shared/input";
import { footstepRadius, FOOTSTEP_INTERVAL_TICKS, landNoiseRadius, NOISE_RADII, shotNoiseRadius } from "@twobullets/shared/match/noise";
import {
  brPhaseSchedule,
  canActorBeKnocked,
  countTeamsInPlay,
  createTeamStates,
  decodeDropArg,
  downedWithoutStandingTeammate,
  killCauseOf,
  refreshTeamCounts,
  resolveEliminations,
  resolveTimeCap,
  type BrEndResult,
  type BrPhaseSchedule,
  type MutableTeamState,
} from "@twobullets/shared/match/rules";
import type {
  ActorKind,
  ActorState,
  BrMatchConfig,
  BrPhase,
  ExternalActorPose,
  ExternalDamage,
  ExternalDamageResult,
  KillCause,
  MatchEquipmentPort,
  MatchEvent,
  MatchExternalActor,
  MatchFxEvent,
  MatchState,
  MatchView,
  TeamSpawnPlan,
  ZonePhase,
} from "@twobullets/shared/match/types";
import { computeZonePhase, createZoneState, isOutsideZone, secondsToTicks, ZONE_WARNING_SECONDS, zoneAtInto, zoneTickDamage, type MutableZoneState, type ZoneCenterCheck } from "@twobullets/shared/match/zone";
import { eyeHeightFor, fallDamage } from "@twobullets/shared/movement/movement";
import type { MoveState, Stance, Vec3 } from "@twobullets/shared/movement/types";
import { createMoveState } from "@twobullets/shared/movement/movement";
import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import type { RaycastFn, WeaponId, WeaponState } from "@twobullets/shared/weapons/types";
import { computeDamage } from "@twobullets/shared/weapons/ballistics";
import { WEAPONS } from "@twobullets/shared/weapons/weapons";
import { combatInputInto, createCombatInput, createWeaponContext, stepPlayerWeapon, weaponContextInto } from "@twobullets/shared/weapons/playerWeapon";
import { ProjectileBuffer } from "@twobullets/shared/weapons/projectileBuffer";
import { stepPlayer, type PlayerBody, type StepOptions } from "../index";
import { queryGroundLootInto } from "./lootQuery";

// Headless battle royale match (docs/bots/design.md §2): bot actors stepped through the shared movement, equipment and
// weapon steps from their brains' PlayerInput, bullets against the static world and the procedural rig, knock/revive,
// zone, team rules, placements and events. Node tests, the offline client and (M5) the match server host it through
// ports. Per tick: rules pre-step → external poses → brains → bot steps → projectiles → equipment world (headless) →
// vitals/zone/wipes → rules post-step (§2.3).

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableVec3 = Mutable<Vec3>;

/** Equipment port with an optional throwables view (client: EquipmentSystem's world). */
export interface MatchSimEquipment extends MatchEquipmentPort {
  /** Throwables for bot perception; empty when absent. */
  readonly throwables?: readonly ThrowableView[];
}

export interface MatchSimPorts {
  /** Static world only (WORLD_ONLY_MASK): no capsules, hitboxes or fences. */
  readonly raycastWorld: RaycastFn;
  readonly nav: NavQuery;
  /** Ground items (headless: `createGroundLoot(generateLoot(...).items)`; client: `equipment.groundLoot`). */
  readonly groundLoot: GroundLoot;
  readonly brainFactory: BotBrainFactory;
  /** Tuning per difficulty (B's `BOT_PROFILES`). */
  readonly profileFor: (difficulty: BotDifficulty) => BotProfile;
  /** Bot capsule factory (client: `new CharacterBody(scene, feet)`; headless: `SimWorld.createBody`). */
  createBody(feet: Vec3): PlayerBody;
  /** Client: EquipmentSystem's world. Omitted: the match owns an EquipmentWorld and steps it (headless). */
  readonly equipment?: MatchSimEquipment;
  /** Actors simulated by the host (the offline human). Their slots must be `kind: "human"` in the config. */
  readonly external?: readonly MatchExternalActor[];
  /** Zone center check (nav: walkable, main component). */
  readonly isValidZoneCenter?: ZoneCenterCheck;
}

export interface MatchSimOptions {
  readonly config: BrMatchConfig;
  readonly spawns: readonly TeamSpawnPlan[];
  readonly ports: MatchSimPorts;
  /** First tick number (default 0). */
  readonly startTick?: number;
  /** Bodies below this Y die (`MapData.bounds.killY`, default -40). */
  readonly killY?: number;
  /** Starting inventory per bot slot (default empty: loot to arm). */
  readonly inventoryFor?: (slot: number) => InventoryState;
  /** Measure brain and sim time per tick (`stats`). */
  readonly profile?: boolean;
  /** A* node expansions per tick for all bots (default BOT_SCHEDULE.navExpansionsPerTick). */
  readonly navExpansionsPerTick?: number;
}

export interface MatchSimStats {
  ticks: number;
  /** Last tick's brain time, sim time (everything else), ms. */
  brainMs: number;
  simMs: number;
  /** Totals since start, ms. */
  brainTotalMs: number;
  simTotalMs: number;
  shots: number;
  projectilesAlive: number;
}

/** Reserve = ammo items in the bag, like the client's equipment-attached combat. */
const LOADOUT: WeaponLoadoutOptions = { ammoFromInventory: true };
const STEP_OPTIONS_GATES: Mutable<StepOptions> = { replay: false };
const DT = TICK_SECONDS;
/** Pickups may reach this much past INTERACT.reach (the client's PICKUP_SLACK). */
const PICKUP_SLACK = 0.4;
/** Max |Δy| between reviver and downed feet, m. */
const REVIVE_HEIGHT = 1.2;
/** Death piles use loot pile ids above generated ones. */
export const DEATH_PILE_ID_BASE = 1_000_000;
const NOISE_POOL = 128;
/** Radius of the `impact` noise a near miss makes (design.md §4). */
const IMPACT_NOISE_RADIUS = NOISE_RADII.impact;
/** Bullets within this of a bot's chest count as near misses, m. */
const NEAR_MISS_RADIUS = 4;
const THROWABLE_VIEW_POOL = 64;

const NO_THROWABLES: readonly ThrowableView[] = Object.freeze([]);

interface MutableNoise {
  kind: NoiseKind;
  sourceSlot: number;
  position: MutableVec3;
  radius: number;
  weaponId: WeaponId | null;
}

interface MutableDamageTaken {
  attackerSlot: number;
  direction: MutableVec3;
  amount: number;
  kind: DamageTakenEvent["kind"];
}

/** Internal per-actor record. Bots own body + brain + equipment state; external actors mirror their host. */
class MatchActor {
  readonly slot: number;
  readonly team: number;
  readonly kind: ActorKind;
  readonly name: string;
  readonly member: number;
  readonly external: MatchExternalActor | null;
  body: PlayerBody | null = null;
  brain: BotBrain | null = null;
  readonly out: BotTickOutput;
  move: MoveState = createMoveState();
  weapon: WeaponState;
  equip: PlayerEquipmentState;
  modifiers: EquipmentModifiers;
  fireLatched = false;
  prevButtons = 0;
  prevSelect = 0;
  prevCycle = false;
  prevHolster = false;
  /** Slot this actor is reviving, or -1. */
  revivingSlot = -1;
  lastShotTick = -1;
  nearMissTick = -1;
  /** Vitals life as of the last sync (external transitions are detected against it). */
  life: Vitals["life"] = "alive";
  readonly feet: MutableVec3 = { x: 0, y: 0, z: 0 };
  readonly eye: MutableVec3 = { x: 0, y: 0, z: 0 };
  velocity: MutableVec3 = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  stance: Stance = "stand";
  grounded = true;
  sprinting = false;
  adsBlend = 0;
  externalWeaponId: WeaponId | null = null;
  readonly state: Mutable<ActorState>;
  readonly snapshot: Mutable<ActorSnapshot>;
  readonly mate: Mutable<TeammateView>;
  readonly hitPose: HitPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, stanceBlend: 0 };
  readonly shapes = new Float64Array(RIG_BUFFER_LENGTH);
  poseDirty = true;
  readonly entity: { id: number; team: number; feet: MutableVec3; posture: WorldEntity["posture"]; eye: MutableVec3; viewDir: MutableVec3 };
  readonly damageTaken: MutableDamageTaken[] = [];
  private readonly damagePool: MutableDamageTaken[] = [];
  readonly teammates: TeammateView[] = [];
  readonly others: ActorSnapshot[] = [];
  view: Mutable<BotWorldView> | null = null;
  selfView: Mutable<BotSelfView> | null = null;
  readonly externalPose: ExternalActorPose;

  constructor(slot: number, team: number, member: number, kind: ActorKind, name: string, external: MatchExternalActor | null, inventory: InventoryState) {
    this.slot = slot;
    this.team = team;
    this.member = member;
    this.kind = kind;
    this.name = name;
    this.external = external;
    this.equip = createPlayerEquipment(inventory);
    this.weapon = weaponStateFromInventory(inventory, LOADOUT);
    this.modifiers = deriveEquipmentModifiers(this.equip);
    this.out = {
      input: { tick: 0, forward: 0, right: 0, buttons: 0, select: 0, yawQ: 0, pitchQ: quantizePitch(0), viewOffset8: 0, action: null },
      intents: { cycleThrowable: false, holster: false, replaceSlot: -1, reviveSlot: -1 },
    };
    this.state = {
      slot,
      team,
      kind,
      name,
      life: "alive",
      health: VITALS.maxHealth,
      downedHealth: 0,
      boost: 0,
      feet: this.feet,
      velocity: this.velocity,
      yaw: 0,
      pitch: 0,
      stance: "stand",
      grounded: true,
      sprinting: false,
      adsBlend: 0,
      weaponId: null,
      helmetLevel: 0,
      vestLevel: 0,
      usingItem: false,
      reviveProgress: 0,
      reviverSlot: -1,
      kills: 0,
      knocks: 0,
      damageDealt: 0,
      deathTick: -1,
    };
    this.snapshot = { slot, team, life: "alive", feet: this.feet, eye: this.eye, velocity: this.velocity, yaw: 0, pitch: 0, stance: "stand", sprinting: false, adsBlend: 0, weaponId: null, lastShotTick: -1 };
    this.mate = { ...this.snapshot, kind, health: VITALS.maxHealth, downedHealth: 0, reviverSlot: -1, healCount: 0 };
    this.entity = { id: slot, team, feet: this.feet, posture: "stand", eye: this.eye, viewDir: { x: 0, y: 0, z: 1 } };
    this.externalPose = { feet: { x: 0, y: 0, z: 0 }, eye: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, stance: "stand", grounded: true, sprinting: false, adsBlend: 0, weaponId: null };
  }

  get vitals(): Vitals {
    return this.external ? this.external.vitals : this.equip.vitals;
  }

  get armor(): ArmorLoadout {
    return this.external ? this.external.armor : armorLoadout(this.equip.inventory);
  }

  pushDamageTaken(attacker: number, dx: number, dy: number, dz: number, amount: number, kind: DamageTakenEvent["kind"]): void {
    let entry = this.damagePool[this.damageTaken.length];
    if (!entry) {
      entry = { attackerSlot: -1, direction: { x: 0, y: 0, z: 0 }, amount: 0, kind: "bullet" };
      this.damagePool.push(entry);
    }
    entry.attackerSlot = attacker;
    entry.direction.x = dx;
    entry.direction.y = dy;
    entry.direction.z = dz;
    entry.amount = amount;
    entry.kind = kind;
    this.damageTaken.push(entry);
  }

  ensurePose(): Float64Array {
    if (this.poseDirty) {
      const p = this.hitPose;
      p.x = this.feet.x;
      p.y = this.feet.y;
      p.z = this.feet.z;
      p.yaw = this.yaw;
      p.pitch = this.pitch;
      p.stanceBlend = stanceBlendOf(this.stance);
      poseHitboxes(p, this.shapes);
      this.poseDirty = false;
    }
    return this.shapes;
  }
}

/** Headless equipment: the match's own EquipmentWorld. */
class OwnEquipment implements MatchSimEquipment {
  readonly world: EquipmentWorld;
  private readonly raycast: RaycastFn;
  constructor(seed: number, raycast: RaycastFn) {
    this.world = createEquipmentWorld(seed);
    this.raycast = raycast;
  }
  get smokes() {
    return this.world.smokes;
  }
  spawnRelease(release: Parameters<MatchEquipmentPort["spawnRelease"]>[0], slot: number): number {
    return spawnRelease(this.world, release, slot, slot, this.raycast);
  }
}

/** Writable ExternalDamageResult reused by `damageActor`. */
type MutableDamageResult = Mutable<ExternalDamageResult>;

export class MatchSim implements MatchView {
  readonly config: BrMatchConfig;
  readonly state: MatchState;
  readonly schedule: BrPhaseSchedule;
  readonly stats: MatchSimStats = { ticks: 0, brainMs: 0, simMs: 0, brainTotalMs: 0, simTotalMs: 0, shots: 0, projectilesAlive: 0 };
  /** Last 256 events, oldest first (DEV `events(n)`). */
  readonly recentEvents: MatchEvent[] = [];

  private readonly ports: MatchSimPorts;
  private readonly mutableState: Mutable<MatchState>;
  private readonly actorsBySlot: (MatchActor | undefined)[] = [];
  private readonly order: MatchActor[] = [];
  private readonly actorStates: (Mutable<ActorState> | undefined)[] = [];
  private readonly teams: MutableTeamState[];
  private readonly zonePhases: ZonePhase[] = [];
  private readonly zone: MutableZoneState;
  private readonly projectiles = new ProjectileBuffer();
  private readonly equipment: MatchSimEquipment;
  private readonly ownEquipment: OwnEquipment | null;
  private readonly eventListeners: ((event: MatchEvent) => void)[] = [];
  private readonly fxListeners: ((event: MatchFxEvent) => void)[] = [];
  private readonly killY: number;
  private readonly profile: boolean;
  private readonly navBudget: number;
  private readonly spawnFeet: { feet: Vec3; yaw: number }[] = [];
  private nextTick: number;
  private started = false;
  private endResult: BrEndResult | null = null;
  // Noises: brains read `noises` (last tick's), steps write `pendingNoises`.
  private noises: MutableNoise[] = [];
  private pendingNoises: MutableNoise[] = [];
  private noisePoolA: MutableNoise[] = [];
  private noisePoolB: MutableNoise[] = [];
  private readonly throwableViews: Mutable<ThrowableView>[] = [];
  private throwablesView: ThrowableView[] = [];
  private readonly worldEntities: WorldEntity[] = [];
  private readonly worldEvents: EquipmentWorldEvent[] = [];
  private readonly ruleEvents: MatchEvent[] = [];
  private readonly wipes: number[] = [];
  private readonly segment = new Float64Array(7);
  private readonly rigHit: MutableRigHit = { t: 0, shape: 0, zone: "body" };
  private readonly from: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly to: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly equipmentInput: Mutable<EquipmentInput> = {
    fire: false,
    firePressed: false,
    aim: false,
    reloadPressed: false,
    jumpPressed: false,
    sprint: false,
    equipThrowablePressed: false,
    cycleThrowablePressed: false,
    holsterPressed: false,
    weaponSelectPressed: false,
    useItem: null,
  };
  private readonly equipmentContext: { eye: Vec3; yaw: number; pitch: number; velocity: Vec3 } = { eye: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, velocity: { x: 0, y: 0, z: 0 } };
  private readonly combatInput = createCombatInput();
  private readonly weaponContext = createWeaponContext();
  private readonly damageResult: MutableDamageResult = { dealt: 0, remainingHealth: 0, knocked: false, killed: false, armorAbsorbed: 0, armorSlot: null, armorDestroyed: false };
  private readonly queryLoot = (center: Vec3, radius: number, out: LootItem[]): number => queryGroundLootInto(this.ports.groundLoot, center, radius, out);
  private readonly actorOnSegmentBound = (from: Vec3, to: Vec3, excludeSlot: number): number => this.actorOnSegment(from, to, excludeSlot);

  constructor(options: MatchSimOptions) {
    const { config, ports } = options;
    this.config = config;
    this.ports = ports;
    this.killY = options.killY ?? -40;
    this.profile = options.profile ?? false;
    this.navBudget = options.navExpansionsPerTick ?? BOT_SCHEDULE.navExpansionsPerTick;
    this.nextTick = options.startTick ?? 0;
    this.schedule = brPhaseSchedule(config, this.nextTick);
    this.ownEquipment = ports.equipment ? null : new OwnEquipment(config.seed, ports.raycastWorld);
    this.equipment = ports.equipment ?? this.ownEquipment!;
    this.zone = createZoneState(config.zone);
    for (let i = 0; i < NOISE_POOL; i++) {
      this.noisePoolA.push({ kind: "footstep", sourceSlot: -1, position: { x: 0, y: 0, z: 0 }, radius: 0, weaponId: null });
      this.noisePoolB.push({ kind: "footstep", sourceSlot: -1, position: { x: 0, y: 0, z: 0 }, radius: 0, weaponId: null });
    }
    for (let i = 0; i < THROWABLE_VIEW_POOL; i++) this.throwableViews.push({ id: 0, ownerSlot: 0, kind: "frag", position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, atRest: false });

    const externals = new Map((ports.external ?? []).map((e) => [e.slot, e]));
    for (const cfg of config.actors) {
      const external = externals.get(cfg.slot) ?? null;
      if (cfg.kind === "human" && !external) throw new Error(`MatchSim: human slot ${cfg.slot} has no external actor`);
      if (cfg.kind === "bot" && external) throw new Error(`MatchSim: external actor on bot slot ${cfg.slot}`);
      const member = cfg.slot - cfg.team * config.teamSize;
      const plan = options.spawns.find((p) => p.team === cfg.team);
      const feet = plan?.feet[member] ?? plan?.feet[0];
      if (!feet || !plan) throw new Error(`MatchSim: no spawn for team ${cfg.team} member ${member}`);
      this.spawnFeet[cfg.slot] = { feet, yaw: plan.yaw };
      const inventory = cfg.kind === "bot" ? (options.inventoryFor?.(cfg.slot) ?? createInventory()) : createInventory();
      const actor = new MatchActor(cfg.slot, cfg.team, member, cfg.kind, cfg.name, external, inventory);
      actor.feet.x = feet.x;
      actor.feet.y = feet.y;
      actor.feet.z = feet.z;
      actor.yaw = plan.yaw;
      if (cfg.kind === "bot") {
        actor.body = ports.createBody(feet);
        actor.brain = ports.brainFactory({ slot: cfg.slot, team: cfg.team, seed: config.seed, profile: ports.profileFor(cfg.difficulty ?? "normal") });
        actor.brain.reset(plan.yaw);
        actor.out.input.yawQ = quantizeYaw(plan.yaw);
      }
      this.actorsBySlot[cfg.slot] = actor;
      this.actorStates[cfg.slot] = actor.state;
      this.order.push(actor);
    }
    this.order.sort((a, b) => a.slot - b.slot);
    for (const actor of this.order) {
      this.syncEye(actor);
      this.syncActorState(actor);
    }
    for (const actor of this.order) if (actor.brain) this.buildView(actor);
    this.teams = createTeamStates(config);

    this.mutableState = {
      tick: this.nextTick,
      phase: "warmup",
      phaseStartTick: this.nextTick,
      phaseEndTick: this.schedule.warmupEndTick,
      combatStartTick: -1,
      zone: this.zone,
      zonePhases: this.zonePhases,
      teams: this.teams,
      actors: this.actorStates as readonly ActorState[],
      teamsInPlay: countTeamsInPlay(this.teams),
      actorsInPlay: this.order.length,
      winnerTeam: null,
      endReason: null,
    };
    this.state = this.mutableState;
  }

  // ---- MatchView ----------------------------------------------------------------------------------------------------

  onEvent(listener: (event: MatchEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const i = this.eventListeners.indexOf(listener);
      if (i >= 0) this.eventListeners.splice(i, 1);
    };
  }

  onFx(listener: (event: MatchFxEvent) => void): () => void {
    this.fxListeners.push(listener);
    return () => {
      const i = this.fxListeners.indexOf(listener);
      if (i >= 0) this.fxListeners.splice(i, 1);
    };
  }

  /** Ended and the linger is over: the host can stop ticking. */
  get finished(): boolean {
    return this.mutableState.phase === "ended" && this.nextTick > this.mutableState.phaseEndTick;
  }

  /** Where a slot starts (the host places the human there before the countdown). */
  spawnOf(slot: number): { readonly feet: Vec3; readonly yaw: number } | null {
    return this.spawnFeet[slot] ?? null;
  }

  brainOf(slot: number): BotBrain | null {
    return this.actorsBySlot[slot]?.brain ?? null;
  }

  bodyOf(slot: number): PlayerBody | null {
    return this.actorsBySlot[slot]?.body ?? null;
  }

  /** Bot vitals (the human's live in the host). */
  vitalsOf(slot: number): Vitals | null {
    return this.actorsBySlot[slot]?.vitals ?? null;
  }

  inventoryOf(slot: number): InventoryState | null {
    const actor = this.actorsBySlot[slot];
    return actor && !actor.external ? actor.equip.inventory : null;
  }

  weaponStateOf(slot: number): WeaponState | null {
    const actor = this.actorsBySlot[slot];
    return actor && !actor.external ? actor.weapon : null;
  }

  /** The input a bot's brain wrote this tick (after the warmup freeze and revive rooting), or null. */
  inputOf(slot: number): PlayerInput | null {
    const actor = this.actorsBySlot[slot];
    return actor?.brain ? actor.out.input : null;
  }

  /** The bot's world view as its brain last saw it (DEV). */
  viewOf(slot: number): BotWorldView | null {
    return this.actorsBySlot[slot]?.view ?? null;
  }

  /** Posed rig shapes of a slot this tick (debug overlay), or null for the dead. */
  hitboxesOf(slot: number): Float64Array | null {
    const actor = this.actorsBySlot[slot];
    return actor && actor.state.life !== "dead" ? actor.ensurePose() : null;
  }

  /**
   * A downed bot's vitals written by someone outside the match (the human holding F: EquipmentSystem's ReviveTarget).
   * Emits reviveStarted / reviveCancelled / revived from the reviver transitions.
   */
  setBotVitals(slot: number, vitals: Vitals): void {
    const actor = this.actorsBySlot[slot];
    if (!actor || actor.external) return;
    const before = actor.equip.vitals;
    actor.equip = { ...actor.equip, vitals };
    const tick = this.mutableState.tick;
    if (before.life === "downed" && vitals.life === "alive") this.emit({ type: "revived", tick, reviver: before.reviverId, target: slot });
    else if (vitals.reviverId >= 0 && before.reviverId !== vitals.reviverId) this.emit({ type: "reviveStarted", tick, reviver: vitals.reviverId, target: slot });
    else if (vitals.reviverId < 0 && before.reviverId >= 0 && vitals.life === "downed") this.emit({ type: "reviveCancelled", tick, reviver: before.reviverId, target: slot });
    this.syncActorState(actor);
  }

  /**
   * Damage from an externally simulated shooter (the human's bullets and grenades on bots). Runs the same pipeline as
   * bot bullets: armor, knock/kill by team state, events, team wipes. Null when ignored (dead victim, no damage).
   */
  damageActor(damage: ExternalDamage): ExternalDamageResult | null {
    const victim = this.actorsBySlot[damage.victim];
    if (!victim) return null;
    if (damage.attacker >= 0 && damage.attacker !== damage.victim && !this.config.rules.friendlyFire && this.actorsBySlot[damage.attacker]?.team === victim.team) return null;
    const d = damage.direction;
    return this.applyDamageTo(victim, damage.amount, damage.kind, damage.zone, damage.attacker, damage.weaponId, damage.position, d.x, d.y, d.z);
  }

  /** First actor slot other than `excludeSlot` whose rig the segment crosses (nearest), or -1. */
  actorOnSegment(from: Vec3, to: Vec3, excludeSlot: number): number {
    let best = 2;
    let bestSlot = -1;
    for (const actor of this.order) {
      if (actor.slot === excludeSlot || actor.state.life === "dead") continue;
      if (!segmentNearRig(actor.feet.x, actor.feet.y, actor.feet.z, from.x, from.y, from.z, to.x, to.y, to.z)) continue;
      if (segmentVsRigInto(actor.ensurePose(), from.x, from.y, from.z, to.x, to.y, to.z, this.rigHit) && this.rigHit.t < best) {
        best = this.rigHit.t;
        bestSlot = actor.slot;
      }
    }
    return bestSlot;
  }

  // ---- DEV ----------------------------------------------------------------------------------------------------------

  /** DEV: kills a slot outright (cause "unknown", no killer). */
  killActor(slot: number): void {
    const actor = this.actorsBySlot[slot];
    if (!actor || actor.state.life === "dead") return;
    if (actor.external) {
      this.applyDamageTo(actor, 100_000, "bleed", null, -1, null, actor.feet, 0, -1, 0);
      if (actor.state.life === "downed") this.applyDamageTo(actor, 100_000, "bleed", null, -1, null, actor.feet, 0, -1, 0);
      return;
    }
    const knockedBy = actor.equip.vitals.knockedById;
    actor.equip = { ...actor.equip, vitals: eliminate(actor.equip.vitals) };
    this.onDeath(actor, -1, "unknown", false, actor.state.life === "downed" ? knockedBy : -1);
    this.resolveTeamWipes();
  }

  /** DEV: jumps the match clock to the next zone announcement or shrink start (match ticks, not the host's). */
  skipZone(): void {
    const s = this.mutableState;
    if (s.phase !== "combat") return;
    const current = this.zonePhases.at(-1);
    let target: number;
    if (!current || this.nextTick >= current.shrinkEndTick) target = current ? current.shrinkEndTick : this.schedule.combatStartTick + secondsToTicks(this.config.zone.firstAnnounceSeconds, this.config.timeScale);
    else if (this.nextTick < current.shrinkStartTick) target = current.shrinkStartTick;
    else target = current.shrinkEndTick;
    if (target > this.nextTick) this.nextTick = target;
  }

  /** DEV: places a bot's body (feet) and stops its velocity. */
  placeActor(slot: number, feet: Vec3): void {
    const actor = this.actorsBySlot[slot];
    if (!actor?.body) return;
    actor.body.restore(feet, { x: 0, y: 0, z: 0 }, actor.move.stance);
    actor.move = { ...actor.move, velocity: { x: 0, y: 0, z: 0 } };
    this.syncFromBody(actor);
  }

  dispose(): void {
    for (const actor of this.order) actor.body?.dispose();
    this.eventListeners.length = 0;
    this.fxListeners.length = 0;
  }

  // ---- Tick ---------------------------------------------------------------------------------------------------------

  /** One 60 Hz match tick (design.md §2.3). */
  tick(): void {
    const tick = this.nextTick++;
    const s = this.mutableState;
    s.tick = tick;
    this.stats.ticks++;
    if (!this.started) {
      this.started = true;
      this.emit({ type: "phaseChanged", tick, phase: "warmup", endTick: this.schedule.warmupEndTick });
    }
    if (s.phase === "ended") return;

    const t0 = this.profile ? performance.now() : 0;
    // 1. Rules pre-step.
    this.stepPhases(tick);
    if (this.endResult) return;
    if (s.phase === "combat") this.stepZoneSchedule(tick);
    zoneAtInto(this.config.zone, this.zonePhases, tick, this.zone);
    this.swapNoises();

    // 2. External actors.
    for (const actor of this.order) if (actor.external) this.readExternal(actor, tick);

    // 3. Brains.
    const t1 = this.profile ? performance.now() : 0;
    this.collectThrowables();
    const frozen = s.phase !== "combat";
    for (const actor of this.order) {
      if (!actor.brain || actor.state.life === "dead") continue;
      this.fillView(actor, tick);
      actor.brain.tick(actor.view!, actor.out);
      actor.damageTaken.length = 0;
      if (frozen) freezeInput(actor.out);
    }
    // Time-sliced path searches for every bot together (design.md §3.3); results are read by next tick's brains.
    this.ports.nav.update(this.navBudget);
    const t2 = this.profile ? performance.now() : 0;

    // 4. Bot sim steps.
    for (const actor of this.order) {
      if (!actor.body || actor.state.life === "dead") continue;
      this.stepBot(actor, tick, frozen);
    }

    // 5. Projectiles.
    this.stepProjectiles(tick);

    // 6. Equipment world (headless only).
    if (this.ownEquipment) this.stepOwnEquipment(tick);

    // 7. Vitals and teams.
    if (s.phase === "combat") this.stepZoneDamage(tick);
    for (const actor of this.order) {
      if (actor.body && actor.state.life !== "dead" && actor.feet.y < this.killY) {
        const knockedBy = actor.equip.vitals.knockedById;
        const wasDowned = actor.state.life === "downed";
        actor.equip = { ...actor.equip, vitals: eliminate(actor.equip.vitals) };
        this.onDeath(actor, wasDowned ? knockedBy : -1, "outOfBounds", false, wasDowned ? knockedBy : -1);
      }
    }
    this.resolveTeamWipes();
    this.refreshExternalKnockRule();

    // 8. Rules post-step.
    this.postStep(tick);
    if (this.profile) {
      const t3 = performance.now();
      this.stats.brainMs = t2 - t1;
      this.stats.simMs = t3 - t0 - (t2 - t1);
      this.stats.brainTotalMs += this.stats.brainMs;
      this.stats.simTotalMs += this.stats.simMs;
    }
    this.stats.projectilesAlive = this.projectiles.count;
  }

  private stepPhases(tick: number): void {
    const s = this.mutableState;
    const sch = this.schedule;
    if (s.phase === "warmup" && tick >= sch.warmupEndTick) this.setPhase("landing", tick, sch.landingEndTick);
    if (s.phase === "landing" && tick >= sch.landingEndTick) this.setPhase("glide", tick, sch.combatStartTick);
    if (s.phase === "glide" && tick >= sch.combatStartTick) {
      this.setPhase("combat", tick, -1);
      s.combatStartTick = tick;
    }
    if (s.phase === "combat" && tick >= sch.timeCapTick && !this.endResult) {
      refreshTeamCounts(this.teams, this.actorStates);
      this.ruleEvents.length = 0;
      this.end(resolveTimeCap(this.teams, this.actorStates, tick, this.ruleEvents), tick);
    }
  }

  private setPhase(phase: BrPhase, tick: number, endTick: number): void {
    const s = this.mutableState;
    s.phase = phase;
    s.phaseStartTick = tick;
    s.phaseEndTick = endTick;
    this.emit({ type: "phaseChanged", tick, phase, endTick });
  }

  private stepZoneSchedule(tick: number): void {
    const spec = this.config.zone;
    const last = this.zonePhases.at(-1) ?? null;
    const nextIndex = this.zonePhases.length + 1;
    if (nextIndex <= spec.phases.length) {
      const announceTick = last ? last.shrinkEndTick : this.mutableState.combatStartTick + secondsToTicks(spec.firstAnnounceSeconds, this.config.timeScale);
      if (tick >= announceTick) {
        const phase = computeZonePhase(spec, this.config.seed, nextIndex, last, this.mutableState.combatStartTick, this.config.timeScale, this.ports.isValidZoneCenter ?? null);
        this.zonePhases.push(phase);
        this.emit({ type: "zoneAnnounced", tick, phase });
      }
    }
    const current = this.zonePhases.at(-1);
    if (!current) return;
    if (tick === current.shrinkStartTick) this.emit({ type: "zoneShrinkStarted", tick, phaseIndex: current.index });
    for (const seconds of ZONE_WARNING_SECONDS) {
      const warnTick = current.shrinkStartTick - seconds * SIMULATION.tickRate;
      if (tick === warnTick && warnTick > current.waitStartTick) this.emit({ type: "zoneWarning", tick, phaseIndex: current.index, secondsLeft: seconds });
    }
  }

  private stepZoneDamage(tick: number): void {
    const spec = this.config.zone;
    const zone = this.zone;
    if (zone.dps <= 0 || (tick - this.mutableState.combatStartTick) % spec.damageIntervalTicks !== 0) return;
    const amount = zoneTickDamage(spec, zone.dps);
    for (const actor of this.order) {
      if (actor.state.life === "dead" || !isOutsideZone(zone.current, actor.feet.x, actor.feet.z)) continue;
      this.applyDamageTo(actor, amount, "zone", null, -1, null, actor.feet, 0, -1, 0);
    }
  }

  private postStep(tick: number): void {
    const s = this.mutableState;
    refreshTeamCounts(this.teams, this.actorStates);
    if (s.phase !== "ended") {
      this.ruleEvents.length = 0;
      const result = resolveEliminations(this.teams, tick, this.ruleEvents);
      if (result) this.end(result, tick);
      else for (const event of this.ruleEvents) this.emit(event);
    }
    let actorsInPlay = 0;
    for (const actor of this.order) if (actor.state.life !== "dead") actorsInPlay++;
    s.actorsInPlay = actorsInPlay;
    s.teamsInPlay = countTeamsInPlay(this.teams);
  }

  private end(result: BrEndResult, tick: number): void {
    const s = this.mutableState;
    this.endResult = result;
    s.winnerTeam = result.winnerTeam;
    s.endReason = result.reason;
    s.phase = "ended";
    s.phaseStartTick = tick;
    s.phaseEndTick = tick + secondsToTicks(this.config.timings.endLingerSeconds, this.config.timeScale);
    s.teamsInPlay = countTeamsInPlay(this.teams);
    for (const event of this.ruleEvents) this.emit(event);
    this.emit({ type: "phaseChanged", tick, phase: "ended", endTick: s.phaseEndTick });
    this.ruleEvents.length = 0;
    this.projectiles.clear();
  }

  // ---- Actors -------------------------------------------------------------------------------------------------------

  private readExternal(actor: MatchActor, tick: number): void {
    const ext = actor.external!;
    const pose = actor.externalPose;
    ext.readPose(pose);
    actor.feet.x = pose.feet.x;
    actor.feet.y = pose.feet.y;
    actor.feet.z = pose.feet.z;
    actor.eye.x = pose.eye.x;
    actor.eye.y = pose.eye.y;
    actor.eye.z = pose.eye.z;
    actor.velocity.x = pose.velocity.x;
    actor.velocity.y = pose.velocity.y;
    actor.velocity.z = pose.velocity.z;
    actor.yaw = pose.yaw;
    actor.pitch = pose.pitch;
    actor.stance = pose.stance;
    actor.grounded = pose.grounded;
    actor.sprinting = pose.sprinting;
    actor.adsBlend = pose.adsBlend;
    actor.externalWeaponId = pose.weaponId;
    actor.poseDirty = true;

    // Life changes the host made on its own (fall, own grenade, bleed-out, a teammate's revive).
    const vitals = ext.vitals;
    const before = actor.life;
    if (vitals.life !== before && before !== "dead") {
      actor.life = vitals.life;
      if (before === "downed" && vitals.life === "alive") {
        for (const other of this.order) {
          if (other.revivingSlot === actor.slot) {
            this.emit({ type: "revived", tick, reviver: other.slot, target: actor.slot });
            other.revivingSlot = -1;
          }
        }
      } else if (vitals.life === "downed") {
        this.emit({ type: "knock", tick, attacker: vitals.knockedById, victim: actor.slot, cause: "unknown", headshot: false });
      } else if (vitals.life === "dead") {
        this.onDeath(actor, before === "downed" ? vitals.knockedById : -1, before === "downed" ? "bleedOut" : "unknown", false, before === "downed" ? vitals.knockedById : -1);
      }
    }
    this.syncActorState(actor);
    // Footsteps and landings of the human are heard by bots too.
    this.footstepNoise(actor, tick);
  }

  private stepBot(actor: MatchActor, tick: number, frozen: boolean): void {
    const body = actor.body!;
    const input = actor.out.input as Mutable<PlayerInput>;
    const intents = actor.out.intents;
    const alive = actor.state.life === "alive";

    // Revive holds root the reviver (like the client's equipment gates).
    const reviveTarget = alive && (input.buttons & Btn.interact) !== 0 && intents.reviveSlot >= 0 ? this.actorsBySlot[intents.reviveSlot] : undefined;
    if (reviveTarget && reviveTarget.state.life === "downed") {
      input.forward = 0;
      input.right = 0;
    }

    // 4.1 Movement with gates from the start-of-tick equipment state.
    const gates = deriveEquipmentModifiers(actor.equip);
    STEP_OPTIONS_GATES.gates = gates;
    const previous = actor.move;
    const step = stepPlayer(body, { move: previous, weapon: actor.weapon }, input, DT, STEP_OPTIONS_GATES);
    actor.move = step.state.move;
    this.syncFromBody(actor);
    for (const event of step.events) {
      if (event.type === "landed") {
        const damage = fallDamage(event.fallSpeed);
        const radius = landNoiseRadius(event.fallSpeed);
        if (radius > 0) this.addNoise("land", actor.slot, actor.feet, radius, null);
        if (damage > 0 && !frozen) this.applyDamageTo(actor, damage, "fall", null, -1, null, actor.feet, 0, -1, 0);
      }
    }
    if (actor.state.deathTick >= 0) return;

    // 4.2 Equipment.
    const buttons = input.buttons;
    const prev = actor.prevButtons;
    const select = input.select;
    const eq = this.equipmentInput;
    eq.fire = (buttons & Btn.fire) !== 0;
    eq.firePressed = eq.fire && (prev & Btn.fire) === 0;
    eq.aim = (buttons & Btn.aim) !== 0;
    eq.reloadPressed = (buttons & Btn.reload) !== 0 && (prev & Btn.reload) === 0;
    eq.jumpPressed = (buttons & Btn.jump) !== 0 && (prev & Btn.jump) === 0;
    eq.sprint = (buttons & Btn.sprint) !== 0 && input.forward > 0;
    eq.equipThrowablePressed = select === 5 && actor.prevSelect !== 5;
    eq.cycleThrowablePressed = intents.cycleThrowable && !actor.prevCycle;
    eq.holsterPressed = intents.holster && !actor.prevHolster;
    eq.weaponSelectPressed = select >= 1 && select <= 3 && select !== actor.prevSelect;
    eq.useItem = input.action?.type === PlayerActionType.use ? consumableOfCode(input.action.arg) : null;
    const ctx = this.equipmentContext;
    ctx.eye = actor.eye;
    ctx.yaw = actor.yaw;
    ctx.pitch = actor.pitch;
    ctx.velocity = actor.velocity;
    const before = actor.equip;
    const equipStep = stepPlayerEquipment(before, eq, ctx, DT);
    actor.equip = equipStep.state;
    for (const event of equipStep.events) {
      switch (event.type) {
        case "bledOut":
          this.syncActorState(actor);
          this.onDeath(actor, event.killerId, "bleedOut", false, event.killerId);
          break;
        case "useStarted":
          this.addNoise("heal", actor.slot, actor.feet, NOISE_RADII.heal, null);
          this.fx({ type: "itemUse", tick, slot: actor.slot, phase: "started" });
          break;
        case "useCancelled":
          this.fx({ type: "itemUse", tick, slot: actor.slot, phase: "cancelled" });
          break;
        case "useCompleted":
          this.fx({ type: "itemUse", tick, slot: actor.slot, phase: "completed" });
          break;
        case "pinPulled":
          this.addNoise("reload", actor.slot, actor.feet, NOISE_RADII.pin, null);
          break;
      }
    }
    if (actor.state.deathTick >= 0 || actor.equip.vitals.life === "dead") {
      this.syncActorState(actor);
      return;
    }
    if (equipStep.release) {
      this.equipment.spawnRelease(equipStep.release, actor.slot);
      this.fx({ type: "throwRelease", tick, slot: actor.slot, kind: equipStep.release.kind });
    }

    // 4.3 Weapons.
    const synced = syncWeaponsFromInventory(actor.weapon, actor.equip.inventory, LOADOUT);
    for (const event of synced.events) this.fx({ type: "weapon", tick, slot: actor.slot, event });
    actor.modifiers = deriveEquipmentModifiers(actor.equip);
    // The weapon half of stepPlayer, run after equipment so its gates and inventory changes apply this tick.
    const raw = combatInputInto(this.combatInput, input);
    const reviving = reviveTarget !== undefined && reviveTarget.state.life === "downed";
    const gated = gateCombatInput(raw, actor.modifiers.allowWeapons && !reviving, actor.fireLatched);
    actor.fireLatched = gated.fireLatched;
    const wctx = weaponContextInto(this.weaponContext, actor.feet, actor.move, input);
    const fired = stepPlayerWeapon(synced.state, gated.input, wctx, DT, false);
    const inventory = commitWeaponsToInventory(synced.state, fired.state, actor.equip.inventory, LOADOUT);
    if (inventory !== actor.equip.inventory) actor.equip = { ...actor.equip, inventory };
    actor.weapon = fired.state;
    for (const event of fired.events) {
      if (event.type === "reloadStarted") this.addNoise("reload", actor.slot, actor.feet, NOISE_RADII.reload, null);
      this.fx({ type: "weapon", tick, slot: actor.slot, event });
    }
    for (const shot of fired.shots) {
      this.projectiles.spawnShot(shot, actor.slot);
      this.stats.shots++;
      actor.lastShotTick = tick;
      actor.brain?.kickAim(shot.recoilUp, shot.recoilRight);
      this.addNoise("shot", actor.slot, shot.origin, shotNoiseRadius(shot.weaponId), shot.weaponId);
      this.fx({ type: "shot", tick, slot: actor.slot, shot });
    }

    // 4.4 Actions.
    const action = input.action;
    if (action && alive && !frozen) {
      if (action.type === PlayerActionType.pickup) this.pickUpFor(actor, action.arg, intents.replaceSlot);
      else if (action.type === PlayerActionType.drop) this.dropFor(actor, action.arg);
    }

    // 4.5 Revive.
    if (alive) this.stepReviveFor(actor, reviving ? reviveTarget! : null, tick);

    this.footstepNoise(actor, tick);
    actor.prevButtons = buttons;
    actor.prevSelect = select;
    actor.prevCycle = intents.cycleThrowable;
    actor.prevHolster = intents.holster;
    this.syncActorState(actor);
  }

  private pickUpFor(actor: MatchActor, lootId: number, replaceSlot: -1 | 0 | 1 | 2): void {
    const ground = this.ports.groundLoot;
    const item = ground.items.get(lootId);
    if (!item) return;
    const [x, y, z] = item.position;
    const dx = x - actor.eye.x;
    const dy = y - actor.eye.y;
    const dz = z - actor.eye.z;
    if (dx * dx + dy * dy + dz * dz > (INTERACT.reach + PICKUP_SLACK) ** 2) return;
    this.to.x = x;
    this.to.y = y + 0.15;
    this.to.z = z;
    if (this.ports.raycastWorld(actor.eye, this.to)) return;
    const instance: ItemInstance = { itemId: item.itemId, quantity: item.quantity, ...(item.durability !== undefined ? { durability: item.durability } : {}), ...(item.magazine !== undefined ? { magazine: item.magazine } : {}) };
    const result = pickUp(actor.equip.inventory, instance, replaceSlot >= 0 ? (replaceSlot as WeaponSlot) : undefined);
    if (!result.ok) return;
    actor.equip = { ...actor.equip, inventory: result.inventory };
    setGroundQuantity(ground, lootId, result.remainder?.quantity ?? 0);
    for (const dropped of result.dropped) dropGroundItem(ground, dropped, item.position);
  }

  private dropFor(actor: MatchActor, arg: number): void {
    const target = decodeDropArg(arg);
    if (!target) return;
    const inventory = actor.equip.inventory;
    let result;
    if (target.kind === "stack") {
      const itemId = ITEM_IDS[target.code];
      if (!itemId) return;
      const def = ITEMS[itemId];
      if (def.category !== "ammo" && def.category !== "throwable" && def.category !== "heal" && def.category !== "boost") return;
      const carried = inventory.stacks.find((s) => s.itemId === itemId)?.quantity ?? 0;
      const quantity = target.quantity > 0 ? Math.min(target.quantity, carried) : carried;
      if (quantity <= 0) return;
      result = dropFromInventory(inventory, { kind: "stack", itemId: def.id, quantity });
    } else {
      result = dropFromInventory(inventory, target);
    }
    if (!result.ok) return;
    actor.equip = { ...actor.equip, inventory: result.inventory };
    const angle = (this.ports.groundLoot.nextId * 2.399) % (Math.PI * 2);
    dropGroundItem(this.ports.groundLoot, result.dropped, [actor.feet.x + Math.sin(angle) * 0.5, actor.feet.y, actor.feet.z + Math.cos(angle) * 0.5]);
  }

  private stepReviveFor(actor: MatchActor, target: MatchActor | null, tick: number): void {
    const handsFree = actor.equip.use.itemId === null && actor.equip.throw.phase === "idle";
    let active = false;
    if (target && handsFree && target.team === actor.team && target.slot !== actor.slot && target.state.life === "downed") {
      const dx = target.feet.x - actor.feet.x;
      const dz = target.feet.z - actor.feet.z;
      active = dx * dx + dz * dz <= VITALS.reviveRange * VITALS.reviveRange && Math.abs(target.feet.y - actor.feet.y) <= REVIVE_HEIGHT;
    }
    // Stop a revive on someone else (or letting go).
    if (actor.revivingSlot >= 0 && (!active || actor.revivingSlot !== target!.slot)) this.cancelRevive(actor, tick);
    if (!active || !target) return;

    if (target.external) {
      if (actor.revivingSlot !== target.slot && target.external.vitals.reviverId < 0) {
        actor.revivingSlot = target.slot;
        target.external.setReviver(actor.slot);
        this.emit({ type: "reviveStarted", tick, reviver: actor.slot, target: target.slot });
      }
      return;
    }
    const step = stepRevive(target.equip.vitals, actor.slot, true, DT);
    target.equip = { ...target.equip, vitals: step.target };
    if (step.event?.type === "reviveStarted") {
      actor.revivingSlot = target.slot;
      this.emit({ type: "reviveStarted", tick, reviver: actor.slot, target: target.slot });
    } else if (step.event?.type === "revived") {
      actor.revivingSlot = -1;
      this.emit({ type: "revived", tick, reviver: actor.slot, target: target.slot });
    } else if (step.target.reviverId !== actor.slot) {
      actor.revivingSlot = -1;
    }
    this.syncActorState(target);
  }

  private cancelRevive(actor: MatchActor, tick: number): void {
    const target = this.actorsBySlot[actor.revivingSlot];
    actor.revivingSlot = -1;
    if (!target) return;
    if (target.external) {
      target.external.setReviver(null);
      if (target.state.life === "downed") this.emit({ type: "reviveCancelled", tick, reviver: actor.slot, target: target.slot });
      return;
    }
    const step = stepRevive(target.equip.vitals, actor.slot, false, 0);
    if (step.event?.type === "reviveCancelled") {
      target.equip = { ...target.equip, vitals: step.target };
      this.emit({ type: "reviveCancelled", tick, reviver: actor.slot, target: target.slot });
      this.syncActorState(target);
    }
  }

  // ---- Damage -------------------------------------------------------------------------------------------------------

  private applyDamageTo(
    victim: MatchActor,
    amount: number,
    kind: DamageKind,
    zone: VitalsHit["zone"],
    attacker: number,
    weaponId: WeaponId | null,
    position: Vec3,
    dirX: number,
    dirY: number,
    dirZ: number,
  ): ExternalDamageResult | null {
    if (victim.state.life === "dead" || !(amount > 0)) return null;
    const tick = this.mutableState.tick;
    const wasDowned = victim.state.life === "downed";
    const knockedByBefore = victim.vitals.knockedById;
    const hit: VitalsHit = { amount, kind, zone, sourceId: attacker };
    const ctx = { canBeKnocked: canActorBeKnocked(this.config.rules, victim.slot, victim.team, this.actorStates) };
    let outcome: DamageOutcome | null;
    if (victim.external) {
      outcome = victim.external.applyDamage(hit, ctx, position);
      if (!outcome) return null;
      if (outcome.vitals.life !== "dead") victim.life = outcome.vitals.life;
    } else {
      outcome = applyDamage(victim.equip.vitals, armorLoadout(victim.equip.inventory), hit, ctx);
      victim.equip = { ...victim.equip, vitals: outcome.vitals, inventory: withArmor(victim.equip.inventory, outcome.armor) };
    }
    const armor = outcome.armorResult;
    if (outcome.dealt <= 0 && armor.absorbed <= 0) return null;

    const attackerActor = attacker >= 0 ? this.actorsBySlot[attacker] : undefined;
    const enemy = attackerActor !== undefined && attackerActor.team !== victim.team;
    this.emit({
      type: "damage",
      tick,
      attacker,
      victim: victim.slot,
      amount: outcome.dealt,
      kind,
      zone,
      weaponId,
      armorAbsorbed: armor.absorbed,
      armorSlot: armor.slot,
      armorDestroyed: armor.destroyed,
      position: { x: position.x, y: position.y, z: position.z },
    });
    if (enemy) attackerActor.state.damageDealt = Math.round((attackerActor.state.damageDealt + outcome.dealt) * 10) / 10;
    if (victim.brain) victim.pushDamageTaken(attacker, dirX, dirY, dirZ, outcome.dealt, kind);

    const cause = killCauseOf(kind, weaponId);
    const headshot = zone === "head";
    if (outcome.knocked) {
      this.syncActorState(victim);
      if (victim.revivingSlot >= 0) this.cancelRevive(victim, tick);
      this.emit({ type: "knock", tick, attacker, victim: victim.slot, cause, headshot });
      if (enemy) attackerActor.state.knocks++;
    }
    if (outcome.killed) {
      this.syncActorState(victim);
      this.onDeath(victim, outcome.killerId, cause, headshot, wasDowned ? knockedByBefore : -1);
    }
    this.syncActorState(victim);
    if (outcome.knocked || outcome.killed) this.resolveTeamWipes();

    const r = this.damageResult;
    r.dealt = outcome.dealt;
    r.remainingHealth = outcome.vitals.life === "downed" ? outcome.vitals.downedHealth : outcome.vitals.health;
    r.knocked = outcome.knocked;
    r.killed = outcome.killed;
    r.armorAbsorbed = armor.absorbed;
    r.armorSlot = armor.slot;
    r.armorDestroyed = armor.destroyed;
    return r;
  }

  private onDeath(actor: MatchActor, killer: number, cause: KillCause, headshot: boolean, knockedBy: number): void {
    const tick = this.mutableState.tick;
    if (actor.state.deathTick >= 0) return;
    actor.state.deathTick = tick;
    actor.life = "dead";
    actor.state.life = "dead";
    actor.snapshot.life = "dead";
    actor.mate.life = "dead";
    const killerActor = killer >= 0 ? this.actorsBySlot[killer] : undefined;
    const teamKill = killerActor !== undefined && killer !== actor.slot && killerActor.team === actor.team;
    this.emit({ type: "kill", tick, killer, victim: actor.slot, cause, headshot, knockedBy, teamKill });
    if (killerActor && killerActor.team !== actor.team) {
      killerActor.state.kills++;
      const team = this.teams[killerActor.team];
      if (team) team.kills++;
    }
    if (actor.revivingSlot >= 0) this.cancelRevive(actor, tick);
    for (const other of this.order) if (other.revivingSlot === actor.slot) other.revivingSlot = -1;
    if (actor.external) {
      actor.external.eliminate();
    } else {
      this.dropDeathPile(actor);
    }
    actor.poseDirty = true;
  }

  /** Whole inventory as one ground pile at the feet (design.md §8.3). */
  private dropDeathPile(actor: MatchActor): void {
    const ground = this.ports.groundLoot;
    const inv = actor.equip.inventory;
    const items: ItemInstance[] = [];
    for (const weapon of inv.weapons) if (weapon) items.push({ itemId: `weapon_${weapon.weaponId}`, quantity: 1, magazine: weapon.magazine });
    if (inv.helmet) items.push({ itemId: `helmet_${inv.helmet.level}`, quantity: 1, durability: inv.helmet.durability });
    if (inv.vest) items.push({ itemId: `vest_${inv.vest.level}`, quantity: 1, durability: inv.vest.durability });
    if (inv.backpack > 0) items.push({ itemId: `backpack_${inv.backpack as 1 | 2 | 3}`, quantity: 1 });
    for (const stack of inv.stacks) if (stack.quantity > 0) items.push({ itemId: stack.itemId, quantity: stack.quantity });
    const pileId = DEATH_PILE_ID_BASE + actor.slot;
    // Settle on whatever is below (a bot can die mid-fall).
    const below = this.ports.raycastWorld({ x: actor.feet.x, y: actor.feet.y + 0.5, z: actor.feet.z }, { x: actor.feet.x, y: actor.feet.y - 30, z: actor.feet.z });
    const floorY = below ? below.point.y : actor.feet.y;
    items.forEach((item, k) => {
      const angle = (k / Math.max(1, items.length)) * Math.PI * 2 + hash32(this.config.seed, actor.slot, k) / 0x100000000;
      const r = items.length > 1 ? LOOT.pileRadius + 0.05 * (k % 3) : 0;
      dropGroundItem(ground, item, [actor.feet.x + Math.sin(angle) * r, floorY, actor.feet.z + Math.cos(angle) * r], pileId);
    });
    const empty = createInventory();
    actor.equip = { ...actor.equip, inventory: empty };
    actor.weapon = weaponStateFromInventory(empty, LOADOUT);
  }

  /** Downed members of teams nobody stands on anymore are eliminated (credit to the knocker, cause teamWipe). */
  private resolveTeamWipes(): void {
    const wipes = downedWithoutStandingTeammate(this.teams, this.actorStates, this.wipes);
    for (let i = 0; i < wipes.length; i++) {
      const actor = this.actorsBySlot[wipes[i]!];
      if (!actor || actor.state.life !== "downed") continue;
      const knockedBy = actor.vitals.knockedById;
      if (actor.external) {
        actor.external.applyDamage({ amount: 100_000, kind: "bleed", zone: null, sourceId: knockedBy }, { canBeKnocked: false }, actor.feet);
      } else {
        actor.equip = { ...actor.equip, vitals: eliminate(actor.equip.vitals) };
      }
      this.syncActorState(actor);
      this.onDeath(actor, knockedBy, "teamWipe", false, knockedBy);
    }
  }

  private refreshExternalKnockRule(): void {
    for (const actor of this.order) {
      if (!actor.external || actor.state.life === "dead") continue;
      const can = canActorBeKnocked(this.config.rules, actor.slot, actor.team, this.actorStates);
      if (can !== this.knockRuleCache[actor.slot]) {
        this.knockRuleCache[actor.slot] = can;
        actor.external.setCanBeKnocked(can);
      }
    }
  }

  private readonly knockRuleCache: boolean[] = [];

  // ---- Projectiles ----------------------------------------------------------------------------------------------------

  private stepProjectiles(tick: number): void {
    const pool = this.projectiles;
    const seg = this.segment;
    const from = this.from;
    const to = this.to;
    const hit = this.rigHit;
    let i = 0;
    while (i < pool.count) {
      const reachesMaxRange = pool.integrate(i, DT, seg);
      const owner = pool.shooter[i]!;
      from.x = seg[0]!;
      from.y = seg[1]!;
      from.z = seg[2]!;
      to.x = seg[3]!;
      to.y = seg[4]!;
      to.z = seg[5]!;
      const length = seg[6]!;
      const worldHit = length > 0 ? this.ports.raycastWorld(from, to) : null;
      let best = worldHit ? worldHit.fraction : 2;
      let victim: MatchActor | null = null;
      let victimZone: MutableRigHit["zone"] = "body";
      if (length > 0) {
        for (const actor of this.order) {
          if (actor.slot === owner || actor.state.life === "dead") continue;
          if (!segmentNearRig(actor.feet.x, actor.feet.y, actor.feet.z, from.x, from.y, from.z, to.x, to.y, to.z)) continue;
          if (segmentVsRigInto(actor.ensurePose(), from.x, from.y, from.z, to.x, to.y, to.z, hit) && hit.t <= best) {
            best = hit.t;
            victim = actor;
            victimZone = hit.zone;
          }
        }
      }

      if (!victim && !worldHit) {
        if (length > 0) this.bulletNoise(owner, pool.weaponId(i), from, to, 1, false, tick);
        if (pool.advance(i, seg, reachesMaxRange)) i++;
        else pool.remove(i);
        continue;
      }

      const weaponId = pool.weaponId(i);
      const distance = pool.distance[i]! + best * length;
      const px = from.x + (to.x - from.x) * best;
      const py = from.y + (to.y - from.y) * best;
      const pz = from.z + (to.z - from.z) * best;
      const i3 = i * 3;
      const vx = pool.velocity[i3]!;
      const vy = pool.velocity[i3 + 1]!;
      const vz = pool.velocity[i3 + 2]!;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      const point = { x: px, y: py, z: pz };
      const direction = { x: vx / speed, y: vy / speed, z: vz / speed };
      this.bulletNoise(owner, weaponId, from, to, best, true, tick);
      if (victim) {
        const shooter = this.actorsBySlot[owner];
        const blocked = !this.config.rules.friendlyFire && shooter !== undefined && shooter.team === victim.team;
        if (!blocked) this.applyDamageTo(victim, computeDamage(WEAPONS[weaponId], victimZone, distance), "bullet", victimZone, owner, weaponId, point, direction.x, direction.y, direction.z);
        this.fx({ type: "impact", tick, slot: owner, weaponId, point, normal: { x: -direction.x, y: -direction.y, z: -direction.z }, victim: victim.slot, zone: victimZone, direction });
      } else if (worldHit) {
        this.fx({ type: "impact", tick, slot: owner, weaponId, point, normal: worldHit.normal, victim: -1, zone: null, direction });
      }
      pool.remove(i);
    }
  }

  /**
   * Bullets heard by nearby bots as `impact` noises with the shooter's slot (design.md §4): a hit within 4 m of a bot's
   * chest at the hit point, else a fly-by within 4 m at the closest point of the trajectory. At most one per bot per tick.
   */
  private bulletNoise(owner: number, weaponId: WeaponId, from: Vec3, to: Vec3, tEnd: number, struck: boolean, tick: number): void {
    const dx = (to.x - from.x) * tEnd;
    const dy = (to.y - from.y) * tEnd;
    const dz = (to.z - from.z) * tEnd;
    const dd = dx * dx + dy * dy + dz * dz;
    const r2 = NEAR_MISS_RADIUS * NEAR_MISS_RADIUS;
    for (const actor of this.order) {
      if (actor.slot === owner || !actor.brain || actor.state.life === "dead" || actor.nearMissTick === tick) continue;
      const cx = actor.feet.x - from.x;
      const cy = actor.feet.y + 1.2 - from.y;
      const cz = actor.feet.z - from.z;
      let t: number;
      const hx = cx - dx;
      const hy = cy - dy;
      const hz = cz - dz;
      if (struck && hx * hx + hy * hy + hz * hz <= r2) {
        t = 1;
      } else {
        t = dd > 0 ? (cx * dx + cy * dy + cz * dz) / dd : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = cx - dx * t;
        const ey = cy - dy * t;
        const ez = cz - dz * t;
        if (ex * ex + ey * ey + ez * ez > r2) continue;
      }
      actor.nearMissTick = tick;
      const p = this.nearMissPoint;
      p.x = from.x + dx * t;
      p.y = from.y + dy * t;
      p.z = from.z + dz * t;
      this.addNoise("impact", owner, p, IMPACT_NOISE_RADIUS, weaponId);
    }
  }

  private readonly nearMissPoint: MutableVec3 = { x: 0, y: 0, z: 0 };

  // ---- Equipment world (headless) --------------------------------------------------------------------------------------

  private stepOwnEquipment(tick: number): void {
    const own = this.ownEquipment!;
    const entities = this.worldEntities;
    entities.length = 0;
    for (const actor of this.order) {
      if (actor.state.life === "dead") continue;
      const e = actor.entity;
      e.posture = actor.state.life === "downed" ? "downed" : actor.stance === "stand" ? "stand" : "crouch";
      const cp = Math.cos(actor.pitch);
      e.viewDir.x = Math.sin(actor.yaw) * cp;
      e.viewDir.y = -Math.sin(actor.pitch);
      e.viewDir.z = Math.cos(actor.yaw) * cp;
      entities.push(e);
    }
    const events = this.worldEvents;
    events.length = 0;
    stepEquipmentWorld(own.world, DT, this.ports.raycastWorld, entities, events);
    for (const event of events) {
      switch (event.type) {
        case "detonate":
          if (event.kind === "frag" || event.kind === "flash") this.addNoise("explosion", event.owner, event.position, NOISE_RADII.explosion, null);
          break;
        case "damage": {
          const request = event.request;
          const victim = this.actorsBySlot[request.targetId];
          if (!victim) break;
          const dx = victim.feet.x - request.position.x;
          const dy = victim.feet.y + 1 - request.position.y;
          const dz = victim.feet.z - request.position.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
          this.applyDamageTo(victim, request.amount, request.kind, event.explosion ? "body" : null, request.sourceId, null, request.position, dx / d, dy / d, dz / d);
          break;
        }
        case "flashed": {
          const victim = this.actorsBySlot[event.targetId];
          if (!victim || victim.external) break;
          const v = victim.equip.vitals;
          victim.equip = { ...victim.equip, vitals: { ...v, blindSeconds: Math.max(v.blindSeconds, event.exposure.blindSeconds), deafSeconds: Math.max(v.deafSeconds, event.exposure.deafSeconds) } };
          break;
        }
        default:
          break;
      }
    }
    void tick;
  }

  private collectThrowables(): void {
    const own = this.ownEquipment;
    if (!own) {
      this.throwablesView = (this.equipment.throwables ?? NO_THROWABLES) as ThrowableView[];
      return;
    }
    const set = own.world.throwables;
    const out = this.throwablesView === NO_THROWABLES ? (this.throwablesView = []) : this.throwablesView;
    out.length = 0;
    for (let i = 0; i < set.count && i < this.throwableViews.length; i++) {
      const v = this.throwableViews[i]!;
      const i3 = i * 3;
      v.id = set.id[i]!;
      v.ownerSlot = set.owner[i]!;
      v.kind = THROWABLE_KINDS[set.kind[i]!]!;
      (v.position as MutableVec3).x = set.position[i3]!;
      (v.position as MutableVec3).y = set.position[i3 + 1]!;
      (v.position as MutableVec3).z = set.position[i3 + 2]!;
      (v.velocity as MutableVec3).x = set.velocity[i3]!;
      (v.velocity as MutableVec3).y = set.velocity[i3 + 1]!;
      (v.velocity as MutableVec3).z = set.velocity[i3 + 2]!;
      v.atRest = set.motion[i] === 2;
      out.push(v);
    }
  }

  // ---- Views and state sync ------------------------------------------------------------------------------------------

  private buildView(actor: MatchActor): void {
    const self: Mutable<BotSelfView> = {
      slot: actor.slot,
      team: actor.team,
      feet: actor.feet,
      eye: actor.eye,
      velocity: actor.velocity,
      move: actor.move,
      aimYaw: actor.yaw,
      aimPitch: actor.pitch,
      vitals: actor.equip.vitals,
      inventory: actor.equip.inventory,
      weapon: actor.weapon,
      throwState: actor.equip.throw,
      use: actor.equip.use,
      modifiers: actor.modifiers,
    };
    actor.selfView = self;
    actor.view = {
      tick: 0,
      dt: DT,
      matchSeed: this.config.seed,
      phase: "warmup",
      self,
      teammates: actor.teammates,
      actors: actor.others,
      noises: this.noises,
      damageTaken: actor.damageTaken,
      throwables: NO_THROWABLES,
      smokes: this.equipment.smokes,
      zone: this.zone,
      teamsInPlay: 0,
      actorsInPlay: 0,
      raycast: this.ports.raycastWorld,
      nav: this.ports.nav,
      queryLoot: this.queryLoot,
      actorOnSegment: this.actorOnSegmentBound,
    };
  }

  private fillView(actor: MatchActor, tick: number): void {
    const view = actor.view!;
    const self = actor.selfView!;
    const s = this.mutableState;
    view.tick = tick;
    view.phase = s.phase;
    view.noises = this.noises;
    view.throwables = this.throwablesView;
    view.smokes = this.equipment.smokes;
    view.teamsInPlay = s.teamsInPlay;
    view.actorsInPlay = s.actorsInPlay;
    self.velocity = actor.velocity;
    self.move = actor.move;
    self.aimYaw = actor.yaw;
    self.aimPitch = actor.pitch;
    self.vitals = actor.equip.vitals;
    self.inventory = actor.equip.inventory;
    self.weapon = actor.weapon;
    self.throwState = actor.equip.throw;
    self.use = actor.equip.use;
    self.modifiers = actor.modifiers;
    const mates = actor.teammates;
    const others = actor.others;
    mates.length = 0;
    others.length = 0;
    for (const other of this.order) {
      if (other === actor || other.state.life === "dead") continue;
      others.push(other.snapshot);
      if (other.team === actor.team) mates.push(other.mate);
    }
  }

  private syncFromBody(actor: MatchActor): void {
    const body = actor.body!;
    const move = actor.move;
    actor.feet.x = body.feet.x;
    actor.feet.y = body.feet.y;
    actor.feet.z = body.feet.z;
    actor.velocity = move.velocity as MutableVec3;
    actor.stance = move.stance;
    actor.grounded = move.grounded;
    actor.sprinting = move.sprinting;
    const input = actor.out.input;
    actor.yaw = dequantizeYaw(input.yawQ);
    actor.pitch = dequantizePitch(input.pitchQ);
    this.syncEye(actor);
    actor.poseDirty = true;
  }

  private syncEye(actor: MatchActor): void {
    if (actor.external) return;
    actor.eye.x = actor.feet.x;
    actor.eye.y = actor.feet.y + eyeHeightFor(actor.stance);
    actor.eye.z = actor.feet.z;
  }

  private syncActorState(actor: MatchActor): void {
    const st = actor.state;
    const vitals = actor.vitals;
    if (st.deathTick < 0) {
      if (!actor.external) actor.life = vitals.life;
      st.life = actor.life;
    }
    st.health = vitals.health;
    st.downedHealth = vitals.downedHealth;
    st.boost = vitals.boost;
    st.feet = actor.feet;
    st.velocity = actor.velocity;
    st.yaw = actor.yaw;
    st.pitch = actor.pitch;
    st.stance = actor.stance;
    st.grounded = actor.grounded;
    st.sprinting = actor.sprinting;
    st.reviveProgress = vitals.reviveProgress;
    st.reviverSlot = vitals.reviverId;
    let weaponId: WeaponId | null;
    if (actor.external) {
      weaponId = actor.externalWeaponId;
      st.adsBlend = actor.adsBlend;
      st.helmetLevel = actor.external.armor.helmet?.level ?? 0;
      st.vestLevel = actor.external.armor.vest?.level ?? 0;
      st.usingItem = false;
    } else {
      const equip = actor.equip;
      const slot = actor.weapon.slots[actor.weapon.activeIndex];
      weaponId = slot && equip.throw.phase === "idle" && equip.use.itemId === null ? slot.id : null;
      st.adsBlend = actor.weapon.adsBlend;
      actor.adsBlend = st.adsBlend;
      st.helmetLevel = equip.inventory.helmet?.level ?? 0;
      st.vestLevel = equip.inventory.vest?.level ?? 0;
      st.usingItem = equip.use.itemId !== null;
    }
    st.weaponId = weaponId;

    const snap = actor.snapshot;
    snap.life = st.life;
    snap.velocity = actor.velocity;
    snap.yaw = actor.yaw;
    snap.pitch = actor.pitch;
    snap.stance = actor.stance;
    snap.sprinting = actor.sprinting;
    snap.adsBlend = st.adsBlend;
    snap.weaponId = weaponId;
    snap.lastShotTick = actor.lastShotTick;
    const mate = actor.mate;
    mate.life = st.life;
    mate.velocity = actor.velocity;
    mate.yaw = actor.yaw;
    mate.pitch = actor.pitch;
    mate.stance = actor.stance;
    mate.sprinting = actor.sprinting;
    mate.adsBlend = st.adsBlend;
    mate.weaponId = weaponId;
    mate.lastShotTick = actor.lastShotTick;
    mate.health = vitals.health;
    mate.downedHealth = vitals.downedHealth;
    mate.reviverSlot = vitals.reviverId;
    if (!actor.external) {
      const stacks = actor.equip.inventory.stacks;
      let heals = 0;
      for (const stack of stacks) if (stack.itemId === "bandage" || stack.itemId === "first_aid" || stack.itemId === "medkit") heals += stack.quantity;
      mate.healCount = heals;
    }
  }

  // ---- Noises and events ----------------------------------------------------------------------------------------------

  private swapNoises(): void {
    const pool = this.noisePoolA;
    this.noisePoolA = this.noisePoolB;
    this.noisePoolB = pool;
    const current = this.noises;
    this.noises = this.pendingNoises;
    this.pendingNoises = current;
    this.pendingNoises.length = 0;
  }

  private addNoise(kind: NoiseKind, slot: number, position: Vec3, radius: number, weaponId: WeaponId | null): void {
    const pending = this.pendingNoises;
    const noise = this.noisePoolA[pending.length];
    if (!noise) return;
    noise.kind = kind;
    noise.sourceSlot = slot;
    noise.position.x = position.x;
    noise.position.y = position.y;
    noise.position.z = position.z;
    noise.radius = radius;
    noise.weaponId = weaponId;
    pending.push(noise);
  }

  private footstepNoise(actor: MatchActor, tick: number): void {
    if ((tick + actor.slot) % FOOTSTEP_INTERVAL_TICKS !== 0 || actor.state.life !== "alive") return;
    const speed = Math.sqrt(actor.velocity.x * actor.velocity.x + actor.velocity.z * actor.velocity.z);
    const radius = footstepRadius(actor.stance, actor.sprinting, speed, actor.grounded);
    if (radius > 0) this.addNoise("footstep", actor.slot, actor.feet, radius, null);
  }

  private emit(event: MatchEvent): void {
    const log = this.recentEvents;
    if (log.length >= 256) log.shift();
    log.push(event);
    for (let i = 0; i < this.eventListeners.length; i++) this.eventListeners[i]!(event);
  }

  private fx(event: MatchFxEvent): void {
    if (this.fxListeners.length === 0) return;
    for (let i = 0; i < this.fxListeners.length; i++) this.fxListeners[i]!(event);
  }
}

// ---------------------------------------------------------------------------------------------------------------

function freezeInput(out: BotTickOutput): void {
  const input = out.input;
  input.forward = 0;
  input.right = 0;
  input.buttons = 0;
  input.select = 0;
  input.action = null;
  out.intents.cycleThrowable = false;
  out.intents.holster = false;
  out.intents.reviveSlot = -1;
}

function consumableOfCode(code: number): ConsumableItemId | null {
  const id = ITEM_IDS[code];
  if (!id) return null;
  const category = ITEMS[id].category;
  return category === "heal" || category === "boost" ? (id as ConsumableItemId) : null;
}

