import { WS_CLOSE_AUTH, WS_CLOSE_REPLACED, type ApiToClientWs } from "@twobullets/contracts/ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LobbySocket, type LobbySocketStatus } from "../../src/platform/LobbySocket";
import { FakeSocket, flush } from "./fakes";

function setup(token: () => Promise<string | null> = async () => "A1", refresh = vi.fn(async () => true)) {
  FakeSocket.instances = [];
  const socket = new LobbySocket({ url: "ws://api.test/v1/ws", createSocket: (url) => new FakeSocket(url), accessToken: token, refreshAccess: refresh });
  const messages: ApiToClientWs[] = [];
  const statuses: LobbySocketStatus[] = [];
  socket.on((m) => messages.push(m));
  socket.onStatus((s) => statuses.push(s));
  const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;
  return { socket, messages, statuses, refresh, last };
}

async function openAndReady(fake: FakeSocket): Promise<void> {
  fake.serverOpen();
  await flush();
  fake.serverSend({ t: "ready", accountId: "g_TEST" });
}

describe("LobbySocket", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("authenticates in the first frame, delivers events and pings every 25 s", async () => {
    const { socket, messages, statuses, last } = setup();
    socket.start();
    expect(last().url).toBe("ws://api.test/v1/ws");
    await openAndReady(last());
    expect(last().sent[0]).toEqual({ t: "auth", accessToken: "A1" });
    expect(socket.status).toBe("open");
    expect(statuses).toEqual(["connecting", "open"]);

    const lobby = { t: "lobby.updated", lobby: { code: "ABCDEF" } };
    last().serverSend(lobby);
    last().serverSend({ t: "pong" });
    expect(messages.map((m) => m.t)).toEqual(["ready", "lobby.updated"]);

    vi.advanceTimersByTime(25_000);
    expect(last().sent[1]).toEqual({ t: "ping" });
  });

  it("reconnects with backoff 1 s, 2 s … and resets it after ready", async () => {
    const { socket, last } = setup();
    socket.start();
    await openAndReady(last());
    last().serverClose(1006);
    await flush();
    expect(socket.status).toBe("reconnecting");
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);

    last().serverClose(1006); // failed before open
    await flush();
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);

    await openAndReady(last());
    expect(socket.status).toBe("open");
    last().serverClose(1006);
    await flush();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("stops when another tab replaces the socket (4010)", async () => {
    const { socket, last } = setup();
    socket.start();
    await openAndReady(last());
    last().serverClose(WS_CLOSE_REPLACED);
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(socket.status).toBe("replaced");
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("refreshes the token after an auth close (4001), then reconnects; stops if the refresh fails", async () => {
    const refresh = vi.fn(async () => true);
    const { socket, last } = setup(async () => "A1", refresh);
    socket.start();
    last().serverOpen();
    await flush();
    last().serverClose(WS_CLOSE_AUTH);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);

    refresh.mockResolvedValueOnce(false);
    last().serverOpen();
    await flush();
    last().serverClose(WS_CLOSE_AUTH);
    await flush();
    vi.advanceTimersByTime(60_000);
    expect(socket.status).toBe("stopped");
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("stop() closes the socket and never reconnects", async () => {
    const { socket, last } = setup();
    socket.start();
    await openAndReady(last());
    const fake = last();
    socket.stop();
    expect(fake.closedWith).toBe(1000);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(socket.status).toBe("stopped");
  });
});
