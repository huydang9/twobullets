import type { BotDifficulty } from "../bots/types";
import type { DamageKind } from "../equipment/armor";
import { ITEMS } from "../equipment/items";
import type { LifeState } from "../equipment/vitals";
import type { WeaponId } from "../weapons/types";
import { secondsToTicks, DEFAULT_ZONE_SPEC } from "./zone";
import type { ActorConfig, BrEndReason, BrMatchConfig, BrRules, BrTimings, KillCause, MatchEvent, TeamResult, TeamState, ZoneSpec } from "./types";

// Battle royale rules (docs/bots/design.md §8.1, §8.3): configuration defaults, phase schedule, team counts,
// eliminations, placements, the win condition, time-cap ranking and kill-feed text. Pure state in, state out; the
// match simulation feeds facts and publishes the events.

export const DEFAULT_BR_RULES: BrRules = { friendlyFire: true, reviveSeconds: 5, bodyBlocking: true };

export const DEFAULT_BR_TIMINGS: BrTimings = { countdownSeconds: 5, landingSeconds: 0, glideSeconds: 0, timeCapSeconds: 720, endLingerSeconds: 8 };

export interface BrMatchConfigOptions {
  readonly seed: number;
  readonly mapId?: string;
  /** 2..5 offline (default 5). */
  readonly teamCount?: number;
  readonly teamSize?: number;
  /** Slot of the local human, or null for a bots-only match (default null). */
  readonly humanSlot?: number | null;
  /** Bots' difficulty, or a per-slot function. */
  readonly difficulty?: BotDifficulty | ((slot: number) => BotDifficulty);
  /** Leave the human's teammate slot empty (`&teammate=none`). */
  readonly humanTeammate?: boolean;
  readonly names?: (slot: number, kind: ActorConfig["kind"]) => string;
  readonly rules?: Partial<BrRules>;
  readonly zone?: ZoneSpec;
  readonly timings?: Partial<BrTimings>;
  readonly timeScale?: number;
}

const BOT_CALLSIGNS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima", "Mike", "Nova", "Oscar", "Papa"];

export function slotOf(team: number, member: number, teamSize: number): number {
  return team * teamSize + member;
}

/** Actors for `teamCount × teamSize` slots; slot = team × teamSize + member, dense. */
export function createActorConfigs(options: BrMatchConfigOptions): ActorConfig[] {
  const teamCount = options.teamCount ?? 5;
  const teamSize = options.teamSize ?? 2;
  const human = options.humanSlot ?? null;
  const actors: ActorConfig[] = [];
  for (let team = 0; team < teamCount; team++) {
    for (let member = 0; member < teamSize; member++) {
      const slot = slotOf(team, member, teamSize);
      const kind = slot === human ? "human" : "bot";
      if (kind === "bot" && human !== null && options.humanTeammate === false && Math.floor(human / teamSize) === team) continue;
      const difficulty = kind === "human" ? null : typeof options.difficulty === "function" ? options.difficulty(slot) : (options.difficulty ?? "normal");
      const name = options.names?.(slot, kind) ?? (kind === "human" ? "You" : `Bot ${BOT_CALLSIGNS[slot % BOT_CALLSIGNS.length]}`);
      actors.push({ slot, team, kind, name, difficulty });
    }
  }
  return actors;
}

export function createBrMatchConfig(options: BrMatchConfigOptions): BrMatchConfig {
  return {
    seed: options.seed >>> 0,
    mapId: options.mapId ?? "v1",
    teamCount: options.teamCount ?? 5,
    teamSize: options.teamSize ?? 2,
    actors: createActorConfigs(options),
    rules: { ...DEFAULT_BR_RULES, ...options.rules },
    zone: options.zone ?? DEFAULT_ZONE_SPEC,
    timings: { ...DEFAULT_BR_TIMINGS, ...options.timings },
    timeScale: options.timeScale ?? 1,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------------------------

/** Tick boundaries of the pre-combat phases and the time cap, from the match's first tick. */
export interface BrPhaseSchedule {
  readonly warmupStartTick: number;
  /** = landing start. */
  readonly warmupEndTick: number;
  /** = glide start. */
  readonly landingEndTick: number;
  /** = combat start. */
  readonly combatStartTick: number;
  readonly timeCapTick: number;
}

export function brPhaseSchedule(config: Pick<BrMatchConfig, "timings" | "timeScale">, startTick: number): BrPhaseSchedule {
  const t = config.timings;
  const s = config.timeScale;
  const warmupEndTick = startTick + secondsToTicks(t.countdownSeconds, s);
  const landingEndTick = warmupEndTick + secondsToTicks(t.landingSeconds, s);
  const combatStartTick = landingEndTick + secondsToTicks(t.glideSeconds, s);
  return { warmupStartTick: startTick, warmupEndTick, landingEndTick, combatStartTick, timeCapTick: combatStartTick + secondsToTicks(t.timeCapSeconds, s) };
}

// ---------------------------------------------------------------------------------------------------------------
// Teams, knock, eliminations, placements, win
// ---------------------------------------------------------------------------------------------------------------

/** What the rules need to know about an actor. */
export interface RulesActor {
  readonly slot: number;
  readonly team: number;
  readonly life: LifeState;
  readonly health: number;
}

export type MutableTeamState = { -readonly [K in keyof TeamState]: TeamState[K] };

export function createTeamStates(config: Pick<BrMatchConfig, "teamCount" | "actors">): MutableTeamState[] {
  const teams: MutableTeamState[] = [];
  for (let team = 0; team < config.teamCount; team++) {
    const slots = config.actors.filter((a) => a.team === team).map((a) => a.slot);
    teams.push({ team, slots, standing: slots.length, inPlay: slots.length, eliminated: slots.length === 0, eliminatedTick: slots.length === 0 ? 0 : -1, placement: null, kills: 0 });
  }
  return teams;
}

/**
 * Reaching 0 HP knocks while another member of the team stands (and knock-down is enabled); otherwise the actor dies.
 * `actors` is indexed by slot (holes allowed).
 */
export function canActorBeKnocked(rules: Pick<BrRules, "reviveSeconds">, slot: number, team: number, actors: readonly (RulesActor | null | undefined)[]): boolean {
  if (!(rules.reviveSeconds > 0)) return false;
  for (let i = 0; i < actors.length; i++) {
    const a = actors[i];
    if (a && a.slot !== slot && a.team === team && a.life === "alive") return true;
  }
  return false;
}

/** Updates `standing` and `inPlay` from the actors (indexed by slot). Allocation-free. */
export function refreshTeamCounts(teams: readonly MutableTeamState[], actors: readonly (RulesActor | null | undefined)[]): void {
  for (const team of teams) {
    let standing = 0;
    let inPlay = 0;
    for (const slot of team.slots) {
      const life = actors[slot]?.life ?? "dead";
      if (life === "alive") standing++;
      if (life !== "dead") inPlay++;
    }
    team.standing = standing;
    team.inPlay = inPlay;
  }
}

/** Downed members of teams nobody on stands anymore: they are eliminated at once (credit to their knocker). */
export function downedWithoutStandingTeammate(teams: readonly TeamState[], actors: readonly (RulesActor | null | undefined)[], out: number[]): number[] {
  out.length = 0;
  for (const team of teams) {
    let standing = false;
    for (const slot of team.slots) if (actors[slot]?.life === "alive") standing = true;
    if (standing) continue;
    for (const slot of team.slots) if (actors[slot]?.life === "downed") out.push(slot);
  }
  return out;
}

export function countTeamsInPlay(teams: readonly TeamState[]): number {
  let n = 0;
  for (const team of teams) if (!team.eliminated) n++;
  return n;
}

export interface BrEndResult {
  readonly reason: BrEndReason;
  /** Winning team, or null (allDead has no winner). */
  readonly winnerTeam: number | null;
}

/**
 * Rules post-step (design.md §8.3), after `refreshTeamCounts`: teams with nobody alive or downed are eliminated with
 * placement = teams in play at the start of the tick (same-tick eliminations share it). Then one team left → it
 * places 1st and wins (`lastTeam`); none left → the teams wiped this tick share 1st, no winner (`allDead`). Emits
 * `teamEliminated`, `win` and `matchEnded`. Returns the end result, or null while the match goes on.
 */
export function resolveEliminations(teams: readonly MutableTeamState[], tick: number, events: MatchEvent[]): BrEndResult | null {
  const inPlayBefore = countTeamsInPlay(teams);
  if (inPlayBefore === 0) return null;
  let wiped = 0;
  for (const team of teams) if (!team.eliminated && team.inPlay === 0) wiped++;
  if (wiped === 0) return null;
  const remaining = inPlayBefore - wiped;
  const placement = remaining === 0 ? 1 : inPlayBefore;
  for (const team of teams) {
    if (team.eliminated || team.inPlay > 0) continue;
    team.eliminated = true;
    team.eliminatedTick = tick;
    team.placement = placement;
    events.push({ type: "teamEliminated", tick, team: team.team, placement });
  }
  if (remaining > 1) return null;
  if (remaining === 0) {
    events.push({ type: "matchEnded", tick, reason: "allDead", results: teamResults(teams) });
    return { reason: "allDead", winnerTeam: null };
  }
  const winner = teams.find((t) => !t.eliminated)!;
  winner.placement = 1;
  events.push({ type: "win", tick, team: winner.team });
  events.push({ type: "matchEnded", tick, reason: "lastTeam", results: teamResults(teams) });
  return { reason: "lastTeam", winnerTeam: winner.team };
}

/**
 * Time cap: the teams still in play are ranked by standing members, then total health (downed count 0), then team
 * index, and take placements 1..n. The top team wins. Emits `win` and `matchEnded{timeCap}`.
 */
export function resolveTimeCap(teams: readonly MutableTeamState[], actors: readonly (RulesActor | null | undefined)[], tick: number, events: MatchEvent[]): BrEndResult {
  const health = (team: TeamState): number => {
    let sum = 0;
    for (const slot of team.slots) {
      const a = actors[slot];
      if (a?.life === "alive") sum += a.health;
    }
    return sum;
  };
  const alive = teams.filter((t) => !t.eliminated).sort((a, b) => b.standing - a.standing || health(b) - health(a) || a.team - b.team);
  alive.forEach((team, i) => (team.placement = i + 1));
  const winner = alive[0] ?? null;
  if (winner) events.push({ type: "win", tick, team: winner.team });
  events.push({ type: "matchEnded", tick, reason: "timeCap", results: teamResults(teams) });
  return { reason: "timeCap", winnerTeam: winner?.team ?? null };
}

/** Results for every team with a placement, best first (ties by team index). */
export function teamResults(teams: readonly TeamState[]): TeamResult[] {
  return teams
    .filter((t) => t.placement !== null)
    .map((t) => ({ team: t.team, placement: t.placement!, kills: t.kills, slots: t.slots }))
    .sort((a, b) => a.placement - b.placement || a.team - b.team);
}

// ---------------------------------------------------------------------------------------------------------------
// Kill causes and feed
// ---------------------------------------------------------------------------------------------------------------

/** Cause of a knock or kill from the damage that dealt it. */
export function killCauseOf(kind: DamageKind, weaponId: WeaponId | null): KillCause {
  switch (kind) {
    case "bullet":
      return weaponId ?? "unknown";
    case "explosion":
      return "frag";
    case "fire":
      return "molotov";
    case "fall":
      return "fall";
    case "zone":
      return "zone";
    case "bleed":
      return "bleedOut";
  }
}

/** Display name of a cause ("AR-4", "Frag Grenade", "the zone"). */
export function killCauseName(cause: KillCause): string {
  switch (cause) {
    case "rifle":
    case "pistol":
    case "shotgun":
    case "sniper":
      return ITEMS[`weapon_${cause}`].name;
    case "frag":
    case "molotov":
      return ITEMS[cause].name;
    case "zone":
      return "the zone";
    case "fall":
      return "a fall";
    case "bleedOut":
      return "bleeding out";
    case "teamWipe":
      return "team wipe";
    case "outOfBounds":
      return "out of bounds";
    case "unknown":
      return "unknown";
  }
}

/**
 * Kill feed line (design.md §8.4): "A knocked B with AR-4", "A killed B with AR-4 (Headshot)", "B bled out",
 * "B died to the zone", "Team 3 eliminated (#4)". Null for events that have no line.
 */
export function killFeedLine(event: MatchEvent, nameOf: (slot: number) => string): string | null {
  switch (event.type) {
    case "knock": {
      if (event.attacker < 0 || event.attacker === event.victim) return `${nameOf(event.victim)} was knocked by ${killCauseName(event.cause)}`;
      return `${nameOf(event.attacker)} knocked ${nameOf(event.victim)} with ${killCauseName(event.cause)}${event.headshot ? " (Headshot)" : ""}`;
    }
    case "kill": {
      const victim = nameOf(event.victim);
      if (event.cause === "bleedOut") return `${victim} bled out`;
      if (event.cause === "zone") return `${victim} died to the zone`;
      if (event.cause === "fall") return `${victim} died from a fall`;
      if (event.cause === "outOfBounds") return `${victim} left the map`;
      if (event.cause === "teamWipe") return event.killer >= 0 ? `${nameOf(event.killer)} finished ${victim}` : `${victim} was eliminated`;
      if (event.killer < 0) return `${victim} died`;
      if (event.killer === event.victim) return `${victim} killed themselves with ${killCauseName(event.cause)}`;
      return `${nameOf(event.killer)} killed ${victim} with ${killCauseName(event.cause)}${event.headshot ? " (Headshot)" : ""}${event.teamKill ? " (Team kill)" : ""}`;
    }
    case "teamEliminated":
      return `Team ${event.team + 1} eliminated (#${event.placement})`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// PlayerAction arguments used by bots and the match simulation
// ---------------------------------------------------------------------------------------------------------------

/** `PlayerActionType.drop` targets packed into the 16-bit `arg`. Gear: 0–2 weapon slot, 3 helmet, 4 vest, 5 backpack. */
export type DropArgTarget =
  | { readonly kind: "weapon"; readonly slot: 0 | 1 | 2 }
  | { readonly kind: "armor"; readonly slot: "helmet" | "vest" }
  | { readonly kind: "backpack" }
  /** Stack by ITEM_IDS code; quantity 0 drops the whole stack (max 255). */
  | { readonly kind: "stack"; readonly code: number; readonly quantity: number };

const DROP_STACK_FLAG = 0x80;

export function encodeDropArg(target: DropArgTarget): number {
  switch (target.kind) {
    case "weapon":
      return target.slot;
    case "armor":
      return target.slot === "helmet" ? 3 : 4;
    case "backpack":
      return 5;
    case "stack":
      return DROP_STACK_FLAG | (target.code & 0x7f) | ((Math.min(255, Math.max(0, target.quantity)) & 0xff) << 8);
  }
}

export function decodeDropArg(arg: number): DropArgTarget | null {
  if (arg & DROP_STACK_FLAG) return { kind: "stack", code: arg & 0x7f, quantity: (arg >> 8) & 0xff };
  if (arg >= 0 && arg <= 2) return { kind: "weapon", slot: arg as 0 | 1 | 2 };
  if (arg === 3) return { kind: "armor", slot: "helmet" };
  if (arg === 4) return { kind: "armor", slot: "vest" };
  if (arg === 5) return { kind: "backpack" };
  return null;
}
