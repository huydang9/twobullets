import { LinkConditioner } from "@twobullets/netcode/testing/LinkConditioner";
import { createMemorySessionPair } from "@twobullets/netcode/testing/memorySession";
import { NETWORK_PROFILES } from "@twobullets/netcode/testing/profiles";
import { MatchEndReason } from "@twobullets/protocol/messages/match";
import type { PlayerInput } from "@twobullets/shared/input";
import { PlayerInputRing } from "@twobullets/shared/inputRing";
import type { LifeState } from "@twobullets/shared/equipment/vitals";
import type { MatchEvent } from "@twobullets/shared/match/types";
import { createZoneState, zoneAtInto } from "@twobullets/shared/match/zone";
import { createMoveState } from "@twobullets/shared/movement/movement";
import type { MoveState, Vec3 } from "@twobullets/shared/movement/types";
import type { WeaponState } from "@twobullets/shared/weapons/types";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { describe, expect, it } from "vitest";
import { LocalPlayerNet, type PredictedBody } from "../../src/net/LocalPlayerNet";
import { NetClient } from "../../src/net/NetClient";
import { NetClock, WT_BUFFER_TICKS } from "../../src/net/NetClock";
import { NetCombat, type CombatFeedback } from "../../src/net/NetCombat";
import { NetMatchView } from "../../src/net/NetMatchView";
import { RemoteRoster } from "../../src/net/RemoteRoster";
import { resolveServerLevel } from "../../../server-match/src/level/serverLevel";
import { createHarness } from "../../../server-match/test/harness";

// The real NetClient + NetMatchView against an in-process server-match running the battle royale flow on Map v1 with
// server bots (virtual clock, scaled zone): Welcome → Roster → warmup countdown → combat → zone phases → MatchEnd, and
// the adapter's state at each step matches the server's lifecycle.

const FRAME_MS = 16;

/** The local player standing still: prediction mirrors the last server state (no physics needed). */
class StandingBody implements PredictedBody {
  readonly tickFeet: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  moveState: MoveState = createMoveState();
  readonly weaponState: WeaponState | null = null;
  restoreMove(feet: Vec3, state: MoveState): void {
    this.tickFeet.x = feet.x;
    this.tickFeet.y = feet.y;
    this.tickFeet.z = feet.z;
    this.moveState = state;
  }
  restoreWeapon(): void {}
  replayTick(): MoveState {
    return this.moveState;
  }
  setRenderOffset(): void {}
}

class FeedToView implements CombatFeedback {
  life: LifeState = "alive";
  private readonly view: NetMatchView;
  constructor(view: NetMatchView) {
    this.view = view;
  }
  remoteShot(): void {}
  remoteHit(): void {}
  hitConfirm(): void {}
  damageTaken(): void {}
  kill(): void {}
  killFeed(event: MatchEvent): void {
    this.view.onKillFeed(event);
  }
  vitals(vitals: { life: LifeState }): void {
    this.life = vitals.life;
  }
}

describe("networked battle royale presentation (client ↔ in-process server-match, Map v1, bots)", () => {
  it("drives NetMatchView from Welcome to MatchEnd with the server's phases, roster, zone and results", async () => {
    const havok = await loadHavok();
    const level = await resolveServerLevel("v1");
    const h = await createHarness(havok, {
      level,
      maxPlayers: 4,
      teamMode: "duo",
      configure: (c) => ({ ...c, mapId: "v1", teams: [{ teamId: 0, accountIds: ["human", "bot:0"] }, { teamId: 1, accountIds: ["bot:1", "bot:2"] }], botDifficulty: "easy" }),
      lifecycle: { warmupSeconds: 5, allJoinedSeconds: 1.5, timeScale: 0.05, endLingerSeconds: 1, zoneSalt: 9 },
    });
    const lifecycle = h.match.lifecycle!;

    const [clientEnd, serverEnd] = createMemorySessionPair({ clock: h.clock, kind: "webtransport", maxDatagramSize: 1200 });
    const link = new LinkConditioner(clientEnd, NETWORK_PROFILES.lan, h.clock, 7);
    h.links.push(link);
    h.acceptRaw(serverEnd);

    const view = new NetMatchView({ mapId: "v1", botName: (n) => `Bot ${n + 1}` });
    const feedback = new FeedToView(view);
    const combat = new NetCombat(feedback);
    const roster = new RemoteRoster();
    const netClock = new NetClock({ bufferTicks: WT_BUFFER_TICKS });
    const ring = new PlayerInputRing();
    const body = new StandingBody();
    const local = new LocalPlayerNet(body);
    const movement = { life: 0 };
    const client = new NetClient(link, {
      clock: h.clock,
      netClock,
      local,
      inputs: ring,
      roster,
      joinToken: h.token({ sub: "human", team: 0, nick: "Huy Đặng" }),
      events: combat,
      movement,
    });
    client.start();

    const events: MatchEvent[] = [];
    view.onEvent((e) => events.push(e));
    const phases: string[] = [];
    let sawCountdown = false;
    let combatCounts: [number, number] | null = null;
    let zoneChecks = 0;
    const serverZone = createZoneState(level.zone);
    const input: { -readonly [K in keyof PlayerInput]: PlayerInput[K] } = { tick: 0, forward: 0, right: 0, buttons: 0, select: 0, yawQ: 0, pitchQ: 0, viewOffset8: 0, action: null };

    const frame = (): void => {
      client.update(FRAME_MS / 1000);
      for (let n = netClock.advance(FRAME_MS / 1000); n > 0; n--) {
        input.tick = netClock.nextTick();
        client.onPredictedTick(ring.push(input));
      }
      view.sync(client);
      const now = h.clock.now();
      const tick = client.sync.sampleCount > 0 ? client.sync.serverTickAt(now) : -1;
      const feet = body.tickFeet;
      view.update(tick, roster, view.ownSlot >= 0 ? { x: feet.x, y: feet.y, z: feet.z, yaw: 0, life: combat.vitalsState.life, health: combat.vitalsState.health, downedHealth: 0, reviveSeconds: 0 } : null);
      const state = view.state;
      if (phases.at(-1) !== state.phase) phases.push(state.phase);
      if (state.phase === "warmup" && state.phaseEndTick > state.tick && tick >= 0) sawCountdown = true;
      if (state.phase === "combat" && combatCounts === null && view.hasRoster) combatCounts = [state.actorsInPlay, state.teamsInPlay];
      // The client's circle equals the server's zone at the same tick.
      if (state.phase === "combat" && state.zonePhases.length > 0 && zoneChecks < 50 && state.tick % 97 === 0) {
        zoneAtInto(level.zone, lifecycle.zonePhases, state.tick, serverZone);
        expect(state.zone.current.r).toBeCloseTo(serverZone.current.r, 1);
        expect(state.zone.current.cx).toBeCloseTo(serverZone.current.cx, 1);
        expect(state.zone.stage).toBe(serverZone.stage);
        zoneChecks++;
      }
    };

    let guard = 0;
    while (!view.ended && guard++ < 10_000) {
      h.run(FRAME_MS, 4);
      frame();
    }
    h.run(100, 4);
    frame();

    // Welcome and Roster.
    expect(view.config).toMatchObject({ maxPlayers: 4, teamSize: 2, teamCount: 2, mapId: "v1" });
    expect(view.ownSlot).toBe(0);
    expect(view.state.actors.map((a) => a?.name)).toEqual(["Huy Đặng", "Bot 1", "Bot 2", "Bot 3"]);
    expect(view.state.actors.map((a) => a?.kind)).toEqual(["human", "bot", "bot", "bot"]);

    // Phases: warmup with a countdown, combat with the server's counters, then the end.
    expect(phases[0]).toBe("warmup");
    expect(phases).toContain("combat");
    expect(phases.at(-1)).toBe("ended");
    expect(phases.indexOf("combat")).toBeLessThan(phases.indexOf("ended"));
    expect(sawCountdown).toBe(true);
    expect(combatCounts).toEqual([4, 2]);
    expect(view.state.combatStartTick).toBe(lifecycle.combatStartTick);

    // Zone: announced, measured time scale, circles in step with the server.
    expect(lifecycle.zonePhases.length).toBeGreaterThan(0);
    expect(view.state.zonePhases.length).toBe(lifecycle.zonePhases.length);
    expect(events.filter((e) => e.type === "zoneAnnounced").length).toBe(lifecycle.zonePhases.length);
    expect(view.config.timeScale).toBeCloseTo(0.05, 3);
    expect(zoneChecks).toBeGreaterThan(0);

    // MatchEnd and results.
    const end = view.matchEnd!;
    expect(end).not.toBeNull();
    expect([MatchEndReason.lastTeam, MatchEndReason.allDead, MatchEndReason.timeCap]).toContain(end.reason);
    expect(end.players).toHaveLength(4);
    expect(end.players.filter((p) => p.bot)).toHaveLength(3);
    expect(view.state.winnerTeam).toBe(lifecycle.winnerTeam);
    expect(view.state.endReason).toBe(lifecycle.endReason);
    const winner = view.state.teams.find((t) => t.placement === 1);
    expect(winner?.team ?? null).toBe(lifecycle.winnerTeam);
    expect(h.results).toHaveLength(1);
    const kills = events.filter((e) => e.type === "kill").length;
    console.info(`[net br] phases ${phases.join(" → ")}; zone phases ${lifecycle.zonePhases.length}, checks ${zoneChecks}; kill feed kills ${kills}; end ${view.state.endReason} winner ${view.state.winnerTeam}`);
    client.disconnect();
    await h.dispose();
  }, 240_000);
});
