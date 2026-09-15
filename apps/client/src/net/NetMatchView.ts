import { remoteLifeCode, teammateReviveSeconds } from "@twobullets/netcode/replication";
import { lifeOfCode, MAX_PLAYER_SLOTS } from "@twobullets/protocol/codes";
import { PhaseCode, type Welcome } from "@twobullets/protocol/messages/control";
import { MatchEndReason, type MatchEnd, type PhaseChange, type ZonePhaseMessage } from "@twobullets/protocol/messages/match";
import type { Roster } from "@twobullets/protocol/messages/roster";
import { SIMULATION } from "@twobullets/shared/constants";
import { VITALS, type LifeState } from "@twobullets/shared/equipment/vitals";
import { DEFAULT_BR_RULES, DEFAULT_BR_TIMINGS } from "@twobullets/shared/match/rules";
import { teamModeOfSize } from "@twobullets/shared/match/teams";
import type {
  ActorState,
  BrEndReason,
  BrMatchConfig,
  BrPhase,
  MatchEvent,
  MatchFxEvent,
  MatchState,
  MatchView,
  TeamState,
  ZonePhase,
  ZoneSpec,
} from "@twobullets/shared/match/types";
import { createZoneState, DEFAULT_ZONE_SPEC, ZONE_WARNING_SECONDS, zoneAtInto, type MutableZoneState } from "@twobullets/shared/match/zone";
import { t } from "../i18n";

// The networked battle royale as a `MatchView` (plan.md B1/B4/B7), so the offline match HUD, map source, zone wall and
// screens run unchanged on server data. Pure: no Babylon, no DOM. NetMatch (the browser side) feeds it every frame:
//   sync(client)        Welcome, Roster, PhaseChange, ZonePhase, MatchEnd as NetClient stored them (identity checks)
//   onKillFeed(event)   knocks and kills from the KillFeed stream
//   update(tick, …)     server tick estimate, remote poses, teammate vitals and the owner's vitals → zone, lives, counters,
//                       warnings, teammate cards

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableActor = Mutable<ActorState> & { feet: { x: number; y: number; z: number } };
type MutableTeam = Mutable<TeamState> & { slots: number[] };

/** Newest teammate vitals group (protocol v6) by slot, as NetClient stores it from snapshots. */
export interface NetTeammateVitals {
  /** Server tick of the group that listed the slot, −1 = not a teammate in the newest group. */
  readonly tick: Float64Array;
  /** `LifeCode`. */
  readonly life: Uint8Array;
  /** Whole HP. */
  readonly health: Uint8Array;
  readonly downedHealth: Uint8Array;
  /** `TeammateVitals.reviveQ`. */
  readonly reviveQ: Uint8Array;
  /** 1 when the local player is the reviver. */
  readonly reviverIsMe: Uint8Array;
}

export function createNetTeammateVitals(): NetTeammateVitals {
  return {
    tick: new Float64Array(MAX_PLAYER_SLOTS).fill(-1),
    life: new Uint8Array(MAX_PLAYER_SLOTS),
    health: new Uint8Array(MAX_PLAYER_SLOTS),
    downedHealth: new Uint8Array(MAX_PLAYER_SLOTS),
    reviveQ: new Uint8Array(MAX_PLAYER_SLOTS),
    reviverIsMe: new Uint8Array(MAX_PLAYER_SLOTS),
  };
}

/** What NetClient stores from the control stream and snapshots (NetClient satisfies it). */
export interface NetMatchSource {
  readonly welcomeInfo: Welcome | null;
  readonly matchPhase: PhaseChange | null;
  readonly zonePhases: readonly ZonePhaseMessage[];
  readonly matchEnd: MatchEnd | null;
  readonly matchRoster: Roster | null;
  /** Teammate health, downed health and revive progress; without it teammates show full bars while standing. */
  readonly teammateVitals?: NetTeammateVitals | null;
}

/** Interpolated remote poses by slot (RemoteRoster satisfies it). */
export interface NetPoseSource {
  readonly visible: Uint8Array;
  readonly poses: readonly { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number; readonly flags: number }[];
}

/** The local player's own state this frame. */
export interface NetOwnState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly life: LifeState;
  readonly health: number;
  readonly downedHealth: number;
  /** Seconds of revive received so far. */
  readonly reviveSeconds: number;
}

export interface NetMatchViewOptions {
  readonly mapId: string;
  /** The server level's zone; default Map v1's (real-world maps use it too), `arena` gets the arena radii. */
  readonly zone?: ZoneSpec;
  /** Zone time scale assumed until the first phase is announced (then measured). */
  readonly timeScale?: number;
  /** Localized bot name for seat `bot:<n>` (default "Bot {n + 1}"). */
  readonly botName?: (botIndex: number) => string;
}

/** Map v1's schedule with the arena's radii (server-match `ARENA_ZONE_SPEC`); only `initial` and the phase count matter here. */
const ARENA_ZONE: ZoneSpec = { ...DEFAULT_ZONE_SPEC, initial: { cx: 0, cz: 0, r: 60 }, edgeMargin: 4 };

const PHASE_NAMES: Readonly<Record<number, BrPhase>> = {
  [PhaseCode.Warmup]: "warmup",
  [PhaseCode.LandingSelect]: "landing",
  [PhaseCode.Glide]: "glide",
  [PhaseCode.Combat]: "combat",
  [PhaseCode.End]: "ended",
};

const END_REASONS: Readonly<Record<number, BrEndReason>> = {
  [MatchEndReason.lastTeam]: "lastTeam",
  [MatchEndReason.allDead]: "allDead",
  [MatchEndReason.timeCap]: "timeCap",
};

/** A warning fires only when the countdown crosses its mark within this window (not when joining late), s. */
const WARNING_WINDOW_SECONDS = 1.5;

function createActor(slot: number, team: number): MutableActor {
  return {
    slot,
    team,
    kind: "human",
    name: "",
    life: "alive",
    health: VITALS.maxHealth,
    downedHealth: 0,
    boost: 0,
    feet: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
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
}

export class NetMatchView implements MatchView {
  readonly config: Mutable<BrMatchConfig>;
  readonly state: MatchState;
  /** Own slot and team from Welcome (−1 before). */
  ownSlot = -1;
  ownTeam = -1;
  /** The MatchEnd message once received (reason includes cancelled and aborted). */
  matchEnd: MatchEnd | null = null;
  /** Last kill feed event with the local player as the victim (death screen cause). */
  lastOwnKill: Extract<MatchEvent, { type: "kill" }> | null = null;
  /** Roster seen at least once. */
  hasRoster = false;
  /** A PhaseChange seen at least once (the M4 sandbox flow never sends one). */
  hasPhase = false;
  /** Teammate the local player is reviving by the server's progress, or −1. */
  reviveTargetSlot = -1;
  /** Server revive progress of `reviveTargetSlot`, 0..1 (0 when none). */
  reviveProgress = 0;
  private readonly mutable: Mutable<MatchState>;
  private readonly actors: (MutableActor | undefined)[] = [];
  private readonly pool: MutableActor[] = [];
  private readonly teams: MutableTeam[] = [];
  private readonly zone: MutableZoneState;
  private readonly eventListeners: ((event: MatchEvent) => void)[] = [];
  private readonly botName: (botIndex: number) => string;
  private readonly warned = new Uint8Array(64);
  private readonly eliminated = new Uint8Array(MAX_PLAYER_SLOTS);
  private readonly timeScaleHint: number;
  private lastWelcome: Welcome | null = null;
  private lastPhase: PhaseChange | null = null;
  private lastEnd: MatchEnd | null = null;
  private lastRoster: Roster | null = null;
  private teammateVitals: NetTeammateVitals | null = null;
  private announcedIndex = 0;
  /** Length of the zone phase list at the last sync (NetClient appends to the same array). */
  private zoneSeen = 0;
  private serverAlive = 0;
  private serverTeams = 0;
  private lastStage: string | null = null;
  private tickKnown = false;

  constructor(options: NetMatchViewOptions) {
    const zone = options.zone ?? (options.mapId === "arena" ? ARENA_ZONE : DEFAULT_ZONE_SPEC);
    this.timeScaleHint = options.timeScale ?? 1;
    this.botName = options.botName ?? ((n) => t("match.botName", { n: n + 1 }));
    this.config = {
      seed: 0,
      mapId: options.mapId,
      teamCount: 1,
      teamSize: 1,
      maxPlayers: 1,
      actors: [],
      rules: DEFAULT_BR_RULES,
      zone,
      timings: DEFAULT_BR_TIMINGS,
      timeScale: this.timeScaleHint,
    };
    this.zone = createZoneState(zone);
    this.mutable = {
      tick: 0,
      phase: "warmup",
      // −1 until the first PhaseChange: the match HUD shows no "waiting for players" banner before it.
      phaseStartTick: -1,
      phaseEndTick: -1,
      combatStartTick: -1,
      zone: this.zone,
      zonePhases: [],
      teams: this.teams,
      actors: this.actors as ActorState[],
      teamsInPlay: 0,
      actorsInPlay: 0,
      winnerTeam: null,
      endReason: null,
    };
    this.state = this.mutable;
  }

  onEvent(listener: (event: MatchEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const i = this.eventListeners.indexOf(listener);
      if (i >= 0) this.eventListeners.splice(i, 1);
    };
  }

  onFx(_listener: (event: MatchFxEvent) => void): () => void {
    return () => undefined;
  }

  /** Warmup with no end scheduled yet (waiting for the first human). */
  get waitingForPlayers(): boolean {
    return this.hasPhase && this.mutable.phase === "warmup" && this.mutable.phaseEndTick < 0;
  }

  get ended(): boolean {
    return this.matchEnd !== null;
  }

  /** "Bạn" is the HUD's job; this is the roster name ("Bot 3" for bots), or "" for an empty slot. */
  nameOf(slot: number): string {
    return this.actors[slot]?.name ?? "";
  }

  teamOf(slot: number): number {
    const actor = this.actors[slot];
    if (actor) return actor.team;
    return this.config.teamSize > 0 && slot >= 0 ? Math.floor(slot / this.config.teamSize) : -1;
  }

  /** Applies whatever NetClient received since the last call. Cheap when nothing changed. */
  sync(source: NetMatchSource): void {
    const welcome = source.welcomeInfo;
    if (welcome !== null && welcome !== this.lastWelcome) this.applyWelcome(welcome);
    const roster = source.matchRoster;
    if (roster !== null && roster !== this.lastRoster) this.applyRoster(roster);
    const phase = source.matchPhase;
    if (phase !== null && phase !== this.lastPhase) this.applyPhase(phase);
    if (source.zonePhases !== this.mutable.zonePhases || source.zonePhases.length !== this.zoneSeen) this.applyZonePhases(source.zonePhases);
    const end = source.matchEnd;
    if (end !== null && end !== this.lastEnd) this.applyEnd(end);
    this.teammateVitals = source.teammateVitals ?? null;
  }

  /** A knock or kill line from the KillFeed stream: lives, kill counts, team eliminations, then listeners. */
  onKillFeed(event: MatchEvent): void {
    if (event.type === "kill") {
      const victim = this.actors[event.victim];
      if (victim) {
        victim.life = "dead";
        victim.health = 0;
        victim.downedHealth = 0;
        victim.deathTick = event.tick;
      }
      const killer = event.killer >= 0 && event.killer !== event.victim ? this.actors[event.killer] : undefined;
      if (killer) killer.kills++;
      if (event.victim === this.ownSlot) this.lastOwnKill = event;
    } else if (event.type === "knock") {
      const victim = this.actors[event.victim];
      if (victim && victim.life === "alive") {
        victim.life = "downed";
        victim.health = 0;
        victim.downedHealth = VITALS.downedHealth;
      }
      const attacker = event.attacker >= 0 && event.attacker !== event.victim ? this.actors[event.attacker] : undefined;
      if (attacker) attacker.knocks++;
    }
    this.emit(event);
    if (event.type === "kill" && this.mutable.phase === "combat") this.checkElimination(this.teamOf(event.victim), event.tick);
  }

  /** Confirmed damage the local player dealt (HitConfirm), for the death screen until MatchEnd has the real total. */
  addOwnDamage(amount: number): void {
    const own = this.actors[this.ownSlot];
    if (own) own.damageDealt += amount;
  }

  /**
   * Per frame. `serverTick`: the client's estimate of the server's current tick (fractional ok), or < 0 when unknown.
   * `poses`: remote players at the render tick; `own`: the local player (null before Welcome).
   */
  update(serverTick: number, poses: NetPoseSource | null, own: NetOwnState | null): void {
    const s = this.mutable;
    if (serverTick >= 0) {
      s.tick = Math.floor(serverTick);
      this.tickKnown = true;
    }
    this.updateActors(poses, own);
    this.updateCounts();
    if (s.phase !== "combat" && s.phase !== "ended") {
      this.lastStage = null;
      return;
    }
    if (!this.tickKnown) return;
    const zone = zoneAtInto(this.config.zone, s.zonePhases, s.tick, this.zone);
    if (s.phase !== "combat") return;
    if (zone.stage === "waiting" && zone.phase !== null) {
      const secondsLeft = zone.ticksToChange / SIMULATION.tickRate;
      const index = zone.phase.index & 63;
      for (let i = 0; i < ZONE_WARNING_SECONDS.length; i++) {
        const mark = ZONE_WARNING_SECONDS[i]!;
        const bit = 1 << i;
        if ((this.warned[index]! & bit) !== 0 || secondsLeft > mark || secondsLeft <= mark - WARNING_WINDOW_SECONDS) continue;
        this.warned[index]! |= bit;
        this.emit({ type: "zoneWarning", tick: s.tick, phaseIndex: zone.phase.index, secondsLeft: mark });
      }
    }
    if (zone.stage === "shrinking" && this.lastStage !== null && this.lastStage !== "shrinking" && zone.phase !== null) {
      this.emit({ type: "zoneShrinkStarted", tick: s.tick, phaseIndex: zone.phase.index });
    }
    this.lastStage = zone.stage;
  }

  // ---- Messages ---------------------------------------------------------------------------------------------------------

  private applyWelcome(welcome: Welcome): void {
    this.lastWelcome = welcome;
    this.ownSlot = welcome.playerSlot;
    this.ownTeam = welcome.teamId;
    const config = this.config;
    config.seed = welcome.matchSeed;
    const sizeChanged = config.teamSize !== welcome.teamSize || config.maxPlayers !== welcome.maxPlayers;
    config.teamSize = welcome.teamSize;
    config.maxPlayers = welcome.maxPlayers;
    config.teamCount = Math.ceil(welcome.maxPlayers / welcome.teamSize);
    const mode = teamModeOfSize(welcome.teamSize);
    if (mode) config.teamMode = mode;
    else delete config.teamMode;
    if (sizeChanged || this.teams.length === 0) this.rebuildSlots();
    // Until a roster arrives, at least the local player exists.
    if (!this.hasRoster) this.actors[welcome.playerSlot] = this.pooled(welcome.playerSlot);
  }

  private rebuildSlots(): void {
    const { teamCount, teamSize } = this.config;
    const maxPlayers = this.config.maxPlayers ?? teamCount * teamSize;
    this.actors.length = 0;
    this.pool.length = 0;
    this.teams.length = 0;
    for (let slot = 0; slot < maxPlayers; slot++) {
      this.pool.push(createActor(slot, Math.floor(slot / teamSize)));
      this.actors.push(undefined);
    }
    for (let team = 0; team < teamCount; team++) {
      this.teams.push({ team, slots: [], standing: 0, inPlay: 0, eliminated: false, eliminatedTick: -1, placement: null, kills: 0 });
    }
    this.eliminated.fill(0);
  }

  private pooled(slot: number): MutableActor {
    let actor = this.pool[slot];
    if (!actor) {
      actor = createActor(slot, this.config.teamSize > 0 ? Math.floor(slot / this.config.teamSize) : 0);
      this.pool[slot] = actor;
    }
    return actor;
  }

  private applyRoster(roster: Roster): void {
    this.lastRoster = roster;
    this.hasRoster = true;
    const present = new Uint8Array(MAX_PLAYER_SLOTS);
    for (const player of roster.players) {
      if (player.slot < 0 || player.slot >= MAX_PLAYER_SLOTS) continue;
      present[player.slot] = 1;
      const actor = this.pooled(player.slot);
      actor.team = player.team;
      actor.kind = player.isBot ? "bot" : "human";
      actor.name = player.isBot ? this.botName(player.botIndex) : player.name;
      this.actors[player.slot] = actor;
    }
    for (let slot = 0; slot < this.actors.length; slot++) if (present[slot] === 0) this.actors[slot] = undefined;
    for (const team of this.teams) team.slots.length = 0;
    for (let slot = 0; slot < this.actors.length; slot++) {
      const actor = this.actors[slot];
      if (actor) this.teams[actor.team]?.slots.push(slot);
    }
  }

  private applyPhase(message: PhaseChange): void {
    this.lastPhase = message;
    this.hasPhase = true;
    const s = this.mutable;
    const phase = PHASE_NAMES[message.phase] ?? "warmup";
    if (phase === "combat" && s.phase !== "combat") this.lastStage = null;
    s.phase = this.matchEnd !== null ? "ended" : phase;
    s.phaseStartTick = message.startTick;
    s.phaseEndTick = message.endTick > 0 ? message.endTick : -1;
    // Before combat nobody is out yet; End keeps the combat start.
    if (phase === "combat") s.combatStartTick = message.startTick;
    else if (phase !== "ended") s.combatStartTick = -1;
    this.serverAlive = message.playersAlive;
    this.serverTeams = message.teamsAlive;
    this.measureTimeScale();
  }

  private applyZonePhases(phases: readonly ZonePhaseMessage[]): void {
    const s = this.mutable;
    s.zonePhases = phases as readonly ZonePhase[];
    this.zoneSeen = phases.length;
    for (const phase of phases) {
      if (phase.index <= this.announcedIndex) continue;
      this.announcedIndex = phase.index;
      this.emit({ type: "zoneAnnounced", tick: phase.waitStartTick, phase });
    }
    this.measureTimeScale();
  }

  /** The server's zone time scale from phase 1's announcement: combat start + firstAnnounceSeconds × scale. */
  private measureTimeScale(): void {
    const s = this.mutable;
    const first = s.zonePhases[0];
    if (!first || s.combatStartTick < 0 || first.index !== 1) return;
    const base = this.config.zone.firstAnnounceSeconds * SIMULATION.tickRate;
    if (base > 0 && first.waitStartTick > s.combatStartTick) this.config.timeScale = (first.waitStartTick - s.combatStartTick) / base;
  }

  private applyEnd(end: MatchEnd): void {
    this.lastEnd = end;
    this.matchEnd = end;
    const s = this.mutable;
    s.phase = "ended";
    s.winnerTeam = end.winningTeam >= 0 ? end.winningTeam : null;
    s.endReason = END_REASONS[end.reason] ?? null;
    for (const team of this.teams) team.kills = 0;
    for (const p of end.players) {
      const actor = this.actors[p.slot] ?? this.pooled(p.slot);
      this.actors[p.slot] = actor;
      actor.team = p.teamId;
      actor.kills = p.kills;
      actor.knocks = p.knocks;
      actor.damageDealt = p.damageDealt;
      if (p.bot) actor.kind = "bot";
      const team = this.teams[p.teamId];
      if (team) {
        team.kills += p.kills;
        if (p.placement > 0) team.placement = p.placement;
      }
    }
  }

  // ---- Per frame --------------------------------------------------------------------------------------------------------

  private updateActors(poses: NetPoseSource | null, own: NetOwnState | null): void {
    const actors = this.actors;
    const tick = this.mutable.tick;
    const mates = this.teammateVitals;
    this.reviveTargetSlot = -1;
    this.reviveProgress = 0;
    for (let slot = 0; slot < actors.length; slot++) {
      const actor = actors[slot];
      if (!actor) continue;
      if (slot === this.ownSlot) {
        if (!own) continue;
        actor.feet.x = own.x;
        actor.feet.y = own.y;
        actor.feet.z = own.z;
        actor.yaw = own.yaw;
        this.setLife(actor, own.life, tick);
        actor.health = own.health;
        actor.downedHealth = own.downedHealth;
        actor.reviveProgress = own.reviveSeconds;
        actor.reviverSlot = own.life === "downed" && own.reviveSeconds > 0 ? slot : -1;
        continue;
      }
      const pose = poses && poses.visible[slot] === 1 ? poses.poses[slot] : undefined;
      if (pose) {
        actor.feet.x = pose.x;
        actor.feet.y = pose.y;
        actor.feet.z = pose.z;
        actor.yaw = pose.yaw;
      }
      if (mates !== null && mates.tick[slot]! >= 0 && actor.team === this.ownTeam) {
        this.applyTeammateVitals(actor, mates, tick);
        continue;
      }
      if (!pose) continue;
      const life = lifeOfCode(remoteLifeCode(pose.flags));
      this.setLife(actor, life, tick);
      // Enemies' health isn't replicated (anti-ESP): full while standing.
      actor.health = life === "alive" ? VITALS.maxHealth : 0;
      if (life !== "downed") actor.downedHealth = 0;
      else if (actor.downedHealth <= 0) actor.downedHealth = VITALS.downedHealth;
      actor.reviveProgress = 0;
      actor.reviverSlot = -1;
    }
  }

  /** The server's teammate vitals group: newer than the interpolated pose flags, so its life wins on the cards. */
  private applyTeammateVitals(actor: MutableActor, mates: NetTeammateVitals, tick: number): void {
    const slot = actor.slot;
    // A kill feed line newer than the group already made it dead.
    const life = actor.life === "dead" && actor.deathTick > mates.tick[slot]! ? "dead" : lifeOfCode(mates.life[slot]!);
    this.setLife(actor, life, tick);
    const downed = life === "downed";
    actor.health = life === "alive" ? mates.health[slot]! : 0;
    actor.downedHealth = downed ? mates.downedHealth[slot]! : 0;
    const mine = downed && mates.reviverIsMe[slot] === 1;
    const reviveQ = downed ? mates.reviveQ[slot]! : 0;
    actor.reviveProgress = reviveQ > 0 ? teammateReviveSeconds(reviveQ) : 0;
    // Someone else's revive has no slot on the wire: the downed teammate's own slot stands in (as for the local player).
    actor.reviverSlot = mine ? this.ownSlot : reviveQ > 0 ? slot : -1;
    if (mine) {
      this.reviveTargetSlot = slot;
      this.reviveProgress = actor.reviveProgress / VITALS.reviveSeconds;
    }
  }

  private setLife(actor: MutableActor, life: LifeState, tick: number): void {
    if (actor.life === life) return;
    if (life === "dead" && actor.deathTick < 0) actor.deathTick = tick;
    if (life !== "dead") actor.deathTick = -1;
    actor.life = life;
  }

  /**
   * Warmup: the server's numbers. Combat: players still in play by what this client saw, never above the server's. No
   * PhaseChange yet (sandbox flow): everyone in the roster not dead right now.
   */
  private updateCounts(): void {
    const s = this.mutable;
    const combat = s.phase === "combat" || (s.phase === "ended" && s.combatStartTick >= 0);
    for (const team of this.teams) {
      team.standing = 0;
      team.inPlay = 0;
    }
    for (let slot = 0; slot < this.actors.length; slot++) {
      const actor = this.actors[slot];
      if (!actor) continue;
      const team = this.teams[actor.team];
      if (!team) continue;
      if (actor.life === "alive") team.standing++;
      if (this.inPlay(actor)) team.inPlay++;
    }
    if (this.hasPhase && (!combat || !this.hasRoster)) {
      s.actorsInPlay = this.serverAlive;
      s.teamsInPlay = this.serverTeams;
      return;
    }
    let players = 0;
    let teams = 0;
    for (const team of this.teams) {
      players += team.inPlay;
      if (team.inPlay > 0) teams++;
      if (combat) team.eliminated = team.inPlay === 0;
    }
    s.actorsInPlay = this.hasPhase ? Math.min(players, this.serverAlive) : players;
    s.teamsInPlay = this.hasPhase ? Math.min(teams, this.serverTeams) : teams;
  }

  /** Dead before combat started (warmup respawns) doesn't count as out. */
  private inPlay(actor: MutableActor): boolean {
    if (actor.life !== "dead") return true;
    const combatStart = this.mutable.combatStartTick;
    return combatStart >= 0 && actor.deathTick >= 0 && actor.deathTick < combatStart;
  }

  private checkElimination(teamId: number, tick: number): void {
    const team = this.teams[teamId];
    if (!team || this.eliminated[teamId] === 1 || team.slots.length === 0) return;
    for (const slot of team.slots) {
      const actor = this.actors[slot];
      if (actor && this.inPlay(actor)) return;
    }
    this.eliminated[teamId] = 1;
    let remaining = 0;
    for (const other of this.teams) {
      if (other.slots.length === 0 || this.eliminated[other.team] === 1) continue;
      if (other.slots.some((slot) => { const a = this.actors[slot]; return a !== undefined && this.inPlay(a); })) remaining++;
    }
    team.eliminatedTick = tick;
    if (team.placement === null) team.placement = remaining + 1;
    this.emit({ type: "teamEliminated", tick, team: teamId, placement: remaining + 1 });
  }

  private emit(event: MatchEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}
