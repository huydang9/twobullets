import { ManualClock } from "@twobullets/netcode/testing/clock";
import { createMemorySessionPair, type MemorySession } from "@twobullets/netcode/testing/memorySession";
import { createBitWriter } from "@twobullets/protocol/bits";
import { DisconnectReason, encodeDisconnect } from "@twobullets/protocol/messages/control";
import { encodeMatchEnd, MatchEndReason } from "@twobullets/protocol/messages/match";
import { PlayerInputRing } from "@twobullets/shared/inputRing";
import { createMoveState } from "@twobullets/shared/movement/movement";
import type { MoveState, Vec3 } from "@twobullets/shared/movement/types";
import { describe, expect, it } from "vitest";
import { LocalPlayerNet, type PredictedBody } from "../../src/net/LocalPlayerNet";
import { NetClient } from "../../src/net/NetClient";
import { NetClock, WS_BUFFER_TICKS } from "../../src/net/NetClock";
import { RemoteRoster } from "../../src/net/RemoteRoster";
import { connectionBannerText } from "../../src/ui/NetDebugHud";

// "After ending a game: lost connection". Ending a match (MatchEnd, then Disconnect{matchEnded} or the match process
// exiting under the socket) and quitting on purpose are the normal end, so the connection banner stays hidden; a drop in
// the middle of a match still shows it.

class StandingBody implements PredictedBody {
  readonly tickFeet = { x: 0, y: 0, z: 0 };
  moveState: MoveState = createMoveState();
  readonly weaponState = null;
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

const CLOSE_ABNORMAL = 1006;

function setup(): { client: NetClient; server: MemorySession; send: (encode: (w: ReturnType<typeof createBitWriter>) => void) => void } {
  const clock = new ManualClock(1000);
  const [clientEnd, server] = createMemorySessionPair({ clock, kind: "websocket" });
  const client = new NetClient(clientEnd, {
    clock,
    netClock: new NetClock({ bufferTicks: WS_BUFFER_TICKS }),
    local: new LocalPlayerNet(new StandingBody()),
    inputs: new PlayerInputRing(),
    roster: new RemoteRoster(),
    joinToken: "token",
  });
  client.start();
  const w = createBitWriter(1500);
  const send = (encode: (w: ReturnType<typeof createBitWriter>) => void): void => {
    w.reset();
    encode(w);
    server.sendStream(w.bytes());
  };
  return { client, server, send };
}

const matchEnd = (w: ReturnType<typeof createBitWriter>): void =>
  encodeMatchEnd(w, { serverTick: 5000, reason: MatchEndReason.hostEnded, winningTeam: 0, players: [{ slot: 0, teamId: 0, placement: 1, bot: false, kills: 2, knocks: 1, revives: 0, damageDealt: 180, survivedSec: 300 }] });

const banner = (client: NetClient): string => connectionBannerText(client.stats);

describe("NetClient: the end of a match is not a lost connection", () => {
  it("MatchEnd, then Disconnect{matchEnded} and the close after the end linger: no banner", () => {
    const { client, send } = setup();
    send(matchEnd);
    expect(client.matchEnd?.reason).toBe(MatchEndReason.hostEnded);
    send((w) => encodeDisconnect(w, { reason: DisconnectReason.matchEnded, detail: 0 }));
    client.handleTransportClosed(4000 + DisconnectReason.matchEnded);
    expect(client.state).toBe("disconnected");
    expect(client.stats.disconnectExpected).toBe(true);
    expect(banner(client)).toBe("");
  });

  it("MatchEnd, then the match process exits under the socket (1006, no Disconnect): no banner", () => {
    const { client, send } = setup();
    send(matchEnd);
    client.handleTransportClosed(CLOSE_ABNORMAL);
    expect(client.state).toBe("disconnected");
    expect(client.stats.disconnectExpected).toBe(true);
    expect(banner(client)).toBe("");
  });

  it("a drained match (MatchEnd aborted, Disconnect{serverShutdown}): no banner, the result screen explains it", () => {
    const { client, send } = setup();
    send((w) => encodeMatchEnd(w, { serverTick: 10, reason: MatchEndReason.aborted, winningTeam: -1, players: [] }));
    send((w) => encodeDisconnect(w, { reason: DisconnectReason.serverShutdown, detail: 0 }));
    expect(client.stats.disconnectExpected).toBe(true);
    expect(banner(client)).toBe("");
  });

  it("leaving or abandoning on purpose (disconnect), and the server's clientLeave answer: no banner", () => {
    const left = setup();
    left.client.requestLeaveMatch();
    left.client.disconnect();
    left.client.handleTransportClosed(CLOSE_ABNORMAL);
    expect(left.server.closed).toBe(true);
    expect(left.client.stats.disconnectExpected).toBe(true);
    expect(banner(left.client)).toBe("");

    const confirmed = setup();
    confirmed.client.requestLeaveMatch();
    confirmed.send((w) => encodeDisconnect(w, { reason: DisconnectReason.clientLeave, detail: 0 }));
    expect(confirmed.client.stats.disconnectExpected).toBe(true);
    expect(banner(confirmed.client)).toBe("");
  });

  it("a real drop mid-match still shows the banner: 1006, a kick, a server shutdown without MatchEnd", () => {
    const dropped = setup();
    dropped.client.handleTransportClosed(CLOSE_ABNORMAL);
    expect(dropped.client.stats.disconnectExpected).toBe(false);
    expect(banner(dropped.client)).not.toBe("");
    expect(dropped.client.stats.disconnectReason).not.toBe("");

    const kicked = setup();
    kicked.send((w) => encodeDisconnect(w, { reason: DisconnectReason.timeout, detail: 0 }));
    expect(kicked.client.stats.disconnectExpected).toBe(false);
    expect(banner(kicked.client)).not.toBe("");

    const shutdown = setup();
    shutdown.send((w) => encodeDisconnect(w, { reason: DisconnectReason.serverShutdown, detail: 0 }));
    expect(banner(shutdown.client)).not.toBe("");
  });

  it("a rejoin gets a fresh client whose banner follows its own connection", () => {
    const old = setup();
    old.send(matchEnd);
    old.client.handleTransportClosed(CLOSE_ABNORMAL);
    const next = setup();
    expect(banner(next.client)).not.toBe("");
    expect(next.client.state).toBe("handshaking");
    next.client.handleTransportClosed(CLOSE_ABNORMAL);
    expect(next.client.stats.disconnectExpected).toBe(false);
  });
});
