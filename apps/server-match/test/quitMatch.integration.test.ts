import { DisconnectReason, MatchCommandCode, MatchCommandStatus, MatchEndReason, PhaseCode } from "@twobullets/protocol";
import type { ZoneSpec } from "@twobullets/shared/match/types";
import type { HavokModule } from "@twobullets/sim";
import { loadHavok } from "@twobullets/sim/node/loadHavok";
import { beforeAll, describe, expect, it } from "vitest";
import type { HeadlessClient } from "../src/dev/HeadlessClient";
import { createHarness, type Harness } from "./harness";

// Quitting a match (protocol v8): leave alone, the host ending it for everyone, a non-host being refused, the host
// leaving and the right passing on, and the races (two quits at once, ending twice). Virtual clock, memory sessions.

let havok: HavokModule;

beforeAll(async () => {
  havok = await loadHavok();
});

/** Slow enough that nothing ends by itself during a test. */
const CALM_ZONE: ZoneSpec = {
  initial: { cx: 0, cz: 0, r: 60 },
  phases: [{ waitSeconds: 60, shrinkSeconds: 60, radius: 40, dps: 1 }],
  firstAnnounceSeconds: 60,
  damageIntervalTicks: 6,
  edgeMargin: 4,
};

const stand = (c: HeadlessClient): void => {
  c.script = (_tick, e) => {
    e.forward = 0;
    e.right = 0;
    e.buttons = 0;
  };
};

function runUntil(h: Harness, done: () => boolean, maxMs: number): boolean {
  for (let t = 0; t < maxMs; t += 10) {
    if (done()) return true;
    h.run(10);
  }
  return done();
}

interface Party {
  readonly h: Harness;
  readonly clients: Record<"a0" | "a1" | "b0" | "b1", HeadlessClient>;
}

/** 4-player duo match, `a0` is the lobby host, everyone connected. `combat`: run on until the combat phase. */
async function party(options: { host?: string | null; combat?: boolean } = {}): Promise<Party> {
  const host = options.host === undefined ? "a0" : options.host;
  const h = await createHarness(havok, {
    maxPlayers: 4,
    teamMode: "duo",
    configure: (c) => ({
      ...c,
      teams: [
        { teamId: 0, accountIds: ["a0", "a1"] },
        { teamId: 1, accountIds: ["b0", "b1"] },
      ],
      rules: { ...c.rules, fillWithBots: false },
      ...(host ? { hostAccountId: host } : {}),
    }),
    lifecycle: { warmupSeconds: 30, allJoinedSeconds: 0.5, endLingerSeconds: 0.5, zone: CALM_ZONE, zoneSalt: 7, nowEpochMs: () => 1_800_000_000_000 },
  });
  const ids = ["a0", "a1", "b0", "b1"] as const;
  const list = ids.map((sub, i) => h.connect({ token: h.token({ sub, team: i < 2 ? 0 : 1 }) }));
  list.forEach(stand);
  h.run(200);
  const clients = { a0: list[0]!, a1: list[1]!, b0: list[2]!, b1: list[3]! };
  if (options.combat !== false) expect(runUntil(h, () => h.match.lifecycle!.phase === "Combat", 3000)).toBe(true);
  h.run(100);
  return { h, clients };
}

describe("quitting a match (v8)", () => {
  it("leave alone: the quitter is eliminated and disconnected, the match runs on for everyone else", async () => {
    const { h, clients } = await party();
    const slot = clients.a1.playerSlot;
    expect(h.match.player(slot)!.accountId).toBe("a1");

    clients.a1.leaveMatch();
    h.run(200);

    expect(clients.a1.commandResults).toEqual([{ command: MatchCommandCode.leave, status: MatchCommandStatus.ok, detail: 0 }]);
    expect(clients.a1.disconnect?.reason).toBe(DisconnectReason.clientLeave);
    // After warmup the slot stays in the match as an elimination, so placements and team wipes stay honest.
    expect(h.match.player(slot)!.life).toBe("dead");
    expect(h.match.player(slot)!.session).toBeNull();
    expect(h.match.lifecycle!.phase).toBe("Combat");
    for (const c of [clients.a0, clients.b0, clients.b1]) {
      expect(c.disconnect).toBeNull();
      expect(c.matchEnd).toBeNull();
      expect(c.phase!.phase).toBe(PhaseCode.Combat);
    }
    // The others see the roster without a connected a1.
    expect(clients.a0.roster!.players.find((p) => p.slot === slot)!.connected).toBe(false);
    await h.dispose();
  });

  it("leaving during warmup frees the slot instead of eliminating the player", async () => {
    const { h, clients } = await party({ combat: false });
    expect(h.match.lifecycle!.phase).toBe("Warmup");
    const slot = clients.b1.playerSlot;
    const before = h.match.playerCount;

    clients.b1.leaveMatch();
    h.run(100);

    expect(clients.b1.commandResults[0]!.status).toBe(MatchCommandStatus.ok);
    expect(h.match.player(slot)).toBeNull();
    expect(h.match.playerCount).toBe(before - 1);
    expect(h.match.lifecycle!.phase).toBe("Warmup");
    await h.dispose();
  });

  it("the host ends it for everyone: MatchEnd(hostEnded) to all, a completed result with placements, then the match closes", async () => {
    const { h, clients } = await party();
    expect(clients.a0.isHost).toBe(true);
    expect(clients.b0.isHost).toBe(false);

    clients.a0.endMatchForAll();
    h.run(100);

    expect(clients.a0.commandResults).toEqual([{ command: MatchCommandCode.endForAll, status: MatchCommandStatus.ok, detail: 0 }]);
    for (const c of [clients.a0, clients.a1, clients.b0, clients.b1]) {
      expect(c.matchEnd, `slot ${c.playerSlot}`).not.toBeNull();
      expect(c.matchEnd!.reason).toBe(MatchEndReason.hostEnded);
      expect(c.matchEnd!.players).toHaveLength(4);
      // Everyone still in play is ranked, like a time cap.
      expect(c.matchEnd!.players.every((p) => p.placement > 0)).toBe(true);
    }
    expect(h.results).toHaveLength(1);
    expect(h.results[0]).toMatchObject({ outcome: "completed", matchId: "local" });
    expect(h.results[0]!.players.map((p) => p.accountId).sort()).toEqual(["a0", "a1", "b0", "b1"]);
    expect(h.lifecyclePhases.at(-1)).toBe("Ended");

    // The end linger runs out, then the match closes: sessions gone, world disposed, the process can exit.
    expect(runUntil(h, () => h.closed.value, 3000)).toBe(true);
    h.run(100);
    expect(h.match.isClosed).toBe(true);
    for (const c of [clients.a0, clients.b1]) expect(c.disconnect?.reason).toBe(DisconnectReason.matchEnded);
    await h.dispose();
  });

  it("a non-host is refused and the match keeps running; unknown command codes are answered too", async () => {
    const { h, clients } = await party();

    clients.b0.endMatchForAll();
    clients.b0.sendMatchCommand(250);
    h.run(100);

    expect(clients.b0.commandResults).toEqual([
      { command: MatchCommandCode.endForAll, status: MatchCommandStatus.denied, detail: 0 },
      { command: 250, status: MatchCommandStatus.unknown, detail: 0 },
    ]);
    expect(h.match.lifecycle!.phase).toBe("Combat");
    expect(h.results).toHaveLength(0);
    for (const c of [clients.a0, clients.b0]) expect(c.matchEnd).toBeNull();
    await h.dispose();
  });

  it("nobody can end a match with no host (quick play): every request is denied", async () => {
    const { h, clients } = await party({ host: null });

    expect(h.match.hostAccountId).toBeNull();
    for (const c of [clients.a0, clients.b1]) expect(c.isHost).toBe(false);
    clients.a0.endMatchForAll();
    h.run(100);

    expect(clients.a0.commandResults.at(-1)!.status).toBe(MatchCommandStatus.denied);
    expect(h.match.isClosed).toBe(false);
    expect(h.match.lifecycle!.phase).toBe("Combat");
    await h.dispose();
  });

  it("the host leaving passes the right on: the lowest connected human can then end it", async () => {
    const { h, clients } = await party();

    clients.a0.leaveMatch();
    h.run(200);

    expect(clients.a1.roster!.players.find((p) => p.host)?.slot).toBe(clients.a1.playerSlot);
    expect(clients.a1.isHost).toBe(true);
    expect(h.match.hostAccountId).toBe("a1");

    clients.b0.endMatchForAll();
    h.run(50);
    expect(clients.b0.commandResults.at(-1)!.status).toBe(MatchCommandStatus.denied);

    clients.a1.endMatchForAll();
    h.run(100);
    expect(clients.a1.commandResults.at(-1)).toMatchObject({ status: MatchCommandStatus.ok });
    expect(clients.b1.matchEnd?.reason).toBe(MatchEndReason.hostEnded);
    expect(h.results).toHaveLength(1);
    await h.dispose();
  });

  it("races: two players quitting in the same turn, and ending a match that is already ending", async () => {
    const { h, clients } = await party();

    clients.b0.leaveMatch();
    clients.b1.leaveMatch();
    h.run(200);
    // Team 1 wiped itself: the match ends on the normal rule, with team 0 first.
    expect(h.match.player(clients.b0.playerSlot)!.life).toBe("dead");
    expect(h.match.player(clients.b1.playerSlot)!.life).toBe("dead");
    expect(clients.a0.matchEnd?.reason).toBe(MatchEndReason.lastTeam);

    // The host asking now is too late; one result only, and it is the one the rules produced.
    clients.a0.endMatchForAll();
    h.run(50);
    expect(clients.a0.commandResults.at(-1)).toMatchObject({ command: MatchCommandCode.endForAll, status: MatchCommandStatus.unavailable });
    expect(h.results).toHaveLength(1);
    expect(h.results[0]!.outcome).toBe("completed");
    await h.dispose();
  });
});
