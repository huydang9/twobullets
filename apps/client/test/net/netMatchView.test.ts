import { LifeCode } from "@twobullets/protocol/codes";
import { PhaseCode, type Welcome } from "@twobullets/protocol/messages/control";
import { MatchEndReason, type MatchEnd, type PhaseChange, type ZonePhaseMessage } from "@twobullets/protocol/messages/match";
import type { Roster } from "@twobullets/protocol/messages/roster";
import { RemoteFlags } from "@twobullets/protocol/quantize";
import { MAP_V1 } from "@twobullets/shared/map/mapV1";
import { MAZE_BR } from "@twobullets/shared/map/mazeBr";
import type { MatchEvent } from "@twobullets/shared/match/types";
import { DEFAULT_ZONE_SPEC, zoneCenterBiasForPois, zoneSpecForHalfExtent } from "@twobullets/shared/match/zone";
import { describe, expect, it } from "vitest";
import { createNetTeammateVitals, NetMatchView, type NetMatchSource, type NetOwnState, type NetPoseSource, type NetTeammateVitals } from "../../src/net/NetMatchView";

// NetMatchView turns the BR control messages into the offline MatchView the match HUD, map and screens read.

const TICK_RATE = 60;

function welcome(overrides: Partial<Welcome> = {}): Welcome {
  return {
    playerSlot: 0,
    teamId: 0,
    teamSize: 2,
    maxPlayers: 6,
    serverTick: 100,
    tickRate: 60,
    snapshotRate: 30,
    matchSeed: 77,
    phase: PhaseCode.Warmup,
    phaseEndTick: 0,
    maxRewindMs: 200,
    interpFloorMs: 50,
    resumeToken: new Uint8Array(16),
    contentHash: 0,
    flags: 0,
    ...overrides,
  };
}

const roster: Roster = {
  players: [
    { slot: 0, team: 0, name: "Huy", isBot: false, botIndex: -1, connected: true, host: true },
    { slot: 1, team: 0, name: "", isBot: true, botIndex: 0, connected: true, host: false },
    { slot: 2, team: 1, name: "Lan 99", isBot: false, botIndex: -1, connected: true, host: false },
    { slot: 3, team: 1, name: "", isBot: true, botIndex: 1, connected: true, host: false },
    { slot: 4, team: 2, name: "", isBot: true, botIndex: 2, connected: true, host: false },
  ],
};

class Source implements NetMatchSource {
  welcomeInfo: Welcome | null = null;
  matchPhase: PhaseChange | null = null;
  readonly zonePhases: ZonePhaseMessage[] = [];
  matchEnd: MatchEnd | null = null;
  matchRoster: Roster | null = null;
  teammateVitals: NetTeammateVitals | null = null;
}

class Poses implements NetPoseSource {
  readonly visible = new Uint8Array(20);
  readonly poses = Array.from({ length: 20 }, () => ({ x: 0, y: 0, z: 0, yaw: 0, flags: RemoteFlags.grounded }));
  set(slot: number, x: number, z: number, life: number): void {
    this.visible[slot] = 1;
    const pose = this.poses[slot]!;
    pose.x = x;
    pose.z = z;
    pose.flags = RemoteFlags.grounded | (life << 11);
  }
}

const own = (x = 0, z = 0, life: NetOwnState["life"] = "alive"): NetOwnState => ({ x, y: 0, z, yaw: 0, life, health: life === "alive" ? 100 : 0, downedHealth: 0, reviveSeconds: 0 });

function setup() {
  const source = new Source();
  const view = new NetMatchView({ mapId: "v1", botName: (n) => `Bot ${n + 1}` });
  const events: MatchEvent[] = [];
  view.onEvent((e) => events.push(e));
  const poses = new Poses();
  source.welcomeInfo = welcome();
  source.matchRoster = roster;
  view.sync(source);
  return { source, view, events, poses };
}

describe("NetMatchView", () => {
  it("Welcome and Roster: match size, teams, names (bots localized), empty slots absent", () => {
    const { view } = setup();
    expect(view.config).toMatchObject({ teamSize: 2, maxPlayers: 6, teamCount: 3, teamMode: "duo", seed: 77, mapId: "v1" });
    expect([view.ownSlot, view.ownTeam]).toEqual([0, 0]);
    expect(view.state.actors.map((a) => a?.name)).toEqual(["Huy", "Bot 1", "Lan 99", "Bot 2", "Bot 3", undefined]);
    expect(view.state.actors[1]!.kind).toBe("bot");
    expect(view.state.teams.map((t) => t.slots)).toEqual([[0, 1], [2, 3], [4]]);
    expect(view.teamOf(3)).toBe(1);
    expect(view.nameOf(5)).toBe("");
    // v8: the roster says who may end the match for everyone (−1 when nobody can).
    expect(view.hostSlot).toBe(0);
    // No PhaseChange yet (sandbox flow): no waiting banner, counters from the roster.
    view.update(10, new Poses(), own());
    expect(view.waitingForPlayers).toBe(false);
    expect(view.state.phaseStartTick).toBe(-1);
    expect([view.state.actorsInPlay, view.state.teamsInPlay]).toEqual([5, 3]);
  });

  it("PhaseChange: warmup waiting → countdown → combat with the server's counters; lives and counters in combat", () => {
    const { source, view, poses } = setup();
    source.matchPhase = { phase: PhaseCode.Warmup, startTick: 100, endTick: 0, teamsAlive: 3, playersAlive: 5 };
    view.sync(source);
    view.update(150, poses, own());
    expect(view.state.phase).toBe("warmup");
    expect(view.waitingForPlayers).toBe(true);
    expect([view.state.actorsInPlay, view.state.teamsInPlay]).toEqual([5, 3]);

    source.matchPhase = { phase: PhaseCode.Warmup, startTick: 100, endTick: 100 + 45 * TICK_RATE, teamsAlive: 3, playersAlive: 5 };
    view.sync(source);
    view.update(160, poses, own());
    expect(view.waitingForPlayers).toBe(false);
    expect(view.state.phaseEndTick).toBe(100 + 45 * TICK_RATE);

    // Died in warmup (respawns): not counted out once combat starts.
    view.onKillFeed({ type: "kill", tick: 500, killer: 2, victim: 4, cause: "rifle", headshot: false, knockedBy: -1, teamKill: false });
    const combatStart = 3000;
    source.matchPhase = { phase: PhaseCode.Combat, startTick: combatStart, endTick: 0, teamsAlive: 3, playersAlive: 5 };
    view.sync(source);
    view.update(combatStart + 10, poses, own());
    expect(view.state.phase).toBe("combat");
    expect(view.state.combatStartTick).toBe(combatStart);
    expect([view.state.actorsInPlay, view.state.teamsInPlay]).toEqual([5, 3]);

    // Poses: slot 4 respawned; slot 3 knocked then killed through the feed; team 2 wiped.
    poses.set(4, 10, 10, LifeCode.alive);
    poses.set(3, 5, 5, LifeCode.downed);
    view.update(combatStart + 20, poses, own());
    expect(view.state.actors[3]!.life).toBe("downed");
    expect(view.state.actorsInPlay).toBe(5);
    poses.visible[3] = 0;
    view.onKillFeed({ type: "kill", tick: combatStart + 30, killer: 0, victim: 3, cause: "rifle", headshot: true, knockedBy: 0, teamKill: false });
    view.update(combatStart + 31, poses, own());
    expect(view.state.actors[3]!.life).toBe("dead");
    expect(view.state.actors[0]!.kills).toBe(1);
    expect([view.state.actorsInPlay, view.state.teamsInPlay]).toEqual([4, 3]);
    poses.visible[4] = 0;
    const eliminated: MatchEvent[] = [];
    view.onEvent((e) => e.type === "teamEliminated" && eliminated.push(e));
    view.onKillFeed({ type: "kill", tick: combatStart + 40, killer: 2, victim: 4, cause: "zone", headshot: false, knockedBy: -1, teamKill: false });
    view.update(combatStart + 41, poses, own());
    expect([view.state.actorsInPlay, view.state.teamsInPlay]).toEqual([3, 2]);
    expect(eliminated).toEqual([{ type: "teamEliminated", tick: combatStart + 40, team: 2, placement: 3 }]);
    expect(view.state.teams[2]!.placement).toBe(3);
    // Never above a later server count.
    source.matchPhase = { phase: PhaseCode.Combat, startTick: combatStart, endTick: 0, teamsAlive: 2, playersAlive: 2 };
    view.sync(source);
    view.update(combatStart + 50, poses, own());
    expect([view.state.actorsInPlay, view.state.teamsInPlay]).toEqual([2, 2]);
  });

  it("ZonePhase: circles from zoneAtInto on the server tick, time scale measured, announce/warning/shrink events once", () => {
    const { source, view, events, poses } = setup();
    const combatStart = 1000;
    source.matchPhase = { phase: PhaseCode.Combat, startTick: combatStart, endTick: 0, teamsAlive: 3, playersAlive: 5 };
    view.sync(source);
    view.update(combatStart + 1, poses, own());
    expect(view.state.zone.stage).toBe("idle");
    expect(view.config.timeScale).toBe(1);

    // Time scale 0.5: phase 1 announced at combat + 30 s × 0.5, waits 70 s × 0.5, shrinks 40 s × 0.5.
    const wait = combatStart + 15 * TICK_RATE;
    const shrinkStart = wait + 35 * TICK_RATE;
    const shrinkEnd = shrinkStart + 20 * TICK_RATE;
    const phase: ZonePhaseMessage = { index: 1, waitStartTick: wait, shrinkStartTick: shrinkStart, shrinkEndTick: shrinkEnd, from: { cx: 0, cz: 0, r: 355 }, to: { cx: 100, cz: -50, r: 200 }, dps: 1 };
    source.zonePhases.push(phase);
    view.sync(source);
    expect(view.config.timeScale).toBeCloseTo(0.5, 6);
    expect(events.filter((e) => e.type === "zoneAnnounced")).toHaveLength(1);
    // NetClient re-sends phases on rejoin into a new list: no second announcement.
    const rejoined = new Source();
    Object.assign(rejoined, { welcomeInfo: source.welcomeInfo, matchPhase: source.matchPhase, matchRoster: source.matchRoster });
    rejoined.zonePhases.push({ ...phase });
    view.sync(rejoined);
    expect(events.filter((e) => e.type === "zoneAnnounced")).toHaveLength(1);

    view.update(wait + 10, poses, own());
    expect(view.state.zone).toMatchObject({ stage: "waiting", phaseIndex: 1, dps: 1 });
    expect(view.state.zone.next).toEqual(phase.to);

    // Joining with 25 s left: no 30 s warning; the 10 s one fires when crossed, once.
    view.update(shrinkStart - 25 * TICK_RATE, poses, own());
    view.update(shrinkStart - 10 * TICK_RATE - 5, poses, own());
    view.update(shrinkStart - 10 * TICK_RATE + 5, poses, own());
    view.update(shrinkStart - 9 * TICK_RATE, poses, own());
    expect(events.filter((e) => e.type === "zoneWarning")).toEqual([{ type: "zoneWarning", tick: shrinkStart - 10 * TICK_RATE + 5, phaseIndex: 1, secondsLeft: 10 }]);

    view.update(shrinkStart + (shrinkEnd - shrinkStart) / 2, poses, own());
    expect(view.state.zone.stage).toBe("shrinking");
    expect(view.state.zone.current.r).toBeCloseTo(277.5, 3);
    expect(view.state.zone.current.cx).toBeCloseTo(50, 3);
    expect(events.filter((e) => e.type === "zoneShrinkStarted")).toHaveLength(1);
    view.update(shrinkEnd + 1, poses, own());
    expect(view.state.zone.stage).toBe("waiting");
    expect(view.state.zone.current).toEqual({ cx: 100, cz: -50, r: 200 });
  });

  it("sizes the zone from the map the server loaded, not from the map id", () => {
    // Without a map there is no playable square to scale to: the arena keeps its own circle, anything else Map v1's.
    expect(new NetMatchView({ mapId: "arena" }).state.zone.current.r).toBe(60);
    expect(new NetMatchView({ mapId: "vn-hangxanh" }).state.zone.current.r).toBe(355);

    // ±250 m maps come out on DEFAULT_ZONE_SPEC untouched — the same object, so Map v1 and the real maps cannot move.
    expect(new NetMatchView({ mapId: "v1", map: MAP_V1 }).config.zone).toBe(DEFAULT_ZONE_SPEC);

    // The maze is ±92 m, where DEFAULT's 355 m opening circle would be four times the map. Same call the server's own
    // level makes (apps/server-match/src/level/serverLevel.ts), so both sides schedule the same circles.
    const maze = new NetMatchView({ mapId: MAZE_BR.id, map: MAZE_BR });
    expect(maze.config.zone).toEqual(zoneSpecForHalfExtent(MAZE_BR.terrain.playableHalfExtent, undefined, { centerBias: zoneCenterBiasForPois(MAZE_BR.pois) }));
    expect(maze.state.zone.current.r).toBe(130.64); // 355 × 92 / 250, still 1.42 × the half extent
    expect(maze.config.zone.playableHalfExtent).toBe(92);
  });

  it("MatchEnd: ended phase, winner, reason, placements and stats from the server; cancelled keeps a null reason", () => {
    const { source, view, poses } = setup();
    source.matchPhase = { phase: PhaseCode.Combat, startTick: 1000, endTick: 0, teamsAlive: 2, playersAlive: 4 };
    view.sync(source);
    view.addOwnDamage(42);
    view.update(1100, poses, own());
    expect(view.state.actors[0]!.damageDealt).toBe(42);
    const players = [
      { slot: 0, teamId: 0, placement: 1, bot: false, kills: 3, knocks: 2, revives: 1, damageDealt: 310, survivedSec: 400 },
      { slot: 1, teamId: 0, placement: 1, bot: true, kills: 1, knocks: 0, revives: 0, damageDealt: 90, survivedSec: 300 },
      { slot: 2, teamId: 1, placement: 2, bot: false, kills: 0, knocks: 1, revives: 0, damageDealt: 40, survivedSec: 200 },
    ];
    source.matchEnd = { serverTick: 30000, reason: MatchEndReason.lastTeam, winningTeam: 0, players };
    view.sync(source);
    expect(view.ended).toBe(true);
    expect(view.state).toMatchObject({ phase: "ended", winnerTeam: 0, endReason: "lastTeam" });
    expect(view.state.actors[0]).toMatchObject({ kills: 3, knocks: 2, damageDealt: 310 });
    expect(view.state.teams[0]).toMatchObject({ placement: 1, kills: 4 });
    expect(view.state.teams[1]!.placement).toBe(2);
    // A late PhaseChange(End) keeps the ended state.
    source.matchPhase = { phase: PhaseCode.End, startTick: 30000, endTick: 30480, teamsAlive: 1, playersAlive: 2 };
    view.sync(source);
    expect(view.state.phase).toBe("ended");

    const cancelled = setup();
    cancelled.source.matchEnd = { serverTick: 500, reason: MatchEndReason.cancelled, winningTeam: -1, players: [] };
    cancelled.view.sync(cancelled.source);
    expect(cancelled.view.state).toMatchObject({ phase: "ended", winnerTeam: null, endReason: null });
    expect(cancelled.view.matchEnd!.reason).toBe(MatchEndReason.cancelled);
  });

  it("kill feed: events reach listeners in order, knocks down, own death remembered, own state from vitals", () => {
    const { view, events, poses } = setup();
    const knock: MatchEvent = { type: "knock", tick: 10, attacker: 2, victim: 0, cause: "pistol", headshot: false };
    const kill: MatchEvent = { type: "kill", tick: 20, killer: 2, victim: 0, cause: "pistol", headshot: false, knockedBy: 2, teamKill: false };
    view.onKillFeed(knock);
    expect(view.state.actors[0]!.life).toBe("downed");
    expect(view.state.actors[2]!.knocks).toBe(1);
    view.onKillFeed(kill);
    expect(view.lastOwnKill).toBe(kill);
    expect(events.slice(-2)).toEqual([knock, kill]);
    view.update(30, poses, own(12, -7, "dead"));
    expect(view.state.actors[0]).toMatchObject({ life: "dead", feet: { x: 12, y: 0, z: -7 }, deathTick: 20 });
  });

  it("teammate vitals: real health, downed pool and revive progress on the teammate; enemies stay full; the local revive", () => {
    const { source, view, poses } = setup();
    const mates = createNetTeammateVitals();
    source.teammateVitals = mates;
    view.sync(source);
    poses.set(1, 3, 4, LifeCode.alive);
    poses.set(2, 9, 9, LifeCode.alive);
    view.update(100, poses, own());
    // No group yet: pose flags, full bar.
    expect(view.state.actors[1]).toMatchObject({ life: "alive", health: 100 });

    mates.tick[1] = 95;
    mates.life[1] = LifeCode.alive;
    mates.health[1] = 43;
    view.update(101, poses, own());
    expect(view.state.actors[1]).toMatchObject({ life: "alive", health: 43, downedHealth: 0, reviverSlot: -1, feet: { x: 3, z: 4 } });
    expect(view.reviveTargetSlot).toBe(-1);

    // Knocked (newer than the pose flags), someone else reviving.
    mates.life[1] = LifeCode.downed;
    mates.health[1] = 0;
    mates.downedHealth[1] = 71;
    mates.reviveQ[1] = 21;
    view.update(102, poses, own());
    const knocked = view.state.actors[1]!;
    expect(knocked).toMatchObject({ life: "downed", health: 0, downedHealth: 71, reviverSlot: 1 });
    expect(knocked.reviveProgress).toBeCloseTo((21 / 63) * 5, 5);
    expect(view.reviveTargetSlot).toBe(-1);

    // The local player is the reviver.
    mates.reviverIsMe[1] = 1;
    mates.reviveQ[1] = 63;
    view.update(103, poses, own());
    expect(view.state.actors[1]!.reviverSlot).toBe(0);
    expect(view.reviveTargetSlot).toBe(1);
    expect(view.reviveProgress).toBeCloseTo(1, 5);

    // A slot that isn't on our team never takes group values (and enemies' health isn't sent at all).
    mates.tick[2] = 95;
    mates.health[2] = 12;
    view.update(104, poses, own());
    expect(view.state.actors[2]).toMatchObject({ life: "alive", health: 100 });

    // A kill feed line newer than the group keeps the teammate dead.
    view.onKillFeed({ type: "kill", tick: 120, killer: 2, victim: 1, cause: "pistol", headshot: false, knockedBy: 2, teamKill: false });
    view.update(121, poses, own());
    expect(view.state.actors[1]).toMatchObject({ life: "dead", health: 0, deathTick: 120 });
  });
});
