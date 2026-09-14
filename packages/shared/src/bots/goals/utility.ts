import type { BotGoalKind, BotProfile } from "../types";

// Utility goal selection (design.md §5.2). The brain fills `GoalFacts` from perception, memory, teammates and its own
// state only; scoring is a pure function of the facts so fixtures can test every rule directly.

export const GOALS = ["idle", "loot", "rotate", "engage", "cover", "heal", "revive", "regroup", "flee", "investigate"] as const satisfies readonly BotGoalKind[];
export type ActiveGoal = (typeof GOALS)[number];
export const GOAL_COUNT = GOALS.length;
export const GoalIndex = { idle: 0, loot: 1, rotate: 2, engage: 3, cover: 4, heal: 5, revive: 6, regroup: 7, flee: 8, investigate: 9 } as const satisfies Record<ActiveGoal, number>;

export const HYSTERESIS = 0.1;
/** A goal is kept at least this long unless damage preempts, s. */
export const MIN_GOAL_SECONDS = 1;
/** Travel goals (loot, rotate, regroup, investigate) commit longer and need a clearer win to be replaced, so two
 * walking goals with different destinations don't alternate and leave the bot shuffling in place. */
export const TRAVEL_GOAL_SECONDS = 3;
export const TRAVEL_HYSTERESIS = 0.15;

export interface GoalFacts {
  health: number;
  boost: number;
  hasHeals: boolean;
  hasBoost: boolean;
  /** Seconds since a hostile was last seen, heard or dealt damage. */
  safeSeconds: number;
  /** An awake hostile is visible now. */
  threatVisible: boolean;
  threatDistance: number;
  threatDowned: boolean;
  /** Visible awake hostiles. */
  visibleThreats: number;
  /** Another standing hostile is visible besides the (downed) threat. */
  otherStandingThreat: boolean;
  /** The threat is scoped and beyond our best range. */
  outranged: boolean;
  /** The threat damaged this bot recently. */
  threatAttackedMe: boolean;
  /** Best usable gun range covers the threat. */
  threatInRange: boolean;
  hasGun: boolean;
  hasAmmo: boolean;
  /** Active magazine fill, 0..1 (1 without a gun). */
  magazineFraction: number;
  /** Combat damage in the last 1.5 s. */
  damagedRecently: boolean;
  /** The per-encounter cover roll passed and cover wasn't just found missing. */
  coverAllowed: boolean;
  /** In a cover position and still holding it. */
  holdingCover: boolean;
  /** A downed teammate that nobody else is reviving and that nav can reach. */
  reviveCandidate: boolean;
  reviveDownedHealth: number;
  /** Precomputed rotate score (zone.ts). */
  rotateScore: number;
  zonePhaseIndex: number;
  /** Best loot value (need × quality × distance falloff), 0 when none. */
  lootValue: number;
  /** Value of walking to search an unsearched building (by how badly the bot needs gear), 0 when none is left. */
  searchValue: number;
  /** No gun at all. */
  unarmed: boolean;
  teammateAlive: boolean;
  teammateDistance: number;
  teammateIsHuman: boolean;
  /** Regroup is the current goal (it then continues until close, instead of flickering at the 40 m edge). */
  regrouping: boolean;
  /** Flee is the current goal. */
  fleeing: boolean;
  /** Confidence of the best unseen hostile memory, 0 when none (or chase time is over). */
  investigateConfidence: number;
}

export function createGoalFacts(): GoalFacts {
  return {
    health: 100,
    boost: 0,
    hasHeals: false,
    hasBoost: false,
    safeSeconds: Infinity,
    threatVisible: false,
    threatDistance: Infinity,
    threatDowned: false,
    visibleThreats: 0,
    otherStandingThreat: false,
    outranged: false,
    threatAttackedMe: false,
    threatInRange: false,
    hasGun: false,
    hasAmmo: false,
    magazineFraction: 1,
    damagedRecently: false,
    coverAllowed: false,
    holdingCover: false,
    reviveCandidate: false,
    reviveDownedHealth: 100,
    rotateScore: 0,
    zonePhaseIndex: 0,
    lootValue: 0,
    searchValue: 0,
    unarmed: false,
    teammateAlive: false,
    teammateDistance: 0,
    teammateIsHuman: false,
    regrouping: false,
    fleeing: false,
    investigateConfidence: 0,
  };
}

/** Writes a 0..1 score per goal (GoalIndex order) into `out`. */
export function scoreGoals(f: GoalFacts, profile: BotProfile, out: Float64Array): Float64Array {
  const t = profile.tactics;
  out.fill(0);
  out[GoalIndex.idle] = 0.05;

  // engage
  if (f.threatVisible && f.threatInRange && f.hasAmmo) {
    let s = 0.6 + 0.3 * (f.health / 100) + (f.threatDowned ? 0.1 : 0) - (f.outranged ? 0.3 : 0);
    // Easy/normal prefer standing threats; hard finishes knocked enemies when nobody else is in sight.
    if (f.threatDowned && profile.difficulty !== "hard") s -= 0.35;
    if (f.threatDowned && f.otherStandingThreat) s -= 0.2;
    // While rotating out of the zone, only close threats or attackers are fought.
    if (f.rotateScore >= 0.9 && f.threatDistance > 60 && !f.threatAttackedMe) s *= 0.5;
    out[GoalIndex.engage] = clamp01(s);
  }

  // cover
  const lowMag = f.magazineFraction < 0.2 && f.threatVisible;
  if (f.holdingCover || ((f.damagedRecently || lowMag) && f.coverAllowed && (f.threatVisible || f.damagedRecently))) {
    out[GoalIndex.cover] = f.damagedRecently ? 0.85 : f.holdingCover ? 0.65 : 0.75;
  }

  // flee
  const low = f.health < t.fleeHealth;
  if ((low && (f.threatVisible || f.damagedRecently || (f.fleeing && f.safeSeconds < 3))) || (f.hasGun && !f.hasAmmo && (f.threatVisible || f.damagedRecently))) {
    out[GoalIndex.flee] = 0.85;
  }

  // heal
  if (f.hasHeals && f.health < 75 && f.safeSeconds >= t.healSafeSeconds) {
    out[GoalIndex.heal] = 0.5 + 0.4 * (1 - f.health / 75);
  } else if (f.hasHeals && f.holdingCover && f.health < t.fleeHealth) {
    out[GoalIndex.heal] = 0.7;
  } else if (f.hasBoost && f.health < 60 && f.boost < 60 && f.safeSeconds >= t.healSafeSeconds) {
    out[GoalIndex.heal] = 0.4;
  }

  // revive
  if (f.reviveCandidate) {
    out[GoalIndex.revive] = clamp01(0.7 + 0.2 * (1 - f.reviveDownedHealth / 100) - f.visibleThreats * (1 - t.reviveRisk) * 0.25);
  }

  // rotate: an unarmed bot keeps looting until the zone really forces it to move.
  out[GoalIndex.rotate] = f.unarmed && f.rotateScore < 0.85 ? f.rotateScore * 0.5 : f.rotateScore;

  // loot: a spotted item, or searching buildings for one
  if (!f.threatVisible && (f.lootValue > 0 || f.searchValue > 0)) {
    const late = f.zonePhaseIndex >= 3 && !f.unarmed ? 0.5 : 1;
    out[GoalIndex.loot] = Math.max(f.lootValue * (f.unarmed ? 0.9 : 0.6), f.searchValue) * late;
  }

  // regroup
  if (f.teammateAlive) {
    let s = f.teammateDistance > 40 ? 0.3 + 0.3 * Math.min(1, (f.teammateDistance - 40) / 60) : 0;
    if (f.teammateIsHuman && f.teammateDistance > 25) s = Math.max(s, 0.45);
    if (f.regrouping && f.teammateDistance > (f.teammateIsHuman ? 15 : 12)) s = Math.max(s, 0.35);
    out[GoalIndex.regroup] = s;
  }

  // investigate
  // Low on health, a bot doesn't go looking for the enemy.
  if (!f.threatVisible && !low && f.investigateConfidence > 0) out[GoalIndex.investigate] = 0.35 * f.investigateConfidence;

  return out;
}

export class GoalSelector {
  goal: ActiveGoal = "idle";
  score = 0;
  startTick = 0;
  readonly scores = new Float64Array(GOAL_COUNT);

  reset(tick: number): void {
    this.goal = "idle";
    this.score = 0;
    this.startTick = tick;
    this.scores.fill(0);
  }

  /**
   * Picks the goal with hysteresis. Returns true when the goal changed. `preempt` (damage this tick) lets cover, flee
   * and engage switch immediately.
   */
  select(tick: number, dt: number, preempt: boolean): boolean {
    const scores = this.scores;
    const current = GoalIndex[this.goal];
    const travel = current === GoalIndex.loot || current === GoalIndex.rotate || current === GoalIndex.regroup || current === GoalIndex.investigate;
    let best: number = current;
    // A goal whose score dropped to zero has no claim to keep: anything positive replaces it.
    let bestScore = scores[current]! > 0 ? scores[current]! + (travel ? TRAVEL_HYSTERESIS : HYSTERESIS) : 0;
    for (let i = 0; i < GOAL_COUNT; i++) {
      if (i === current) continue;
      if (scores[i]! > bestScore) {
        bestScore = scores[i]!;
        best = i;
      }
    }
    this.score = scores[best]!;
    if (best === current) return false;
    const currentDead = scores[current]! <= 0;
    const held = (tick - this.startTick) * dt < (travel ? TRAVEL_GOAL_SECONDS : MIN_GOAL_SECONDS);
    const combat = best === GoalIndex.cover || best === GoalIndex.flee || best === GoalIndex.engage;
    // Zone pressure and revives are not held back by travel commitment.
    const urgent = combat || (best === GoalIndex.rotate && scores[best]! >= 0.85) || best === GoalIndex.revive;
    if (held && !currentDead && !(preempt && combat) && !(travel && urgent && (tick - this.startTick) * dt >= MIN_GOAL_SECONDS)) {
      this.score = scores[current]!;
      return false;
    }
    this.goal = GOALS[best]!;
    this.startTick = tick;
    return true;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
