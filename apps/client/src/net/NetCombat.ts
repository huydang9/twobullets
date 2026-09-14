import { shotOriginInto, shotSpreadDegrees, unwrapShotId } from "@twobullets/netcode/replication";
import {
  actorFromCode,
  damageKindOfCode,
  HitZoneMask,
  hitZoneOfCode,
  killCauseOfCode,
  LifeCode,
  lifeOfCode,
  weaponIdOfCode,
  type KillCause,
} from "@twobullets/protocol/codes";
import type { KillFeed } from "@twobullets/protocol/messages/control";
import { DAMAGE_DIR_BITS, PLAYER_HIT_DIR_BITS, ReliableEventType, type ReliableEvent } from "@twobullets/protocol/messages/events";
import {
  copyOwnerVitals,
  createOwnerVitalsBlock,
  EntityPresence,
  MAX_ENTITY_SLOTS,
  ownerVitalsEqual,
  type OwnerVitalsBlock,
  type Snapshot,
} from "@twobullets/protocol/messages/snapshot";
import { dequantizePitch, dequantizeYaw } from "@twobullets/shared/aim";
import type { DamageKind } from "@twobullets/shared/equipment/armor";
import type { LifeState } from "@twobullets/shared/equipment/vitals";
import type { MatchEvent } from "@twobullets/shared/match/types";
import { dequantizeYaw as dequantizeYawBits } from "@twobullets/protocol/quantize";
import type { FiredShot, HitZone, WeaponId } from "@twobullets/shared/weapons/types";
import { WEAPONS } from "@twobullets/shared/weapons/weapons";
import { shotDirections } from "@twobullets/shared/weapons/weaponStep";
import { EVENT_RULES } from "./netCombatRules";

/** What NetClient hands to the combat layer (M4). Everything is called synchronously while a message is handled. */
export interface NetEventSink {
  onWelcome(slot: number, team: number): void;
  /** Every decoded snapshot: tier U `shots` and `hits` (entities give shot origins). */
  onSnapshotEvents(snapshot: Snapshot): void;
  /** Tier R, exactly once and in order. `event` is only valid during the call. */
  onReliableEvent(event: ReliableEvent, serverTick: number): void;
  /** Owner vitals of the newest snapshot that carried them. */
  onOwnerVitals(serverTick: number, vitals: OwnerVitalsBlock): void;
  onKillFeed(feed: KillFeed): void;
}

export interface NetHitConfirm {
  readonly victim: number;
  readonly pellets: number;
  /** Highest zone hit (head > body > limb). */
  readonly zone: HitZone;
  readonly damage: number;
  readonly killed: boolean;
  readonly downed: boolean;
  readonly armorHit: boolean;
  readonly armorBroken: boolean;
}

export interface NetDamageTaken {
  /** Slot, or −1 for the world (fall). */
  readonly attacker: number;
  readonly amount: number;
  /** World yaw from the victim toward the source (MoveInput convention), or null without a source direction. */
  readonly directionYaw: number | null;
  readonly zone: HitZone | null;
  readonly kind: DamageKind;
}

export interface NetKill {
  /** Slot, or −1 for the world. */
  readonly killer: number;
  readonly victim: number;
  readonly cause: KillCause;
  readonly headshot: boolean;
  readonly friendlyFire: boolean;
  readonly knock: boolean;
  readonly distanceM: number;
}

/** Dequantized owner vitals. */
export interface NetOwnerVitals {
  life: LifeState;
  health: number;
  /** Bleed-out pool while downed. */
  downedHealth: number;
  boost: number;
  /** Seconds of revive held so far (someone is reviving us when > 0). */
  reviveSeconds: number;
  helmetLevel: number;
  helmetDurability: number;
  vestLevel: number;
  vestDurability: number;
}

/** Presentation and HUD side of networked combat (Babylon/DOM in the browser, a mock in tests). */
export interface CombatFeedback {
  /** A remote player's shot, when the render timeline reaches its fire tick: tracer, flash, gunshot, near misses. */
  remoteShot(shooter: number, shot: FiredShot): void;
  /** Blood and flesh impact on a remote body; (dirX, dirZ) is the bullet's horizontal travel direction. */
  remoteHit(victim: number, zone: HitZone, armor: boolean, dirX: number, dirZ: number): void;
  /** Our bullet hit someone (server confirm): hitmarker, damage number, confirm sound. */
  hitConfirm(hit: NetHitConfirm): void;
  /** We took damage: direction indicator (the health bar follows vitals). */
  damageTaken(hit: NetDamageTaken): void;
  /** A knock or kill anywhere (kill notice for ours, death screen for us, remote kill FX). */
  kill(kill: NetKill): void;
  /** Kill feed line (a `knock` or `kill` match event). */
  killFeed(event: MatchEvent): void;
  /** Owner vitals changed. */
  vitals(vitals: Readonly<NetOwnerVitals>, previousLife: LifeState): void;
  /** Our slot and team (Welcome). */
  welcome?(slot: number, team: number): void;
}

interface PendingShot {
  active: boolean;
  fireTick: number;
  shooter: number;
  weaponId: WeaponId;
  shotId: number;
  yaw: number;
  pitch: number;
  spread: number;
  readonly origin: { x: number; y: number; z: number };
}

interface PendingHit {
  active: boolean;
  tick: number;
  victim: number;
  zone: HitZone;
  armor: boolean;
  dirX: number;
  dirZ: number;
}

const PENDING_SHOTS = 64;
const PENDING_HITS = 32;
/** Events wait for the render timeline at most this many ticks (a stalled render tick never swallows them). */
const MAX_WAIT_TICKS = 30;

export interface NetCombatStats {
  shotsPlayed: number;
  shotsDropped: number;
  hitsPlayed: number;
  hitConfirms: number;
  damageTaken: number;
  kills: number;
  feedLines: number;
}

/**
 * Networked combat events → `CombatFeedback` calls (netcode.md §5.7, §6.5; spec in netCombatRules.ts). No Babylon, no
 * DOM. Remote shots and player hits are delayed to the render timeline (interpolation delay) so tracers leave the
 * shooter's rendered body; confirms, damage and kills show at once. Allocation: one `FiredShot` per played remote shot.
 */
export class NetCombat implements NetEventSink {
  readonly stats: NetCombatStats = { shotsPlayed: 0, shotsDropped: 0, hitsPlayed: 0, hitConfirms: 0, damageTaken: 0, kills: 0, feedLines: 0 };
  readonly vitalsState: NetOwnerVitals = {
    life: "alive",
    health: 100,
    downedHealth: 0,
    boost: 0,
    reviveSeconds: 0,
    helmetLevel: 0,
    helmetDurability: 0,
    vestLevel: 0,
    vestDurability: 0,
  };
  ownSlot = -1;
  ownTeam = -1;
  private readonly feedback: CombatFeedback;
  private readonly lastShotId = new Float64Array(MAX_ENTITY_SLOTS).fill(-1);
  private readonly shots: PendingShot[] = [];
  private readonly hits: PendingHit[] = [];
  private readonly lastVitals = createOwnerVitalsBlock();
  private hasVitals = false;
  private newestTick = -1;

  constructor(feedback: CombatFeedback) {
    this.feedback = feedback;
    for (let i = 0; i < PENDING_SHOTS; i++) {
      this.shots.push({ active: false, fireTick: 0, shooter: 0, weaponId: "rifle", shotId: 0, yaw: 0, pitch: 0, spread: 0, origin: { x: 0, y: 0, z: 0 } });
    }
    for (let i = 0; i < PENDING_HITS; i++) this.hits.push({ active: false, tick: 0, victim: 0, zone: "body", armor: false, dirX: 0, dirZ: 1 });
  }

  onWelcome(slot: number, team: number): void {
    this.ownSlot = slot;
    this.ownTeam = team;
    this.lastShotId.fill(-1);
    this.hasVitals = false;
    this.feedback.welcome?.(slot, team);
  }

  onSnapshotEvents(snapshot: Snapshot): void {
    const tick = snapshot.header.serverTick;
    if (tick > this.newestTick) this.newestTick = tick;
    const shots = snapshot.shots;
    if (shots !== undefined) {
      for (let i = 0; i < shots.length; i++) {
        const e = shots[i]!;
        if (e.shooter === this.ownSlot && !EVENT_RULES.shotsIncludeOwn) continue;
        const weaponId = weaponIdOfCode(e.weapon);
        const feet = entityFeet(snapshot, e.shooter);
        if (weaponId === null || feet === null) {
          this.stats.shotsDropped++;
          continue;
        }
        const shotId = unwrapShotId(e.shotId, this.lastShotId[e.shooter]!);
        if (shotId > this.lastShotId[e.shooter]!) this.lastShotId[e.shooter] = shotId;
        const pending = this.acquireShot();
        pending.active = true;
        pending.fireTick = tick - e.tickOffset;
        pending.shooter = e.shooter;
        pending.weaponId = weaponId;
        pending.shotId = shotId;
        pending.yaw = dequantizeYaw(e.yawQ);
        pending.pitch = dequantizePitch(e.pitchQ);
        pending.spread = shotSpreadDegrees(e);
        shotOriginInto(e, feet, pending.origin);
      }
    }
    const hits = snapshot.hits;
    if (hits !== undefined) {
      for (let i = 0; i < hits.length; i++) {
        const e = hits[i]!;
        if (e.victim === this.ownSlot && !EVENT_RULES.playerHitsIncludeOwnVictim) continue;
        const pending = this.acquireHit();
        pending.active = true;
        pending.tick = tick;
        pending.victim = e.victim;
        pending.zone = hitZoneOfCode(e.zone) ?? "body";
        pending.armor = e.armor;
        const yaw = dequantizeYawBits(e.dirYawQ, PLAYER_HIT_DIR_BITS);
        pending.dirX = Math.sin(yaw);
        pending.dirZ = Math.cos(yaw);
      }
    }
  }

  onReliableEvent(event: ReliableEvent, _serverTick: number): void {
    switch (event.type) {
      case ReliableEventType.HitConfirm: {
        this.stats.hitConfirms++;
        const zones = event.zones;
        const zone: HitZone = (zones & HitZoneMask.head) !== 0 ? "head" : (zones & HitZoneMask.body) !== 0 ? "body" : "limb";
        this.feedback.hitConfirm({
          victim: event.victim,
          pellets: event.pellets,
          zone,
          damage: event.damageQ / 10,
          killed: event.killed,
          downed: event.downed,
          armorHit: event.armorHit,
          armorBroken: event.armorBroken,
        });
        break;
      }
      case ReliableEventType.DamageTaken: {
        this.stats.damageTaken++;
        const attacker = actorFromCode(event.attacker);
        this.feedback.damageTaken({
          attacker,
          amount: event.amountQ / 10,
          directionYaw: attacker >= 0 ? dequantizeYawBits(event.dirYawQ, DAMAGE_DIR_BITS) : null,
          zone: hitZoneOfCode(event.zone),
          kind: damageKindOfCode(event.kind) ?? "bullet",
        });
        break;
      }
      case ReliableEventType.Kill:
        this.stats.kills++;
        this.feedback.kill({
          killer: actorFromCode(event.killer),
          victim: event.victim,
          cause: killCauseOfCode(event.cause) ?? "unknown",
          headshot: event.headshot,
          friendlyFire: event.friendlyFire,
          knock: event.knock,
          distanceM: event.distanceM,
        });
        break;
    }
  }

  onOwnerVitals(_serverTick: number, vitals: OwnerVitalsBlock): void {
    if (this.hasVitals && ownerVitalsEqual(this.lastVitals, vitals)) return;
    this.hasVitals = true;
    copyOwnerVitals(vitals, this.lastVitals);
    const v = this.vitalsState;
    const previousLife = v.life;
    v.life = lifeOfCode(vitals.life);
    v.health = vitals.healthQ / 10;
    v.downedHealth = vitals.life === LifeCode.downed ? vitals.downedHealthQ / 10 : 0;
    v.boost = vitals.boost;
    v.reviveSeconds = vitals.life === LifeCode.downed ? vitals.reviveTicks / 60 : 0;
    v.helmetLevel = vitals.helmetLevel;
    v.helmetDurability = vitals.helmetDurability;
    v.vestLevel = vitals.vestLevel;
    v.vestDurability = vitals.vestDurability;
    this.feedback.vitals(v, previousLife);
  }

  onKillFeed(feed: KillFeed): void {
    const cause = killCauseOfCode(feed.cause) ?? "unknown";
    const attacker = actorFromCode(feed.killer);
    this.stats.feedLines++;
    const event: MatchEvent = feed.knock
      ? { type: "knock", tick: feed.serverTick, attacker, victim: feed.victim, cause, headshot: feed.headshot }
      : {
          type: "kill",
          tick: feed.serverTick,
          killer: attacker,
          victim: feed.victim,
          cause,
          headshot: feed.headshot,
          knockedBy: actorFromCode(feed.knockedBy),
          teamKill: feed.friendlyFire,
        };
    this.feedback.killFeed(event);
  }

  /** Per frame with the tick remote players are rendered at: plays shots and hits the timeline has reached. */
  update(renderTick: number): void {
    const late = this.newestTick - MAX_WAIT_TICKS;
    for (let i = 0; i < this.shots.length; i++) {
      const s = this.shots[i]!;
      if (s.active && (s.fireTick <= renderTick || s.fireTick <= late)) this.playShot(s);
    }
    for (let i = 0; i < this.hits.length; i++) {
      const h = this.hits[i]!;
      if (!h.active || (h.tick > renderTick && h.tick > late)) continue;
      h.active = false;
      this.stats.hitsPlayed++;
      this.feedback.remoteHit(h.victim, h.zone, h.armor, h.dirX, h.dirZ);
    }
  }

  /** Forget queued events (disconnect). */
  clear(): void {
    for (const s of this.shots) s.active = false;
    for (const h of this.hits) h.active = false;
    this.lastShotId.fill(-1);
    this.newestTick = -1;
    this.hasVitals = false;
  }

  private playShot(s: PendingShot): void {
    s.active = false;
    this.stats.shotsPlayed++;
    const def = WEAPONS[s.weaponId];
    const shot: FiredShot = {
      weaponId: s.weaponId,
      shotId: s.shotId,
      origin: { x: s.origin.x, y: s.origin.y, z: s.origin.z },
      directions: shotDirections(def, s.shotId, s.yaw, s.pitch, s.spread),
      recoilUp: 0,
      recoilRight: 0,
    };
    this.feedback.remoteShot(s.shooter, shot);
  }

  /** A free pending shot, or the oldest one played right away. */
  private acquireShot(): PendingShot {
    let oldest: PendingShot | null = null;
    for (const s of this.shots) {
      if (!s.active) return s;
      if (oldest === null || s.fireTick < oldest.fireTick) oldest = s;
    }
    this.playShot(oldest!);
    return oldest!;
  }

  private acquireHit(): PendingHit {
    let oldest: PendingHit | null = null;
    for (const h of this.hits) {
      if (!h.active) return h;
      if (oldest === null || h.tick < oldest.tick) oldest = h;
    }
    oldest!.active = false;
    this.feedback.remoteHit(oldest!.victim, oldest!.zone, oldest!.armor, oldest!.dirX, oldest!.dirZ);
    return oldest!;
  }
}

function entityFeet(snapshot: Snapshot, slot: number): { readonly xMm: number; readonly yMm: number; readonly zMm: number } | null {
  const entities = snapshot.entities;
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i]!;
    if (e.slot === slot) return e.presence === EntityPresence.full ? e : null;
  }
  return null;
}
