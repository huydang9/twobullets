import type { DevJoinTokenResponse } from "@twobullets/contracts";
import { DisconnectReason } from "@twobullets/protocol";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer, type RunningServer } from "../src/app";
import { HeadlessClient } from "../src/dev/HeadlessClient";
import { WsSession } from "../src/transport/WsSession";

// Real localhost transport: the full server wiring on a random port, one ws client, real clock and scheduler.

let server: RunningServer | null = null;

afterAll(async () => {
  await server?.stop();
});

async function until(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

describe("ws transport (localhost)", () => {
  it("serves a dev token, handshakes, streams snapshots, acks inputs and shuts down cleanly", async () => {
    server = await startServer({ mode: "local", host: "127.0.0.1", port: 0, log: () => {} });
    const base = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({ ok: true });

    const res = await fetch(`${base}/dev/token?sub=smoke&team=3`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const dev = (await res.json()) as DevJoinTokenResponse;
    expect(dev.url).toBe(`ws://127.0.0.1:${server.port}/m/local`);

    const ws = new WebSocket(dev.url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const clock = { now: () => performance.now() };
    const client = new HeadlessClient({ session: new WsSession(ws, clock), clock, token: dev.token, seed: 1 });
    client.hello();
    const pump = setInterval(() => client.update(), 4);
    try {
      expect(await until(() => client.welcome !== null || client.disconnect !== null, 3000)).toBe(true);
      expect(client.disconnect).toBeNull();
      expect(client.welcome).toMatchObject({ teamId: 3, playerSlot: 6, tickRate: 60, interpFloorMs: 50 });
      expect(await until(() => client.snapshotsReceived >= 20 && client.lastProcessedInputTick >= 0, 5000)).toBe(true);
      expect(client.snapshotsDropped).toBe(0);
      expect(server.matches[0]!.connectedCount).toBe(1);

      const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
      await server.stop();
      server = null;
      expect(await closed).toBe(4000 + DisconnectReason.serverShutdown);
      expect(client.disconnect?.reason).toBe(DisconnectReason.serverShutdown);
    } finally {
      clearInterval(pump);
      ws.terminate();
    }
  }, 30_000);

  // A terminated socket reaches a browser as close code 1006, which the client shows as "connection lost". Stopping the
  // process (the match ended, drain) must close every socket with a reason instead.
  it("stop closes a socket still before Hello with serverShutdown, and waits for a peer slow to answer the close", async () => {
    const lines: string[] = [];
    server = await startServer({ mode: "local", host: "127.0.0.1", port: 0, log: (line) => lines.push(line) });
    const dev = (await (await fetch(`http://127.0.0.1:${server.port}/dev/token?sub=slow&team=0`)).json()) as DevJoinTokenResponse;
    const open = async (): Promise<WebSocket> => {
      const ws = new WebSocket(dev.url);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      return ws;
    };
    const idle = await open();
    const slow = await open();
    const clock = { now: () => performance.now() };
    const client = new HeadlessClient({ session: new WsSession(slow, clock), clock, token: dev.token, seed: 2 });
    client.hello();
    const pump = setInterval(() => client.update(), 4);
    try {
      expect(await until(() => client.welcome !== null && client.snapshotsReceived > 0, 5000)).toBe(true);
      const idleClosed = new Promise<number>((resolve) => idle.once("close", (code) => resolve(code)));
      const slowClosed = new Promise<number>((resolve) => slow.once("close", (code) => resolve(code)));
      // The attached client reads nothing for 600 ms (a busy tab, a long round trip): its close reply comes late.
      const raw = (slow as unknown as { _socket: { pause(): void; resume(): void } })._socket;
      raw.pause();
      setTimeout(() => raw.resume(), 600);
      const stopped = server.stop();
      server = null;
      await stopped;
      expect(await idleClosed).toBe(4000 + DisconnectReason.serverShutdown);
      expect(await slowClosed).toBe(4000 + DisconnectReason.serverShutdown);
      expect(client.disconnect?.reason).toBe(DisconnectReason.serverShutdown);
      expect(lines.filter((l) => l.includes("terminating"))).toEqual([]);
    } finally {
      clearInterval(pump);
      idle.terminate();
      slow.terminate();
    }
  }, 30_000);
});
