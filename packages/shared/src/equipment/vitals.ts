import type { HitZone } from "../weapons/types";
import { applyArmor, type ArmorLoadout, type ArmorResult, type DamageKind } from "./armor";
import { consumableDef, type ConsumableItemId } from "./items";
import { clamp, round1, TIMER_EPSILON } from "./math";

export const VITALS = {
  maxHealth: 100,
  maxBoost: 100,
  /** Knocked players get a separate pool that bleeds out and that enemies (or teammates) can shoot down. */
  downedHealth: 100,
  /** Bleed-out per second for the 1st, 2nd and 3rd+ knock in one life: 60 s, 40 s, 25 s. */
  bleedPerSecond: [100 / 60, 100 / 40, 100 / 25],
  reviveSeconds: 5,
  /** Health after a revive. */
  reviveHealth: 10,
  /** Max distance between reviver and downed feet, m. */
  reviveRange: 2,
  /** Downed crawl speed, m/s. */
  crawlSpeed: 1.2,
  /** Walk speed while using a consumable, as a speed scale. */
  useSpeedScale: 0.5,
  boost: {
    /** Points lost per second: a full bar lasts 250 s. */
    decayPerSecond: 0.4,
    /** Heal-over-time is applied in pulses of this length. */
    pulseSeconds: 6,
    /** Tier = highest entry whose `above` the boost exceeds; `heal` HP per pulse. */
    tiers: [
      { above: 0, heal: 1 },
      { above: 20, heal: 2 },
      { above: 60, heal: 3 },
      { above: 90, heal: 4 },
    ],
    /** Ground speed multipliers at high boost. */
    speed: [
      { atLeast: 60, scale: 1.025 },
      { atLeast: 90, scale: 1.06 },
    ],
  },
} as const;

export type LifeState = "alive" | "downed" | "dead";

/** Per-entity health state. Plain data keyed by entity id (players now, bots later). */
export interface Vitals {
  readonly life: LifeState;
  readonly health: number;
  readonly boost: number;
  /** Seconds accumulated toward the next boost heal pulse. */
  readonly boostPulse: number;
  /** Downed pool; 0 unless downed. */
  readonly downedHealth: number;
  /** Knocks this life (bleed-out speeds up). */
  readonly knockCount: number;
  /** Seconds of revive held so far; 0 unless someone is reviving. */
  readonly reviveProgress: number;
  /** Entity reviving this one, or -1. */
  readonly reviverId: number;
  /** Who knocked this entity (bleed-out kill credit), or -1. */
  readonly knockedById: number;
  /** Seconds of flash blindness and ear ringing left. */
  readonly blindSeconds: number;
  readonly deafSeconds: number;
}

export function createVitals(): Vitals {
  return {
    life: "alive",
    health: VITALS.maxHealth,
    boost: 0,
    boostPulse: 0,
    downedHealth: 0,
    knockCount: 0,
    reviveProgress: 0,
    reviverId: -1,
    knockedById: -1,
    blindSeconds: 0,
    deafSeconds: 0,
  };
}

export interface VitalsHit {
  readonly amount: number;
  readonly kind: DamageKind;
  /** Hit zone for bullets; explosions use "body"; null for zone-less damage. */
  readonly zone: HitZone | null;
  /** Attacker entity id (self for own grenades), or -1 for the world. */
  readonly sourceId: number;
}

export interface DamageContext {
  /**
   * A living teammate exists, so reaching 0 HP knocks instead of killing. False for solo players and the last
   * standing member of a team (see {@link canBeKnocked}).
   */
  readonly canBeKnocked: boolean;
}

export interface DamageOutcome {
  readonly vitals: Vitals;
  readonly armor: ArmorLoadout;
  readonly armorResult: ArmorResult;
  /** Health (or downed pool) actually removed. */
  readonly dealt: number;
  readonly knocked: boolean;
  readonly killed: boolean;
  /** Entity credited with the kill when `killed`: the finisher, or -1 for the world. */
  readonly killerId: number;
}

/**
 * Damage pipeline: armor reduction → health → knocked state → death.
 * - Alive at ≤ 0 HP: knocked (fresh downed pool, boost cleared) when `canBeKnocked`, otherwise killed. Overflow is dropped.
 * - Downed: damage drains the downed pool (armor still applies); empty pool = killed by that attacker (finishing).
 * - Dead: ignored.
 */
export function applyDamage(vitals: Vitals, armor: ArmorLoadout, hit: VitalsHit, ctx: DamageContext): DamageOutcome {
  const ignored = (): DamageOutcome => ({
    vitals,
    armor,
    armorResult: { armor, amount: 0, absorbed: 0, slot: null, durabilityBefore: 0, durabilityAfter: 0, destroyed: false },
    dealt: 0,
    knocked: false,
    killed: false,
    killerId: -1,
  });
  if (vitals.life === "dead" || !(hit.amount > 0)) return ignored();

  const armorResult = applyArmor(armor, hit.amount, hit.kind, hit.zone);
  const amount = armorResult.amount;

  if (vitals.life === "downed") {
    const downedHealth = round1(Math.max(0, vitals.downedHealth - amount));
    const killed = downedHealth <= 0;
    return {
      vitals: killed ? killedVitals(vitals) : { ...vitals, downedHealth },
      armor: armorResult.armor,
      armorResult,
      dealt: round1(vitals.downedHealth - downedHealth),
      knocked: false,
      killed,
      killerId: killed ? hit.sourceId : -1,
    };
  }

  const health = round1(Math.max(0, vitals.health - amount));
  const dealt = round1(vitals.health - health);
  if (health > 0) {
    return { vitals: { ...vitals, health }, armor: armorResult.armor, armorResult, dealt, knocked: false, killed: false, killerId: -1 };
  }
  if (!ctx.canBeKnocked) {
    return { vitals: killedVitals(vitals), armor: armorResult.armor, armorResult, dealt, knocked: false, killed: true, killerId: hit.sourceId };
  }
  const knocked: Vitals = {
    ...vitals,
    life: "downed",
    health: 0,
    boost: 0,
    boostPulse: 0,
    downedHealth: VITALS.downedHealth,
    knockCount: vitals.knockCount + 1,
    reviveProgress: 0,
    reviverId: -1,
    knockedById: hit.sourceId,
  };
  return { vitals: knocked, armor: armorResult.armor, armorResult, dealt, knocked: true, killed: false, killerId: -1 };
}

function killedVitals(vitals: Vitals): Vitals {
  return { ...vitals, life: "dead", health: 0, boost: 0, boostPulse: 0, downedHealth: 0, reviveProgress: 0, reviverId: -1 };
}

export type VitalsEvent =
  | { readonly type: "boostHeal"; readonly amount: number }
  | { readonly type: "bledOut"; readonly killerId: number };

export interface VitalsStepResult {
  readonly vitals: Vitals;
  readonly events: readonly VitalsEvent[];
}

/** Per-tick vitals: boost decay and heal pulses while alive, bleed-out while downed (paused while being revived), flash timers. */
export function stepVitals(vitals: Vitals, dt: number): VitalsStepResult {
  const events: VitalsEvent[] = [];
  let next = vitals;
  if (vitals.blindSeconds > 0 || vitals.deafSeconds > 0) {
    next = { ...next, blindSeconds: Math.max(0, vitals.blindSeconds - dt), deafSeconds: Math.max(0, vitals.deafSeconds - dt) };
  }

  if (vitals.life === "alive" && vitals.boost > 0) {
    const cfg = VITALS.boost;
    let pulse = vitals.boostPulse + dt;
    let health = vitals.health;
    if (pulse >= cfg.pulseSeconds - TIMER_EPSILON) {
      pulse -= cfg.pulseSeconds;
      const heal = boostHealPerPulse(vitals.boost);
      const healed = Math.min(VITALS.maxHealth, health + heal);
      if (healed > health) events.push({ type: "boostHeal", amount: round1(healed - health) });
      health = healed;
    }
    const boost = Math.max(0, vitals.boost - cfg.decayPerSecond * dt);
    next = { ...next, health, boost, boostPulse: boost > 0 ? Math.max(0, pulse) : 0 };
  } else if (vitals.life === "downed" && vitals.reviverId < 0) {
    const downedHealth = Math.max(0, vitals.downedHealth - bleedPerSecond(vitals.knockCount) * dt);
    if (downedHealth <= TIMER_EPSILON) {
      next = killedVitals(next);
      events.push({ type: "bledOut", killerId: vitals.knockedById });
    } else {
      next = { ...next, downedHealth };
    }
  }
  return { vitals: next, events };
}

export function bleedPerSecond(knockCount: number): number {
  const rates = VITALS.bleedPerSecond;
  return rates[clamp(knockCount - 1, 0, rates.length - 1)]!;
}

/** HP per pulse at a boost level (0 when empty). */
export function boostHealPerPulse(boost: number): number {
  let heal = 0;
  for (const tier of VITALS.boost.tiers) if (boost > tier.above) heal = tier.heal;
  return heal;
}

/** 0 = empty, 1–4 = heal tier, for the segmented HUD bar. */
export function boostTier(boost: number): number {
  let tier = 0;
  VITALS.boost.tiers.forEach((t, i) => {
    if (boost > t.above) tier = i + 1;
  });
  return tier;
}

export function boostSpeedScale(boost: number): number {
  let scale = 1;
  for (const step of VITALS.boost.speed) if (boost >= step.atLeast) scale = step.scale;
  return scale;
}

export type ConsumableBlock = "notAlive" | "healthFull" | "boostFull";

/** Why a consumable can't be started now, or null if it can. */
export function consumableBlock(vitals: Vitals, id: ConsumableItemId): ConsumableBlock | null {
  if (vitals.life !== "alive") return "notAlive";
  const def = consumableDef(id);
  if (def.category === "heal") return vitals.health >= def.healCap ? "healthFull" : null;
  return vitals.boost >= VITALS.maxBoost ? "boostFull" : null;
}

/** Effect of a completed consumable. Healing never lowers health that is already above the cap. */
export function applyConsumable(vitals: Vitals, id: ConsumableItemId): Vitals {
  if (vitals.life !== "alive") return vitals;
  const def = consumableDef(id);
  let health = vitals.health;
  if (def.category === "heal" && health < def.healCap) {
    health = def.healAmount === null ? def.healCap : Math.min(def.healCap, health + def.healAmount);
  }
  const boost = Math.min(VITALS.maxBoost, vitals.boost + def.boostAmount);
  return { ...vitals, health: round1(health), boost };
}

// ---------------------------------------------------------------------------------------------------------------
// Revive and team elimination
// ---------------------------------------------------------------------------------------------------------------

export type ReviveEvent =
  | { readonly type: "reviveStarted"; readonly reviverId: number }
  | { readonly type: "reviveCancelled"; readonly reviverId: number }
  | { readonly type: "revived"; readonly reviverId: number };

export interface ReviveStepResult {
  readonly target: Vitals;
  readonly event: ReviveEvent | null;
}

/**
 * One tick of a teammate holding interact on a downed entity. `active` = the reviver is alive, holding the key,
 * in range and not otherwise busy (the caller checks team, range and busy state). A second reviver is ignored.
 * Bleed-out pauses while the revive runs; letting go resets the progress.
 */
export function stepRevive(target: Vitals, reviverId: number, active: boolean, dt: number): ReviveStepResult {
  if (target.life !== "downed") return { target, event: null };
  const mine = target.reviverId === reviverId;
  if (!active) {
    if (!mine) return { target, event: null };
    return { target: { ...target, reviverId: -1, reviveProgress: 0 }, event: { type: "reviveCancelled", reviverId } };
  }
  if (target.reviverId >= 0 && !mine) return { target, event: null };

  const progress = target.reviveProgress + dt;
  if (progress >= VITALS.reviveSeconds - TIMER_EPSILON) {
    const revived: Vitals = { ...target, life: "alive", health: VITALS.reviveHealth, downedHealth: 0, reviveProgress: 0, reviverId: -1 };
    return { target: revived, event: { type: "revived", reviverId } };
  }
  return { target: { ...target, reviverId, reviveProgress: progress }, event: mine ? null : { type: "reviveStarted", reviverId } };
}

export interface TeamMember {
  readonly id: number;
  readonly team: number;
  readonly vitals: Vitals;
}

/** Reaching 0 HP knocks only while another member of the team is still standing. */
export function canBeKnocked(id: number, team: number, members: readonly TeamMember[]): boolean {
  return members.some((m) => m.team === team && m.id !== id && m.vitals.life === "alive");
}

/** Downed members of teams with nobody left standing: they are all eliminated at once. */
export function findTeamWipes(members: readonly TeamMember[]): number[] {
  const standing = new Set<number>();
  for (const m of members) if (m.vitals.life === "alive") standing.add(m.team);
  return members.filter((m) => m.vitals.life === "downed" && !standing.has(m.team)).map((m) => m.id);
}

/** Eliminates a downed entity outright (team wipe). */
export function eliminate(vitals: Vitals): Vitals {
  return vitals.life === "dead" ? vitals : killedVitals(vitals);
}
