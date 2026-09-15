import { quantizePitch, quantizeYaw } from "../../aim";
import { capacityOf } from "../../equipment/inventory";
import { ITEMS, itemCode } from "../../equipment/items";
import type { LootItem } from "../../equipment/loot";
import { INTERACT } from "../../equipment/loot";
import { Btn, PlayerActionType } from "../../input";
import type { Vec3 } from "../../movement/types";
import { WEAPONS } from "../../weapons/weapons";
import { AimModel, aimHeight, createAimSolution, solveAim } from "../aim/aim";
import { FireControl } from "../aim/fire";
import { chooseBoost, chooseHeal, chooseWeaponSlot, bestUsableRange, countOf, hasAmmo, hasGun, lootNeed, type LootNeed } from "../goals/equipment";
import { GrenadeThrow } from "../goals/grenade";
import { BuildingSearch, SEARCH_MAX_DISTANCE_UNARMED } from "../goals/search";
import { PositionPicker } from "../goals/tactics";
import { createGoalFacts, GoalSelector, scoreGoals, type ActiveGoal } from "../goals/utility";
import { createRotatePlan, planRotate } from "../goals/zone";
import { BotMemoryState } from "../memory/memory";
import { createMoveOptions, Motor } from "../motor/motor";
import { PerceptionState, type PerceivedActorState } from "../perception/perception";
import {
  BOT_SCHEDULE,
  type BotBrain,
  type BotBrainFactory,
  type BotBrainOptions,
  type BotDebugState,
  type BotGoalKind,
  type BotProfile,
  type BotTickOutput,
  type BotWorldView,
  type TeammateView,
} from "../types";
import { BotRandom, DEG, RNG_STREAM, copyVec, ticksFor, vec3, type MutVec3 } from "./util";

// The utility brain (design.md §5): perception 10 Hz → memory → goal selection 4 Hz → goal behavior → motor + aim every
// tick → PlayerInput. Reads only its BotWorldView; `view.actors` is read by perception alone.

type MutableDebug = { -readonly [K in keyof BotDebugState]: BotDebugState[K] };
type MutableAction = { type: PlayerActionType; arg: number };

const LOOT_SCAN_RADIUS = 35;
const LOOT_MAX_RAYS = 6;
const LOOT_CAPACITY = 48;
const PICKUP_RANGE = 1.6;
const PICKUP_REACH = 2.4;
const PICKUP_RETRY_TICKS = 20;
const LOOT_SKIP_SECONDS = 20;
const LOOT_TARGET_SECONDS = 25;
const REVIVE_REACH = 1.4;
const COVER_HOLD_SECONDS = 8;
const RECENT_TICKS = 90;
const LOOK_RATE_CASUAL = 0.45;
const SETTLE_MIN_DISTANCE = 15;
const PLANNING_OFFSET = 1;
const INVESTIGATE_NEAR = 60;
const INVESTIGATE_FAR = 180;
const LOOT_OFFSET = 2;
const SETTLE_SPEED = 1;

/** Look intent for this tick. */
const Look = { Move: 0, Point: 1, Track: 2, Angles: 3 } as const;
type Look = (typeof Look)[keyof typeof Look];

class UtilityBrain implements BotBrain {
  readonly slot: number;
  readonly team: number;
  readonly profile: BotProfile;
  readonly perception = new PerceptionState();
  readonly memory = new BotMemoryState();

  private readonly seed: number;
  private readonly aim = new AimModel();
  private readonly fire = new FireControl();
  private readonly motor = new Motor();
  private readonly goals = new GoalSelector();
  private readonly grenade = new GrenadeThrow();
  private readonly picker = new PositionPicker();
  private readonly search = new BuildingSearch();
  private readonly facts = createGoalFacts();
  private readonly rotate = createRotatePlan();
  private readonly solution = createAimSolution();
  private readonly moveOptions = createMoveOptions();
  private readonly rngPerception: BotRandom;
  private readonly rngAim: BotRandom;
  private readonly rngGoals: BotRandom;
  private readonly rngMotor: BotRandom;
  private readonly rngCombat: BotRandom;
  private readonly debugState: MutableDebug = { goal: "idle", goalScore: 0, subState: "", targetSlot: -1, aimErrorDeg: Number.NaN, path: null, moveTarget: null, lootTargetId: -1 };
  private readonly pickupAction: MutableAction = { type: PlayerActionType.pickup, arg: 0 };
  private readonly useAction: MutableAction = { type: PlayerActionType.use, arg: 0 };
  private readonly lootBuffer: LootItem[] = [];
  private readonly need: LootNeed = { need: 0, replaceSlot: -1 };
  private readonly scratch: MutVec3 = vec3();
  private readonly point: MutVec3 = vec3();

  private initialized = false;
  private lastTick = -1;
  private subState = "";
  private goalKind: BotGoalKind = "idle";

  // Look intent.
  private look: Look = Look.Move;
  private lookYaw = 0;
  private lookPitch = 0;
  private readonly lookPoint: MutVec3 = vec3();
  private trackSlot = -1;
  private noiseScale = 1;
  private aiming = false;
  private aimSteered = false;
  private dt = 1 / 60;
  private lastPlannedThreat = -1;
  private rotateLatched = false;
  private zonePressureUntil = 0;
  private rotateLatchX = 0;
  private rotateLatchY = 0;
  private rotateLatchZ = 0;
  private rotateCircleR = -1;

  // Loot.
  private lootId = -1;
  private lootReplace: -1 | 0 | 1 | 2 = -1;
  private lootValue = 0;
  private readonly lootPos: MutVec3 = vec3();
  private lootAttempts = 0;
  private lastPickupTick = -1000;
  private lootTargetTick = 0;

  // Combat.
  private switchWaitUntil = 0;
  private nextStrafeTick = 0;
  private strafeDir = 0;
  private crouchHold = false;
  private suppressUntil = -1;
  private suppressSlot = -1;
  private hiddenSince = -1;
  private grenadeReadyTick = 0;
  private coverRollSlot = -1;
  private coverRollTick = -100000;
  private coverRollPassed = false;
  private coverFailUntil = 0;

  // Cover.
  private coverValid = false;
  private readonly coverPoint: MutVec3 = vec3();
  private coverArrivedTick = -1;
  private coverHoldUntil = -1;
  private nextPeekTick = 0;
  private peekUntil = -1;
  private peekStartTick = -1;
  private peekSide = 1;
  private peeks = 0;

  // Flee, heal, revive, regroup, investigate.
  private fleeValid = false;
  private readonly fleePoint: MutVec3 = vec3();
  private lastUseTick = -1000;
  private useAttempts = 0;
  private healBlockedUntil = 0;
  private reviveSlot = -1;
  private reviveSmokeRolled = false;
  private readonly regroupPoint: MutVec3 = vec3();
  private regroupSide = 1;
  private readonly investigatePoint: MutVec3 = vec3();
  private scanBaseYaw = 0;
  private dodgeUntil = -1;
  private dodgeYaw = 0;
  private dodgedId = -1;
  private escapeUntil = -1;
  private readonly escapeDir: MutVec3 = vec3();

  constructor(options: BotBrainOptions) {
    this.slot = options.slot;
    this.team = options.team;
    this.profile = options.profile;
    this.seed = options.seed >>> 0;
    this.rngPerception = new BotRandom(this.seed, this.slot, RNG_STREAM.perception);
    this.rngAim = new BotRandom(this.seed, this.slot, RNG_STREAM.aim);
    this.rngGoals = new BotRandom(this.seed, this.slot, RNG_STREAM.goals);
    this.rngMotor = new BotRandom(this.seed, this.slot, RNG_STREAM.motor);
    this.rngCombat = new BotRandom(this.seed, this.slot, RNG_STREAM.combat);
    this.regroupSide = this.slot % 2 === 0 ? 1 : -1;
  }

  tick(view: BotWorldView, out: BotTickOutput): void {
    const input = out.input;
    const self = view.self;
    const tick = view.tick;
    input.tick = tick;
    input.forward = 0;
    input.right = 0;
    input.buttons = 0;
    input.select = 0;
    input.viewOffset8 = 0;
    input.action = null;
    out.intents.cycleThrowable = false;
    out.intents.holster = false;
    out.intents.replaceSlot = -1;
    out.intents.reviveSlot = -1;
    this.lastTick = tick;

    if (!this.initialized) {
      this.aim.reset(self.aimYaw, self.aimPitch);
      this.scanBaseYaw = self.aimYaw;
      this.goals.reset(tick);
      this.initialized = true;
    }

    if (self.vitals.life === "dead") {
      this.goalKind = "dead";
      this.subState = "";
      this.trackSlot = -1;
      this.writeAim(input);
      this.updateDebug();
      return;
    }

    const profile = this.profile;
    this.perception.tickAlways(view, profile.perception, this.memory, this.rngPerception, this.aim.yaw);
    if (this.perception.damagedThisTick) this.aim.flinch(profile.aim, this.rngAim);
    if ((tick + this.slot) % BOT_SCHEDULE.perceptionTicks === 0) this.perception.update(view, profile.perception, this.memory, this.rngPerception, this.aim.yaw);

    this.motor.beginTick();
    this.look = Look.Move;
    this.trackSlot = -1;
    this.aiming = false;
    this.aimSteered = false;
    this.dt = view.dt;
    this.noiseScale = this.perception.blind ? 4 : 1;

    if (self.vitals.life === "downed") {
      this.grenade.cancel();
      this.downed(view);
    } else if (view.phase !== "combat") {
      this.goalKind = "idle";
      this.subState = view.phase;
      this.scan(view, tick);
    } else {
      // Offsets keep perception (≡0 mod 3), planning (≡1) and the loot scan (≡2) on different ticks of each bot.
      const busy = this.goals.goal === "engage" || this.goals.goal === "cover" || this.goals.goal === "flee" || this.goals.goal === "revive";
      if (!busy && (tick + this.slot) % BOT_SCHEDULE.lootTicks === LOOT_OFFSET) this.scanLoot(view);
      const planning = (tick + this.slot) % BOT_SCHEDULE.planningTicks === PLANNING_OFFSET;
      const preempt = this.perception.damagedThisTick && this.goals.goal !== "cover" && this.goals.goal !== "flee" && this.goals.goal !== "engage";
      // A new threat past its reaction time is acted on now, not at the next 4 Hz planning tick.
      const threat = this.perception.track(this.perception.threatSlot);
      const newThreat = threat !== null && threat.visible && threat.awake(tick) && this.goals.goal !== "engage" && this.lastPlannedThreat !== threat.slot;
      if (planning || preempt || newThreat) {
        this.plan(view, preempt || newThreat);
        this.lastPlannedThreat = this.perception.threatSlot;
      }
      this.goalKind = this.goals.goal;
      this.runGoal(view, out);
      const g = this.goals.goal;
      if (g === "idle" || g === "loot" || g === "rotate" || g === "regroup" || g === "heal") this.glance(view);
      this.reactToThrowables(view);
    }

    // Aim first: the axes are relative to the yaw this tick sends.
    this.steerAim(view);
    if (this.grenade.active) this.grenade.tick(view, out, this.aim.yaw, this.aim.pitch);
    this.motor.output(view, input, this.aim.yaw, this.perception, this.rngMotor, this.aiming);
    if (view.phase !== "combat") {
      input.forward = 0;
      input.right = 0;
      input.buttons = 0;
    }
    this.writeAim(input);
    this.updateDebug();
  }

  kickAim(up: number, right: number): void {
    this.aim.kick(up, right, this.lastTick, this.dt, this.profile.aim);
    this.fire.onShot(this.lastTick, this.dt, this.profile.fire, this.rngCombat);
  }

  reset(yaw: number): void {
    this.perception.reset();
    this.memory.clear();
    this.aim.reset(yaw, 0);
    this.fire.reset();
    this.motor.reset();
    this.grenade.cancel();
    this.goals.reset(this.lastTick < 0 ? 0 : this.lastTick);
    this.initialized = true;
    this.scanBaseYaw = yaw;
    this.goalKind = "idle";
    this.subState = "";
    this.lootId = -1;
    this.lootValue = 0;
    this.coverValid = false;
    this.search.reset();
    this.coverHoldUntil = -1;
    this.coverRollSlot = -1;
    this.fleeValid = false;
    this.reviveSlot = -1;
    this.suppressUntil = -1;
    this.hiddenSince = -1;
    this.dodgeUntil = -1;
    this.escapeUntil = -1;
    this.healBlockedUntil = 0;
    this.useAttempts = 0;
  }

  debug(): BotDebugState {
    return this.debugState;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------------------------------------------

  private plan(view: BotWorldView, preempt: boolean): void {
    const f = this.facts;
    const self = view.self;
    const tick = view.tick;
    const dt = view.dt;
    const profile = this.profile;
    const perception = this.perception;
    const weapon = self.weapon;

    f.health = self.vitals.health;
    f.boost = self.vitals.boost;
    const usable = tick >= this.healBlockedUntil;
    f.hasHeals = usable && chooseHeal(self.inventory, f.health) !== null;
    f.hasBoost = usable && chooseBoost(self.inventory, f.boost) !== null;
    const contact = Math.max(perception.lastHostileContactTick, perception.lastDamageTick, perception.lastSuppressTick);
    f.safeSeconds = contact < 0 ? Infinity : (tick - contact) * dt;

    const threat = perception.track(perception.threatSlot);
    f.threatVisible = threat !== null && threat.visible && threat.awake(tick);
    f.threatDistance = threat ? threat.distance : Infinity;
    f.threatDowned = threat !== null && threat.life === "downed";
    f.threatAttackedMe = threat !== null && threat.damagedMeTick >= 0 && tick - threat.damagedMeTick <= 180;
    let visible = 0;
    let otherStanding = false;
    const tracks = perception.actors;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]!;
      if (!t.hostile || !t.visible || !t.awake(tick)) continue;
      visible++;
      if (t !== threat && t.life === "alive") otherStanding = true;
    }
    f.visibleThreats = visible;
    f.otherStandingThreat = otherStanding;
    const range = bestUsableRange(weapon, profile);
    f.threatInRange = f.threatDistance <= range;
    f.outranged = threat !== null && threat.weaponId === "sniper" && threat.adsBlend > 0.5 && f.threatDistance > range * 0.8;
    f.hasGun = hasGun(weapon);
    f.hasAmmo = hasAmmo(weapon);
    const active = weapon.slots[weapon.activeIndex];
    f.magazineFraction = active ? active.magazine / WEAPONS[active.id].magazineSize : 1;
    f.damagedRecently = (perception.lastDamageTick >= 0 && tick - perception.lastDamageTick <= RECENT_TICKS) || (perception.lastSuppressTick >= 0 && tick - perception.lastSuppressTick <= 60);

    // One cover roll per threat encounter.
    const encounter = perception.threatSlot >= 0 ? perception.threatSlot : f.damagedRecently ? 99 : -1;
    if (encounter >= 0 && (encounter !== this.coverRollSlot || tick - this.coverRollTick > ticksFor(20, dt))) {
      this.coverRollSlot = encounter;
      this.coverRollTick = tick;
      this.coverRollPassed = this.rngGoals.chance(profile.tactics.coverChance);
    }
    f.coverAllowed = this.coverRollPassed && tick >= this.coverFailUntil;
    f.holdingCover = this.goals.goal === "cover" && this.coverArrivedTick >= 0 && tick < this.coverHoldUntil;

    // Revive: a downed teammate nobody else is reviving, reachable on the nav grid.
    f.reviveCandidate = false;
    const downed = this.downedTeammate(view);
    if (downed) {
      const a = view.nav.nearest(self.feet, 2, this.scratch);
      const b = view.nav.nearest(downed.feet, 2, this.point);
      f.reviveCandidate = a >= 0 && b >= 0 && view.nav.reachable(a, b);
      f.reviveDownedHealth = downed.downedHealth;
      if (f.reviveCandidate && this.reviveSlot !== downed.slot) {
        this.reviveSlot = downed.slot;
        this.reviveSmokeRolled = false;
      }
    }

    planRotate(view.zone, self.feet, dt, profile.tactics.zoneMarginSeconds, this.rotate);
    f.rotateScore = this.rotate.score;
    f.zonePhaseIndex = view.zone.phaseIndex;

    f.lootValue = this.lootId >= 0 ? this.lootValue : 0;
    f.unarmed = !f.hasGun;
    f.searchValue = 0;
    // Zone pressure (latched 30 s so a bot near the threshold doesn't alternate): search only inside the circle.
    if (f.rotateScore >= (f.unarmed ? 0.85 : 0.5)) this.zonePressureUntil = tick + ticksFor(30, dt);
    const searchNeed = f.unarmed ? 0.75 : this.poorlyEquipped(self) ? 0.45 : 0.2;
    if (this.search.available(view, view.zone.next ?? view.zone.current, f.unarmed ? SEARCH_MAX_DISTANCE_UNARMED : undefined, tick < this.zonePressureUntil)) {
      // Far buildings are worth less (a long walk), except to an unarmed bot.
      const falloff = f.unarmed ? 1 : Math.exp(-this.search.distance(view) / 150);
      f.searchValue = searchNeed * falloff;
    }

    const mate = this.aliveTeammate(view);
    f.teammateAlive = mate !== null;
    f.teammateDistance = mate ? flatDistance(self.feet, mate.feet) : 0;
    f.teammateIsHuman = mate !== null && mate.kind === "human";
    f.regrouping = this.goals.goal === "regroup";
    f.fleeing = this.goals.goal === "flee";

    // Investigate the most confident unseen hostile memory, for at most chaseSeconds per goal.
    f.investigateConfidence = 0;
    const entry = this.memory.bestHostile(0, -1);
    if (entry) {
      const t = perception.track(entry.slot);
      const chasing = this.goals.goal === "investigate" && (tick - this.goals.startTick) * dt > profile.tactics.chaseSeconds;
      if (chasing) this.memory.forget(entry.slot);
      else if (!t || !t.visible) {
        // Distant fights aren't worth a walk across the map: interest fades from 60 m to nothing at 180 m.
        const d = flatDistance(self.feet, entry.position);
        f.investigateConfidence = entry.confidence * Math.max(0, Math.min(1, 1 - (d - INVESTIGATE_NEAR) / (INVESTIGATE_FAR - INVESTIGATE_NEAR)));
      }
    }

    scoreGoals(f, profile, this.goals.scores);
    const before = this.goals.goal;
    if (this.goals.select(tick, dt, preempt)) this.enterGoal(view, before, this.goals.goal);
  }

  private enterGoal(view: BotWorldView, previous: ActiveGoal, next: ActiveGoal): void {
    if (previous === "cover") {
      this.coverValid = false;
      this.coverArrivedTick = -1;
    }
    if (previous === "flee") this.fleeValid = false;
    if (previous === "engage" || previous === "cover") this.fire.interrupt();
    if (next === "cover") {
      this.coverValid = false;
      this.coverArrivedTick = -1;
      this.coverHoldUntil = view.tick + ticksFor(COVER_HOLD_SECONDS, view.dt);
      this.peeks = 0;
    }
    if (next === "heal") this.useAttempts = 0;
    if (next === "idle") this.scanBaseYaw = this.aim.yaw;
    // The motor keeps its path when the new goal walks the same way; it replans when the target moves.
  }

  // -------------------------------------------------------------------------------------------------------------
  // Goal behaviors
  // -------------------------------------------------------------------------------------------------------------

  private runGoal(view: BotWorldView, out: BotTickOutput): void {
    if (this.grenade.active) {
      this.subState = "grenade";
      this.look = Look.Angles;
      this.lookYaw = this.grenade.yaw;
      this.lookPitch = this.grenade.pitch;
      return;
    }
    switch (this.goals.goal) {
      case "engage":
        return this.engage(view, out);
      case "cover":
        return this.cover(view, out);
      case "flee":
        return this.flee(view, out);
      case "heal":
        return this.heal(view, out);
      case "revive":
        return this.revive(view, out);
      case "rotate":
        return this.rotateGoal(view, out);
      case "loot":
        return this.loot(view, out);
      case "regroup":
        return this.regroup(view, out);
      case "investigate":
        return this.investigate(view, out);
      case "idle":
        this.maintain(view, out);
        this.subState = "scan";
        return this.scan(view, view.tick);
    }
  }

  private engage(view: BotWorldView, out: BotTickOutput): void {
    const tick = view.tick;
    const threat = this.perception.track(this.perception.threatSlot);
    if (!threat || threat.life === "dead") {
      this.subState = "no-target";
      this.scan(view, tick);
      return;
    }
    const recent = tick - threat.lastSeenTick <= RECENT_TICKS;
    this.combat(view, out, threat, true);
    if (!threat.visible) {
      if (this.hiddenSince < 0) this.hiddenSince = tick;
      this.maybeGrenade(view, threat);
      if (!recent || tick < this.suppressUntil) return;
      // Lost sight: push toward the last known position carefully.
      this.moveOptions.sprint = false;
      this.moveOptions.preferCover = 0.5;
      this.moveOptions.zone = null;
      this.moveOptions.arriveRadius = 3;
      this.motor.moveTo(view, threat.position.x, threat.position.y, threat.position.z, this.moveOptions);
      this.subState = "push-last-known";
    } else {
      this.hiddenSince = -1;
    }
  }

  /** Weapon choice, aim, ADS, trigger, reload and (when `move`) strafing/approach against one track. */
  private combat(view: BotWorldView, out: BotTickOutput, target: PerceivedActorState, move: boolean): void {
    const tick = view.tick;
    const dt = view.dt;
    const self = view.self;
    const profile = this.profile;
    const weapon = self.weapon;
    const input = out.input;
    const distance = target.distance;

    if (self.throwState.phase !== "idle") out.intents.holster = true;

    const wanted = chooseWeaponSlot(weapon, distance, profile);
    if (wanted >= 0 && wanted !== weapon.activeIndex && tick >= this.switchWaitUntil) {
      input.select = wanted + 1;
      const next = weapon.slots[wanted]!;
      this.switchWaitUntil = tick + ticksFor(WEAPONS[next.id].equipSeconds + 0.2, dt);
      this.fire.interrupt();
    }
    const active = weapon.slots[weapon.activeIndex];
    if (!active) {
      this.subState = "unarmed";
      this.lookAtTrack(target);
      return;
    }
    const def = WEAPONS[active.id];

    // Aim at the estimate (visible: sampled pose; otherwise the remembered or smoke-covered last position).
    const age = (tick - target.sampleTick) * dt;
    const p = this.point;
    const lead = target.visible ? Math.min(age, 0.2) : 0;
    p.x = target.position.x + target.velocity.x * lead;
    p.y = target.position.y;
    p.z = target.position.z + target.velocity.z * lead;
    const height = aimHeight(profile.aim, target.stance, target.life === "downed");
    solveAim(self.eye, p, target.visible ? target.velocity : ZERO, height, active.id, profile.aim, profile.aim.fireToleranceScale, this.solution);
    this.look = Look.Track;
    this.trackSlot = target.slot;

    if (distance > profile.fire.hipFireMeters && weapon.phase !== "reloading") {
      input.buttons |= Btn.aim;
      this.aiming = true;
    }

    // Smoke: keep suppressing the last position for a moment (rolled once per disappearance).
    if (!target.visible && target.lastSeenTick === tick - BOT_SCHEDULE.perceptionTicks && this.suppressSlot !== target.slot + tick) {
      this.suppressSlot = target.slot + tick;
      if (view.smokes.length > 0 && this.rngCombat.chance(profile.fire.smokeSuppressChance)) {
        this.suppressUntil = tick + ticksFor(profile.fire.smokeSuppressSeconds, dt);
      }
    }
    const canShoot = target.visible || tick < this.suppressUntil;

    // Reload: empty, or low with nobody in sight.
    if (weapon.phase === "ready" && active.reserve > 0 && (active.magazine === 0 || (!target.visible && active.magazine < def.magazineSize * 0.2))) {
      input.buttons |= Btn.reload;
    }

    const ready = weapon.phase === "ready" && weapon.cooldown <= 1e-6 && active.magazine > 0 && self.modifiers.allowWeapons;
    // Settle before a burst beyond close range: moving spread would waste it (the strafe stops while on target).
    const speed = Math.sqrt(self.velocity.x * self.velocity.x + self.velocity.z * self.velocity.z);
    const settling = distance > SETTLE_MIN_DISTANCE && speed > SETTLE_SPEED && !this.fire.inBurst;
    if (!this.aimSteered && tick >= this.dodgeUntil) {
      this.aim.track(target.slot, this.solution, tick, dt, profile.aim, this.rngAim, this.noiseScale);
      this.aimSteered = true;
    }
    let blocked = false;
    let press = false;
    if (canShoot && target.life !== "dead") {
      press = this.fire.decide(tick, dt, def.fireMode, distance, this.aim.perceivedErrorDeg, this.solution.toleranceDeg, ready && !settling, false, profile.aim, profile.fire, this.rngCombat);
      if (press) {
        const hit = view.actorOnSegment(self.eye, this.solution.point, self.slot);
        if (hit >= 0 && this.isTeammate(view, hit)) {
          blocked = true;
          press = false;
          this.fire.interrupt();
        }
      }
    } else {
      this.fire.interrupt();
    }
    if (press) input.buttons |= Btn.fire;
    this.subState = press ? "fire" : blocked ? "friendly-in-line" : target.visible ? "aim" : "suppress";

    if (!move) return;
    const maxRange = profile.fire.maxRange[active.id];
    if (target.visible && distance > maxRange * 0.95) {
      this.moveOptions.sprint = false;
      this.moveOptions.preferCover = 0.5;
      this.moveOptions.zone = null;
      this.moveOptions.arriveRadius = maxRange * 0.6;
      this.motor.moveTo(view, target.position.x, target.position.y, target.position.z, this.moveOptions);
      this.subState = "approach";
      return;
    }
    if (!target.visible) return;
    // Strafe perpendicular to the target, re-decided every strafe interval.
    const dx = target.position.x - self.feet.x;
    const dz = target.position.z - self.feet.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const rx = dz / len;
    const rz = -dx / len;
    if (tick >= this.nextStrafeTick || blocked) {
      this.nextStrafeTick = tick + ticksFor(this.rngCombat.span(profile.tactics.strafeIntervalSeconds), dt);
      this.strafeDir = blocked || this.rngCombat.chance(profile.tactics.strafeChance) ? (this.rngCombat.next() < 0.5 ? -1 : 1) : 0;
      if (this.strafeDir !== 0 && !this.strafeClear(view, rx * this.strafeDir, rz * this.strafeDir)) {
        this.strafeDir = this.strafeClear(view, -rx * this.strafeDir, -rz * this.strafeDir) ? -this.strafeDir : 0;
      }
      this.crouchHold = profile.difficulty !== "easy" && distance > 60 && active.id === "rifle" && this.rngCombat.chance(0.5);
    }
    // Counter-strafe: stand still while on target or firing (moving spread), strafe during burst pauses and while
    // re-acquiring.
    const onTarget = this.aim.perceivedErrorDeg <= this.solution.toleranceDeg * 1.5;
    const shooting = press || this.fire.inBurst || (onTarget && ready && !this.fire.pausing(tick) && distance > SETTLE_MIN_DISTANCE);
    if (active.id === "shotgun" && distance > 8) {
      this.motor.moveDirect(dx + rx * this.strafeDir * 2, dz + rz * this.strafeDir * 2, false);
    } else if (this.strafeDir !== 0 && !shooting) {
      this.motor.moveDirect(rx * this.strafeDir, rz * this.strafeDir, false);
    }
    this.motor.setCrouch(this.crouchHold && this.strafeDir === 0);
  }

  private strafeClear(view: BotWorldView, x: number, z: number): boolean {
    const feet = view.self.feet;
    this.scratch.x = feet.x + x * 2;
    this.scratch.y = feet.y;
    this.scratch.z = feet.z + z * 2;
    return view.nav.lineWalkable(feet, this.scratch);
  }

  private maybeGrenade(view: BotWorldView, target: PerceivedActorState): void {
    const tick = view.tick;
    const dt = view.dt;
    if (tick < this.grenadeReadyTick || this.hiddenSince < 0 || (tick - this.hiddenSince) * dt < 4) return;
    const distance = target.distance;
    if (distance < 8 || distance > 35) return;
    const inventory = view.self.inventory;
    const kind = countOf(inventory, "frag") > 0 ? "frag" : countOf(inventory, "molotov") > 0 ? "molotov" : null;
    this.grenadeReadyTick = tick + ticksFor(2, dt);
    if (kind === null || !this.rngCombat.chance(this.profile.tactics.grenadeChance)) return;
    if (this.grenade.start(view, kind, target.position, this.profile.difficulty === "hard")) {
      this.grenadeReadyTick = tick + ticksFor(this.profile.tactics.grenadeCooldownSeconds, dt);
    }
  }

  private cover(view: BotWorldView, out: BotTickOutput): void {
    const tick = view.tick;
    const dt = view.dt;
    const self = view.self;
    const threat = this.perception.track(this.perception.threatSlot) ?? this.perception.track(this.memory.bestHostile(tick - ticksFor(10, dt), -1)?.slot ?? -1);
    // Threat eye estimate: the track, or 20 m back along the last damage direction.
    const eye = this.scratch;
    if (threat) {
      eye.x = threat.position.x;
      eye.y = threat.position.y + threat.eyeHeight;
      eye.z = threat.position.z;
    } else {
      const from = this.perception.lastDamageFrom;
      eye.x = self.feet.x + from.x * 20;
      eye.y = self.eye.y;
      eye.z = self.feet.z + from.z * 20;
    }

    if (!this.coverValid) {
      const seed = (this.rngGoals.next() * 0xffffffff) >>> 0;
      this.coverValid = this.picker.findCover(view, eye, 1.5, 12, seed, this.coverPoint);
      if (!this.coverValid) {
        this.coverFailUntil = tick + ticksFor(6, dt);
        this.coverHoldUntil = tick;
        this.subState = "no-cover";
        if (threat) this.combat(view, out, threat, true);
        return;
      }
    }

    const arrived = this.coverArrivedTick >= 0;
    if (!arrived) {
      this.moveOptions.sprint = true;
      this.moveOptions.preferCover = 0.3;
      this.moveOptions.zone = null;
      this.moveOptions.arriveRadius = 0.5;
      const status = this.motor.moveTo(view, this.coverPoint.x, this.coverPoint.y, this.coverPoint.z, this.moveOptions);
      if (this.motor.gaveUp) {
        this.coverValid = false;
        this.coverFailUntil = tick + ticksFor(4, dt);
        return;
      }
      this.subState = "to-cover";
      if (status === "arrived") {
        this.coverArrivedTick = tick;
        this.nextPeekTick = tick + ticksFor(this.rngGoals.range(0.6, 1.4), dt);
      }
      if (threat && threat.visible && threat.distance < 25) this.combat(view, out, threat, false);
      return;
    }

    // In cover: crouch, reload, peek.
    const weapon = self.weapon;
    const active = weapon.slots[weapon.activeIndex];
    if (tick < this.peekUntil && threat) {
      this.subState = "peek";
      if (this.profile.difficulty === "hard" && tick - this.peekStartTick < ticksFor(0.3, dt)) {
        const dx = eye.x - self.feet.x;
        const dz = eye.z - self.feet.z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        this.motor.moveDirect((dz / len) * this.peekSide, (-dx / len) * this.peekSide, false);
      }
      this.combat(view, out, threat, false);
      return;
    }
    if (this.peekUntil >= 0 && tick >= this.peekUntil) {
      this.peekUntil = -1;
      this.peeks++;
      this.peekSide = -this.peekSide;
      this.nextPeekTick = tick + ticksFor(this.rngGoals.range(0.8, 1.6), dt);
      if (this.peeks >= 3) this.coverHoldUntil = tick;
    }
    this.motor.setCrouch(true);
    this.subState = "in-cover";
    if (active && weapon.phase === "ready" && active.reserve > 0 && active.magazine < WEAPONS[active.id].magazineSize) {
      out.input.buttons |= Btn.reload;
      this.subState = "reload-in-cover";
    }
    if (threat) this.lookAtTrack(threat);
    const reloading = weapon.phase === "reloading";
    if (!reloading && tick >= this.nextPeekTick && threat) {
      this.peekStartTick = tick;
      this.peekUntil = tick + ticksFor(this.rngGoals.span(this.profile.tactics.peekSeconds), dt);
    }
    // Drifted out of the spot (peek strafe): walk back.
    if (flatDistance(self.feet, this.coverPoint) > 1.2) {
      this.moveOptions.sprint = false;
      this.moveOptions.arriveRadius = 0.4;
      this.motor.moveTo(view, this.coverPoint.x, this.coverPoint.y, this.coverPoint.z, this.moveOptions);
    }
  }

  private flee(view: BotWorldView, out: BotTickOutput): void {
    const tick = view.tick;
    const self = view.self;
    const threat = this.perception.track(this.perception.threatSlot);
    if (!this.fleeValid) {
      let ax = this.perception.lastDamageFrom.x;
      let az = this.perception.lastDamageFrom.z;
      if (threat) {
        ax = threat.position.x - self.feet.x;
        az = threat.position.z - self.feet.z;
      }
      const len = Math.sqrt(ax * ax + az * az) || 1;
      const zone = view.zone.next ?? view.zone.current;
      const seed = (this.rngGoals.next() * 0xffffffff) >>> 0;
      this.fleeValid = this.picker.findFlee(view, -ax / len, -az / len, zone.cx, zone.cz, zone.r, seed, this.fleePoint);
      if (!this.fleeValid) {
        this.subState = "cornered";
        if (threat && threat.visible) this.combat(view, out, threat, true);
        return;
      }
    }
    this.moveOptions.sprint = true;
    this.moveOptions.preferCover = 0.8;
    this.moveOptions.zone = view.zone.next;
    this.moveOptions.arriveRadius = 3;
    const status = this.motor.moveTo(view, this.fleePoint.x, this.fleePoint.y, this.fleePoint.z, this.moveOptions);
    if (status === "arrived" || this.motor.gaveUp) this.fleeValid = false;
    this.subState = "run";
    // Cornered at close range: fight back instead of showing the back.
    if (threat && threat.visible && threat.awake(tick) && threat.distance < 10 && hasAmmo(self.weapon)) this.combat(view, out, threat, false);
  }

  private heal(view: BotWorldView, out: BotTickOutput): void {
    const tick = view.tick;
    const self = view.self;
    if (self.throwState.phase !== "idle") out.intents.holster = true;
    this.motor.setCrouch(true);
    this.scan(view, tick);
    if (self.use.itemId !== null) {
      this.subState = "using";
      this.useAttempts = 0;
      return;
    }
    const item = chooseHeal(self.inventory, self.vitals.health) ?? chooseBoost(self.inventory, self.vitals.boost);
    if (item === null) {
      this.subState = "nothing";
      return;
    }
    if (tick - this.lastUseTick >= 30) {
      if (this.useAttempts >= 3) {
        this.healBlockedUntil = tick + ticksFor(5, view.dt);
        this.subState = "blocked";
        return;
      }
      this.useAction.arg = itemCode(item);
      out.input.action = this.useAction;
      this.lastUseTick = tick;
      this.useAttempts++;
    }
    this.subState = "start-use";
  }

  private revive(view: BotWorldView, out: BotTickOutput): void {
    const tick = view.tick;
    const self = view.self;
    const mate = this.teammateBySlot(view, this.reviveSlot);
    if (!mate || mate.life !== "downed") {
      this.subState = "gone";
      return;
    }
    if (self.throwState.phase !== "idle" && !this.grenade.active) out.intents.holster = true;
    const distance = flatDistance(self.feet, mate.feet);
    const underFire = this.facts.visibleThreats > 0 || (this.perception.lastDamageTick >= 0 && tick - this.perception.lastDamageTick < ticksFor(5, view.dt));
    if (underFire && !this.reviveSmokeRolled && distance < 25) {
      this.reviveSmokeRolled = true;
      if (countOf(self.inventory, "smoke") > 0 && this.rngGoals.chance(this.profile.tactics.smokeReviveChance)) {
        if (this.grenade.start(view, "smoke", mate.feet, false)) return;
      }
    }
    if (distance <= REVIVE_REACH) {
      // Normal and hard let go when hit; the planner then preempts to cover.
      if (this.perception.damagedThisTick && this.profile.difficulty !== "easy") {
        this.subState = "revive-cancel";
        return;
      }
      out.input.buttons |= Btn.interact;
      out.intents.reviveSlot = mate.slot;
      this.look = Look.Point;
      copyVec(this.lookPoint, mate.feet);
      this.subState = "reviving";
      return;
    }
    this.moveOptions.sprint = distance > 6;
    this.moveOptions.preferCover = underFire ? 0.5 : 0;
    this.moveOptions.zone = null;
    this.moveOptions.arriveRadius = REVIVE_REACH * 0.8;
    this.motor.moveTo(view, mate.feet.x, mate.feet.y, mate.feet.z, this.moveOptions);
    this.subState = "to-teammate";
  }

  private rotateGoal(view: BotWorldView, out: BotTickOutput): void {
    this.maintain(view, out);
    const target = this.rotate.target;
    // Latch the destination: the safe point slides as the bot walks, and a sliding target flips between nav levels.
    const circle = this.rotate.circle;
    const cx = circle ? circle.cx : target.x;
    const cz = circle ? circle.cz : target.z;
    const cr = circle ? circle.r : 0;
    const latchedInside = circle !== null && flatDistance2(this.rotateLatchX, this.rotateLatchZ, cx, cz) < cr * 0.85;
    if (!this.rotateLatched || !latchedInside || this.rotateCircleR !== cr) {
      this.rotateLatchX = target.x;
      this.rotateLatchZ = target.z;
      this.rotateLatchY = view.self.feet.y;
      this.rotateCircleR = cr;
      this.rotateLatched = true;
    }
    this.moveOptions.sprint = true;
    this.moveOptions.preferCover = 0.2;
    this.moveOptions.zone = this.rotate.circle;
    this.moveOptions.arriveRadius = 8;
    const status = this.motor.moveTo(view, this.rotateLatchX, this.rotateLatchY, this.rotateLatchZ, this.moveOptions);
    if (this.motor.gaveUp) this.rotateLatched = false;
    this.subState = this.rotate.outside ? "outside-zone" : status === "pending" ? "planning" : "to-zone";
  }

  private loot(view: BotWorldView, out: BotTickOutput): void {
    const tick = view.tick;
    const self = view.self;
    this.maintain(view, out);
    if (this.lootId < 0) {
      this.searchBuildings(view);
      return;
    }
    const d = flatDistance(self.feet, this.lootPos);
    if ((tick - this.lootTargetTick) * view.dt > LOOT_TARGET_SECONDS) {
      // Couldn't reach or take it in time (other floor, behind furniture): skip it.
      this.memory.skipLoot(this.lootId, tick + ticksFor(LOOT_SKIP_SECONDS * 3, view.dt));
      this.clearLoot();
      return;
    }
    const eyeGap = Math.sqrt(d * d + (this.lootPos.y + 0.15 - self.eye.y) * (this.lootPos.y + 0.15 - self.eye.y));
    if (d <= PICKUP_REACH) this.motor.setCrouch(eyeGap > INTERACT.reach - 0.2);
    // The match allows INTERACT.reach + 0.4 from the eye with a clear line; stay a little inside it.
    if (d <= PICKUP_REACH && eyeGap <= INTERACT.reach + 0.25) {
      this.look = Look.Point;
      copyVec(this.lookPoint, this.lootPos);
      this.subState = "pickup";
      if (tick - this.lastPickupTick >= PICKUP_RETRY_TICKS) {
        if (this.lootAttempts >= 3) {
          this.memory.skipLoot(this.lootId, tick + ticksFor(LOOT_SKIP_SECONDS, view.dt));
          this.clearLoot();
          return;
        }
        this.pickupAction.arg = this.lootId;
        out.input.action = this.pickupAction;
        out.intents.replaceSlot = this.lootReplace;
        this.lastPickupTick = tick;
        this.lootAttempts++;
      }
      return;
    }
    this.moveOptions.sprint = d > 8;
    this.moveOptions.preferCover = 0;
    this.moveOptions.zone = null;
    this.moveOptions.arriveRadius = PICKUP_RANGE * 0.6;
    const status = this.motor.moveTo(view, this.lootPos.x, this.lootPos.y, this.lootPos.z, this.moveOptions);
    this.subState = "to-item";
    if (this.motor.gaveUp) {
      this.memory.skipLoot(this.lootId, tick + ticksFor(LOOT_SKIP_SECONDS, view.dt));
      this.clearLoot();
    }
  }

  /** No item in sight: walk into the nearest unsearched building and look around its rooms. */
  private searchBuildings(view: BotWorldView): void {
    const zone = view.zone.next ?? view.zone.current;
    if (!this.search.available(view, zone, this.facts.unarmed ? SEARCH_MAX_DISTANCE_UNARMED : undefined, view.tick < this.zonePressureUntil)) {
      this.subState = "nothing-to-search";
      this.scan(view, view.tick);
      return;
    }
    const p = this.search.point;
    const approach = this.search.stage === "approach";
    this.moveOptions.sprint = approach;
    this.moveOptions.preferCover = 0;
    this.moveOptions.zone = null;
    this.moveOptions.arriveRadius = approach ? 2.5 : 1.2;
    const status = this.motor.moveTo(view, p.x, p.y, p.z, this.moveOptions);
    if (!this.search.advance(view, status === "arrived", this.motor.gaveUp, this.rngGoals, zone)) {
      this.subState = "nothing-to-search";
      return;
    }
    this.subState = this.search.stage === "approach" ? "to-building" : "search-rooms";
  }

  /** Missing a primary, body armor or heals. */
  private poorlyEquipped(self: BotWorldView["self"]): boolean {
    const inv = self.inventory;
    if (!inv.weapons[0] && !inv.weapons[1]) return true;
    if (!inv.vest && !inv.helmet) return true;
    return chooseHeal(inv, 50) === null;
  }

  private regroup(view: BotWorldView, out: BotTickOutput): void {
    const tick = view.tick;
    const self = view.self;
    this.maintain(view, out);
    const mate = this.aliveTeammate(view);
    if (!mate) {
      this.subState = "alone";
      return;
    }
    const behind = mate.yaw + Math.PI + this.regroupSide * 0.7;
    const distance = 4 + ((this.slot * 7) % 5);
    this.regroupPoint.x = mate.feet.x + Math.sin(behind) * distance;
    this.regroupPoint.y = mate.feet.y;
    this.regroupPoint.z = mate.feet.z + Math.cos(behind) * distance;
    const d = flatDistance(self.feet, this.regroupPoint);
    if (d < 3) {
      this.subState = "overwatch";
      this.look = Look.Angles;
      this.lookYaw = mate.yaw + this.regroupSide * (Math.PI / 2) + Math.sin(tick * view.dt * 0.7) * 0.6;
      this.lookPitch = 0;
      return;
    }
    this.moveOptions.sprint = d > 15;
    this.moveOptions.preferCover = 0;
    this.moveOptions.zone = null;
    this.moveOptions.arriveRadius = 2;
    this.motor.moveTo(view, this.regroupPoint.x, this.regroupPoint.y, this.regroupPoint.z, this.moveOptions);
    this.subState = "follow";
  }

  private investigate(view: BotWorldView, out: BotTickOutput): void {
    const tick = view.tick;
    const self = view.self;
    this.maintain(view, out);
    const entry = this.memory.bestHostile(0, -1);
    if (!entry) {
      this.subState = "lost";
      this.scan(view, tick);
      return;
    }
    this.memory.estimate(entry, tick, view.dt, this.investigatePoint);
    const d = flatDistance(self.feet, this.investigatePoint);
    this.look = Look.Point;
    copyVec(this.lookPoint, this.investigatePoint);
    this.lookPoint.y += 1.4;
    const weapon = self.weapon;
    if (weapon.slots[weapon.activeIndex] && d < 60) {
      out.input.buttons |= Btn.aim;
      this.aiming = true;
    }
    if (d < 4) {
      this.subState = "search";
      this.memory.forget(entry.slot);
      return;
    }
    this.moveOptions.sprint = false;
    this.moveOptions.preferCover = 0.5;
    this.moveOptions.zone = null;
    this.moveOptions.arriveRadius = 3;
    const status = this.motor.moveTo(view, this.investigatePoint.x, this.investigatePoint.y, this.investigatePoint.z, this.moveOptions);
    this.subState = "approach";
    if (this.motor.gaveUp) this.memory.forget(entry.slot);
  }

  private downed(view: BotWorldView): void {
    const self = view.self;
    const mate = this.aliveTeammate(view);
    const threat = this.perception.track(this.perception.threatSlot);
    this.subState = "downed";
    if (mate && mate.life === "alive" && flatDistance(self.feet, mate.feet) > 1.5) {
      this.goalKind = "regroup";
      this.moveOptions.sprint = false;
      this.moveOptions.preferCover = 0.5;
      this.moveOptions.zone = null;
      this.moveOptions.arriveRadius = 1.2;
      this.motor.moveTo(view, mate.feet.x, mate.feet.y, mate.feet.z, this.moveOptions);
    } else if (threat && threat.visible) {
      this.goalKind = "flee";
      this.motor.moveDirect(self.feet.x - threat.position.x, self.feet.z - threat.position.z, false);
    } else {
      this.goalKind = "idle";
    }
  }

  /** Out-of-combat upkeep: put away stray throwables, reload, draw the best primary. */
  private maintain(view: BotWorldView, out: BotTickOutput): void {
    const tick = view.tick;
    const self = view.self;
    const weapon = self.weapon;
    if (self.throwState.phase !== "idle" && !this.grenade.active) out.intents.holster = true;
    const active = weapon.slots[weapon.activeIndex];
    if (active && weapon.phase === "ready" && active.reserve > 0 && active.magazine < WEAPONS[active.id].magazineSize * 0.6 && this.facts.safeSeconds > 2) {
      out.input.buttons |= Btn.reload;
    }
    if (tick >= this.switchWaitUntil && weapon.phase !== "reloading") {
      const best = chooseWeaponSlot(weapon, 40, this.profile);
      if (best >= 0 && best !== weapon.activeIndex) {
        out.input.select = best + 1;
        this.switchWaitUntil = tick + ticksFor(1.5, view.dt);
      }
    }
  }

  private scan(view: BotWorldView, tick: number): void {
    this.look = Look.Angles;
    this.lookYaw = this.scanBaseYaw + Math.sin(tick * view.dt * 0.8 + this.slot) * 60 * DEG;
    this.lookPitch = 0;
  }

  private lookAtTrack(track: PerceivedActorState): void {
    this.look = Look.Point;
    this.lookPoint.x = track.position.x;
    this.lookPoint.y = track.position.y + track.eyeHeight * 0.8;
    this.lookPoint.z = track.position.z;
  }

  /**
   * Turn toward something half-noticed (a figure building awareness, a hostile noise in the last second) so the field
   * of view can confirm it: what a player does when movement catches the eye. Uses perception only.
   */
  private glance(view: BotWorldView): void {
    if (this.grenade.active) return;
    const tick = view.tick;
    const tracks = this.perception.actors;
    let best: PerceivedActorState | null = null;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i]!;
      if (!t.hostile || t.life === "dead" || t.awareness < 0.1) continue;
      if (!t.visible && tick - t.lastSeenTick > 60) continue;
      if (!best || t.awareness > best.awareness) best = t;
    }
    if (best) {
      this.lookAtTrack(best);
      return;
    }
    const heard = this.memory.bestHostile(tick - 60, -1);
    if (heard && heard.source !== "seen") {
      this.look = Look.Point;
      this.lookPoint.x = heard.position.x;
      this.lookPoint.y = heard.position.y + 1.4;
      this.lookPoint.z = heard.position.z;
    }
  }

  /** Flashbang dodge and escaping a live grenade, over any goal. */
  private reactToThrowables(view: BotWorldView): void {
    const tick = view.tick;
    const self = view.self;
    const count = this.perception.seenThrowableList();
    for (let i = 0; i < count; i++) {
      const t = this.perception.seenThrowables[i]!;
      if (t.tick !== this.perception.tick) continue;
      const d = flatDistance(self.feet, t.position);
      if (t.kind === "flash" && !t.atRest && d < 20 && t.id !== this.dodgedId) {
        this.dodgedId = t.id;
        if (this.rngCombat.chance(this.profile.tactics.flashDodgeChance)) {
          this.dodgeUntil = tick + ticksFor(2.5, view.dt);
          this.dodgeYaw = Math.atan2(self.feet.x - t.position.x, self.feet.z - t.position.z);
        }
      } else if ((t.kind === "frag" || t.kind === "molotov") && d < 8) {
        this.escapeUntil = tick + ticksFor(1.5, view.dt);
        const len = d || 1;
        this.escapeDir.x = (self.feet.x - t.position.x) / len;
        this.escapeDir.z = (self.feet.z - t.position.z) / len;
        this.memory.addDanger(t.position.x, t.position.z, 8, 6, tick + ticksFor(6, view.dt));
      }
    }
    if (tick < this.escapeUntil) {
      this.motor.moveDirect(this.escapeDir.x, this.escapeDir.z, true);
      this.subState = "escape-grenade";
    }
    if (tick < this.dodgeUntil) {
      // Turn the view ~120° away from the flash.
      this.look = Look.Angles;
      this.lookYaw = this.dodgeYaw + (this.slot % 2 === 0 ? 1 : -1) * 0.5;
      this.lookPitch = 0.2;
      this.fire.interrupt();
      this.subState = "flash-dodge";
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Aim, output, debug
  // -------------------------------------------------------------------------------------------------------------

  private steerAim(view: BotWorldView): void {
    const tick = view.tick;
    const dt = view.dt;
    const aim = this.profile.aim;
    const self = view.self;
    if (this.aimSteered && this.look === Look.Track) return;
    switch (this.look) {
      case Look.Track:
        // combat() steers with aim.track; a flash dodge overrides it with Look.Angles.
        return;
      case Look.Angles:
        this.aim.look(this.lookYaw, this.lookPitch, tick, dt, aim, this.grenade.active ? 1 : LOOK_RATE_CASUAL);
        return;
      case Look.Point: {
        const dx = this.lookPoint.x - self.eye.x;
        const dz = this.lookPoint.z - self.eye.z;
        const h = Math.sqrt(dx * dx + dz * dz);
        const yaw = h > 0.05 ? Math.atan2(dx, dz) : this.aim.yaw;
        const pitch = Math.atan2(self.eye.y - this.lookPoint.y, Math.max(h, 0.3));
        this.aim.look(yaw, pitch, tick, dt, aim, 0.8);
        return;
      }
      case Look.Move: {
        const yaw = this.motor.moving || this.motor.status === "moving" ? this.motor.moveYaw : this.aim.yaw;
        this.aim.look(yaw, 0, tick, dt, aim, LOOK_RATE_CASUAL);
        return;
      }
    }
  }

  private writeAim(input: BotTickOutput["input"]): void {
    input.yawQ = quantizeYaw(this.aim.yaw);
    input.pitchQ = quantizePitch(this.aim.pitch);
  }

  private updateDebug(): void {
    const d = this.debugState;
    d.goal = this.goalKind;
    d.goalScore = this.goals.score;
    d.subState = this.subState;
    d.targetSlot = this.trackSlot;
    d.aimErrorDeg = this.trackSlot >= 0 ? this.aim.errorDeg : Number.NaN;
    d.path = this.motor.status === "moving" ? this.motor.path : null;
    d.moveTarget = this.motor.moving ? this.motor.moveTarget : null;
    d.lootTargetId = this.lootId;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Loot scan (2 Hz)
  // -------------------------------------------------------------------------------------------------------------

  private scanLoot(view: BotWorldView): void {
    const self = view.self;
    const tick = view.tick;
    const inventory = self.inventory;
    const n = view.queryLoot(self.feet, LOOT_SCAN_RADIUS, this.lootBuffer);
    const free = capacityOf(inventory.backpack, inventory.vest !== null) - bagWeight(inventory);
    let bestValue = 0;
    let bestIndex = -1;
    let bestReplace: -1 | 0 | 1 | 2 = -1;
    let rays = 0;
    let currentStillThere = false;
    for (let i = 0; i < n && i < LOOT_CAPACITY; i++) {
      const item = this.lootBuffer[i]!;
      if (item.lootId === this.lootId) currentStillThere = true;
      if (this.memory.isLootSkipped(item.lootId, tick)) continue;
      const def = ITEMS[item.itemId];
      const fits = def.weight > 0 ? Math.min(Math.floor((free + 1e-9) / def.weight), def.maxStack - countOf(inventory, item.itemId)) : 1;
      lootNeed(item.itemId, inventory, this.profile.difficulty, fits, this.need);
      if (this.need.need <= 0) continue;
      const dx = item.position[0] - self.feet.x;
      const dy = item.position[1] - self.feet.y;
      const dz = item.position[2] - self.feet.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Sticky target: the current item keeps a bonus so the bot doesn't flip between equal items.
      const value = this.need.need * Math.exp(-d / 25) * (item.lootId === this.lootId ? 1.15 : 1);
      if (value <= bestValue) continue;
      if (d > 3 && item.lootId !== this.lootId) {
        if (rays >= LOOT_MAX_RAYS) continue;
        rays++;
        this.scratch.x = item.position[0];
        this.scratch.y = item.position[1] + 0.15;
        this.scratch.z = item.position[2];
        if (view.raycast(self.eye, this.scratch) !== null) continue;
      }
      bestValue = value;
      bestIndex = i;
      bestReplace = this.need.replaceSlot;
    }
    if (this.lootId >= 0 && !currentStillThere) this.clearLoot();
    if (bestIndex < 0) {
      this.clearLoot();
      return;
    }
    const item = this.lootBuffer[bestIndex]!;
    if (item.lootId !== this.lootId) {
      this.lootAttempts = 0;
      this.lootId = item.lootId;
      this.lootTargetTick = tick;
    }
    this.lootReplace = bestReplace;
    this.lootValue = bestValue;
    this.lootPos.x = item.position[0];
    this.lootPos.y = item.position[1];
    this.lootPos.z = item.position[2];
  }

  private clearLoot(): void {
    this.lootId = -1;
    this.lootValue = 0;
    this.lootAttempts = 0;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Teammates (squad knowledge: allowed)
  // -------------------------------------------------------------------------------------------------------------

  /** The teammate to stay with: a living human, else the nearest living teammate (squads have up to three). */
  private aliveTeammate(view: BotWorldView): TeammateView | null {
    const mates = view.teammates;
    let best: TeammateView | null = null;
    let bestD = Infinity;
    for (let i = 0; i < mates.length; i++) {
      const m = mates[i]!;
      if (m.slot === this.slot || m.life !== "alive") continue;
      const d = m.kind === "human" ? -1 : flatDistance(view.self.feet, m.feet);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /** Nearest downed teammate nobody else is reviving (the one this bot already revives wins). */
  private downedTeammate(view: BotWorldView): TeammateView | null {
    const mates = view.teammates;
    let best: TeammateView | null = null;
    let bestD = Infinity;
    for (let i = 0; i < mates.length; i++) {
      const m = mates[i]!;
      if (m.slot === this.slot || m.life !== "downed" || (m.reviverSlot >= 0 && m.reviverSlot !== this.slot)) continue;
      const d = m.reviverSlot === this.slot ? -1 : flatDistance(view.self.feet, m.feet);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  private teammateBySlot(view: BotWorldView, slot: number): TeammateView | null {
    const mates = view.teammates;
    for (let i = 0; i < mates.length; i++) if (mates[i]!.slot === slot) return mates[i]!;
    return null;
  }

  private isTeammate(view: BotWorldView, slot: number): boolean {
    return this.teammateBySlot(view, slot) !== null;
  }
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

function flatDistance2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

function flatDistance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

function bagWeight(inventory: BotWorldView["self"]["inventory"]): number {
  let weight = 0;
  const stacks = inventory.stacks;
  for (let i = 0; i < stacks.length; i++) weight += ITEMS[stacks[i]!.itemId].weight * stacks[i]!.quantity;
  return weight;
}

/** The offline/server bot brain (a `BotBrainFactory`). */
export const createBotBrain: BotBrainFactory = (options) => new UtilityBrain(options);
