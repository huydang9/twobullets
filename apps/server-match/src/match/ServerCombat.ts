import { NET_RESPAWN_SECONDS, NET_REVIVE_GRACE_TICKS, type MatchRules } from "@twobullets/contracts";
import { LagCompHistory } from "@twobullets/netcode";
import { killFeedOf, writeDamageTaken, writeHitConfirm, writeKill } from "@twobullets/netcode/replication";
import { createBitWriter, createReliableEventStore, encodeKillFeed, hitZoneMaskBit, type KillCause } from "@twobullets/protocol";
import type { ArmorLoadout, DamageKind } from "@twobullets/shared/equipment/armor";
import { withArmor } from "@twobullets/shared/equipment/inventory";
import { applyDamage, eliminate, stepRevive, stepVitals, VITALS } from "@twobullets/shared/equipment/vitals";
import type { HitPose } from "@twobullets/shared/hitreg/rig";
import { stanceBlendOf } from "@twobullets/shared/hitreg/rig";
import { Btn } from "@twobullets/shared/input";
import { canActorBeKnocked, downedWithoutStandingTeammate, killCauseOf, type MutableTeamState } from "@twobullets/shared/match/rules";
import type { Vec3 } from "@twobullets/shared/movement/types";
import { computeDamage } from "@twobullets/shared/weapons/ballistics";
import type { AimedShot, HitZone, RaycastFn, WeaponId } from "@twobullets/shared/weapons/types";
import { WEAPONS } from "@twobullets/shared/weapons/weapons";
import { dequantizePitch, dequantizeYaw } from "@twobullets/shared/aim";
import { ServerProjectiles, type ProjectileHitSink } from "../hitreg/ServerProjectiles";
import { HitLog, ShotLog } from "../snapshot/eventLog";
import type { Player } from "./Player";

// Server combat (T4.3/T4.6): shots → server projectiles with shooter-time rewind → damage pipeline (shared rules: zone
// multipliers and falloff, armor, knock while a teammate stands, bleed-out, 5 s revive, team wipes) → events. Tier-U
// Shot/PlayerHit go to the shared logs the snapshot builder reads; tier-R HitConfirm/DamageTaken/Kill go to each
// recipient's reliable queue; KillFeed goes on every control stream. Without a BR lifecycle (M4 sandbox, BR warmup) the dead
// respawn after NET_RESPAWN_SECONDS at their server spawn with a fresh loadout; BrLifecycle turns respawns off for combat.

export interface ServerCombatOptions {
  readonly rules: MatchRules;
  readonly maxSlots: number;
  readonly raycastWorld: RaycastFn;
  readonly tickRate?: number;
  /** Damage between players (M5 turns it off during Warmup). Default true. */
  readonly damageEnabled?: boolean;
  /** Armor players spawn with (tests). Default none. */
  readonly spawnArmor?: () => ArmorLoadout;
}

export interface CombatStats {
  shotsFired: number;
  /** Shots whose claimed view delay was clamped. */
  viewDelayClamps: number;
  hits: number;
  damageEvents: number;
  knocks: number;
  kills: number;
  revives: number;
  respawns: number;
  friendlyFireHits: number;
}

export interface CombatHost {
  /** Sparse, indexed by slot. */
  readonly slots: readonly (Player | null)[];
  /** Dense, sorted by slot. */
  readonly players: readonly Player[];
  respawn(p: Player): void;
}

/** Hits aggregated per (shooter, shotId, victim) within one tick (netcode.md §5.6). */
interface HitAggregate {
  shooter: number;
  shotId: number;
  victim: number;
  pellets: number;
  zones: number;
  bestZone: HitZone;
  damage: number;
  killed: boolean;
  downed: boolean;
  armorHit: boolean;
  armorBroken: boolean;
  dirX: number;
  dirZ: number;
}

const MAX_AGGREGATES = 128;
/** Max |Δy| between reviver and downed feet, m (MatchSim's REVIVE_HEIGHT). */
const REVIVE_HEIGHT = 1.5;
const ZONE_RANK: Readonly<Record<HitZone, number>> = { limb: 1, body: 2, head: 3 };

export class ServerCombat implements ProjectileHitSink {
  readonly history: LagCompHistory;
  readonly projectiles: ServerProjectiles;
  readonly shots = new ShotLog();
  readonly hits = new HitLog();
  readonly stats: CombatStats = { shotsFired: 0, viewDelayClamps: 0, hits: 0, damageEvents: 0, knocks: 0, kills: 0, revives: 0, respawns: 0, friendlyFireHits: 0 };
  readonly rules: MatchRules;
  /** Player and fall damage (off in BR warmup, glide and end). Zone damage is applied by the lifecycle. */
  damageEnabled: boolean;
  /** The dead respawn after NET_RESPAWN_SECONDS (sandbox and BR warmup); off in BR combat. */
  respawnEnabled = true;
  /** Damage dealt to a player (server bots' DamageTaken). `dirX/dirZ`: horizontal direction the damage travelled. */
  onDamage: ((victim: Player, attacker: number, amount: number, kind: DamageKind, dirX: number, dirZ: number) => void) | null = null;
  /** A player died (any cause), after the kill events: the match drops their inventory (B5). */
  onKilled: ((victim: Player) => void) | null = null;
  private readonly dt: number;
  private readonly respawnTicks: number;
  private readonly spawnArmor: (() => ArmorLoadout) | null;
  private readonly hittable: Uint8Array;
  private readonly teams: MutableTeamState[] = [];
  private readonly wipes: number[] = [];
  private readonly aggregates: HitAggregate[] = [];
  private aggregateCount = 0;
  private readonly store = createReliableEventStore();
  private readonly feedWriter = createBitWriter(64);
  private readonly pose: HitPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, stanceBlend: 0 };
  private host: CombatHost | null = null;
  private tickNow = 0;

  constructor(options: ServerCombatOptions) {
    this.rules = options.rules;
    this.damageEnabled = options.damageEnabled ?? true;
    const tickRate = options.tickRate ?? 60;
    this.dt = 1 / tickRate;
    this.respawnTicks = Math.round(NET_RESPAWN_SECONDS * tickRate);
    this.spawnArmor = options.spawnArmor ?? null;
    this.history = new LagCompHistory({ maxSlots: options.maxSlots });
    this.projectiles = new ServerProjectiles(this.history, options.raycastWorld);
    this.hittable = new Uint8Array(options.maxSlots);
    for (let i = 0; i < MAX_AGGREGATES; i++) {
      this.aggregates.push({ shooter: 0, shotId: 0, victim: 0, pellets: 0, zones: 0, bestZone: "body", damage: 0, killed: false, downed: false, armorHit: false, armorBroken: false, dirX: 0, dirZ: 0 });
    }
  }

  attach(host: CombatHost, teamCount: number, teamSize: number): void {
    this.host = host;
    this.teams.length = 0;
    for (let team = 0; team < teamCount; team++) {
      const slots: number[] = [];
      for (let i = 0; i < teamSize; i++) if (team * teamSize + i < host.slots.length) slots.push(team * teamSize + i);
      this.teams.push({ team, slots, standing: 0, inPlay: 0, eliminated: false, eliminatedTick: -1, placement: null, kills: 0 });
    }
  }

  /** Fresh vitals and armor for a (re)spawn. */
  armorForSpawn(): ArmorLoadout {
    return this.spawnArmor?.() ?? { helmet: null, vest: null };
  }

  /** Start of a tick, before players step. */
  beginTick(tick: number): void {
    this.tickNow = tick;
    this.shots.trim(tick);
    this.hits.trim(tick);
  }

  /** A shot the weapon step fired for `p` this tick (only alive players fire). */
  fire(p: Player, shot: AimedShot, viewOffset8: number): void {
    // Server bots aim at present-time poses: no rewind.
    let d = 0;
    if (p.bot === null) {
      const clampsBefore = p.viewDelay.stats.clamps;
      d = p.viewDelay.validate(viewOffset8, this.history.maxRewindTicks);
      if (p.viewDelay.stats.clamps !== clampsBefore) this.stats.viewDelayClamps++;
    }
    this.projectiles.spawn(shot, p.slot, d);
    this.shots.add(this.tickNow, p.slot, shot, p.yawQ, p.pitchQ);
    this.stats.shotsFired++;
  }

  /** Fall damage from a `landed` movement event. */
  landed(p: Player, damage: number): void {
    if (damage > 0 && this.damageEnabled) this.damage(p, damage, "fall", null, -1, null, 0, 0, 0, true);
  }

  /**
   * Area damage from a throwable (protocol v9, ServerThrowables): the shared blast/fire rules already decided the
   * amount, so this only runs the damage pipeline (armor, knock, kill credit to `attacker`, kill feed with cause
   * `frag`/`molotov`). Friendly fire follows the match rules; self damage always lands, like offline.
   */
  areaDamage(victim: Player, amount: number, kind: "explosion" | "fire", attacker: number, position: Vec3): void {
    if (victim.life === "dead" || !this.damageEnabled || !(amount > 0)) return;
    const attackerPlayer = attacker >= 0 ? (this.host!.slots[attacker] ?? null) : null;
    const sameTeam = attackerPlayer !== null && attackerPlayer.slot !== victim.slot && attackerPlayer.teamId === victim.teamId;
    if (sameTeam && !this.rules.friendlyFire) return;
    if (sameTeam) this.stats.friendlyFireHits++;
    const feet = victim.feet;
    const dx = position.x - feet.x;
    const dz = position.z - feet.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    const toX = length > 1e-6 ? dx / length : 0;
    const toZ = length > 1e-6 ? dz / length : 0;
    this.damage(victim, amount, kind, null, attacker, null, length, toX, toZ, true);
  }

  /** Zone damage (BR combat); the owner sees it through vitals, no DamageTaken per zone tick. */
  zoneDamage(p: Player, amount: number): void {
    if (p.life !== "dead") this.damage(p, amount, "zone", null, -1, null, 0, 0, 0, false);
  }

  /** Out of the match without a killer (disconnected past the reconnect grace in BR combat). */
  forfeit(p: Player): void {
    if (p.life === "dead") return;
    const knockedBy = p.life === "downed" ? p.vitals.knockedById : -1;
    p.vitals = eliminate(p.vitals);
    this.onDeath(p, knockedBy, "unknown", false, knockedBy, 0);
    this.resolveWipes();
  }

  /** Below the level's kill plane. */
  outOfBounds(p: Player): void {
    if (p.life === "dead") return;
    const knockedBy = p.life === "downed" ? p.vitals.knockedById : -1;
    p.vitals = eliminate(p.vitals);
    this.onDeath(p, knockedBy, "outOfBounds", false, knockedBy, 0);
    this.resolveWipes();
  }

  /** The slot left the match. */
  removed(slot: number): void {
    this.history.clear(slot);
    this.projectiles.clearShooter(slot);
    this.hittable[slot] = 0;
  }

  /** After every player stepped: record poses, fly bullets, apply hits, revive, bleed, respawn. */
  endTick(tick: number): void {
    const host = this.host!;
    const players = host.players;
    const pose = this.pose;
    const hittable = this.hittable;
    hittable.fill(0);
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      const feet = p.body.feet;
      pose.x = feet.x;
      pose.y = feet.y;
      pose.z = feet.z;
      pose.yaw = dequantizeYaw(p.yawQ);
      pose.pitch = dequantizePitch(p.pitchQ);
      pose.stanceBlend = stanceBlendOf(p.state.move.stance);
      this.history.record(tick, p.slot, pose, !p.poseDiscontinuous);
      p.poseDiscontinuous = false;
      if (p.life !== "dead") hittable[p.slot] = 1;
    }

    this.aggregateCount = 0;
    this.projectiles.step(tick, this.dt, hittable, this);
    this.flushHits();

    for (let i = 0; i < players.length; i++) this.stepRevive(players[i]!, tick);
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.life === "downed") this.stepBleed(p);
    }
    if (!this.respawnEnabled) return;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.life === "dead" && p.deathTick >= 0 && tick - p.deathTick >= this.respawnTicks) {
        this.stats.respawns++;
        host.respawn(p);
      }
    }
  }

  // ---- ProjectileHitSink ------------------------------------------------------------------------------------------

  playerHit(shooter: number, shotId: number, weaponId: WeaponId, victim: number, zone: HitZone, distance: number, _point: Vec3, dir: Vec3): void {
    const slots = this.host!.slots;
    const v = slots[victim];
    if (v === null || v === undefined || v.life === "dead") return;
    this.stats.hits++;
    if (!this.damageEnabled) return;
    const attacker = slots[shooter] ?? null;
    const sameTeam = attacker !== null && attacker.teamId === v.teamId;
    // Friendly fire off: the teammate's body still stops the bullet.
    if (sameTeam && !this.rules.friendlyFire) return;
    if (sameTeam) this.stats.friendlyFireHits++;
    const agg = this.aggregateFor(shooter, shotId, victim);
    const r = this.damage(v, computeDamage(WEAPONS[weaponId], zone, distance), "bullet", zone, shooter, weaponId, distance, -dir.x, -dir.z, false);
    if (agg === null) return;
    agg.pellets++;
    agg.zones |= hitZoneMaskBit(zone);
    if (ZONE_RANK[zone] > ZONE_RANK[agg.bestZone]) agg.bestZone = zone;
    agg.damage += r.dealt;
    agg.killed ||= r.killed;
    agg.downed ||= r.knocked;
    agg.armorHit ||= r.absorbed > 0;
    agg.armorBroken ||= r.destroyed;
    agg.dirX = dir.x;
    agg.dirZ = dir.z;
  }

  // ---- Damage pipeline --------------------------------------------------------------------------------------------

  private readonly result = { dealt: 0, absorbed: 0, destroyed: false, knocked: false, killed: false };

  /**
   * One hit through the shared pipeline (armor → health → knock/kill by team state). `toX/toZ` points from the victim
   * toward the source. `notify` sends DamageTaken right away (non-aggregated damage such as falls).
   */
  private damage(
    v: Player,
    amount: number,
    kind: DamageKind,
    zone: HitZone | null,
    attacker: number,
    weaponId: WeaponId | null,
    distance: number,
    toX: number,
    toZ: number,
    notify: boolean,
  ): { dealt: number; absorbed: number; destroyed: boolean; knocked: boolean; killed: boolean } {
    const r = this.result;
    r.dealt = 0;
    r.absorbed = 0;
    r.destroyed = false;
    r.knocked = false;
    r.killed = false;
    if (v.life === "dead" || !(amount > 0)) return r;
    const wasDowned = v.life === "downed";
    const knockedByBefore = v.vitals.knockedById;
    const canBeKnocked = canActorBeKnocked(this.rules, v.slot, v.teamId, this.host!.slots);
    const outcome = applyDamage(v.vitals, v.armor, { amount, kind, zone, sourceId: attacker }, { canBeKnocked });
    v.vitals = outcome.vitals;
    if (outcome.armor !== v.armor) {
      v.armor = outcome.armor;
      v.inventory = withArmor(v.inventory, outcome.armor);
    }
    r.dealt = outcome.dealt;
    r.absorbed = outcome.armorResult.absorbed;
    r.destroyed = outcome.armorResult.destroyed;
    r.knocked = outcome.knocked;
    r.killed = outcome.killed;
    if (outcome.dealt <= 0 && r.absorbed <= 0) return r;
    this.stats.damageEvents++;
    if (this.onDamage !== null && outcome.dealt > 0) this.onDamage(v, attacker, outcome.dealt, kind, -toX, -toZ);
    const attackerPlayer = attacker >= 0 ? this.host!.slots[attacker] : null;
    if (attackerPlayer && attackerPlayer.teamId !== v.teamId) attackerPlayer.combat.damageDealt = Math.round((attackerPlayer.combat.damageDealt + outcome.dealt) * 10) / 10;
    if (notify && v.session !== null) v.net.push(writeDamageTaken(attacker, outcome.dealt, zone, kind, toX, toZ, this.store));

    const cause = killCauseOf(kind, weaponId);
    const headshot = zone === "head";
    if (outcome.knocked) {
      this.cancelRevive(v);
      this.stats.knocks++;
      if (attackerPlayer && attackerPlayer.teamId !== v.teamId) attackerPlayer.combat.knocks++;
      this.emitKill(attacker, v, cause, headshot, true, -1, distance);
    }
    if (outcome.killed) this.onDeath(v, outcome.killerId, cause, headshot, wasDowned ? knockedByBefore : -1, distance);
    if (outcome.knocked || outcome.killed) this.resolveWipes();
    return r;
  }

  private onDeath(v: Player, killer: number, cause: KillCause, headshot: boolean, knockedBy: number, distance: number): void {
    if (v.deathTick >= 0) return;
    v.deathTick = this.tickNow;
    v.combat.deaths++;
    this.hittable[v.slot] = 0;
    this.cancelRevive(v);
    this.stats.kills++;
    const killerPlayer = killer >= 0 ? this.host!.slots[killer] : null;
    if (killerPlayer && killer !== v.slot && killerPlayer.teamId !== v.teamId) killerPlayer.combat.kills++;
    this.emitKill(killer, v, cause, headshot, false, knockedBy, distance);
    this.onKilled?.(v);
  }

  /** Downed members of teams with nobody standing are eliminated (credit to their knocker). */
  private resolveWipes(): void {
    const wipes = downedWithoutStandingTeammate(this.teams, this.host!.slots, this.wipes);
    for (let i = 0; i < wipes.length; i++) {
      const p = this.host!.slots[wipes[i]!];
      if (!p || p.life !== "downed") continue;
      const knockedBy = p.vitals.knockedById;
      p.vitals = eliminate(p.vitals);
      this.onDeath(p, knockedBy, "teamWipe", false, knockedBy, 0);
    }
  }

  /** Kill or knock to every connected client (tier R) and the kill feed on every control stream. */
  private emitKill(killer: number, v: Player, cause: KillCause, headshot: boolean, knock: boolean, knockedBy: number, distance: number): void {
    const host = this.host!;
    const killerPlayer = killer >= 0 ? host.slots[killer] : null;
    const friendlyFire = killerPlayer !== null && killerPlayer !== undefined && killer !== v.slot && killerPlayer.teamId === v.teamId;
    const event = writeKill(killer, v.slot, cause, headshot, friendlyFire, knock, distance, this.store);
    const w = this.feedWriter;
    w.reset();
    encodeKillFeed(w, killFeedOf(this.tickNow, killer, v.slot, cause, knockedBy, headshot, friendlyFire, knock, distance));
    const feed = w.bytes();
    for (const p of host.players) {
      if (p.session === null) continue;
      p.net.push(event);
      p.session.sendStream(feed);
    }
  }

  private aggregateFor(shooter: number, shotId: number, victim: number): HitAggregate | null {
    for (let i = 0; i < this.aggregateCount; i++) {
      const a = this.aggregates[i]!;
      if (a.shooter === shooter && a.shotId === shotId && a.victim === victim) return a;
    }
    if (this.aggregateCount >= MAX_AGGREGATES) return null;
    const a = this.aggregates[this.aggregateCount++]!;
    a.shooter = shooter;
    a.shotId = shotId;
    a.victim = victim;
    a.pellets = 0;
    a.zones = 0;
    a.bestZone = "limb";
    a.damage = 0;
    a.killed = false;
    a.downed = false;
    a.armorHit = false;
    a.armorBroken = false;
    return a;
  }

  /** One HitConfirm to the shooter, one DamageTaken to the victim, one PlayerHit for everyone else per aggregate. */
  private flushHits(): void {
    const slots = this.host!.slots;
    for (let i = 0; i < this.aggregateCount; i++) {
      const a = this.aggregates[i]!;
      if (a.pellets === 0) continue;
      this.hits.add(this.tickNow, a.victim, a.bestZone, a.armorHit, a.dirX, a.dirZ);
      const shooter = slots[a.shooter];
      if (shooter && shooter.session !== null) {
        shooter.net.push(writeHitConfirm(a.victim, a.pellets, a.zones, a.damage, a.killed, a.downed, a.armorHit, a.armorBroken, this.store));
      }
      const victim = slots[a.victim];
      if (victim && victim.session !== null && (a.damage > 0 || a.armorHit)) {
        victim.net.push(writeDamageTaken(a.shooter, a.damage, a.bestZone, "bullet", -a.dirX, -a.dirZ, this.store));
      }
    }
    this.aggregateCount = 0;
  }

  // ---- Revive and bleed-out ---------------------------------------------------------------------------------------

  /**
   * Hold interact within VITALS.reviveRange of a downed teammate for VITALS.reviveSeconds. Interact may drop out for
   * NET_REVIVE_GRACE_TICKS (lost inputs) without resetting; moving out of range, being knocked or the target dying
   * cancels. No movement rooting, so client prediction needs no revive state.
   */
  private stepRevive(p: Player, tick: number): void {
    const slots = this.host!.slots;
    const alive = p.life === "alive";
    if (alive && (p.buttons & Btn.interact) !== 0) p.lastInteractTick = tick;
    const holding = alive && tick - p.lastInteractTick <= NET_REVIVE_GRACE_TICKS;
    const freshPress = alive && p.lastInteractTick === tick;

    if (p.reviveTarget >= 0) {
      const target = slots[p.reviveTarget];
      if (!target || !holding || !this.inReviveRange(p, target)) {
        this.cancelRevive(p);
      } else {
        const step = stepRevive(target.vitals, p.slot, true, freshPress ? this.dt : 0);
        target.vitals = step.target;
        if (step.event?.type === "revived") {
          this.stats.revives++;
          p.combat.revives++;
          p.reviveTarget = -1;
        } else if (step.target.reviverId !== p.slot) {
          p.reviveTarget = -1;
        }
      }
      return;
    }
    if (!freshPress || !this.rules.reviveSeconds) return;
    let best: Player | null = null;
    let bestD = Infinity;
    for (const other of this.host!.players) {
      if (other === p || other.teamId !== p.teamId || other.life !== "downed" || other.vitals.reviverId >= 0 || !this.inReviveRange(p, other)) continue;
      const dx = other.feet.x - p.feet.x;
      const dz = other.feet.z - p.feet.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = other;
      }
    }
    if (best === null) return;
    const step = stepRevive(best.vitals, p.slot, true, this.dt);
    best.vitals = step.target;
    if (step.event?.type === "revived") {
      this.stats.revives++;
      p.combat.revives++;
    } else if (step.target.reviverId === p.slot) p.reviveTarget = best.slot;
  }

  private inReviveRange(p: Player, target: Player): boolean {
    if (target === p || target.teamId !== p.teamId || target.life !== "downed") return false;
    const dx = target.feet.x - p.feet.x;
    const dz = target.feet.z - p.feet.z;
    return dx * dx + dz * dz <= VITALS.reviveRange * VITALS.reviveRange && Math.abs(target.feet.y - p.feet.y) <= REVIVE_HEIGHT;
  }

  /** Stops `p` reviving (letting go, knocked, dead). */
  private cancelRevive(p: Player): void {
    if (p.reviveTarget < 0) return;
    const target = this.host!.slots[p.reviveTarget];
    p.reviveTarget = -1;
    if (target) target.vitals = stepRevive(target.vitals, p.slot, false, 0).target;
  }

  private stepBleed(p: Player): void {
    const step = stepVitals(p.vitals, this.dt);
    p.vitals = step.vitals;
    if (p.vitals.life === "dead") {
      const killer = p.vitals.knockedById;
      this.onDeath(p, killer, "bleedOut", false, killer, 0);
      this.resolveWipes();
    }
  }
}
