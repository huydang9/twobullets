import { isBotAccountId } from "@twobullets/contracts/claims";
import type { MatchConfig, MatchPhase, MatchResult, PlayerResult } from "@twobullets/contracts";
import {
  createBitWriter,
  encodeMatchEnd,
  encodePhaseChange,
  encodeZonePhase,
  MatchEndReason,
  PhaseCode,
  quantizeZonePhase,
  type MatchEndPlayer,
} from "@twobullets/protocol";
import { hash32 } from "@twobullets/shared/equipment/math";
import { countTeamsInPlay, DEFAULT_BR_TIMINGS, refreshTeamCounts, resolveEliminations, resolveTimeCap, type BrEndResult, type MutableTeamState } from "@twobullets/shared/match/rules";
import type { MatchEvent, ZonePhase, ZoneSpec } from "@twobullets/shared/match/types";
import { computeZonePhase, createZoneState, isOutsideZone, secondsToTicks, zoneAtInto, zoneTickDamage, type MutableZoneState, type ZoneCenterCheck } from "@twobullets/shared/match/zone";
import { SIMULATION } from "@twobullets/shared/constants";
import type { Session } from "@twobullets/netcode";
import type { Player } from "./Player";
import type { ServerCombat } from "./ServerCombat";

// Server battle royale loop (plan.md B1, netcode.md §8): Warmup → LandingSelect → Glide → Combat → End on match ticks,
// with the shared rules (zone schedule and damage, knocks, team eliminations, placements, time cap).
//   Warmup: joins open, damage off, the dead respawn. Ends `warmupSeconds` after the first human joins, sooner once every
//     rostered human is connected (`allJoinedSeconds`); holds while no human is connected.
//   LandingSelect / Glide: MVP hooks with zero default length. Glide start puts every player on its team start with a
//     fresh loadout (B3 replaces this with landing marker → spawn at altitude → glide).
//   Combat: damage on, no respawns, no new joins; zone phases announced one at a time (centers from the match seed and a
//     server-only salt) and quantized to the wire so client and server run the same circles.
//   End: MatchEnd to everyone, the result goes to the host at once, inputs freeze, sessions close after `endLingerSeconds`.
// A match with no connected human for `noHumansTimeoutMs` ends cancelled (warmup) or aborted.

export type GameplayPhaseName = "Warmup" | "LandingSelect" | "Glide" | "Combat" | "End";

export interface BrLifecycleOptions {
  /** Warmup after the first human joins, s. Default 60. */
  readonly warmupSeconds?: number;
  /** Warmup left once every rostered human is connected, s. Default 10. */
  readonly allJoinedSeconds?: number;
  /** B3 hooks. Default 0. */
  readonly landingSeconds?: number;
  readonly glideSeconds?: number;
  /** Combat start → forced end (shared default 720). */
  readonly timeCapSeconds?: number;
  /** End → sessions closed, s. Default 8. */
  readonly endLingerSeconds?: number;
  /** Wall-clock ms without a connected human before the match is cancelled/aborted. Default 120 000. */
  readonly noHumansTimeoutMs?: number;
  /** Scales landing, glide, the time cap and the zone schedule (tests, quick local runs); not warmup or linger. Default 1. */
  readonly timeScale?: number;
  /** Default: the level's zone. */
  readonly zone?: ZoneSpec;
  /** Server-secret salt mixed into the zone seed (never sent). */
  readonly zoneSalt?: number;
  /** Epoch ms for results. Default Date.now. */
  readonly nowEpochMs?: () => number;
}

export interface LifecycleHost {
  readonly config: MatchConfig;
  /** Sparse, indexed by slot. */
  readonly slots: readonly (Player | null)[];
  /** Dense, sorted by slot. */
  readonly players: readonly Player[];
  readonly combat: ServerCombat;
  readonly teamCount: number;
  readonly teamSize: number;
  readonly zone: ZoneSpec;
  readonly isValidZoneCenter: ZoneCenterCheck | null;
  /** Team start, fresh loadout and vitals. */
  placeAtStart(p: Player): void;
  /** Lifecycle phase for the host agent (contracts `MatchPhase`). */
  lifecyclePhase(phase: MatchPhase): void;
  /** The result is final (sent once). */
  result(result: MatchResult): void;
  /** End linger is over (or cancelled/aborted): close the match. */
  close(): void;
}

const PHASE_CODE: Record<GameplayPhaseName, number> = { Warmup: PhaseCode.Warmup, LandingSelect: PhaseCode.LandingSelect, Glide: PhaseCode.Glide, Combat: PhaseCode.Combat, End: PhaseCode.End };
const END_REASON: Record<string, MatchEndReason> = { lastTeam: MatchEndReason.lastTeam, allDead: MatchEndReason.allDead, timeCap: MatchEndReason.timeCap, cancelled: MatchEndReason.cancelled, aborted: MatchEndReason.aborted };

export class BrLifecycle {
  phase: GameplayPhaseName = "Warmup";
  phaseStartTick = 0;
  /** 0 = open-ended. */
  phaseEndTick = 0;
  combatStartTick = -1;
  endReason: BrEndResult["reason"] | "cancelled" | "aborted" | null = null;
  winnerTeam: number | null = null;
  readonly zonePhases: ZonePhase[] = [];
  readonly zoneState: MutableZoneState;
  readonly teams: MutableTeamState[] = [];
  private readonly host: LifecycleHost;
  private readonly o: Required<Omit<BrLifecycleOptions, "zone" | "zoneSalt" | "nowEpochMs">>;
  private readonly zone: ZoneSpec;
  private readonly zoneSeed: number;
  private readonly nowEpochMs: () => number;
  private readonly writer = createBitWriter(256);
  private readonly events: MatchEvent[] = [];
  private readonly rosterHumans: readonly string[];
  private firstHumanTick = -1;
  private lastHumanSeenMs: number;
  private allocatedAtEpochMs: number;
  private combatStartedAtEpochMs = 0;
  private endedTick = -1;
  private resultSent = false;
  private closed = false;
  private tickNow = 0;

  constructor(host: LifecycleHost, options: BrLifecycleOptions, nowMs: number, startTick: number) {
    this.host = host;
    this.o = {
      warmupSeconds: options.warmupSeconds ?? 60,
      allJoinedSeconds: options.allJoinedSeconds ?? 10,
      landingSeconds: options.landingSeconds ?? DEFAULT_BR_TIMINGS.landingSeconds,
      glideSeconds: options.glideSeconds ?? DEFAULT_BR_TIMINGS.glideSeconds,
      timeCapSeconds: options.timeCapSeconds ?? DEFAULT_BR_TIMINGS.timeCapSeconds,
      endLingerSeconds: options.endLingerSeconds ?? DEFAULT_BR_TIMINGS.endLingerSeconds,
      noHumansTimeoutMs: options.noHumansTimeoutMs ?? 120_000,
      timeScale: options.timeScale ?? 1,
    };
    this.zone = options.zone ?? host.zone;
    this.zoneSeed = hash32(host.config.matchSeed >>> 0, (options.zoneSalt ?? 0) >>> 0, 0x5a0e);
    this.nowEpochMs = options.nowEpochMs ?? Date.now;
    this.zoneState = createZoneState(this.zone);
    this.lastHumanSeenMs = nowMs;
    this.allocatedAtEpochMs = this.nowEpochMs();
    this.phaseStartTick = startTick;
    this.tickNow = startTick;
    const rosterHumans: string[] = [];
    for (const t of host.config.teams) for (const id of t.accountIds) if (!isBotAccountId(id)) rosterHumans.push(id);
    this.rosterHumans = rosterHumans;
    for (let team = 0; team < host.teamCount; team++) {
      const slots: number[] = [];
      for (let m = 0; m < host.teamSize; m++) if (team * host.teamSize + m < host.slots.length) slots.push(team * host.teamSize + m);
      this.teams.push({ team, slots, standing: 0, inPlay: 0, eliminated: false, eliminatedTick: -1, placement: null, kills: 0 });
    }
    host.combat.damageEnabled = false;
    host.combat.respawnEnabled = true;
  }

  get ended(): boolean {
    return this.phase === "End";
  }

  /** New accounts may take a slot (reconnects are always allowed). */
  get acceptsNewPlayers(): boolean {
    return this.phase === "Warmup";
  }

  /** Inputs drain but nobody moves or shoots. */
  get frozen(): boolean {
    return this.phase === "End";
  }

  /** Grace-expired disconnects stay in the world as eliminated instead of freeing their slot. */
  get keepsDisconnected(): boolean {
    return this.phase !== "Warmup";
  }

  private ticks(seconds: number): number {
    return secondsToTicks(seconds, this.o.timeScale);
  }

  // ---- Tick ---------------------------------------------------------------------------------------------------------

  /** Before players step: phase transitions and the zone schedule. */
  beginTick(tick: number): void {
    this.tickNow = tick;
    if (this.phase === "Warmup") this.stepWarmup(tick);
    if (this.phase === "LandingSelect" && tick >= this.phaseEndTick) {
      this.setPhase("Glide", tick, tick + this.ticks(this.o.glideSeconds));
      this.onGlideStart();
    }
    if (this.phase === "Glide" && tick >= this.phaseEndTick) this.startCombat(tick);
    if (this.phase === "Combat") {
      this.stepZoneSchedule(tick);
      zoneAtInto(this.zone, this.zonePhases, tick, this.zoneState);
      if (tick >= this.combatStartTick + this.ticks(this.o.timeCapSeconds)) {
        refreshTeamCounts(this.teams, this.host.slots);
        this.events.length = 0;
        this.end(resolveTimeCap(this.teams, this.host.slots, tick, this.events).reason, this.winnerOf(), tick);
      }
    }
  }

  /** After players and combat stepped: zone damage, eliminations, win. */
  endTick(tick: number): void {
    if (this.phase === "End") {
      if (!this.closed && tick >= this.phaseEndTick) this.close();
      return;
    }
    if (this.phase !== "Combat") return;
    const zone = this.zone;
    const state = this.zoneState;
    if (state.dps > 0 && (tick - this.combatStartTick) % zone.damageIntervalTicks === 0) {
      const amount = zoneTickDamage(zone, state.dps);
      const players = this.host.players;
      for (let i = 0; i < players.length; i++) {
        const p = players[i]!;
        if (p.life !== "dead" && isOutsideZone(state.current, p.feet.x, p.feet.z)) this.host.combat.zoneDamage(p, amount);
      }
    }
    refreshTeamCounts(this.teams, this.host.slots);
    this.events.length = 0;
    const result = resolveEliminations(this.teams, tick, this.events);
    if (result !== null) this.end(result.reason, result.winnerTeam, tick);
  }

  /** Once a second from the match sweep: the no-humans timeout. */
  sweep(nowMs: number): void {
    if (this.phase === "End") return;
    if (this.connectedHumans() > 0) {
      this.lastHumanSeenMs = nowMs;
      return;
    }
    if (nowMs - this.lastHumanSeenMs >= this.o.noHumansTimeoutMs) this.abort();
  }

  /** Drain, SIGTERM or no humans: ends at once with `cancelled` (warmup) or `aborted`, and closes. */
  abort(): void {
    if (this.phase !== "End") this.end(this.phase === "Warmup" ? "cancelled" : "aborted", null, this.tickNow);
    this.phaseEndTick = this.tickNow;
    if (!this.closed) this.close();
  }

  // ---- Joins ----------------------------------------------------------------------------------------------------------

  /** A session was bound to `p` (first join or reconnect), after Welcome. */
  onBound(p: Player, session: Session): void {
    if (!isBotAccountId(p.accountId) && this.firstHumanTick < 0) this.firstHumanTick = this.tickNow;
    const w = this.writer;
    this.writePhaseChange();
    session.sendStream(w.bytes());
    for (const phase of this.zonePhases) {
      w.reset();
      encodeZonePhase(w, phase);
      session.sendStream(w.bytes());
    }
    if (this.phase === "End") {
      this.writeMatchEnd();
      session.sendStream(w.bytes());
    }
  }

  // ---- Phases ---------------------------------------------------------------------------------------------------------

  private stepWarmup(tick: number): void {
    let end = 0;
    if (this.firstHumanTick >= 0 && this.connectedHumans() > 0) {
      // A countdown resumed after everyone left gets at least `allJoinedSeconds`; once all rostered humans are in, the
      // end moves no later than `allJoinedSeconds` from that tick (min() keeps the first such value).
      const short = tick + secondsToTicks(this.o.allJoinedSeconds);
      end = this.phaseEndTick > 0 ? this.phaseEndTick : Math.max(this.firstHumanTick + secondsToTicks(this.o.warmupSeconds), short);
      if (this.allHumansConnected()) end = Math.min(end, short);
    }
    if (end !== this.phaseEndTick) {
      this.phaseEndTick = end;
      this.broadcastPhase();
    }
    if (end > 0 && tick >= end) this.setPhase("LandingSelect", tick, tick + this.ticks(this.o.landingSeconds));
  }

  /** B3 hook: spawn at altitude above the team's landing choice and glide. MVP: team starts on the ground. */
  private onGlideStart(): void {
    const players = this.host.players;
    for (let i = 0; i < players.length; i++) this.host.placeAtStart(players[i]!);
  }

  private startCombat(tick: number): void {
    this.combatStartTick = tick;
    this.combatStartedAtEpochMs = this.nowEpochMs();
    const combat = this.host.combat;
    combat.damageEnabled = true;
    combat.respawnEnabled = false;
    for (const p of this.host.players) {
      const s = p.combat;
      s.kills = s.knocks = s.damageDealt = s.deaths = s.revives = 0;
    }
    refreshTeamCounts(this.teams, this.host.slots);
    // Teams nobody joined are out from the start and share the last place.
    for (const team of this.teams) {
      if (team.inPlay > 0) continue;
      team.eliminated = true;
      team.eliminatedTick = tick;
      team.placement = this.teams.length;
    }
    this.setPhase("Combat", tick, 0);
    if (countTeamsInPlay(this.teams) === 0) this.end("aborted", null, tick);
  }

  private stepZoneSchedule(tick: number): void {
    const spec = this.zone;
    const last = this.zonePhases.length > 0 ? this.zonePhases[this.zonePhases.length - 1]! : null;
    const index = this.zonePhases.length + 1;
    if (index > spec.phases.length) return;
    const announceTick = last ? last.shrinkEndTick : this.combatStartTick + this.ticks(spec.firstAnnounceSeconds);
    if (tick < announceTick) return;
    const phase = quantizeZonePhase(computeZonePhase(spec, this.zoneSeed, index, last, this.combatStartTick, this.o.timeScale, this.host.isValidZoneCenter));
    this.zonePhases.push(phase);
    const w = this.writer;
    w.reset();
    encodeZonePhase(w, phase);
    this.broadcast(w.bytes());
  }

  private end(reason: NonNullable<BrLifecycle["endReason"]>, winner: number | null, tick: number): void {
    if (this.phase === "End") return;
    this.endReason = reason;
    this.winnerTeam = winner;
    this.endedTick = tick;
    const combat = this.host.combat;
    combat.damageEnabled = false;
    combat.respawnEnabled = false;
    const linger = reason === "cancelled" || reason === "aborted" ? 0 : secondsToTicks(this.o.endLingerSeconds);
    this.setPhase("End", tick, tick + linger);
    this.writeMatchEnd();
    this.broadcast(this.writer.bytes());
    if (!this.resultSent) {
      this.resultSent = true;
      this.host.result(this.buildResult());
    }
  }

  private close(): void {
    this.closed = true;
    this.host.close();
  }

  private setPhase(phase: GameplayPhaseName, tick: number, endTick: number): void {
    this.phase = phase;
    this.phaseStartTick = tick;
    this.phaseEndTick = endTick;
    this.broadcastPhase();
    const lifecycle: MatchPhase = phase === "End" ? (this.endReason === "cancelled" ? "Cancelled" : "Ended") : phase;
    this.host.lifecyclePhase(lifecycle);
  }

  // ---- Wire -----------------------------------------------------------------------------------------------------------

  private broadcastPhase(): void {
    this.writePhaseChange();
    this.broadcast(this.writer.bytes());
  }

  private writePhaseChange(): void {
    let teamsAlive = 0;
    let playersAlive = 0;
    if (this.combatStartTick >= 0) {
      teamsAlive = countTeamsInPlay(this.teams);
      for (const p of this.host.players) if (p.life !== "dead") playersAlive++;
    } else {
      let mask = 0;
      for (const p of this.host.players) {
        playersAlive++;
        mask |= 1 << p.teamId;
      }
      for (; mask !== 0; mask &= mask - 1) teamsAlive++;
    }
    const w = this.writer;
    w.reset();
    encodePhaseChange(w, { phase: PHASE_CODE[this.phase], startTick: this.phaseStartTick, endTick: this.phaseEndTick, teamsAlive, playersAlive });
  }

  private writeMatchEnd(): void {
    const players: MatchEndPlayer[] = [];
    for (const p of this.host.players) {
      players.push({
        slot: p.slot,
        teamId: p.teamId,
        placement: this.placementOf(p.teamId),
        bot: isBotAccountId(p.accountId),
        kills: p.combat.kills,
        knocks: p.combat.knocks,
        revives: p.combat.revives,
        damageDealt: p.combat.damageDealt,
        survivedSec: Math.floor(this.survivedMs(p) / 1000),
      });
    }
    const w = this.writer;
    w.reset();
    encodeMatchEnd(w, { serverTick: this.endedTick >= 0 ? this.endedTick : this.tickNow, reason: END_REASON[this.endReason ?? "aborted"]!, winningTeam: this.winnerTeam ?? -1, players });
  }

  private broadcast(bytes: Uint8Array): void {
    const players = this.host.players;
    for (let i = 0; i < players.length; i++) players[i]!.session?.sendStream(bytes);
  }

  // ---- Results --------------------------------------------------------------------------------------------------------

  /** `MatchResult` for server-api: every rostered account (bots flagged) plus any unrostered player that joined. */
  buildResult(): MatchResult {
    const config = this.host.config;
    const byAccount = new Map<string, Player>();
    for (const p of this.host.players) byAccount.set(p.accountId, p);
    // Aborted mid-combat: rank the teams still in play like a time cap so every player has a place.
    if (this.endReason === "aborted" && this.combatStartTick >= 0 && this.teams.some((t) => t.placement === null)) {
      refreshTeamCounts(this.teams, this.host.slots);
      resolveTimeCap(this.teams, this.host.slots, this.endedTick, []);
    }
    const players: PlayerResult[] = [];
    const push = (accountId: string, teamId: number, p: Player | undefined): void => {
      players.push({
        accountId,
        teamId,
        bot: isBotAccountId(accountId),
        placement: this.placementOf(teamId),
        kills: p?.combat.kills ?? 0,
        knocks: p?.combat.knocks ?? 0,
        revives: p?.combat.revives ?? 0,
        damageDealt: p?.combat.damageDealt ?? 0,
        survivedMs: p ? this.survivedMs(p) : 0,
      });
    };
    const listed = new Set<string>();
    for (const team of config.teams) {
      for (const id of team.accountIds) {
        listed.add(id);
        push(id, team.teamId, byAccount.get(id));
      }
    }
    for (const p of this.host.players) if (!listed.has(p.accountId)) push(p.accountId, p.teamId, p);
    const endedAt = this.nowEpochMs();
    const outcome = this.endReason === "cancelled" ? "cancelled" : this.endReason === "aborted" ? "aborted" : "completed";
    return {
      matchId: config.matchId,
      protocolVersion: config.protocolVersion,
      contentHash: config.contentHash,
      outcome,
      startedAt: this.combatStartTick >= 0 ? this.combatStartedAtEpochMs : this.allocatedAtEpochMs,
      endedAt,
      winningTeamId: outcome === "completed" ? this.winnerTeam : null,
      players,
    };
  }

  private placementOf(teamId: number): number {
    if (this.combatStartTick < 0) return 0;
    return this.teams[teamId]?.placement ?? 0;
  }

  private survivedMs(p: Player): number {
    if (this.combatStartTick < 0) return 0;
    const last = p.deathTick >= 0 ? p.deathTick : this.endedTick >= 0 ? this.endedTick : this.tickNow;
    return Math.max(0, Math.round(((last - this.combatStartTick) * 1000) / SIMULATION.tickRate));
  }

  private winnerOf(): number | null {
    for (const t of this.teams) if (t.placement === 1) return t.team;
    return null;
  }

  private connectedHumans(): number {
    let n = 0;
    for (const p of this.host.players) if (p.session !== null && !isBotAccountId(p.accountId)) n++;
    return n;
  }

  private allHumansConnected(): boolean {
    const players = this.host.players;
    if (this.rosterHumans.length === 0) {
      if (players.length < this.host.slots.length) return false;
      for (const p of players) if (p.session === null) return false;
      return true;
    }
    for (const id of this.rosterHumans) {
      let found = false;
      for (const p of players) if (p.accountId === id && p.session !== null) found = true;
      if (!found) return false;
    }
    return true;
  }
}
