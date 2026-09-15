import { DEFAULT_BOT_DIFFICULTY, type BotDifficulty } from "@twobullets/contracts";
import type { LagCompHistory } from "@twobullets/netcode";
import { dequantizePitch, dequantizeYaw, quantizePitch, quantizeYaw } from "@twobullets/shared/aim";
import { createBotBrain } from "@twobullets/shared/bots/brain/brain";
import { BOT_PROFILES } from "@twobullets/shared/bots/profiles/profiles";
import {
  BOT_SCHEDULE,
  type ActorSnapshot,
  type BotBrain,
  type BotBrainFactory,
  type BotSelfView,
  type BotTickOutput,
  type BotWorldView,
  type DamageTakenEvent,
  type NavQuery,
  type NoiseKind,
  type TeammateView,
  type ThrowableView,
} from "@twobullets/shared/bots/types";
import type { DamageKind } from "@twobullets/shared/equipment/armor";
import { createPlayerEquipment, deriveEquipmentModifiers, type EquipmentModifiers, type PlayerEquipmentState } from "@twobullets/shared/equipment/equipmentStep";
import type { InventoryState } from "@twobullets/shared/equipment/inventory";
import type { LootItem } from "@twobullets/shared/equipment/loot";
import type { SmokeCloud } from "@twobullets/shared/equipment/smoke";
import type { LifeState } from "@twobullets/shared/equipment/vitals";
import type { MutableRigHit } from "@twobullets/shared/hitreg/rig";
import { footstepRadius, FOOTSTEP_INTERVAL_TICKS, landNoiseRadius, NOISE_RADII, shotNoiseRadius } from "@twobullets/shared/match/noise";
import type { BrPhase, ZoneState } from "@twobullets/shared/match/types";
import { eyeHeightFor } from "@twobullets/shared/movement/movement";
import type { Vec3 } from "@twobullets/shared/movement/types";
import type { SimEvent } from "@twobullets/sim";
import type { AimedShot, RaycastFn, WeaponId } from "@twobullets/shared/weapons/types";
import type { Player } from "../match/Player";

// Server bots (plan.md B6, docs/bots/design.md §2.5): the offline bot brain as another input source. Every tick, before
// players step, each bot's brain reads a BotWorldView built from server state and writes one PlayerInput into that
// bot's ServerInputBuffer; ServerMatch then takes it and runs the exact human path (stepPlayer with weapons,
// ServerProjectiles, ServerCombat). Noises (shots, footsteps, landings, reloads, near misses) and damage taken are fed
// from the same hooks. Loot (B5): bots start with the networked starting kit like humans, see the server's ground loot
// through `queryLoot` and pick up with the same `pickup` action ServerLoot validates for everyone.

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableVec3 = { x: number; y: number; z: number };

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

/** Per-slot observable pose, refreshed once per tick for every player. */
interface ActorViews {
  readonly snapshot: Mutable<ActorSnapshot>;
  readonly mate: Mutable<TeammateView>;
  readonly eye: MutableVec3;
  readonly velocity: MutableVec3;
}

/** One bot's brain, output and view (lives on `Player.bot`). */
export class BotSeat {
  readonly brain: BotBrain;
  readonly out: BotTickOutput;
  readonly name: string;
  readonly view: Mutable<BotWorldView>;
  readonly self: Mutable<BotSelfView>;
  readonly teammates: TeammateView[] = [];
  readonly others: ActorSnapshot[] = [];
  readonly damageTaken: MutableDamageTaken[] = [];
  private readonly damagePool: MutableDamageTaken[] = [];
  /** `Player.inventory` as the brain last saw it (equipment decisions). */
  inventory: InventoryState;
  equip: PlayerEquipmentState;
  modifiers: EquipmentModifiers;
  modifiersLife: LifeState = "alive";
  nearMissTick = -1;

  constructor(brain: BotBrain, name: string, view: Mutable<BotWorldView>, self: Mutable<BotSelfView>, inventory: InventoryState, equip: PlayerEquipmentState) {
    this.brain = brain;
    this.name = name;
    this.view = view;
    this.self = self;
    this.inventory = inventory;
    this.equip = equip;
    this.modifiers = deriveEquipmentModifiers(equip);
    this.out = {
      input: { tick: 0, forward: 0, right: 0, buttons: 0, select: 0, yawQ: 0, pitchQ: quantizePitch(0), viewOffset8: 0, action: null },
      intents: { cycleThrowable: false, holster: false, replaceSlot: -1, reviveSlot: -1 },
    };
  }

  pushDamage(attacker: number, dirX: number, dirZ: number, amount: number, kind: DamageTakenEvent["kind"]): void {
    let e = this.damagePool[this.damageTaken.length];
    if (e === undefined) {
      e = { attackerSlot: -1, direction: { x: 0, y: 0, z: 0 }, amount: 0, kind: "bullet" };
      this.damagePool.push(e);
    }
    const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
    e.attackerSlot = attacker;
    e.direction.x = len > 0 ? dirX / len : 0;
    e.direction.y = len > 0 ? 0 : -1;
    e.direction.z = len > 0 ? dirZ / len : 0;
    e.amount = amount;
    e.kind = kind;
    this.damageTaken.push(e);
  }
}

export interface ServerBotsOptions {
  readonly matchSeed: number;
  readonly maxSlots: number;
  readonly difficulty?: BotDifficulty;
  readonly nav: NavQuery;
  readonly raycastWorld: RaycastFn;
  /** Present-time poses for `actorOnSegment` (the last recorded tick). */
  readonly history: LagCompHistory;
  /** Current zone (the lifecycle's, or the level's initial circle). */
  readonly zone: () => ZoneState;
  readonly brainFactory?: BotBrainFactory;
  /** Server ground loot within a radius, nearest first (ServerLoot.queryLoot); absent = none. */
  readonly queryLoot?: (center: Vec3, radius: number, out: LootItem[]) => number;
  /** A* node expansions per tick for every bot together. */
  readonly navExpansionsPerTick?: number;
}

export interface ServerBotsStats {
  /** Last tick's brain + nav time, ms, and the running total. */
  brainMs: number;
  brainTotalMs: number;
  ticks: number;
  shots: number;
  inputs: number;
}

const NOISE_POOL = 256;
const NEAR_MISS_RADIUS = 4;
const NO_THROWABLES: readonly ThrowableView[] = Object.freeze([]);
const NO_SMOKES: readonly SmokeCloud[] = Object.freeze([]);
const DT = 1 / 60;

/** Bot display name from its roster id (`bot:3` → `Bot 3`). */
export function botDisplayName(accountId: string): string {
  const id = accountId.slice(accountId.indexOf(":") + 1);
  return `Bot ${id}`;
}

export class ServerBots {
  readonly nav: NavQuery;
  readonly difficulty: BotDifficulty;
  readonly stats: ServerBotsStats = { brainMs: 0, brainTotalMs: 0, ticks: 0, shots: 0, inputs: 0 };
  private readonly o: ServerBotsOptions;
  private readonly brainFactory: BotBrainFactory;
  private readonly navBudget: number;
  private readonly actors: ActorViews[] = [];
  private readonly lastShotTick: Float64Array;
  private noises: MutableNoise[] = [];
  private pending: MutableNoise[] = [];
  private poolA: MutableNoise[] = [];
  private poolB: MutableNoise[] = [];
  private readonly rigHit: MutableRigHit = { t: 0, shape: 0, zone: "body" };
  private readonly nearPoint: MutableVec3 = { x: 0, y: 0, z: 0 };
  private players: readonly Player[] = [];
  private tickNow = 0;
  private phase: BrPhase = "warmup";
  private teamsInPlay = 0;
  private actorsInPlay = 0;
  private botCount = 0;
  private readonly queryLoot = (center: Vec3, radius: number, out: LootItem[]): number => {
    if (this.o.queryLoot) return this.o.queryLoot(center, radius, out);
    out.length = 0;
    return 0;
  };
  private readonly actorOnSegment = (from: Vec3, to: Vec3, excludeSlot: number): number => this.firstActorOnSegment(from, to, excludeSlot);

  constructor(options: ServerBotsOptions) {
    this.o = options;
    this.nav = options.nav;
    this.difficulty = options.difficulty ?? DEFAULT_BOT_DIFFICULTY;
    this.brainFactory = options.brainFactory ?? createBotBrain;
    this.navBudget = options.navExpansionsPerTick ?? BOT_SCHEDULE.navExpansionsPerTick;
    this.lastShotTick = new Float64Array(options.maxSlots).fill(-1);
    for (let i = 0; i < NOISE_POOL; i++) {
      this.poolA.push({ kind: "footstep", sourceSlot: -1, position: { x: 0, y: 0, z: 0 }, radius: 0, weaponId: null });
      this.poolB.push({ kind: "footstep", sourceSlot: -1, position: { x: 0, y: 0, z: 0 }, radius: 0, weaponId: null });
    }
    for (let slot = 0; slot < options.maxSlots; slot++) {
      const eye = { x: 0, y: 0, z: 0 };
      const velocity = { x: 0, y: 0, z: 0 };
      const feet = { x: 0, y: 0, z: 0 };
      const snapshot: Mutable<ActorSnapshot> = { slot, team: 0, life: "alive", feet, eye, velocity, yaw: 0, pitch: 0, stance: "stand", sprinting: false, adsBlend: 0, weaponId: null, lastShotTick: -1 };
      this.actors.push({ snapshot, mate: { ...snapshot, kind: "human", health: 100, downedHealth: 0, reviverSlot: -1, healCount: 0 }, eye, velocity });
    }
  }

  get count(): number {
    return this.botCount;
  }

  /** Makes `p` a bot (a player with no session). */
  attach(p: Player): BotSeat {
    const profile = BOT_PROFILES[this.difficulty];
    const brain = this.brainFactory({ slot: p.slot, team: p.teamId, seed: this.o.matchSeed >>> 0, profile });
    const inventory = p.inventory;
    const equip = createPlayerEquipment(inventory);
    const views = this.actors[p.slot]!;
    const self: Mutable<BotSelfView> = {
      slot: p.slot,
      team: p.teamId,
      feet: p.body.feet,
      eye: views.eye,
      velocity: views.velocity,
      move: p.state.move,
      aimYaw: p.spawn.yaw,
      aimPitch: 0,
      vitals: p.vitals,
      inventory,
      weapon: p.state.weapon,
      throwState: equip.throw,
      use: equip.use,
      modifiers: deriveEquipmentModifiers(equip),
    };
    const view: Mutable<BotWorldView> = {
      tick: 0,
      dt: DT,
      matchSeed: this.o.matchSeed >>> 0,
      phase: "warmup",
      self,
      teammates: [],
      actors: [],
      noises: this.noises,
      damageTaken: [],
      throwables: NO_THROWABLES,
      smokes: NO_SMOKES,
      zone: this.o.zone(),
      teamsInPlay: 0,
      actorsInPlay: 0,
      raycast: this.o.raycastWorld,
      nav: this.o.nav,
      queryLoot: this.queryLoot,
      actorOnSegment: this.actorOnSegment,
    };
    const seat = new BotSeat(brain, botDisplayName(p.accountId), view, self, inventory, equip);
    view.teammates = seat.teammates;
    view.actors = seat.others;
    view.damageTaken = seat.damageTaken;
    p.bot = seat;
    this.botCount++;
    this.reset(p);
    return seat;
  }

  /** A (re)spawn: fresh brain state facing the spawn yaw. */
  reset(p: Player): void {
    const seat = p.bot;
    if (seat === null) return;
    seat.brain.reset(p.spawn.yaw);
    const input = seat.out.input;
    input.forward = 0;
    input.right = 0;
    input.buttons = 0;
    input.select = 0;
    input.action = null;
    input.yawQ = quantizeYaw(p.spawn.yaw);
    input.pitchQ = quantizePitch(0);
    seat.damageTaken.length = 0;
    this.lastShotTick[p.slot] = -1;
  }

  /**
   * Before players step: swap noises, refresh actor views, run every living bot's brain and buffer its input for `tick`,
   * then the shared nav budget. `frozen` (not in combat) zeroes movement and buttons like the offline match.
   */
  beginTick(tick: number, players: readonly Player[], phase: BrPhase, frozen: boolean): void {
    this.tickNow = tick;
    this.players = players;
    this.phase = phase;
    this.swapNoises();
    if (this.botCount === 0) return;
    const started = performance.now();
    this.refreshActors(players);
    const zone = this.o.zone();
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      const seat = p.bot;
      if (seat === null || p.life === "dead") continue;
      this.fillView(p, seat, tick, zone);
      seat.brain.tick(seat.view, seat.out);
      seat.damageTaken.length = 0;
      const input = seat.out.input;
      if (frozen) {
        input.forward = 0;
        input.right = 0;
        input.buttons = 0;
        input.select = 0;
        input.action = null;
      }
      input.tick = tick;
      input.viewOffset8 = 0;
      p.inputs.insert(input, tick);
      this.stats.inputs++;
    }
    this.o.nav.update(this.navBudget);
    const ms = performance.now() - started;
    this.stats.brainMs = ms;
    this.stats.brainTotalMs += ms;
    this.stats.ticks++;
  }

  /** After a player's step (humans too): shot, reload and landing noises, footsteps, recoil for bots. */
  afterStep(p: Player, shots: readonly AimedShot[], events: readonly SimEvent[]): void {
    const tick = this.tickNow;
    for (let k = 0; k < shots.length; k++) {
      const shot = shots[k]!;
      this.lastShotTick[p.slot] = tick;
      this.addNoise("shot", p.slot, shot.origin, shotNoiseRadius(shot.weaponId), shot.weaponId);
      if (p.bot !== null) {
        p.bot.brain.kickAim(shot.recoilUp, shot.recoilRight);
        this.stats.shots++;
      }
    }
    for (let k = 0; k < events.length; k++) {
      const e = events[k]!;
      if (e.type === "landed") {
        const radius = landNoiseRadius(e.fallSpeed);
        if (radius > 0) this.addNoise("land", p.slot, p.body.feet, radius, null);
      } else if (e.type === "reloadStarted") {
        this.addNoise("reload", p.slot, p.body.feet, NOISE_RADII.reload, null);
      }
    }
    if ((tick + p.slot) % FOOTSTEP_INTERVAL_TICKS === 0 && p.life === "alive") {
      const v = p.state.move.velocity;
      const radius = footstepRadius(p.state.move.stance, p.state.move.sprinting, Math.sqrt(v.x * v.x + v.z * v.z), p.state.move.grounded);
      if (radius > 0) this.addNoise("footstep", p.slot, p.body.feet, radius, null);
    }
  }

  /** ServerCombat.onDamage. */
  onDamage(victim: Player, attacker: number, amount: number, kind: DamageKind, dirX: number, dirZ: number): void {
    const seat = victim.bot;
    if (seat === null) return;
    const k: DamageTakenEvent["kind"] = kind === "bullet" || kind === "explosion" || kind === "fire" || kind === "fall" || kind === "zone" || kind === "bleed" ? kind : "bullet";
    seat.pushDamage(attacker, dirX, dirZ, amount, k);
  }

  /** ServerProjectiles.onSegment: a bullet within 4 m of a bot's chest is heard as an `impact` (design.md §4). */
  onSegment(shooter: number, weaponId: WeaponId, from: Vec3, to: Vec3, tEnd: number, struck: boolean): void {
    if (this.botCount === 0) return;
    const dx = (to.x - from.x) * tEnd;
    const dy = (to.y - from.y) * tEnd;
    const dz = (to.z - from.z) * tEnd;
    const dd = dx * dx + dy * dy + dz * dz;
    const r2 = NEAR_MISS_RADIUS * NEAR_MISS_RADIUS;
    const players = this.players;
    const tick = this.tickNow;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      const seat = p.bot;
      if (seat === null || p.slot === shooter || p.life === "dead" || seat.nearMissTick === tick) continue;
      const feet = p.body.feet;
      const cx = feet.x - from.x;
      const cy = feet.y + 1.2 - from.y;
      const cz = feet.z - from.z;
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
      seat.nearMissTick = tick;
      const q = this.nearPoint;
      q.x = from.x + dx * t;
      q.y = from.y + dy * t;
      q.z = from.z + dz * t;
      this.addNoise("impact", shooter, q, NOISE_RADII.impact, weaponId);
    }
  }

  // ---- Views ----------------------------------------------------------------------------------------------------------

  private refreshActors(players: readonly Player[]): void {
    let teamMask = 0;
    let inPlay = 0;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      const a = this.actors[p.slot]!;
      const s = a.snapshot;
      const move = p.state.move;
      const weapon = p.state.weapon;
      const feet = p.body.feet;
      s.team = p.teamId;
      s.life = p.life;
      s.feet = feet;
      a.eye.x = feet.x;
      a.eye.y = feet.y + eyeHeightFor(move.stance);
      a.eye.z = feet.z;
      a.velocity.x = move.velocity.x;
      a.velocity.y = move.velocity.y;
      a.velocity.z = move.velocity.z;
      s.yaw = dequantizeYaw(p.yawQ);
      s.pitch = dequantizePitch(p.pitchQ);
      s.stance = move.stance;
      s.sprinting = move.sprinting;
      s.adsBlend = weapon.adsBlend;
      s.weaponId = p.life === "alive" ? (weapon.slots[weapon.activeIndex]?.id ?? null) : null;
      s.lastShotTick = this.lastShotTick[p.slot]!;
      const m = a.mate;
      m.team = s.team;
      m.life = s.life;
      m.feet = feet;
      m.yaw = s.yaw;
      m.pitch = s.pitch;
      m.stance = s.stance;
      m.sprinting = s.sprinting;
      m.adsBlend = s.adsBlend;
      m.weaponId = s.weaponId;
      m.lastShotTick = s.lastShotTick;
      m.kind = p.bot !== null ? "bot" : "human";
      m.health = p.vitals.health;
      m.downedHealth = p.vitals.downedHealth;
      m.reviverSlot = p.vitals.reviverId;
      if (p.life !== "dead") {
        inPlay++;
        teamMask |= 1 << p.teamId;
      }
    }
    let teams = 0;
    for (; teamMask !== 0; teamMask &= teamMask - 1) teams++;
    this.teamsInPlay = teams;
    this.actorsInPlay = inPlay;
  }

  private fillView(p: Player, seat: BotSeat, tick: number, zone: ZoneState): void {
    const view = seat.view;
    const self = seat.self;
    view.tick = tick;
    view.phase = this.phase;
    view.noises = this.noises;
    view.zone = zone;
    view.teamsInPlay = this.teamsInPlay;
    view.actorsInPlay = this.actorsInPlay;
    self.feet = p.body.feet;
    self.move = p.state.move;
    self.weapon = p.state.weapon;
    self.vitals = p.vitals;
    self.aimYaw = dequantizeYaw(p.yawQ);
    self.aimPitch = dequantizePitch(p.pitchQ);
    const views = this.actors[p.slot]!;
    self.eye = views.eye;
    self.velocity = views.velocity;
    const inventory = p.inventory;
    if (inventory !== seat.inventory) {
      seat.inventory = inventory;
      seat.equip = { ...seat.equip, inventory };
    }
    self.inventory = inventory;
    const life = p.life;
    if (life !== seat.modifiersLife) {
      seat.modifiersLife = life;
      seat.equip = { ...seat.equip, vitals: p.vitals };
      seat.modifiers = deriveEquipmentModifiers(seat.equip);
    }
    self.modifiers = seat.modifiers;
    const mates = seat.teammates;
    const others = seat.others;
    mates.length = 0;
    others.length = 0;
    const players = this.players;
    for (let i = 0; i < players.length; i++) {
      const other = players[i]!;
      if (other === p || other.life === "dead") continue;
      const a = this.actors[other.slot]!;
      others.push(a.snapshot);
      if (other.teamId === p.teamId) mates.push(a.mate);
    }
  }

  /** First living player other than `excludeSlot` whose last recorded rig the segment crosses (nearest), or -1. */
  private firstActorOnSegment(from: Vec3, to: Vec3, excludeSlot: number): number {
    const history = this.o.history;
    const t = this.tickNow - 1;
    let best = 2;
    let bestSlot = -1;
    const players = this.players;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.slot === excludeSlot || p.life === "dead" || !history.has(p.slot, t)) continue;
      if (history.segmentVsRig(p.slot, t, from.x, from.y, from.z, to.x, to.y, to.z, this.rigHit) && this.rigHit.t < best) {
        best = this.rigHit.t;
        bestSlot = p.slot;
      }
    }
    return bestSlot;
  }

  // ---- Noises ---------------------------------------------------------------------------------------------------------

  /** Brains read last tick's noises; this tick's steps write the other pool. */
  private swapNoises(): void {
    const pool = this.poolA;
    this.poolA = this.poolB;
    this.poolB = pool;
    const current = this.noises;
    this.noises = this.pending;
    this.pending = current;
    this.pending.length = 0;
  }

  private addNoise(kind: NoiseKind, slot: number, position: Vec3, radius: number, weaponId: WeaponId | null): void {
    if (this.botCount === 0) return;
    const pending = this.pending;
    const noise = this.poolA[pending.length];
    if (noise === undefined) return;
    noise.kind = kind;
    noise.sourceSlot = slot;
    noise.position.x = position.x;
    noise.position.y = position.y;
    noise.position.z = position.z;
    noise.radius = radius;
    noise.weaponId = weaponId;
    pending.push(noise);
  }
}
